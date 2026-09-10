import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileUriForPath, formatError, relativeWorkspacePath, resolveWorkspacePath } from "./config.js";
import type {
  Finding,
  FindingSeverity,
  InspectionOutput,
  InspectionRequest,
  InspectorContext,
  Logger,
  Range
} from "./types.js";
import { noopLogger } from "./types.js";

const MAX_OUTPUT = 200_000;

export class InspectionExecutionError extends Error {
  readonly code: string;
  readonly details: string | undefined;

  constructor(code: string, message: string, details?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InspectionExecutionError";
    this.code = code;
    this.details = details;
  }
}

export class InspectionCancelledError extends InspectionExecutionError {
  constructor() {
    super("cancelled", "Inspection was cancelled before it completed.");
    this.name = "InspectionCancelledError";
  }
}

export class InspectionEngine {
  private readonly context: InspectorContext;
  private readonly logger: Logger;

  constructor(context: InspectorContext, logger: Logger = noopLogger) {
    this.context = context;
    this.logger = logger;
  }

  async run(request: InspectionRequest, signal?: AbortSignal): Promise<InspectionOutput> {
    const startedAt = Date.now();
    let findings: Finding[];
    let summaryExtra: Partial<InspectionOutput["summary"]> = {};
    if (request.inspector === "eslint") {
      findings = await this.runEslint(request, signal);
    } else if (request.inspector === "typescript") {
      findings = await this.runTypeScript(request, signal);
    } else {
      const build = await this.runBuild(request, signal);
      findings = build.findings;
      summaryExtra = build.summary;
    }
    if (findings.length > this.context.config.maxFindings) {
      this.logger.warn(`Inspection findings exceeded the configured limit; keeping the first ${this.context.config.maxFindings}.`, { inspector: request.inspector, total: findings.length });
      findings = findings.slice(0, this.context.config.maxFindings);
    }
    const durationMs = Date.now() - startedAt;
    const summary = summarize(findings, durationMs, summaryExtra);
    this.logger.info(`Inspection ${request.inspector} completed`, { durationMs, findings: findings.length });
    return { findings, summary };
  }

  private async runEslint(request: InspectionRequest, signal?: AbortSignal): Promise<Finding[]> {
    const settings = this.context.config.inspectors.eslint;
    const cwd = this.resolveInspectorCwd(settings.cwd);
    const eslintModule = await loadProjectModule(cwd, "eslint");
    const eslintClass = getExport(eslintModule, "ESLint");
    if (typeof eslintClass !== "function") {
      throw new InspectionExecutionError("unsupported-tool", "The project ESLint package does not expose the ESLint API.");
    }
    const options = { cwd } as Record<string, unknown>;
    const eslint = new (eslintClass as new (options: Record<string, unknown>) => EslintApi)(options);
    const files = request.scope.files?.map((file) => resolveWorkspacePath(this.context.root, file));
    const patterns = files && files.length > 0 ? files : settings.patterns;
    try {
      const results = await eslint.lintFiles(patterns);
      throwIfAborted(signal);
      return results.flatMap((result) => this.mapEslintResult(result, request));
    } catch (error) {
      if (error instanceof InspectionExecutionError) throw error;
      const message = formatError(error);
      const code = /config|configuration|eslint.config|could not find/i.test(message) ? "missing-configuration" : "inspector-failed";
      throw new InspectionExecutionError(code, `ESLint inspection failed: ${message}`, undefined, { cause: error });
    }
  }

  private mapEslintResult(result: EslintResult, request: InspectionRequest): Finding[] {
    const file = result.filePath ? this.findingFile(result.filePath) : undefined;
    return result.messages.map((message, index) => {
      const range = eslintRange(message);
      return {
        id: findingId(request, file, message.ruleId ?? undefined, message.message, range, index),
        inspector: "eslint",
        source: "eslint",
        ...(message.ruleId ? { code: message.ruleId } : {}),
        severity: eslintSeverity(message.severity),
        message: message.message,
        ...(file ? { file } : {}),
        ...(range ? { range } : {}),
        runId: request.runId,
        generation: request.generation
      };
    });
  }

