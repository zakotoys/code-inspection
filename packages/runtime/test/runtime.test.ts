import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TrustStore,
  WorkspaceTrustError,
  canonicalizeWorkspaceRoot,
  noopLogger,
  type InspectionRun
} from "@zakotoys/code-inspection-core";
import { WorkspaceService } from "../src/service.js";

const repoRoot = resolve(import.meta.dirname, "../../../");
const services: WorkspaceService[] = [];
const dataDirectories: string[] = [];

async function temporaryTrustStore(): Promise<TrustStore> {
  const directory = await mkdtemp(join(tmpdir(), "code-inspection-runtime-"));
  dataDirectories.push(directory);
  return new TrustStore(directory);
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(dataDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function serviceFor(fixture: string, trusted = true): Promise<WorkspaceService> {
  const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures", fixture));
  const trustStore = await temporaryTrustStore();
  if (trusted) await trustStore.grant(root);
  const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore });
  services.push(service);
  return service;
}

async function waitForRun(service: WorkspaceService, runId: string): Promise<InspectionRun> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await service.getRun({ runId });
    if (["completed", "failed", "cancelled", "superseded"].includes(result.snapshot.run.outcome)) return result.snapshot.run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

describe("workspace service", () => {
  it("reports unknown runs without creating state", async () => {
    const service = await serviceFor("eslint-clean");
    await expect(service.getRun({ runId: "missing" })).rejects.toThrow("Run not found");
    await expect(service.cancelRun({ runId: "missing" })).rejects.toThrow("Run not found");
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("rejects escaping and oversized scopes before scheduling", async () => {
    const service = await serviceFor("eslint-clean");
    for (const files of [["../eslint-broken/broken.js"], Array(101).fill("clean.js")]) {
      await expect(service.runInspection({ inspector: "eslint", scope: { files }, trigger: "save" })).rejects.toThrow();
    }
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("returns a failed run for a disabled inspector", async () => {
    const service = await serviceFor("eslint-clean");
    const { run } = await service.runInspection({ inspector: "build", trigger: "manual" });
    expect(run).toMatchObject({ outcome: "failed", error: { code: "inspector-disabled" } });
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("cancels a queued run idempotently without publishing findings", async () => {
    const service = await serviceFor("eslint-broken");
    const { run } = await service.runInspection({ inspector: "eslint", trigger: "save" });
    expect(run.outcome).toBe("queued");
    expect((await service.cancelRun({ runId: run.runId })).run.outcome).toBe("cancelled");
    expect((await service.cancelRun({ runId: run.runId })).run.outcome).toBe("cancelled");
    expect((await service.getStatus()).activeRuns).toEqual([]);
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: true })).page.total).toBe(0);
  });

  it("supersedes queued work when its document changes", async () => {
    const service = await serviceFor("eslint-broken");
    const { run } = await service.runInspection({ inspector: "eslint", trigger: "save" });
    await service.didChange({ file: "broken.js" });
    const { snapshot } = await service.getRun({ runId: run.runId });
    expect(snapshot.run.outcome).toBe("superseded");
    expect(snapshot.freshness.dirtyFiles).toEqual(["broken.js"]);
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("paginates and filters findings without duplicates or phantom next pages", async () => {
    const service = await serviceFor("eslint-broken");
    const { run } = await service.runInspection({ inspector: "eslint", trigger: "manual" });
    await waitForRun(service, run.runId);
    const first = (await service.getFindings({ offset: 0, limit: 2, includeStale: false, file: "broken.js" })).page;
    expect(first).toMatchObject({ total: 3, count: 2, hasMore: true, nextOffset: 2 });
    const last = (await service.getFindings({ offset: first.nextOffset!, limit: 2, includeStale: false })).page;
    expect(last).toMatchObject({ total: 3, count: 1, hasMore: false });
    expect(last.nextOffset).toBeUndefined();
    expect(new Set([...first.findings, ...last.findings].map((finding) => finding.id)).size).toBe(3);
    for (const filter of [{ offset: 3 }, { inspector: "build" as const }, { file: "absent.js" }]) {
      const { page } = await service.getFindings({ offset: 0, limit: 2, includeStale: false, ...filter });
      expect(page.count).toBe(0);
      expect(page.hasMore).toBe(false);
    }
    await service.didChange({ file: "broken.js" });
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(0);
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: true })).page.total).toBe(3);
  });

  it("requires explicit trust before execution", async () => {
    const service = await serviceFor("eslint-clean", false);
    await expect(service.runInspection({ inspector: "eslint", trigger: "manual" })).rejects.toBeInstanceOf(WorkspaceTrustError);
    await service.dispose();
  });

  it("coalesces queued requests and exposes the shared result set", async () => {
    const service = await serviceFor("eslint-broken");
    const [first, second] = await Promise.all([
      service.runInspection({ inspector: "eslint", trigger: "manual" }),
      service.runInspection({ inspector: "eslint", scope: { files: ["broken.js"] }, trigger: "manual" })
    ]);
    expect(second.run.runId).toBe(first.run.runId);
    const run = await waitForRun(service, first.run.runId);
    expect(run.outcome).toBe("completed");
    const findings = await service.getFindings({ offset: 0, limit: 50, includeStale: false });
    expect(findings.page.total).toBe(3);
    await service.dispose();
  });

  it("marks saved findings stale while dirty and replaces them after a successful save", async () => {
    const service = await serviceFor("eslint-broken");
    const initial = await service.runInspection({ inspector: "eslint", trigger: "manual" });
    await waitForRun(service, initial.run.runId);
    await service.didChange({ file: "broken.js" });
    const stale = await service.getFindings({ offset: 0, limit: 50, includeStale: true });
    expect(stale.page.findings.every((finding) => finding.stale === true)).toBe(true);
    const saved = await service.didSave({ file: "broken.js" });
    expect(saved.runs).toHaveLength(1);
    const completed = await waitForRun(service, saved.runs[0]!.runId);
    expect(completed.outcome).toBe("completed");
    const current = await service.getFindings({ offset: 0, limit: 50, includeStale: false });
    expect(current.page.findings.every((finding) => finding.stale !== true)).toBe(true);
    await service.dispose();
  });

  it("clears a resolved finding after the saved file is fixed", async () => {
    const rootPath = await mkdtemp(join(repoRoot, "tests/fixtures/save-workflow-"));
    await writeFile(join(rootPath, "package.json"), '{"name":"save-workflow","private":true,"type":"module"}\n', "utf8");
    await writeFile(join(rootPath, "eslint.config.js"), 'export default [{ files: ["**/*.js"], rules: { "no-unused-vars": "error" } }];\n', "utf8");
    await writeFile(join(rootPath, "broken.js"), "const unused = 1;\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 1, inspectors: { eslint: { enabled: true, cwd: ".", patterns: ["**/*.js"] } } }), "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    const trustStore = await temporaryTrustStore();
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore });
    try {
      const first = await service.runInspection({ inspector: "eslint", trigger: "manual" });
      await waitForRun(service, first.run.runId);
      expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(1);
      await writeFile(join(rootPath, "broken.js"), "const used = 1;\nconsole.log(used);\n", "utf8");
      const saved = await service.didSave({ file: "broken.js" });
      await waitForRun(service, saved.runs[0]!.runId);
      expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(0);
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("represents a failing build with an execution result and logs", async () => {
    const service = await serviceFor("build-failing");
    const started = await service.runInspection({ inspector: "build", trigger: "manual" });
    const run = await waitForRun(service, started.run.runId);
    expect(run.outcome).toBe("completed");
    expect(run.summary?.exitCode).toBe(4);
    expect(run.summary?.stderr).toContain("fixture build failed");
    await service.dispose();
  });
});
