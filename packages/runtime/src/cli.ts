#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  TrustStore,
  canonicalizeWorkspaceRoot,
  formatError,
  type Finding,
  type FindingsPage,
  type InspectionRun,
  type LanguageId
} from "@zakotoys/code-inspection-core";
import { connectWorkspaceService } from "./ipc.js";
import { createStderrLogger } from "./logger.js";
import type { InspectorCapability, ServiceApi } from "./protocol.js";
import { VERSION } from "./version.js";

const logger = createStderrLogger("cli");

interface CliOptions {
  workspace: string;
  checks: string[];
  files: string[];
  json: boolean;
  trust: boolean;
  includeStale: boolean;
  language?: LanguageId;
  project?: string;
  runId?: string;
  offset: number;
  limit: number;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case "trust": await trustCommand(args, false); return;
      case "revoke": await trustCommand(args, true); return;
      case "init": await initCommand(args); return;
      case "inspect": process.exitCode = await inspectCommand(args); return;
      case "findings": await findingsCommand(args); return;
      case "status": await statusCommand(args); return;
      case "capabilities": await capabilitiesCommand(args); return;
      case "projects": await projectsCommand(args); return;
      case "cancel": await cancelCommand(args); return;
      case "help":
      case "--help":
      case "-h": printHelp(); return;
      case "--version":
      case "version": process.stdout.write(`${VERSION}\n`); return;
      default: throw new Error(`Unknown command "${command}". Run code-inspection help for usage.`);
    }
  } catch (error) {
    process.stderr.write(`code-inspection: ${formatError(error)}\n`);
    process.exitCode = 2;
  }
}

async function trustCommand(args: string[], revoke: boolean): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const store = new TrustStore();
  if (revoke) await store.revoke(root); else await store.grant(root);
  process.stdout.write(`${revoke ? "Revoked" : "Trusted"} workspace: ${root}\n`);
}

