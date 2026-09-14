import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  InspectionEngine,
  TrustStore,
  WorkspaceTrustError,
  canonicalizeWorkspaceRoot,
  fileUriForPath,
  loadWorkspaceConfig,
  noopLogger,
  type InspectionRun
} from "@zakotoys/code-inspection-core";
import { WorkspaceService } from "../src/service.js";
import { runInspectionWorker } from "../src/worker-executor.js";
import { startServiceOwner } from "../src/ipc.js";
import {
  SERVICE_IDENTITY,
  SERVICE_PROTOCOL_VERSION,
  parseGetFindingsParams,
  parseGetStatusParams,
  parseRunInspectionParams,
  type ServiceApi
} from "../src/protocol.js";

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
  it("rejects malformed v2 requests at the protocol boundary", () => {
    expect(() => parseRunInspectionParams({ inspector: "eslint", trigger: "manual" })).toThrow("Invalid runInspection request");
    expect(() => parseRunInspectionParams({ checkId: "eslint", trigger: "manual", language: "kotlin" })).toThrow("language");
    expect(() => parseRunInspectionParams({ checkId: "eslint", trigger: "manual", scope: { files: Array(101).fill("main.js") } })).toThrow("100");
    expect(() => parseGetFindingsParams({ offset: -1, limit: 1, includeStale: false })).toThrow("offset");
    expect(() => parseGetFindingsParams({ offset: 0, limit: 501, includeStale: false })).toThrow("limit");
    expect(() => parseGetFindingsParams({ offset: 0, limit: 1, includeStale: false, projectRoot: "." })).toThrow("Unrecognized");
    expect(() => parseGetStatusParams(null)).toThrow("parameters are not supported");
    expect(parseGetFindingsParams({})).toMatchObject({ offset: 0, limit: 50, includeStale: false });
  });

  it("reports unknown runs without creating state", async () => {
    const service = await serviceFor("eslint-clean");
    await expect(service.getRun({ runId: "missing" })).rejects.toThrow("Run not found");
    await expect(service.cancelRun({ runId: "missing" })).rejects.toThrow("Run not found");
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("rejects escaping and oversized scopes before scheduling", async () => {
    const service = await serviceFor("eslint-clean");
    for (const files of [["../eslint-broken/broken.js"], Array(101).fill("clean.js")]) {
      await expect(service.runInspection({ checkId: "eslint", scope: { files }, trigger: "save" })).rejects.toThrow();
    }
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("returns a failed run for a disabled inspector", async () => {
    const service = await serviceFor("eslint-clean");
    const { run } = await service.runInspection({ checkId: "build", trigger: "manual" });
    expect(run).toMatchObject({ outcome: "failed", error: { code: "inspector-disabled" } });
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("cancels a queued run idempotently without publishing findings", async () => {
    const service = await serviceFor("eslint-broken");
    const { run } = await service.runInspection({ checkId: "eslint", trigger: "save" });
    expect(run.outcome).toBe("queued");
    expect((await service.cancelRun({ runId: run.runId })).run.outcome).toBe("cancelled");
    expect((await service.cancelRun({ runId: run.runId })).run.outcome).toBe("cancelled");
    expect((await service.getStatus()).activeRuns).toEqual([]);
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: true })).page.total).toBe(0);
  });

  it("supersedes queued work when its document changes", async () => {
    const service = await serviceFor("eslint-broken");
    const { run } = await service.runInspection({ checkId: "eslint", trigger: "save" });
    await service.didChange({ file: "broken.js" });
    const { snapshot } = await service.getRun({ runId: run.runId });
    expect(snapshot.run.outcome).toBe("superseded");
    expect(snapshot.freshness.dirtyFiles).toEqual(["broken.js"]);
    expect((await service.getStatus()).activeRuns).toEqual([]);
  });

  it("paginates and filters findings without duplicates or phantom next pages", async () => {
    const service = await serviceFor("eslint-broken");
    const { run } = await service.runInspection({ checkId: "eslint", trigger: "manual" });
    await waitForRun(service, run.runId);
    const first = (await service.getFindings({ offset: 0, limit: 2, includeStale: false, file: "broken.js" })).page;
    expect(first).toMatchObject({ total: 3, count: 2, hasMore: true, nextOffset: 2 });
    const last = (await service.getFindings({ offset: first.nextOffset!, limit: 2, includeStale: false })).page;
    expect(last).toMatchObject({ total: 3, count: 1, hasMore: false });
    expect(last.nextOffset).toBeUndefined();
    expect(new Set([...first.findings, ...last.findings].map((finding) => finding.id)).size).toBe(3);
    for (const filter of [{ offset: 3 }, { checkId: "build" as const }, { file: "absent.js" }]) {
      const { page } = await service.getFindings({ offset: 0, limit: 2, includeStale: false, ...filter });
      expect(page.count).toBe(0);
      expect(page.hasMore).toBe(false);
    }
    await service.didChange({ file: "broken.js" });
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(0);
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: true })).page.total).toBe(3);
    await expect(service.getFindings({ checkId: "missing-check", offset: 0, limit: 1, includeStale: false })).rejects.toThrow("Unknown configured check");
  });

  it("filters latest runs with the same check and language selectors as findings", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-findings-runs-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, "package.json"), '{"name":"findings-runs","private":true}\n', "utf8");
    await writeFile(join(rootPath, "pyproject.toml"), "[project]\nname='findings-runs'\nversion='0.0.0'\n", "utf8");
    await writeFile(join(rootPath, "main.js"), "export const value = 1;\n", "utf8");
    await writeFile(join(rootPath, "main.py"), "value = 1\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      eslint: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file", cwd: "." },
      ruff: { adapter: "ruff", enabled: true, languages: ["python"], scope: "file", cwd: "." }
    } }) + "\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const engine = vi.spyOn(InspectionEngine.prototype, "run").mockImplementation(async (request) => ({
      findings: [{
        id: request.checkId,
        checkId: request.checkId,
        source: request.checkId,
        language: request.language,
        severity: "warning",
        message: request.checkId,
        runId: request.runId,
        generation: request.generation
      }],
      summary: { errorCount: 0, warningCount: 1, infoCount: 0, hintCount: 0, durationMs: 0 }
    }));
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const eslint = await service.runInspection({ checkId: "eslint", language: "javascript", scope: { files: ["main.js"] }, trigger: "manual" });
      const ruff = await service.runInspection({ checkId: "ruff", language: "python", scope: { files: ["main.py"] }, trigger: "manual" });
      await Promise.all([waitForRun(service, eslint.run.runId), waitForRun(service, ruff.run.runId)]);
      const filtered = await service.getFindings({ checkId: "eslint", language: "javascript", offset: 0, limit: 50, includeStale: false });
      expect(filtered.page.findings).toHaveLength(1);
      expect(filtered.runs).toHaveLength(1);
      expect(filtered.runs[0]).toMatchObject({ runId: eslint.run.runId, checkId: "eslint", language: "javascript" });
    } finally {
      engine.mockRestore();
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("requires explicit trust before execution", async () => {
    const service = await serviceFor("eslint-clean", false);
    await expect(service.runInspection({ checkId: "eslint", trigger: "manual" })).rejects.toBeInstanceOf(WorkspaceTrustError);
    await service.dispose();
  });

  it("rejects new service requests after disposal", async () => {
    const service = await serviceFor("eslint-clean");
    await service.dispose();
    await expect(service.runInspection({ checkId: "eslint", trigger: "manual" })).rejects.toMatchObject({ code: "service-disposed" });
    await expect(service.didSave({ file: "clean.js" })).rejects.toMatchObject({ code: "service-disposed" });
    await expect(service.getStatus()).rejects.toMatchObject({ code: "service-disposed" });
  });

  it("does not queue a request that was disposed while awaiting trust", async () => {
    const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures/eslint-clean"));
    const trustStore = await temporaryTrustStore();
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    let trustCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const originalRequireTrusted = trustStore.requireTrusted.bind(trustStore);
    vi.spyOn(trustStore, "requireTrusted").mockImplementation(async (workspaceRoot) => {
      trustCalls += 1;
      if (trustCalls === 2) await gate;
      return originalRequireTrusted(workspaceRoot);
    });
    const pending = service.runInspection({ checkId: "eslint", trigger: "manual" });
    await expect.poll(() => trustCalls).toBe(2);
    await service.dispose();
    release();
    await expect(pending).rejects.toMatchObject({ code: "service-disposed" });
  });

  it("does not start a worker payload for a pre-cancelled request", async () => {
    const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures/eslint-clean"));
    const config = await loadWorkspaceConfig(root);
    const controller = new AbortController();
    controller.abort();
    const previousWorker = process.env.CODE_INSPECTION_WORKER_PATH;
    process.env.CODE_INSPECTION_WORKER_PATH = join(repoRoot, "packages/runtime/dist/inspection-worker.js");
    try {
      await expect(runInspectionWorker({
        root,
        config,
        request: { runId: "pre-cancelled", checkId: "eslint", language: "javascript", projectRoot: root, scope: {}, trigger: "manual", generation: 0 },
        timeoutMs: 1000,
        signal: controller.signal,
        logger: noopLogger
      })).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      if (previousWorker === undefined) delete process.env.CODE_INSPECTION_WORKER_PATH;
      else process.env.CODE_INSPECTION_WORKER_PATH = previousWorker;
    }
  });

  it("coalesces queued requests and exposes the shared result set", async () => {
    const service = await serviceFor("eslint-broken");
    const [first, second] = await Promise.all([
      service.runInspection({ checkId: "eslint", trigger: "save" }),
      service.runInspection({ checkId: "eslint", scope: { files: ["broken.js"] }, trigger: "save" })
    ]);
    expect(first.run.outcome).toBe("queued");
    expect(second.run.outcome).toBe("queued");
    expect(second.run.runId).toBe(first.run.runId);
    const run = await waitForRun(service, first.run.runId);
    expect(run.outcome).toBe("completed");
    const findings = await service.getFindings({ offset: 0, limit: 50, includeStale: false });
    expect(findings.page.total).toBe(3);
    await service.dispose();
  });

  it("marks saved findings stale while dirty and replaces them after a successful save", async () => {
    const service = await serviceFor("eslint-broken");
    const initial = await service.runInspection({ checkId: "eslint", trigger: "manual" });
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
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: { eslint: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file", cwd: ".", patterns: ["**/*.js"] } } }), "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    const trustStore = await temporaryTrustStore();
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore });
    try {
      const first = await service.runInspection({ checkId: "eslint", trigger: "manual" });
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

  it("removes findings when a file is deleted", async () => {
    const service = await serviceFor("eslint-broken");
    const started = await service.runInspection({ checkId: "eslint", trigger: "manual" });
    await waitForRun(service, started.run.runId);
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(3);
    await service.didDelete({ file: "broken.js" });
    expect((await service.getFindings({ offset: 0, limit: 50, includeStale: true })).page.total).toBe(0);
  });

  it("represents a failing build with an execution result and logs", async () => {
    const service = await serviceFor("build-failing");
    const started = await service.runInspection({ checkId: "build", trigger: "manual" });
    const run = await waitForRun(service, started.run.runId);
    expect(run.outcome).toBe("completed");
    expect(run.summary?.exitCode).toBe(4);
    expect(run.summary?.stderr).toContain("fixture build failed");
    await service.dispose();
  });

  it("keeps a failed execution visible as the latest run", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-failed-run-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      missing: {
        adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
        command: ["code-inspection-command-that-does-not-exist"], parser: "build"
      }
    } }) + "\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const started = await service.runInspection({ checkId: "missing", trigger: "manual" });
      const run = await waitForRun(service, started.run.runId);
      expect(run).toMatchObject({ outcome: "failed", error: { code: "missing-tool" } });
      expect((await service.getStatus()).latestRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: run.runId, outcome: "failed" })
      ]));
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("recovers after an inspection worker crashes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-worker-recovery-"));
    const trustStore = await temporaryTrustStore();
    const crashWorker = join(rootPath, "crash-worker.mjs");
    await writeFile(crashWorker, "throw new Error('worker crash fixture');\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      build: { adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".", command: [process.execPath, "-e", "process.stdout.write('worker recovery ok')"], parser: "build" }
    } }) + "\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const previousWorker = process.env.CODE_INSPECTION_WORKER_PATH;
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: true });
    services.push(service);
    try {
      process.env.CODE_INSPECTION_WORKER_PATH = crashWorker;
      const crashed = await service.runInspection({ checkId: "build", trigger: "manual" });
      const failed = await waitForRun(service, crashed.run.runId);
      expect(failed).toMatchObject({ outcome: "failed", error: { code: "worker-failed" } });

      process.env.CODE_INSPECTION_WORKER_PATH = join(repoRoot, "packages/runtime/dist/inspection-worker.js");
      const recovered = await service.runInspection({ checkId: "build", trigger: "manual" });
      const completed = await waitForRun(service, recovered.run.runId);
      expect(completed.outcome).toBe("completed");
    } finally {
      if (previousWorker === undefined) delete process.env.CODE_INSPECTION_WORKER_PATH;
      else process.env.CODE_INSPECTION_WORKER_PATH = previousWorker;
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("does not supersede a run when its tool creates an ignored build directory", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-generated-directory-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, "package.json"), '{"name":"generated-directory-test","private":true}\n', "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      build: {
        adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
        command: [process.execPath, "-e", "const fs = require('node:fs'); fs.mkdirSync('targetAb3Xy9'); fs.renameSync('targetAb3Xy9', 'target'); setTimeout(() => {}, 300)"],
        parser: "build", timeoutMs: 2000
      }
    } }), "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const started = await service.runInspection({ checkId: "build", trigger: "manual" });
      expect((await waitForRun(service, started.run.runId)).outcome).toBe("completed");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      expect((await service.getRun({ runId: started.run.runId })).snapshot.run.outcome).toBe("completed");
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("discovers dynamic checks and filters save triggers by language", async () => {
    const python = await serviceFor("python-broken");
    const capabilities = await python.listInspectors({ includeDisabled: true });
    expect(capabilities.inspectors.map((item) => item.id)).toEqual(["ruff", "pyright"]);
    expect(capabilities.languages.map((item) => item.id)).toContain("cpp");
    const runs = await python.didSave({ file: "broken.py" });
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ checkId: "ruff", language: "python" });
    await python.dispose();
  });

  it("lists detected nested projects for a configured check", async () => {
    const python = await serviceFor("python-broken");
    const result = await python.listProjects({ checkId: "ruff" });
    expect(result.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: "python", marker: "pyproject.toml" })
    ]));
  });

  it("deduplicates one project root when a check covers multiple languages", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-project-dedupe-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, "package.json"), '{"name":"dedupe","private":true}\n', "utf8");
    await writeFile(join(rootPath, "tsconfig.json"), '{"compilerOptions":{}}\n', "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      typescript: { adapter: "typescript", enabled: true, languages: ["javascript", "typescript"], scope: "project", cwd: ".", project: "tsconfig.json" }
    } }), "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const result = await service.listProjects({ checkId: "typescript" });
      const roots = result.projects.map((project) => project.root);
      expect(roots.filter((projectRoot) => projectRoot === root)).toHaveLength(1);
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("retains C and C++ capabilities when they share a project root", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-c-cpp-projects-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(shared LANGUAGES C CXX)\n", "utf8");
    await writeFile(join(rootPath, "main.c"), "int main(void) { return 0; }\n", "utf8");
    await writeFile(join(rootPath, "main.cpp"), "int main() { return 0; }\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      clang: { adapter: "clang-build", enabled: true, languages: ["c", "cpp"], scope: "project", cwd: ".", command: [process.execPath, "-e", "process.stdout.write('[]')"], parser: "clang-json" }
    } }) + "\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const result = await service.listProjects({ checkId: "clang" });
      expect(result.projects.filter((project) => project.root === root).map((project) => project.language).sort()).toEqual(["c", "cpp"]);
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("anchors native project adapters to the discovered nested project", async () => {
    const rootPath = await mkdtemp(join(repoRoot, "tests/fixtures/nested-project-"));
    const nestedPath = join(rootPath, "packages", "nested");
    const trustStore = await temporaryTrustStore();
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(rootPath, "package.json"), '{"name":"nested-workspace","private":true}\n', "utf8");
    // The workspace project intentionally contains no source files. A buggy
    // adapter that ignores request.projectRoot therefore reports no finding.
    await writeFile(join(rootPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, files: [] }) + "\n", "utf8");
    await writeFile(join(nestedPath, "package.json"), '{"name":"nested-package","private":true}\n', "utf8");
    await writeFile(join(nestedPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["main.ts"] }) + "\n", "utf8");
    await writeFile(join(nestedPath, "main.ts"), 'const value: number = "bad";\n', "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      typescript: { adapter: "typescript", enabled: true, languages: ["typescript"], scope: "project", cwd: ".", project: "tsconfig.json" }
    } }) + "\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const started = await service.runInspection({ checkId: "typescript", scope: { files: ["packages/nested/main.ts"] }, trigger: "manual" });
      const run = await waitForRun(service, started.run.runId);
      expect(run.outcome).toBe("completed");
      expect(run.summary?.errorCount).toBeGreaterThan(0);
      const findings = await service.getFindings({ checkId: "typescript", offset: 0, limit: 50, includeStale: false });
      expect(findings.page.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ file: fileUriForPath(join(nestedPath, "main.ts")), projectRoot: nestedPath })
      ]));
      const byConfig = await service.getFindings({ checkId: "typescript", project: "packages/nested/tsconfig.json", offset: 0, limit: 50, includeStale: false });
      expect(byConfig.page.findings).toHaveLength(findings.page.findings.length);
      expect(byConfig.runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectRoot: nestedPath })
      ]));
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects a project-scoped request that spans nested projects", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-cross-project-"));
    const trustStore = await temporaryTrustStore();
    const nestedPath = join(rootPath, "packages", "nested");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(rootPath, "package.json"), '{"name":"cross-project","private":true}\n', "utf8");
    await writeFile(join(rootPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, include: ["root.ts"] }) + "\n", "utf8");
    await writeFile(join(rootPath, "root.ts"), "const rootValue: number = 1;\n", "utf8");
    await writeFile(join(nestedPath, "package.json"), '{"name":"nested","private":true}\n', "utf8");
    await writeFile(join(nestedPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, include: ["main.ts"] }) + "\n", "utf8");
    await writeFile(join(nestedPath, "main.ts"), "const nestedValue: number = 1;\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      typescript: { adapter: "typescript", enabled: true, languages: ["typescript"], scope: "project", cwd: "." }
    } }) + "\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      await expect(service.runInspection({
        checkId: "typescript",
        scope: { files: ["root.ts", "packages/nested/main.ts"] },
        trigger: "manual"
      })).rejects.toThrow("different projects");
      expect((await service.getStatus()).activeRuns).toEqual([]);
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("invalidates a project generation when a new file changes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-generation-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, "package.json"), '{"name":"generation-test","private":true}\n', "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      build: {
        adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
        command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], parser: "build", timeoutMs: 5000
      }
    } }), "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const started = await service.runInspection({ checkId: "build", trigger: "manual" });
      await writeFile(join(rootPath, "new.js"), "export const value = 1;\n", "utf8");
      await service.didChange({ file: "new.js" });
      expect((await service.getRun({ runId: started.run.runId })).snapshot.run.outcome).toBe("superseded");
      expect((await service.getStatus()).generation).toBeGreaterThan(0);
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps global inspection concurrency within the scheduler limit", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "code-inspection-scheduler-"));
    const trustStore = await temporaryTrustStore();
    await writeFile(join(rootPath, "package.json"), '{"name":"scheduler-test","private":true,"type":"module"}\n', "utf8");
    await writeFile(join(rootPath, "pyproject.toml"), "[project]\nname='scheduler-test'\nversion='0.0.0'\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      eslint: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file", cwd: ".", patterns: ["**/*.js"] },
      ruff: { adapter: "ruff", enabled: true, languages: ["python"], scope: "file", cwd: "." }
    } }), "utf8");
    await writeFile(join(rootPath, "main.js"), "export const value = 1;\n", "utf8");
    await writeFile(join(rootPath, "main.py"), "value = 1\n", "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    await trustStore.grant(root);
    const activeRuns = new Set<string>();
    let maximum = 0;
    const original = vi.spyOn(InspectionEngine.prototype, "run").mockImplementation(async (request) => {
      activeRuns.add(request.checkId);
      maximum = Math.max(maximum, activeRuns.size);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      activeRuns.delete(request.checkId);
      return { findings: [], summary: { errorCount: 0, warningCount: 0, infoCount: 0, hintCount: 0, durationMs: 0 } };
    });
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });
    services.push(service);
    try {
      const [eslint, ruff] = await Promise.all([
        service.runInspection({ checkId: "eslint", scope: { files: ["main.js"] }, trigger: "manual" }),
        service.runInspection({ checkId: "ruff", scope: { files: ["main.py"] }, trigger: "manual" })
      ]);
      await Promise.all([waitForRun(service, eslint.run.runId), waitForRun(service, ruff.run.runId)]);
      expect(maximum).toBeLessThanOrEqual(2);
      expect((await service.getStatus()).runningCount).toBe(0);
    } finally {
      original.mockRestore();
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps a newly spawned owner alive until its first handshake", async () => {
    const root = await canonicalizeWorkspaceRoot(await mkdtemp(join(tmpdir(), "code-inspection-owner-grace-")));
    let idleCalls = 0;
    let owner: Awaited<ReturnType<typeof startServiceOwner>> | undefined;
    const api = {
      getStatus: async () => ({
        root,
        trusted: true,
        activeRuns: [],
        latestRuns: [],
        findingCount: 0,
        queuedRuns: 0,
        runningCount: 0,
        maxConcurrentRuns: 2,
        queueLimit: 100,
        generation: 0
      })
    } as unknown as ServiceApi;
    try {
      owner = await startServiceOwner(root, api, noopLogger, undefined, "owner-grace-test", {
        idleTimeoutMs: 1,
        onIdle: async () => {
          idleCalls += 1;
          await owner?.close();
        }
      });
      await delay(25);
      expect(idleCalls).toBe(0);
      const socket = await new Promise<import("node:net").Socket>((resolveSocket, rejectSocket) => {
        const client = connect(owner!.endpoint);
        client.once("connect", () => resolveSocket(client));
        client.once("error", rejectSocket);
      });
      const connection = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
      connection.listen();
      const handshake = await connection.sendRequest("initialize", {
        root,
        secret: "owner-grace-test",
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        identity: SERVICE_IDENTITY
      });
      expect(handshake).toMatchObject({ root, protocolVersion: SERVICE_PROTOCOL_VERSION, identity: SERVICE_IDENTITY });
      await expect(connection.sendRequest("getStatus")).resolves.toMatchObject({ root, activeRuns: [] });
      connection.dispose();
      socket.destroy();
      await owner.close();
      owner = undefined;
      await delay(25);
      expect(idleCalls).toBe(0);
    } finally {
      await owner?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
