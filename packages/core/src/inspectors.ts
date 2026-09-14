import { createRequire } from "node:module";
import { existsSync, readFileSync, unlinkSync, statSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fileUriForPath,
  formatError,
  resolveWorkspacePath
} from "./config.js";
import { InspectionCancelledError, InspectionExecutionError } from "./errors.js";
import { createFinding } from "./findings.js";
import { isExcludedPath } from "./matching.js";
import { getDiagnosticParser } from "./parsers.js";
import { disambiguateHeaderLanguage } from "./projects.js";
import { languagesForFile } from "./languages.js";
import { probeToolVersion, runTool } from "./tool-runner.js";
import type { CheckConfig } from "./config.js";
import type { InspectorExecutionContext } from "./registry.js";
import type {
  Finding,
  FindingSeverity,
  InspectionOutput,
  InspectionRequest,
  LanguageId,
  Range,
  RawDiagnostic
} from "./types.js";

const DEFAULT_SOURCE_PATTERNS = ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];

export async function runEslint(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  // Project-scoped requests may point at a nested package. ESLint resolves its
  // flat config, plugins, and relative patterns from cwd, so use that project
  // root instead of silently falling back to the workspace root.
  const cwd = resolveCwd(context, config, request.projectRoot);
  const eslintModule = await loadProjectModule(cwd, "eslint");
  const eslintClass = getExport(eslintModule, "ESLint");
  if (typeof eslintClass !== "function") {
    throw new InspectionExecutionError("unsupported-tool", "The project ESLint package does not expose the ESLint API.");
  }
  const eslint = new (eslintClass as new (options: Record<string, unknown>) => EslintApi)({ cwd });
  const files = request.scope.files
    ?.map((file) => resolveWorkspacePath(context.root, file))
    .filter((file) => !isExcludedPath(context.root, file, config.exclude));
  if (request.scope.files && request.scope.files.length > 0 && (files?.length ?? 0) === 0) return output([]);
  const patterns = files && files.length > 0 ? files : (config.patterns ?? DEFAULT_SOURCE_PATTERNS);
  try {
    const results = await eslint.lintFiles(patterns);
    throwIfAborted(signal);
    const findings = results.flatMap((result) => {
      if (isExcludedPath(context.root, result.filePath, config.exclude)) return [];
      return result.messages.map((message) => {
      const file = result.filePath ? resolveFindingFile(context.root, cwd, result.filePath, context.logger) : undefined;
      const range = eslintRange(message);
      return makeFinding(context, request, config, {
        message: message.message,
        severity: eslintSeverity(message.severity),
        code: message.ruleId ?? undefined,
        file,
        range
      }, "eslint");
      });
    });
    return output(findings);
  } catch (error) {
    if (error instanceof InspectionExecutionError) throw error;
    const message = formatError(error);
    const code = /config|configuration|eslint.config|could not find/i.test(message) ? "missing-configuration" : "inspector-failed";
    throw new InspectionExecutionError(code, "ESLint inspection failed: " + message, undefined, { cause: error });
  }
}

export async function runTypeScript(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  // Keep compiler config/module resolution anchored to the discovered project.
  // Without this, a monorepo's first tsconfig shadows diagnostics from the
  // nested project selected by the scheduler.
  const cwd = resolveCwd(context, config, request.projectRoot);
  const tsModule = await loadProjectModule(cwd, "typescript");
  const ts = unwrapModule(tsModule) as TypeScriptApi;
  if (typeof ts.createProgram !== "function" || typeof ts.readConfigFile !== "function" || typeof ts.parseJsonConfigFileContent !== "function") {
    throw new InspectionExecutionError("unsupported-tool", "The project TypeScript package does not expose the compiler API.");
  }
  const projectPath = resolveWorkspacePath(context.root, resolve(cwd, config.project ?? "tsconfig.json"));
  if (!existsSync(projectPath)) {
    throw new InspectionExecutionError("missing-configuration", "TypeScript project file does not exist: " + projectPath);
  }
  try {
    const readConfig = ts.readConfigFile(projectPath, ts.sys.readFile);
    if (readConfig.error) {
      const finding = mapTypeScriptDiagnostic(context, request, config, readConfig.error);
      return output([finding]);
    }
    const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, dirname(projectPath));
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences
    });
    const diagnostics = [...(parsed.errors ?? []), ...ts.getPreEmitDiagnostics(program)]
      .filter((diagnostic) => !diagnostic.file?.fileName || !isExcludedPath(context.root, diagnostic.file.fileName, config.exclude));
    throwIfAborted(signal);
    return output(diagnostics.map((diagnostic) => mapTypeScriptDiagnostic(context, request, config, diagnostic)));
  } catch (error) {
    if (error instanceof InspectionExecutionError) throw error;
    throw new InspectionExecutionError("inspector-failed", "TypeScript inspection failed: " + formatError(error), undefined, { cause: error });
  }
}

