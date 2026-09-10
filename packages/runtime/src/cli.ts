#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TrustStore,
  canonicalizeWorkspaceRoot,
  formatError,
  loadWorkspaceConfig,
  type InspectionRun,
  type InspectorId
} from "@zakotoys/code-inspection-core";
import { connectWorkspaceService } from "./ipc.js";
import { createStderrLogger } from "./logger.js";

const logger = createStderrLogger("cli");

interface CliOptions {
  workspace: string;
  inspectors: InspectorId[];
  files: string[];
  json: boolean;
  trust: boolean;
  includeStale: boolean;
  runId?: string;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case "trust":
        await trustCommand(args, false);
        return;
      case "revoke":
        await trustCommand(args, true);
        return;
      case "init":
        await initCommand(args);
        return;
      case "inspect":
        process.exitCode = await inspectCommand(args);
        return;
      case "findings":
        await findingsCommand(args);
        return;
      case "status":
        await statusCommand(args);
        return;
      case "cancel":
        await cancelCommand(args);
        return;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      case "--version":
      case "version":
        process.stdout.write("0.1.0\n");
        return;
      default:
        throw new Error(`Unknown command \"${command}\". Run code-inspection help for usage.`);
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
  if (revoke) await store.revoke(root);
  else await store.grant(root);
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
    if (isNodeError(error) && error.code === "ENOENT") {
      const config = {
        version: 1,
        debounceMs: 300,
        inspectors: {
          eslint: { enabled: true, cwd: ".", patterns: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"] },
          typescript: { enabled: false, cwd: ".", project: "tsconfig.json" },
          build: { enabled: false, cwd: ".", command: ["npm", "run", "build"], timeoutMs: 120000 }
        }
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      process.stdout.write(`Created ${configPath}\n`);
      return;
    }
    throw error;
  }
}

async function inspectCommand(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const trustStore = new TrustStore();
  if (options.trust) await trustStore.grant(root);
  const config = await loadWorkspaceConfig(root);
  const inspectors: InspectorId[] = options.inspectors.length > 0 ? options.inspectors : ["eslint"];
  const client = await connectWorkspaceService(root, logger);
  try {
    const results: InspectionRun[] = [];
    for (const inspector of inspectors) {
      if (!config.inspectors[inspector].enabled) {
        logger.warn(`Inspector ${inspector} is disabled in .code-inspection.json`);
        continue;
      }
      const response = await client.api.runInspection({
        inspector,
        ...(options.files.length > 0 ? { scope: { files: options.files } } : {}),
        trigger: "cli"
      });
      results.push(await waitForRun(client.api, response.run.runId));
    }
    const output = options.json ? JSON.stringify(results, null, 2) : formatRuns(results);
    process.stdout.write(`${output}\n`);
    if (results.some((run) => run.outcome === "failed")) return 2;
    if (results.some((run) => run.outcome === "cancelled" || run.outcome === "superseded")) return 3;
    return results.some((run) => {
      const summary = run.summary;
      return (summary?.errorCount ?? 0) + (summary?.warningCount ?? 0) + (summary?.infoCount ?? 0) + (summary?.hintCount ?? 0) > 0;
    }) ? 1 : 0;
  } finally {
    client.close();
  }
}

async function findingsCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try {
    const response = await client.api.getFindings({ offset: 0, limit: 500, includeStale: options.includeStale });
    process.stdout.write(`${options.json ? JSON.stringify(response.page, null, 2) : formatFindings(response.page.findings)}\n`);
  } finally {
    client.close();
  }
}

async function statusCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try {
    const status = await client.api.getStatus();
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } finally {
    client.close();
  }
}

async function cancelCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  if (!options.runId) throw new Error("cancel requires --run-id <id>.");
  const root = await canonicalizeWorkspaceRoot(options.workspace);
  const client = await connectWorkspaceService(root, logger);
  try {
    const response = await client.api.cancelRun({ runId: options.runId });
    process.stdout.write(`${JSON.stringify(response.run, null, 2)}\n`);
  } finally {
    client.close();
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { workspace: process.cwd(), inspectors: [], files: [], json: false, trust: false, includeStale: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
      case "-w":
        options.workspace = requiredValue(args, ++index, arg);
        break;
      case "--inspector":
      case "-i":
        options.inspectors.push(...requiredValue(args, ++index, arg).split(",").map(asInspector));
        break;
      case "--file":
      case "-f":
        options.files.push(requiredValue(args, ++index, arg));
        break;
      case "--json":
        options.json = true;
        break;
      case "--trust":
        options.trust = true;
        break;
      case "--include-stale":
        options.includeStale = true;
        break;
      case "--run-id":
        options.runId = requiredValue(args, ++index, arg);
        break;
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

function asInspector(value: string): InspectorId {
  if (value === "eslint" || value === "typescript" || value === "build") return value;
  throw new Error(`Unknown inspector \"${value}\". Use eslint, typescript, or build.`);
}

async function waitForRun(api: import("./protocol.js").ServiceApi, runId: string): Promise<InspectionRun> {
  for (;;) {
    const response = await api.getRun({ runId });
    if (["completed", "failed", "cancelled", "superseded"].includes(response.snapshot.run.outcome)) return response.snapshot.run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function formatRuns(runs: InspectionRun[]): string {
  return runs.map((run) => {
    const summary = run.summary;
    if (run.outcome === "failed") return `${run.inspector}: failed (${run.error?.code ?? "error"}) ${run.error?.message ?? ""}`;
    return `${run.inspector}: ${run.outcome}, ${summary?.errorCount ?? 0} error(s), ${summary?.warningCount ?? 0} warning(s) in ${summary?.durationMs ?? 0}ms`;
  }).join("\n");
}

function formatFindings(findings: import("@zakotoys/code-inspection-core").Finding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings.map((finding) => {
    const location = finding.file ? `${finding.file}:${(finding.range?.start.line ?? 0) + 1}:${(finding.range?.start.character ?? 0) + 1}` : "workspace";
    return `${location} ${finding.severity} ${finding.code ? `[${finding.code}] ` : ""}${finding.message}${finding.stale ? " (stale)" : ""}`;
  }).join("\n");
}

function printHelp(): void {
  process.stdout.write(`code-inspection 0.1.0

Usage:
  code-inspection init [--workspace <path>]
  code-inspection trust [--workspace <path>]
  code-inspection inspect [--workspace <path>] [--inspector eslint,typescript,build] [--file <path>] [--json] [--trust]
  code-inspection findings [--workspace <path>] [--json] [--include-stale]
  code-inspection status [--workspace <path>]
  code-inspection cancel --run-id <id> [--workspace <path>]

Exit codes for inspect: 0 clean, 1 findings, 2 execution failure, 3 cancelled or superseded.
`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

void main();