async function initCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const configPath = join(root, ".code-inspection.json");
  try {
    await readFile(configPath, "utf8");
    throw new Error(`${configPath} already exists; edit it instead of overwriting it.`);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    const disabled = (adapter: string, languages: string[], scope = "project") => ({ adapter, enabled: false, languages, scope, cwd: "." });
    const config = {
      version: 2,
      debounceMs: 300,
      maxFindings: 2000,
      checks: {
        eslint: { adapter: "eslint", enabled: true, languages: ["javascript", "typescript"], scope: "file", cwd: ".", patterns: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"] },
        typescript: { adapter: "typescript", enabled: false, languages: ["javascript", "typescript"], scope: "project", cwd: ".", project: "tsconfig.json" },
        ruff: disabled("ruff", ["python"], "file"),
        pyright: disabled("pyright", ["python"]),
        "go-vet": disabled("go-vet", ["go"]),
        "golangci-lint": disabled("golangci-lint", ["go"]),
        "cargo-check": disabled("cargo-check", ["rust"]),
        "cargo-clippy": disabled("cargo-clippy", ["rust"]),
        checkstyle: disabled("checkstyle", ["java"]),
        pmd: disabled("pmd", ["java"]),
        "java-build": disabled("java-build", ["java"]),
        "clang-tidy": disabled("clang-tidy", ["c", "cpp"], "file"),
        "clang-build": disabled("clang-build", ["c", "cpp"]),
        build: { adapter: "command", enabled: false, languages: [], scope: "workspace", cwd: ".", command: ["npm", "run", "build"], parser: "build", timeoutMs: 120000 }
      }
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    process.stdout.write(`Created ${configPath}\n`);
  }
}

async function inspectCommand(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const trustStore = new TrustStore();
  if (options.trust) await trustStore.grant(root);
  const client = await connectWorkspaceService(root, logger);
  try {
    const capabilities = await client.api.listInspectors({ includeDisabled: true });
    const byId = new Map(capabilities.inspectors.map((item) => [item.id, item]));
    const requested = options.checks.length > 0
      ? [...new Set(options.checks)]
      : capabilities.inspectors.filter((item) => item.enabled).map((item) => item.id);
    if (requested.length === 0) throw new Error("No enabled checks are configured. Enable a check in .code-inspection.json.");
    const results: InspectionRun[] = [];
    for (const checkId of requested) {
      const capability = byId.get(checkId);
      if (!capability) throw new Error(`Unknown check "${checkId}". Run code-inspection capabilities to list configured checks.`);
      if (!capability.enabled) { logger.warn(`Check ${checkId} is disabled in .code-inspection.json`); continue; }
      const targets = await inspectionTargets(client.api, root, checkId, capability.scope, options);
      for (const target of targets) {
        const response = await client.api.runInspection({
          checkId,
          ...(options.language ? { language: options.language } : {}),
          ...(target.project ? { project: target.project } : {}),
          ...(target.files.length > 0 ? { scope: { files: target.files } } : {}),
          trigger: "cli"
        });
        results.push(await waitForRun(client.api, response.run.runId));
      }
    }
    process.stdout.write(`${options.json ? JSON.stringify(results, null, 2) : formatRuns(results)}\n`);
    if (results.some((run) => run.outcome === "failed")) return 2;
    if (results.some((run) => run.outcome === "cancelled" || run.outcome === "superseded")) return 3;
    return results.some((run) => (run.summary?.errorCount ?? 0) + (run.summary?.warningCount ?? 0) + (run.summary?.infoCount ?? 0) + (run.summary?.hintCount ?? 0) > 0) ? 1 : 0;
  } finally { client.close(); }
}

interface InspectionTarget {
  project?: string;
  files: string[];
}

/**
 * Keep a multi-project request from sending files from one project through
 * another project's toolchain. Project-scoped checks are grouped by the
 * locator result; an unmarked file is left for the service to classify and
 * report as missing configuration when appropriate.
 */
async function inspectionTargets(api: ServiceApi, workspace: string, checkId: string, scope: InspectorCapability["scope"], options: CliOptions): Promise<InspectionTarget[]> {
  if (options.project) return [{ project: options.project, files: [...options.files] }];
  if (options.files.length === 0 && scope === "project") {
    const projects = await api.listProjects({ checkId, ...(options.language ? { language: options.language } : {}) });
    const roots = [...new Set(projects.projects.map((project) => project.root))];
    return roots.length > 0 ? roots.map((project) => ({ project, files: [] })) : [{ files: [] }];
  }
  if (options.files.length === 0) return [{ files: [] }];
  const projects = await api.listProjects({ checkId, ...(options.language ? { language: options.language } : {}) });
  const grouped = new Map<string, string[]>();
  const unassigned: string[] = [];
  for (const file of options.files) {
    const absolute = resolve(workspace, file);
    const project = projects.projects
      .filter((candidate) => isWithin(candidate.root, absolute))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (!project) {
      unassigned.push(file);
      continue;
    }
    const files = grouped.get(project.root) ?? [];
    files.push(file);
    grouped.set(project.root, files);
  }
  const targets: InspectionTarget[] = [...grouped.entries()].map(([project, files]) => ({ project, files }));
  if (unassigned.length > 0 || targets.length === 0) targets.push({ files: unassigned.length > 0 ? unassigned : [...options.files] });
  return targets;
}

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && relation !== ".." && !isAbsolute(relation));
}

async function findingsCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try {
    const page = await queryFindings(client.api, options);
    process.stdout.write(`${options.json ? JSON.stringify(page, null, 2) : formatFindings(page.findings)}\n`);
  } finally { client.close(); }
}

async function capabilitiesCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try {
    const result = await client.api.listInspectors({ includeDisabled: true });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.inspectors.map(formatCapability).join("\n")}\n`);
  } finally { client.close(); }
}

async function projectsCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try {
    const result = await queryProjects(client.api, options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.projects.map((project) => `${project.root}\t${project.language}\t${project.marker ?? ""}`).join("\n")}\n`);
  } finally { client.close(); }
}