  private async runTypeScript(request: InspectionRequest, signal?: AbortSignal): Promise<Finding[]> {
    const settings = this.context.config.inspectors.typescript;
    const cwd = this.resolveInspectorCwd(settings.cwd);
    const tsModule = await loadProjectModule(cwd, "typescript");
    const ts = unwrapModule(tsModule) as TypeScriptApi;
    if (typeof ts.findConfigFile !== "function" || typeof ts.createProgram !== "function") {
      throw new InspectionExecutionError("unsupported-tool", "The project TypeScript package does not expose the compiler API.");
    }
    const projectPath = resolve(cwd, settings.project);
    if (!existsSync(projectPath)) {
      throw new InspectionExecutionError("missing-configuration", `TypeScript project file does not exist: ${projectPath}`);
    }
    try {
      const readConfig = ts.readConfigFile(projectPath, ts.sys.readFile);
      if (readConfig.error) {
        return [this.mapTypeScriptDiagnostic(readConfig.error, request)];
      }
      const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, dirname(projectPath));
      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences
      });
      const diagnostics = [...(parsed.errors ?? []), ...ts.getPreEmitDiagnostics(program)];
      throwIfAborted(signal);
      return diagnostics.map((diagnostic, index) => this.mapTypeScriptDiagnostic(diagnostic, request, index));
    } catch (error) {
      if (error instanceof InspectionExecutionError) throw error;
      throw new InspectionExecutionError("inspector-failed", `TypeScript inspection failed: ${formatError(error)}`, undefined, { cause: error });
    }
  }

  private mapTypeScriptDiagnostic(diagnostic: TypeScriptDiagnostic, request: InspectionRequest, index = 0): Finding {
    const message = flattenTypeScriptMessage(diagnostic.messageText);
    const file = diagnostic.file?.fileName ? this.findingFile(diagnostic.file.fileName) : undefined;
    const range = diagnostic.file && typeof diagnostic.start === "number"
      ? typeScriptRange(diagnostic.file, diagnostic.start, diagnostic.length ?? 0)
      : undefined;
    return {
      id: findingId(request, file, diagnostic.code !== undefined ? String(diagnostic.code) : undefined, message, range, index),
      inspector: "typescript",
      source: "typescript",
      ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
      severity: typeScriptSeverity(diagnostic.category),
      message,
      ...(file ? { file } : {}),
      ...(range ? { range } : {}),
      runId: request.runId,
      generation: request.generation
    };
  }

  private async runBuild(request: InspectionRequest, signal?: AbortSignal): Promise<{ findings: Finding[]; summary: Partial<InspectionOutput["summary"]> }> {
    const settings = this.context.config.inspectors.build;
    const cwd = this.resolveInspectorCwd(settings.cwd);
    const [command, ...args] = settings.command;
    if (!command) {
      throw new InspectionExecutionError("configuration-error", "Build command cannot be empty.");
    }
    const result = await runCommand(command, args, {
      cwd,
      env: { ...process.env, ...settings.env },
      timeoutMs: settings.timeoutMs,
      signal,
      logger: this.logger
    });
    if (result.cancelled) throw new InspectionCancelledError();
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.exitCode === 0) return { findings: [], summary: { exitCode: 0, stdout: result.stdout, stderr: result.stderr } };
    const message = output || `Build command exited with status ${result.exitCode ?? "unknown"}.`;
    const finding: Finding = {
      id: findingId(request, undefined, `exit-${result.exitCode ?? "unknown"}`, message, undefined, 0),
      inspector: "build",
      source: "build",
      code: result.exitCode === null ? "timeout" : `exit-${result.exitCode ?? "unknown"}`,
      severity: "error",
      message,
      runId: request.runId,
      generation: request.generation
    };
    return { findings: [finding], summary: { ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}), stdout: result.stdout, stderr: result.stderr } };
  }

  private resolveInspectorCwd(cwd: string): string {
    const value = resolveWorkspacePath(this.context.root, cwd);
    if (!isAbsolute(value)) throw new InspectionExecutionError("configuration-error", `Inspector cwd is not absolute: ${cwd}`);
    return value;
  }

  private findingFile(value: string): string | undefined {
    try {
      return fileUriForPath(resolveWorkspacePath(this.context.root, value));
    } catch (error) {
      this.logger.warn("Inspector returned a file outside the workspace; omitting its location.", { file: value, error: formatError(error) });
      return undefined;
    }
  }
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
  sys: { fileExists(path: string): boolean; readFile(path: string): string | undefined };
  findConfigFile(searchPath: string, fileExists: (path: string) => boolean, configName?: string): string | undefined;
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
  return {
    start: { line: startPosition.line, character: startPosition.character },
    end: { line: endPosition.line, character: endPosition.character }
  };
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

function summarize(findings: Finding[], durationMs: number, extra: Partial<InspectionOutput["summary"]> = {}): InspectionOutput["summary"] {
  return {
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
    infoCount: findings.filter((finding) => finding.severity === "info").length,
    hintCount: findings.filter((finding) => finding.severity === "hint").length,
    durationMs,
    ...extra
  };
}

function findingId(request: InspectionRequest, file: string | undefined, code: string | undefined, message: string, range: Range | undefined, index: number): string {
  const location = range ? `${range.start.line}:${range.start.character}` : "none";
  return `${request.inspector}:${request.generation}:${index}:${file ?? "workspace"}:${code ?? ""}:${location}:${message}`;
}

async function loadProjectModule(cwd: string, name: string): Promise<unknown> {
  try {
    const require = createRequire(join(cwd, ".code-inspection-require.cjs"));
    const resolved = require.resolve(name);
    return await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new InspectionExecutionError("missing-tool", `Project dependency \"${name}\" is not installed or cannot be loaded from ${cwd}. Install it in the workspace before running inspection.`, formatError(error), { cause: error });
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

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
}

async function runCommand(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  logger: Logger;
}): Promise<CommandResult> {
  const executable = process.platform === "win32" && ["npm", "npx", "pnpm", "yarn", "bun"].includes(command) ? `${command}.cmd` : command;
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const windowsScript = process.platform === "win32" && executable.endsWith(".cmd");
    const child = spawn(windowsScript ? (process.env.ComSpec ?? "cmd.exe") : executable, windowsScript ? ["/d", "/s", "/c", executable, ...args] : args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > MAX_OUTPUT ? next.slice(0, MAX_OUTPUT) : next;
    };
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const kill = (): void => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => child.kill());
      } else {
        child.kill("SIGTERM");
      }
    };
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    const timeout = setTimeout(() => {
      stderr = append(stderr, Buffer.from(`\nBuild timed out after ${options.timeoutMs}ms.`));
      kill();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      if (settled) return;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new InspectionExecutionError("process-failed", `Unable to start build command \"${command}\": ${formatError(error)}`, undefined, { cause: error }));
    });
    child.once("close", (exitCode) => finish({ exitCode, stdout, stderr, cancelled }));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    options.logger.debug(`Started build command ${executable}`, { args, cwd: options.cwd });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InspectionCancelledError();
}
