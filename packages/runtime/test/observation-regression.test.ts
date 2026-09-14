import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  canonicalizeWorkspaceRoot, createFinding, fileUriForPath, InspectionEngine, noopLogger,
  TrustStore, type Finding, type InspectionOutput, type RunSnapshot
} from "@zakotoys/code-inspection-core";
import { startServiceOwner } from "../src/ipc.js";
import { WorkspaceService } from "../src/service.js";

const directories: string[] = [];
const services: WorkspaceService[] = [];
const releaseChecks: Array<() => void> = [];

afterEach(async () => {
  for (const release of releaseChecks.splice(0)) release();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function output(findings: Finding[] = [], truncated = false): InspectionOutput {
  return {
    findings,
    summary: { errorCount: findings.length, warningCount: 0, infoCount: 0, hintCount: 0, durationMs: 0, ...(truncated ? { truncated: true } : {}) }
  };
}

function finding(root: string, file = "a.js", message = "Unused variable"): Finding {
  return createFinding({
    checkId: "eslint", source: "eslint", severity: "error", message,
    file: fileUriForPath(join(root, file)), runId: "mock", generation: 0
  });
}

function heldOutput(result: InspectionOutput): Promise<InspectionOutput> {
  return new Promise((resolvePromise) => releaseChecks.push(() => resolvePromise(result)));
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspection-observations-"));
  directories.push(directory);
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"observation-tests","type":"module"}\n');
  await writeFile(join(project, ".code-inspection.json"), JSON.stringify({
    version: 2, debounceMs: 0,
    checks: { eslint: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file" } }
  }));
  await writeFile(join(project, "a.js"), "export const first = 1;\n");
  await writeFile(join(project, "b.js"), "export const second = 2;\n");
  const root = await canonicalizeWorkspaceRoot(project);
  const dataDirectory = join(directory, "state");
  const trustStore = new TrustStore(dataDirectory);
  await trustStore.grant(root);
  const engine = vi.spyOn(InspectionEngine.prototype, "run").mockResolvedValue(output());
  const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
  services.push(service);
  return { root, dataDirectory, service, engine };
}

async function waitForRun(service: WorkspaceService, runId: string): Promise<RunSnapshot> {
  await vi.waitFor(async () => {
    const { snapshot } = await service.getRun({ runId });
    expect(["completed", "failed", "cancelled", "superseded"]).toContain(snapshot.run.outcome);
  }, { timeout: 4000, interval: 10 });
  return (await service.getRun({ runId })).snapshot;
}

async function inspect(service: WorkspaceService, files = ["a.js"]): Promise<RunSnapshot> {
  const { run } = await service.runInspection({ checkId: "eslint", scope: { files }, trigger: "manual" });
  return waitForRun(service, run.runId);
}

describe("inspection observations", () => {
  it("reuses a running request only when its scope covers the new request", async () => {
    const { root, service, engine } = await fixture();
    engine.mockImplementationOnce(() => heldOutput(output([finding(root, "a.js", "old result")])));
    engine.mockResolvedValue(output([finding(root, "b.js")]));
    const first = await service.runInspection({ checkId: "eslint", scope: { files: ["a.js"] }, trigger: "manual" });
    await vi.waitFor(async () => expect((await service.getRun({ runId: first.run.runId })).snapshot.run.outcome).toBe("running"));
    const repeated = await service.runInspection({ checkId: "eslint", scope: { files: ["a.js"] }, trigger: "mcp" });
    expect(repeated.run.runId).toBe(first.run.runId);
    const second = await service.runInspection({ checkId: "eslint", scope: { files: ["b.js"] }, trigger: "mcp" });
    expect(second.run.runId).not.toBe(first.run.runId);
    expect(second.run.scope.files).toEqual(["a.js", "b.js"]);
    expect((await waitForRun(service, second.run.runId)).run.outcome).toBe("completed");
    expect((await service.getRun({ runId: first.run.runId })).snapshot.run.outcome).toBe("superseded");
    releaseChecks[0]!();
    await vi.waitFor(async () => expect((await service.getStatus()).runningCount).toBe(0));
    const { page } = await service.getFindings({ offset: 0, limit: 50, includeStale: false });
    expect(page.findings.map((entry) => entry.message)).toEqual(["Unused variable"]);
  });

  it("does not mistake an external edit just after saving for a duplicate save event", async () => {
    const { root, service, engine } = await fixture();
    engine.mockResolvedValue(output([finding(root)]));
    const saved = await service.didSave({ file: "a.js" });
    await waitForRun(service, saved.runs[0]!.runId);
    await writeFile(join(root, "a.js"), "export const first = 2;\n");
    await vi.waitFor(async () => {
      const { page } = await service.getFindings({ offset: 0, limit: 50, includeStale: true });
      expect(page.findings[0]?.stale).toBe(true);
    }, { timeout: 3000, interval: 10 });
  });

  it("ignores a repeated disk notification only when saved content is unchanged", async () => {
    const { root, service, engine } = await fixture();
    engine.mockImplementationOnce(() => heldOutput(output([finding(root)])));
    const saved = await service.didSave({ file: "a.js" });
    const runId = saved.runs[0]!.runId;
    await vi.waitFor(async () => expect((await service.getRun({ runId })).snapshot.run.outcome).toBe("running"));
    await utimes(join(root, "a.js"), new Date(), new Date());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect((await service.getRun({ runId })).snapshot.run.outcome).toBe("running");
    await writeFile(join(root, "a.js"), "export const first = 9;\n");
    await vi.waitFor(async () => expect((await service.getRun({ runId })).snapshot.run.outcome).toBe("superseded"));
  });

  it("reinitializes the baseline when the inspection configuration changes", async () => {
    const { root, dataDirectory, service, engine } = await fixture();
    engine.mockResolvedValue(output([finding(root)]));
    await inspect(service);
    await writeFile(join(root, ".code-inspection.json"), JSON.stringify({
      version: 2, debounceMs: 0,
      checks: { eslint: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file", timeoutMs: 5000 } }
    }));
    await vi.waitFor(async () => expect((await service.getFindings({ offset: 0, limit: 50, includeStale: true })).page.findings[0]?.stale).toBe(true));
    await new TrustStore(dataDirectory).grant(root);
    expect((await inspect(service)).changes).toMatchObject({ baseline: true, added: [], resolved: [] });
  });

  it("retains the baseline across failed and incomplete checks", async () => {
    const { root, service, engine } = await fixture();
    engine.mockResolvedValue(output([finding(root)]));
    const first = await inspect(service);
    expect(first.changes).toMatchObject({ baseline: true, added: [], resolved: [] });
    engine.mockRejectedValueOnce(new Error("tool failed"));
    const failed = await inspect(service);
    expect(failed.run.outcome).toBe("failed");
    expect(failed.changes).toBeUndefined();
    engine.mockResolvedValueOnce(output([], true));
    expect((await inspect(service)).changes).toBeUndefined();
    engine.mockResolvedValueOnce(output());
    const repaired = await inspect(service);
    expect(repaired.changes?.baseline).toBe(false);
    expect(repaired.changes?.resolved.map((entry) => entry.message)).toEqual(["Unused variable"]);
    expect((await service.getRun({ runId: first.run.runId })).snapshot.changes).toEqual(first.changes);
  });

  it("does not establish a baseline from results for a dirty document", async () => {
    const { root, service, engine } = await fixture();
    engine.mockResolvedValue(output([finding(root)]));
    await service.didChange({ file: "a.js" });
    const dirty = await inspect(service);
    expect(dirty.run.outcome).toBe("superseded");
    expect(dirty.changes).toBeUndefined();
    const saved = await service.didSave({ file: "a.js" });
    expect((await waitForRun(service, saved.runs[0]!.runId)).changes?.baseline).toBe(true);
  });

  it.each(["edited", "cancelled"])("does not advance the baseline when a running check is %s", async (reason) => {
    const { root, service, engine } = await fixture();
    engine.mockResolvedValue(output([finding(root)]));
    await inspect(service);
    engine.mockImplementationOnce(() => heldOutput(output()));
    const running = await service.runInspection({ checkId: "eslint", scope: { files: ["a.js"] }, trigger: "manual" });
    await vi.waitFor(async () => expect((await service.getRun({ runId: running.run.runId })).snapshot.run.outcome).toBe("running"));
    if (reason === "edited") await service.didChange({ file: "a.js" });
    else await service.cancelRun({ runId: running.run.runId });
    releaseChecks[0]!();
    await vi.waitFor(async () => expect((await service.getStatus()).runningCount).toBe(0));
    expect((await service.getRun({ runId: running.run.runId })).snapshot.changes).toBeUndefined();
    engine.mockResolvedValue(output());
    const saved = await service.didSave({ file: "a.js" });
    const repaired = await waitForRun(service, saved.runs[0]!.runId);
    expect(repaired.changes?.resolved).toHaveLength(1);
  });

  it("keeps other files' baselines when a partial inspection reports a repair", async () => {
    const { root, service, engine } = await fixture();
    engine.mockResolvedValueOnce(output([finding(root), finding(root, "b.js")]));
    await inspect(service, ["a.js", "b.js"]);
    engine.mockResolvedValueOnce(output());
    expect((await inspect(service)).changes?.resolved.map((entry) => entry.file)).toEqual([fileUriForPath(join(root, "a.js"))]);
    engine.mockResolvedValueOnce(output([finding(root, "b.js")]));
    expect((await inspect(service, ["b.js"])).changes).toMatchObject({ baseline: false, added: [], resolved: [] });
  });

  it.each(["change", "delete"])("forwards LSP %s events before a slow save check finishes", async (event) => {
    const { root, dataDirectory, service, engine } = await fixture();
    vi.stubEnv("CODE_INSPECTION_DATA_DIR", dataDirectory);
    const owner = await startServiceOwner(root, service, noopLogger, undefined, undefined);
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../dist/lsp.js")], {
      cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    const exited = once(child, "exit");
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    connection.listen();
    try {
      await connection.sendRequest("initialize", { processId: process.pid, rootUri: fileUriForPath(root), capabilities: {}, initializationOptions: { trusted: true } });
      await connection.sendNotification("initialized", {});
      const uri = fileUriForPath(join(root, "a.js"));
      await connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "javascript", version: 1, text: "export const first = 1;\n" } });
      engine.mockImplementationOnce(() => heldOutput(output([finding(root, "a.js", "obsolete result")])));
      await connection.sendNotification("textDocument/didSave", { textDocument: { uri } });
      await vi.waitFor(async () => expect((await service.getStatus()).activeRuns.some((run) => run.outcome === "running"), stderr).toBe(true));
      const runId = (await service.getStatus()).activeRuns[0]!.runId;
      if (event === "change") {
        await connection.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "export const first = 2;\n" }] });
      } else {
        await connection.sendNotification("workspace/didDeleteFiles", { files: [{ uri }] });
      }
      await vi.waitFor(async () => expect((await service.getRun({ runId })).snapshot.run.outcome).toBe("superseded"), { timeout: 1500, interval: 10 });
      releaseChecks[0]!();
      await vi.waitFor(async () => expect((await service.getStatus()).runningCount).toBe(0));
      expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.findings).toEqual([]);
      await connection.sendRequest("shutdown");
      await connection.sendNotification("exit");
    } finally {
      connection.dispose();
      child.kill();
      await exited;
      await owner.close();
    }
  }, 15_000);

  it("returns baseline changes through the MCP output contract", async () => {
    const { root, dataDirectory, service, engine } = await fixture();
    vi.stubEnv("CODE_INSPECTION_DATA_DIR", dataDirectory);
    const owner = await startServiceOwner(root, service, noopLogger, undefined, undefined);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dirname, "../dist/mcp.js")],
      cwd: root,
      env: { ...process.env, CODE_INSPECTION_DATA_DIR: dataDirectory } as Record<string, string>,
      stderr: "ignore"
    });
    const client = new Client({ name: "observation-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      engine.mockResolvedValue(output([finding(root)]));
      const first = await inspect(service);
      const baseline = await client.callTool({ name: "get_run", arguments: { workspace: root, run_id: first.run.runId } });
      expect(baseline.isError).not.toBe(true);
      expect(baseline.structuredContent?.changes).toMatchObject({ baseline: true, added: [], resolved: [] });
      engine.mockResolvedValue(output());
      const repaired = await inspect(service);
      const changes = await client.callTool({ name: "get_run", arguments: { workspace: root, run_id: repaired.run.runId } });
      expect(changes.isError).not.toBe(true);
      expect(changes.structuredContent?.changes).toMatchObject({ baseline: false, added: [], resolved: [{ message: "Unused variable" }] });
    } finally {
      await client.close();
      await transport.close();
      await owner.close();
    }
  }, 15_000);
});