async function queryFindings(api: ServiceApi, options: CliOptions): Promise<FindingsPage> {
  const checks = [...new Set(options.checks)];
  const files = [...new Set(options.files)];
  // Preserve the service's native pagination for the common single-selector
  // case. The aggregation path below is only needed when a caller supplies
  // multiple check or file selectors.
  if (checks.length <= 1 && files.length <= 1) {
    const response = await api.getFindings({
      ...(checks[0] ? { checkId: checks[0] } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.project ? { project: options.project } : {}),
      ...(files[0] ? { file: files[0] } : {}),
      offset: options.offset,
      limit: options.limit,
      includeStale: options.includeStale
    });
    return response.page;
  }

  const checkSelectors: Array<string | undefined> = checks.length > 0 ? checks : [undefined];
  const fileSelectors: Array<string | undefined> = files.length > 0 ? files : [undefined];
  const collected: Finding[] = [];
  for (const checkId of checkSelectors) {
    for (const file of fileSelectors) {
      let offset = 0;
      for (;;) {
        const response = await api.getFindings({
          ...(checkId ? { checkId } : {}),
          ...(options.language ? { language: options.language } : {}),
          ...(options.project ? { project: options.project } : {}),
          ...(file ? { file } : {}),
          offset,
          limit: 500,
          includeStale: options.includeStale
        });
        collected.push(...response.page.findings);
        if (!response.page.hasMore) break;
        const next = response.page.nextOffset;
        if (next === undefined || next <= offset) throw new Error("Service returned an invalid findings page cursor.");
        offset = next;
      }
    }
  }
  const unique = new Map<string, Finding>();
  for (const finding of collected) unique.set(finding.id, finding);
  const sorted = [...unique.values()].sort(compareFindings);
  const pageFindings = sorted.slice(options.offset, options.offset + options.limit);
  return {
    total: sorted.length,
    count: pageFindings.length,
    offset: options.offset,
    findings: pageFindings,
    hasMore: options.offset + pageFindings.length < sorted.length,
    ...(options.offset + pageFindings.length < sorted.length ? { nextOffset: options.offset + pageFindings.length } : {})
  };
}

async function queryProjects(api: ServiceApi, options: CliOptions): Promise<Awaited<ReturnType<ServiceApi["listProjects"]>>> {
  const checks = [...new Set(options.checks)];
  if (checks.length <= 1) {
    return api.listProjects({
      ...(checks[0] ? { checkId: checks[0] } : {}),
      ...(options.language ? { language: options.language } : {})
    });
  }
  const responses = await Promise.all(checks.map((checkId) => api.listProjects({
    checkId,
    ...(options.language ? { language: options.language } : {})
  })));
  const unique = new Map<string, Awaited<ReturnType<ServiceApi["listProjects"]>>["projects"][number]>();
  for (const response of responses) {
    for (const project of response.projects) {
      const key = [project.root, project.language, project.marker ?? "", project.configuration ?? ""].join("|");
      unique.set(key, project);
    }
  }
  return {
    projects: [...unique.values()].sort((left, right) => left.root.localeCompare(right.root) || left.language.localeCompare(right.language))
  };
}

function compareFindings(left: Finding, right: Finding): number {
  return (left.file ?? "").localeCompare(right.file ?? "")
    || (left.range?.start.line ?? -1) - (right.range?.start.line ?? -1)
    || (left.range?.start.character ?? -1) - (right.range?.start.character ?? -1)
    || left.message.localeCompare(right.message)
    || left.id.localeCompare(right.id);
}

async function statusCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try { process.stdout.write(`${JSON.stringify(await client.api.getStatus(), null, 2)}\n`); }
  finally { client.close(); }
}