export async function runCommandBuild(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  const command = config.command;
  if (!command || command.length === 0) throw new InspectionExecutionError("configuration-error", "Configured command check " + context.checkId + " requires a command.");
  return runExternal(context, request, config, command, config.parser ?? "build", signal, { appendFiles: false, alwaysWorkspaceFailure: true });
}

export async function runRuff(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  return runExternal(context, request, config, config.command ?? ["ruff", "check", "--output-format", "json"], config.parser ?? "ruff-json", signal, { appendFiles: true, allowedFindingExitCodes: [1], probeVersion: true });
}

export async function runPyright(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  // Pyright's project graph and import resolution are configuration-driven.
  // Running it from an arbitrary workspace root silently changes the meaning
  // of the check, so require a project marker before invoking the tool.
  const projectRoot = request.projectRoot ?? context.root;
  requireProjectMarker(context, request, ["pyrightconfig.json", "pyproject.toml"], "Pyright", config.project);
  const command = config.command ?? [
    "pyright",
    "--outputjson",
    ...(config.project ? ["--project", resolveWorkspacePath(context.root, resolve(projectRoot, config.project))] : [])
  ];
  return runExternal(context, request, config, command, config.parser ?? "pyright-json", signal, { appendFiles: false, allowedFindingExitCodes: [1], probeVersion: true });
}

export async function runGoVet(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  requireProjectMarker(context, request, ["go.mod", "go.work"], "Go module");
  return runExternal(context, request, config, config.command ?? ["go", "vet", "-json", "./..."], config.parser ?? "go-json", signal, { appendFiles: false, allowedFindingExitCodes: [1], probeVersion: true, versionArgs: ["version"] });
}

export async function runGolangciLint(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  requireProjectMarker(context, request, ["go.mod", "go.work"], "Go module");
  return runExternal(context, request, config, config.command ?? ["golangci-lint", "run", "--output.json.path", "stdout"], config.parser ?? "golangci-json", signal, { appendFiles: false, allowedFindingExitCodes: [1], probeVersion: true, versionArgs: ["version"] });
}

export async function runCargoCheck(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  requireProjectMarker(context, request, ["Cargo.toml"], "Cargo project");
  return runExternal(context, request, config, config.command ?? ["cargo", "check", "--message-format=json"], config.parser ?? "rust-json", signal, { appendFiles: false, allowedFindingExitCodes: [101], probeVersion: true });
}

export async function runCargoClippy(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  requireProjectMarker(context, request, ["Cargo.toml"], "Cargo project");
  return runExternal(context, request, config, config.command ?? ["cargo", "clippy", "--message-format=json"], config.parser ?? "rust-json", signal, { appendFiles: false, allowedFindingExitCodes: [101], probeVersion: true });
}

export async function runCheckstyle(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  const projectRoot = request.projectRoot ?? context.root;
  if (!config.command) requireProjectMarker(context, request, ["pom.xml", "build.gradle", "build.gradle.kts", "mvnw", "gradlew", "mvnw.cmd", "gradlew.bat"], "Java");
  const command = config.command ?? javaWrapperCommand(projectRoot, ["checkstyle:check"]);
  return runExternal(context, request, config, command, config.parser ?? "checkstyle-xml", signal, {
    appendFiles: false,
    allowedFindingExitCodes: [1],
    reportFiles: reportFiles(config, projectRoot, ["target/checkstyle-result.xml", "build/reports/checkstyle/main.xml"]),
    probeVersion: true
  });
}

export async function runPmd(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  const projectRoot = request.projectRoot ?? context.root;
  if (!config.command) requireProjectMarker(context, request, ["pom.xml", "build.gradle", "build.gradle.kts", "mvnw", "gradlew", "mvnw.cmd", "gradlew.bat"], "Java");
  const command = config.command ?? javaWrapperCommand(projectRoot, ["pmd:check"]);
  return runExternal(context, request, config, command, config.parser ?? "pmd-json", signal, {
    appendFiles: false,
    allowedFindingExitCodes: [1],
    reportFiles: reportFiles(config, projectRoot, ["target/pmd.json", "target/pmd.xml", "build/reports/pmd/main.json", "build/reports/pmd/main.xml"]),
    probeVersion: true
  });
}