async function cancelCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  if (!options.runId) throw new Error("cancel requires --run-id <id>.");
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try { process.stdout.write(`${JSON.stringify((await client.api.cancelRun({ runId: options.runId })).run, null, 2)}\n`); }
  finally { client.close(); }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { workspace: process.cwd(), checks: [], files: [], json: false, trust: false, includeStale: false, offset: 0, limit: 500 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
      case "-w": options.workspace = requiredValue(args, ++index, arg); break;
      case "--check":
      case "-i": options.checks.push(...requiredValue(args, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean)); break;
      case "--file":
      case "-f": options.files.push(requiredValue(args, ++index, arg)); break;
      case "--language": options.language = requiredValue(args, ++index, arg) as LanguageId; break;
      case "--project": options.project = requiredValue(args, ++index, arg); break;
      case "--offset": options.offset = parseInteger(requiredValue(args, ++index, arg), arg, 0, 10_000_000); break;
      case "--limit": options.limit = parseInteger(requiredValue(args, ++index, arg), arg, 1, 500); break;
      case "--json": options.json = true; break;
      case "--trust": options.trust = true; break;
      case "--include-stale": options.includeStale = true; break;
      case "--run-id": options.runId = requiredValue(args, ++index, arg); break;
      default:
        if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        options.workspace = arg ?? options.workspace;
    }
  }
  return options;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseInteger(value: string, option: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} requires an integer between ${minimum} and ${maximum}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${option} requires an integer between ${minimum} and ${maximum}.`);
  return parsed;
}

async function waitForRun(api: ServiceApi, runId: string): Promise<InspectionRun> {
  for (;;) {
    const response = await api.getRun({ runId });
    if (["completed", "failed", "cancelled", "superseded"].includes(response.snapshot.run.outcome)) return response.snapshot.run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function formatRuns(runs: InspectionRun[]): string {
  return runs.map((run) => {
    const summary = run.summary;
    if (run.outcome === "failed") return `${run.checkId}: failed (${run.error?.code ?? "error"}) ${run.error?.message ?? ""}`;
    return `${run.checkId}: ${run.outcome}, ${summary?.errorCount ?? 0} error(s), ${summary?.warningCount ?? 0} warning(s) in ${summary?.durationMs ?? 0}ms`;
  }).join("\n");
}

function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings.map((finding) => {
    const location = finding.file ? `${finding.file}:${(finding.range?.start.line ?? 0) + 1}:${(finding.range?.start.character ?? 0) + 1}` : "workspace";
    return `${location} ${finding.severity} ${finding.code ? `[${finding.code}] ` : ""}${finding.message}${finding.stale ? " (stale)" : ""}`;
  }).join("\n");
}

function formatCapability(capability: InspectorCapability): string {
  const state = capability.enabled ? "enabled" : "disabled";
  const languages = capability.languages.length > 0 ? capability.languages.join(",") : "workspace";
  return `${capability.id}\t${state}\t${capability.displayName}\t${capability.scope}\t${languages}`;
}

function printHelp(): void {
  process.stdout.write(`code-inspection ${VERSION}\n\nUsage:\n  code-inspection init [--workspace <path>]\n  code-inspection trust [--workspace <path>]\n  code-inspection inspect [--workspace <path>] [--check <id>] [--language <id>] [--project <path>] [--file <path>] [--json] [--trust]\n  code-inspection findings [--workspace <path>] [--check <id>] [--language <id>] [--project <path>] [--file <path>] [--offset <n>] [--limit <n>] [--json] [--include-stale]\n  code-inspection capabilities [--workspace <path>] [--json]\n  code-inspection projects [--workspace <path>] [--check <id>] [--language <id>] [--json]\n  code-inspection status [--workspace <path>]\n  code-inspection cancel --run-id <id> [--workspace <path>]\n\n--check accepts any check ID configured in .code-inspection.json.\nExit codes for inspect: 0 clean, 1 findings, 2 execution failure, 3 cancelled or superseded.\n`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }

void main();