export async function runJavaBuild(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  const projectRoot = request.projectRoot ?? context.root;
  if (!config.command) requireProjectMarker(context, request, ["pom.xml", "build.gradle", "build.gradle.kts", "mvnw", "gradlew", "gradlew.bat", "mvnw.cmd"], "Java");
  const command = config.command ?? javaBuildCommand(projectRoot);
  return runExternal(context, request, config, command, config.parser ?? "text", signal, { appendFiles: false, alwaysWorkspaceFailure: true, probeVersion: true });
}

export async function runClangTidy(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  const projectRoot = request.projectRoot ?? context.root;
  const compileCommands = typeof config.options.compileCommands === "string" ? config.options.compileCommands : "compile_commands.json";
  const compilePath = findCompileCommands(context.root, projectRoot, compileCommands);
  if (!existsSync(compilePath)) {
    throw new InspectionExecutionError("missing-configuration", "C/C++ inspection requires a compilation database: " + compilePath);
  }
  const files = request.scope.files?.map((file) => resolveWorkspacePath(context.root, file)) ?? [];
  if (files.length === 0 && !config.command) {
    throw new InspectionExecutionError("configuration-error", "clang-tidy requires a file scope or an explicit project command.");
  }
  const preparedDatabase = config.command ? undefined : prepareCompileDatabase(compilePath);
  const command = config.command ?? ["clang-tidy", "-p", preparedDatabase?.directory ?? dirname(compilePath), ...files];
  try {
    return await runExternal(context, request, config, command, config.parser ?? "clang-json", signal, { appendFiles: false, allowedFindingExitCodes: [1, 2], probeVersion: true });
  } finally {
    if (preparedDatabase?.temporaryDirectory) {
      rmSync(preparedDatabase.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

interface PreparedCompileDatabase {
  directory: string;
  temporaryDirectory?: string;
}

/**
 * clang-tidy expects compile database paths to be canonical in practice,
 * although the JSON compilation database format permits relative paths.
 * Normalize relative entries in a temporary copy so project files remain
 * untouched and generated CMake databases continue to work unchanged.
 */
function prepareCompileDatabase(compilePath: string): PreparedCompileDatabase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(compilePath, "utf8")) as unknown;
  } catch {
    return { directory: dirname(compilePath) };
  }
  if (!Array.isArray(parsed)) return { directory: dirname(compilePath) };
  const databaseRoot = dirname(compilePath);
  let changed = false;
  const entries = parsed.map((entry) => {
    if (!isRecord(entry)) return entry;
    const originalDirectory = typeof entry.directory === "string" && entry.directory.length > 0 ? entry.directory : ".";
    const directory = isAbsolute(originalDirectory) ? normalize(originalDirectory) : resolve(databaseRoot, originalDirectory);
    const originalFile = typeof entry.file === "string" ? entry.file : undefined;
    const file = originalFile && !isAbsolute(originalFile) ? resolve(directory, originalFile) : originalFile;
    if (directory !== originalDirectory || (originalFile && file !== originalFile)) changed = true;
    return {
      ...entry,
      directory,
      ...(file ? { file } : {})
    };
  });
  if (!changed) return { directory: databaseRoot };
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "code-inspection-compile-db-"));
  try {
    writeFileSync(join(temporaryDirectory, "compile_commands.json"), JSON.stringify(entries), "utf8");
    return { directory: temporaryDirectory, temporaryDirectory };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new InspectionExecutionError("configuration-error", "Unable to prepare the C/C++ compilation database: " + formatError(error), undefined, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findCompileCommands(workspaceRoot: string, projectRoot: string, configured: string): string {
  const configuredPath = resolveWorkspacePath(workspaceRoot, resolve(projectRoot, configured));
  const candidates = [
    configuredPath,
    resolve(projectRoot, "build", "compile_commands.json"),
    resolve(projectRoot, "cmake-build-debug", "compile_commands.json")
  ];
  const direct = candidates.find((candidate) => existsSync(candidate));
  if (direct) return direct;
  const nested = findNestedCompileDatabase(projectRoot, 3);
  return nested ?? candidates[0]!;
}

function findNestedCompileDatabase(root: string, maxDepth: number): string | undefined {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const skipped = new Set([".git", "node_modules", "target", ".cargo", ".gradle"]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try { entries = readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === "compile_commands.json" && entry.isFile()) return join(current.directory, entry.name);
      if (current.depth >= maxDepth || !entry.isDirectory() || entry.isSymbolicLink() || skipped.has(entry.name.toLowerCase())) continue;
      queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return undefined;
}

export async function runClangBuild(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal): Promise<InspectionOutput> {
  if (!config.command || config.command.length === 0) throw new InspectionExecutionError("configuration-error", "Clang build requires an explicit command.");
  return runExternal(context, request, config, config.command, config.parser ?? "clang-json", signal, { appendFiles: false, alwaysWorkspaceFailure: true, probeVersion: true });
}

interface ExternalOptions {
  appendFiles: boolean;
  allowedFindingExitCodes?: number[];
  alwaysWorkspaceFailure?: boolean;
  reportFiles?: string[];
  probeVersion?: boolean;
  versionArgs?: string[];
}

async function runExternal(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, commandLine: string[], parserId: string, signal: AbortSignal | undefined, options: ExternalOptions): Promise<InspectionOutput> {
  const [command, ...baseArgs] = commandLine;
  if (!command) throw new InspectionExecutionError("configuration-error", "Inspection command cannot be empty.");
  const cwd = resolveCwd(context, config, request.projectRoot);
  const reportPaths = (options.reportFiles ?? []).map((file) => resolveWorkspacePath(context.root, file));
  for (const reportPath of reportPaths) {
    try { unlinkSync(reportPath); } catch { /* A report may not exist on the first run. */ }
  }
  const files = options.appendFiles && request.scope.files ? request.scope.files.map((file) => resolveWorkspacePath(context.root, file)) : [];
  const filteredFiles = files.filter((file) => !isExcludedPath(context.root, file, config.exclude));
  if (options.appendFiles && request.scope.files && request.scope.files.length > 0 && filteredFiles.length === 0) return output([]);
  const shouldProbeVersion = options.probeVersion === true || (options.probeVersion === undefined && config.options.probeVersion === true);
  const toolVersion = shouldProbeVersion
    ? await probeToolVersion(command, { cwd, env: config.env, timeoutMs: config.timeoutMs, ...(signal ? { signal } : {}), logger: context.logger }, options.versionArgs ?? ["--version"])
    : undefined;
  const result = await runTool(command, [...baseArgs, ...filteredFiles], {
    cwd,
    env: config.env,
    timeoutMs: config.timeoutMs,
    signal,
    logger: context.logger
  });
  if (result.cancelled) throw new InspectionCancelledError();
  // A deadline is a terminal execution outcome. Check it before attempting to
  // parse partially written reports or truncated JSON, otherwise a timeout can
  // be misreported as a parser failure.
  if (result.timedOut) {
    const timeoutOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new InspectionExecutionError("timeout", "Inspection tool timed out after " + config.timeoutMs + "ms.", timeoutOutput || undefined);
  }
  let raw: RawDiagnostic[] = [];
  try {
    const reports = reportPaths.flatMap((reportPath) => {
      try { return [readFileSync(reportPath, "utf8")]; } catch { return []; }
    });
    const parserStdout = reports.length > 0 ? reports.join("\n") : result.stdout;
    raw = getDiagnosticParser(parserId)(parserStdout, result.stderr, { root: context.root, cwd });
  } catch (error) {
    throw new InspectionExecutionError("parse-failed", "Unable to parse " + context.checkId + " output: " + formatError(error), undefined, { cause: error });
  }
  let findings = raw.flatMap((diagnostic) => {
    if (diagnostic.file && isExcludedDiagnostic(context.root, cwd, diagnostic.file, config.exclude)) return [];
    if (diagnostic.file && !canResolveFindingFile(context.root, cwd, diagnostic.file)) return [];
    return [makeFinding(context, request, config, diagnostic, context.checkId, cwd)];
  });
  const outputText = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const exitCode = result.exitCode;
  if (options.alwaysWorkspaceFailure && exitCode !== 0 && findings.length === 0) {
    findings.push(workspaceFinding(context, request, config, "exit-" + (exitCode ?? "unknown"), outputText || "Inspection command exited with status " + (exitCode ?? "unknown") + "."));
  } else if (exitCode !== 0 && findings.length === 0 && !(options.allowedFindingExitCodes ?? []).includes(exitCode ?? -1)) {
    throw new InspectionExecutionError("inspector-failed", context.checkId + " exited with status " + (exitCode ?? "unknown") + ".", outputText);
  } else if (exitCode !== 0 && findings.length === 0) {
    findings.push(workspaceFinding(context, request, config, "exit-" + (exitCode ?? "unknown"), outputText || "Inspection command exited with status " + (exitCode ?? "unknown") + "."));
  }
  return output(findings, { exitCode: exitCode === null ? undefined : exitCode, stdout: result.stdout, stderr: result.stderr, ...(toolVersion ? { toolVersion } : {}) });
}

function mapTypeScriptDiagnostic(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, diagnostic: TypeScriptDiagnostic): Finding {
  const message = flattenTypeScriptMessage(diagnostic.messageText);
  const file = diagnostic.file?.fileName ? resolveFindingFile(context.root, resolveCwd(context, config, request.projectRoot), diagnostic.file.fileName, context.logger) : undefined;
  const range = diagnostic.file && typeof diagnostic.start === "number" ? typeScriptRange(diagnostic.file, diagnostic.start, diagnostic.length ?? 0) : undefined;
  return makeFinding(context, request, config, {
    message,
    severity: typeScriptSeverity(diagnostic.category),
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    file,
    range
  }, "typescript");
}

function makeFinding(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, diagnostic: RawDiagnostic, source: string, baseDirectory = context.root): Finding {
  const file = diagnostic.file ? (diagnostic.file.startsWith("file://") || isAbsolute(diagnostic.file) ? resolveFindingFile(context.root, baseDirectory, diagnostic.file, context.logger) : resolveFindingFile(context.root, baseDirectory, diagnostic.file, context.logger)) : undefined;
  const language = request.language ?? (file ? inferLanguageFromUri(context.root, file, config.languages) : config.languages[0]);
  const relatedInformation = diagnostic.relatedInformation?.map((related) => ({
    message: related.message,
    ...(related.file ? { file: resolveFindingFile(context.root, baseDirectory, related.file, context.logger) } : {}),
    ...(related.range ? { range: related.range } : {})
  }));
  return createFinding({
    checkId: request.checkId,
    source,
    ...(language ? { language } : {}),
    ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    ...(request.executionKey ? { executionKey: request.executionKey } : {}),
    ...(diagnostic.code ? { code: diagnostic.code } : {}),
    severity: diagnostic.severity ?? "error",
    message: diagnostic.message,
    ...(file ? { file } : {}),
    ...(diagnostic.range ? { range: diagnostic.range } : {}),
    ...(relatedInformation && relatedInformation.length > 0 ? { relatedInformation } : {}),
    runId: request.runId,
    generation: request.generation
  });
}

function workspaceFinding(context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, code: string, message: string): Finding {
  return makeFinding(context, request, config, { message, severity: "error", code }, context.checkId);
}

function output(findings: Finding[], extra: Partial<InspectionOutput["summary"]> = {}): InspectionOutput {
  return {
    findings,
    summary: {
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      hintCount: 0,
      durationMs: 0,
      ...extra
    }
  };
}

function resolveCwd(context: InspectorExecutionContext, config: CheckConfig, projectRoot?: string): string {
  const configured = resolveWorkspacePath(context.root, config.cwd);
  if (projectRoot && config.cwd === ".") return projectRoot;
  return configured;
}

function resolveFindingFile(root: string, baseDirectory: string, value: string, logger: InspectorExecutionContext["logger"]): string | undefined {
  try {
    const candidates = value.startsWith("file://") || isAbsolute(value) ? [value] : [join(baseDirectory, value), join(root, value)];
    for (const candidate of candidates) {
      try {
        return fileUriForPath(resolveWorkspacePath(root, candidate));
      } catch {
        // Try the next path interpretation.
      }
    }
    logger.warn("Inspector returned a file outside the workspace; omitting its location.", { file: value });
  } catch (error) {
    logger.warn("Unable to normalize inspector file location.", { file: value, error: formatError(error) });
  }
  return undefined;
}

function canResolveFindingFile(root: string, baseDirectory: string, value: string): boolean {
  try {
    const candidates = value.startsWith("file://") || isAbsolute(value) ? [value] : [join(baseDirectory, value), join(root, value)];
    for (const candidate of candidates) {
      try {
        resolveWorkspacePath(root, candidate);
        return true;
      } catch {
        // Try the next interpretation.
      }
    }
  } catch {
    // Invalid locations are omitted from normalized findings.
  }
  return false;
}

function isExcludedDiagnostic(root: string, baseDirectory: string, value: string, patterns: readonly string[]): boolean {
  try {
    const candidate = value.startsWith("file://") || isAbsolute(value) ? value : resolve(baseDirectory, value);
    return isExcludedPath(root, candidate, patterns);
  } catch {
    return true;
  }
}

function inferLanguageFromUri(root: string, uri: string, configured: readonly LanguageId[]): LanguageId | undefined {
  let file = uri;
  try { if (uri.startsWith("file:")) file = fileURLToPath(uri); } catch { /* Keep the URI extension fallback below. */ }
  const candidates = languagesForFile(file);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const disambiguated = disambiguateHeaderLanguage(root, file, candidates);
    if (disambiguated) return disambiguated;
    // A single configured language is an explicit enough decision for an
    // otherwise ambiguous header; when both C and C++ are enabled, leave the
    // field unset instead of silently assigning the first catalog entry.
    return configured.length === 1 && candidates.includes(configured[0]!) ? configured[0] : undefined;
  }
  const extension = extname(file).toLowerCase();
  return extension ? configured.find((language) => languagesForFile("file" + extension).includes(language)) : undefined;
}

function requireProjectMarker(context: InspectorExecutionContext, request: InspectionRequest, markers: readonly string[], label: string, configuredProject?: string): void {
  const projectRoot = request.projectRoot ?? context.root;
  if (configuredProject) {
    try {
      const configuredPath = resolveWorkspacePath(context.root, resolve(projectRoot, configuredProject));
      if (existsSync(configuredPath)) return;
    } catch {
      // Configuration path validation is reported by the workspace config
      // loader; keep the execution error actionable when called directly.
    }
  }
  if (!markers.some((marker) => existsSync(join(projectRoot, marker)))) {
    throw new InspectionExecutionError("missing-configuration", label + " configuration was not found under " + projectRoot + ". Expected one of: " + markers.join(", "));
  }
}

function javaWrapperCommand(projectRoot: string, args: string[]): string[] {
  const gradleArgs = args.map((value) => value === "checkstyle:check" ? "checkstyleMain" : value === "pmd:check" ? "pmdMain" : value);
  const system = javaBuildSystem(projectRoot);
  if (system === "gradle") {
    const gradlew = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    if (existsSync(join(projectRoot, gradlew))) return wrapperCommand(join(projectRoot, gradlew), gradleArgs);
    return ["gradle", ...gradleArgs];
  }
  const mvnw = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
  if (existsSync(join(projectRoot, mvnw))) return wrapperCommand(join(projectRoot, mvnw), args);
  return ["mvn", ...args];
}

function javaBuildCommand(projectRoot: string): string[] {
  if (javaBuildSystem(projectRoot) === "gradle") {
    const gradlew = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    const gradleArgs = ["compileJava"];
    if (existsSync(join(projectRoot, gradlew))) return wrapperCommand(join(projectRoot, gradlew), gradleArgs);
    return ["gradle", ...gradleArgs];
  }
  const mvnw = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
  if (existsSync(join(projectRoot, mvnw))) return wrapperCommand(join(projectRoot, mvnw), ["-DskipTests", "compile"]);
  return ["mvn", "-DskipTests", "compile"];
}

type JavaBuildSystem = "maven" | "gradle";

/** Select the build system from project files before considering wrappers. */
function javaBuildSystem(projectRoot: string): JavaBuildSystem {
  if (existsSync(join(projectRoot, "pom.xml"))) return "maven";
  if (existsSync(join(projectRoot, "build.gradle")) || existsSync(join(projectRoot, "build.gradle.kts"))) return "gradle";
  if (existsSync(join(projectRoot, process.platform === "win32" ? "mvnw.cmd" : "mvnw"))) return "maven";
  if (existsSync(join(projectRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew"))) return "gradle";
  // Callers validate the presence of a Java marker first. Maven is the
  // deterministic default for a marker-less direct invocation.
  return "maven";
}

function wrapperCommand(wrapper: string, args: string[]): string[] {
  if (process.platform !== "win32") {
    try {
      if ((statSync(wrapper).mode & 0o111) === 0) return ["sh", wrapper, ...args];
    } catch {
      // Let ToolRunner report a precise process error if the wrapper disappears.
    }
  }
  return [wrapper, ...args];
}

function reportFiles(config: CheckConfig, projectRoot: string, defaults: string[]): string[] {
  const configured = typeof config.options.reportFile === "string" ? config.options.reportFile : undefined;
  return [...new Set([...(configured ? [resolve(projectRoot, configured)] : []), ...defaults.map((file) => resolve(projectRoot, file))])];
}

async function loadProjectModule(cwd: string, name: string): Promise<unknown> {
  try {
    const require = createRequire(join(cwd, ".code-inspection-require.cjs"));
    const resolved = require.resolve(name);
    return await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new InspectionExecutionError("missing-tool", "Project dependency " + JSON.stringify(name) + " is not installed or cannot be loaded from " + cwd + ". Install it in the workspace before running inspection.", formatError(error), { cause: error });
  }
}

function unwrapModule(module: unknown): unknown {
  if (module && typeof module === "object") {
    const namespace = module as Record<string, unknown>;
    if (namespace["module.exports"] && typeof namespace["module.exports"] === "object") return namespace["module.exports"];
    if (namespace.default && typeof namespace.default === "object") return namespace.default;
  }
  return module;
}

function getExport(module: unknown, name: string): unknown {
  if (module && typeof module === "object" && name in module) return module[name as keyof typeof module];
  const unwrapped = unwrapModule(module);
  if (unwrapped && typeof unwrapped === "object" && name in unwrapped) return unwrapped[name as keyof typeof unwrapped];
  return unwrapped;
}

interface EslintApi {
  lintFiles(patterns: string[]): Promise<EslintResult[]>;
}

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

interface EslintMessage {
  ruleId?: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

interface TypeScriptApi {
  sys: { readFile(path: string): string | undefined };
  readConfigFile(fileName: string, readFile: (path: string) => string | undefined): { config: unknown; error?: TypeScriptDiagnostic };
  parseJsonConfigFileContent(config: unknown, host: unknown, basePath: string): { fileNames: string[]; options: unknown; projectReferences?: unknown; errors?: TypeScriptDiagnostic[] };
  createProgram(options: { rootNames: string[]; options: unknown; projectReferences?: unknown }): TypeScriptProgram;
  getPreEmitDiagnostics(program: TypeScriptProgram): TypeScriptDiagnostic[];
}

interface TypeScriptProgram {
  getTypeChecker?: () => unknown;
}

interface TypeScriptDiagnostic {
  code?: number;
  category: number;
  messageText: string | { messageText: string; next?: unknown[] };
  file?: TypeScriptSourceFile;
  start?: number;
  length?: number;
}

interface TypeScriptSourceFile {
  fileName: string;
  getLineAndCharacterOfPosition(position: number): { line: number; character: number };
}

function eslintRange(message: EslintMessage): Range | undefined {
  if (!message.line || !message.column) return undefined;
  const start = { line: Math.max(0, message.line - 1), character: Math.max(0, message.column - 1) };
  const endLine = message.endLine ?? message.line;
  const endColumn = message.endColumn ?? message.column;
  return { start, end: { line: Math.max(0, endLine - 1), character: Math.max(0, endColumn - 1) } };
}

function typeScriptRange(file: TypeScriptSourceFile, start: number, length: number): Range {
  const startPosition = file.getLineAndCharacterOfPosition(start);
  const endPosition = file.getLineAndCharacterOfPosition(start + length);
  return { start: { line: startPosition.line, character: startPosition.character }, end: { line: endPosition.line, character: endPosition.character } };
}

function eslintSeverity(value: number): FindingSeverity {
  return value >= 2 ? "error" : value === 1 ? "warning" : "info";
}

function typeScriptSeverity(value: number): FindingSeverity {
  return value === 1 ? "error" : value === 0 ? "warning" : value === 2 ? "hint" : "info";
}

function flattenTypeScriptMessage(message: string | { messageText: string; next?: unknown[] }): string {
  if (typeof message === "string") return message;
  const childMessages = Array.isArray(message.next) ? message.next.filter(isDiagnosticMessage).map(flattenTypeScriptMessage) : [];
  return [message.messageText, ...childMessages].join("\n");
}

function isDiagnosticMessage(value: unknown): value is { messageText: string; next?: unknown[] } {
  return typeof value === "object" && value !== null && "messageText" in value && typeof value.messageText === "string";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InspectionCancelledError();
}
