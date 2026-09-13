#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalizeWorkspaceRoot,
  InspectionEngine,
  noopLogger,
  TrustStore
} from "../packages/core/dist/index.js";
import { WorkspaceService } from "../packages/runtime/dist/service.js";

const repositoryRoot = resolve(".");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(predicate, timeoutMs = 5_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForRun(service, runId, timeoutMs = 15_000) {
  let last;
  await waitUntil(async () => {
    last = (await service.getRun({ runId })).snapshot.run;
    return ["completed", "failed", "cancelled", "superseded"].includes(last.outcome);
  }, timeoutMs, `run ${runId} (last outcome: ${last?.outcome ?? "unknown"})`);
  return last;
}

function summary() {
  return { errorCount: 0, warningCount: 0, infoCount: 0, hintCount: 0, durationMs: 0 };
}

const parent = await mkdtemp(join(tmpdir(), "code-inspection-pressure-"));
const pressureRootPath = join(parent, "pressure workspace");
const pressureTrustPath = join(parent, "pressure trust");
let pressureService;
let originalRun;
let tracker;

try {
  await mkdir(pressureRootPath, { recursive: true });
  await writeFile(join(pressureRootPath, "package.json"), '{"name":"pressure-fixture","private":true,"type":"module"}\n', "utf8");
  await writeFile(join(pressureRootPath, "main.js"), "export const value = 1;\n", "utf8");

  const checks = {
    parallelA: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file", cwd: ".", patterns: ["**/*.js"] },
    parallelB: { adapter: "eslint", enabled: true, languages: ["javascript"], scope: "file", cwd: ".", patterns: ["**/*.js"] },
    buildA: { adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".", command: [process.execPath, "-e", "void 0"], parser: "build" },
    buildB: { adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".", command: [process.execPath, "-e", "void 0"], parser: "build" }
  };
  for (let index = 0; index < 106; index += 1) {
    checks[`queue-${String(index).padStart(3, "0")}`] = {
      adapter: "eslint",
      enabled: true,
      languages: ["javascript"],
      scope: "file",
      cwd: ".",
      patterns: ["**/*.js"]
    };
  }
  await writeFile(join(pressureRootPath, ".code-inspection.json"), `${JSON.stringify({ version: 2, checks }, null, 2)}\n`, "utf8");

  const root = await canonicalizeWorkspaceRoot(pressureRootPath);
  const trustStore = new TrustStore(pressureTrustPath);
  await trustStore.grant(root);
  tracker = {
    active: new Set(),
    starts: [],
    maximum: 0,
    buildActive: 0,
    maximumBuild: 0,
    aborted: 0
  };
  originalRun = InspectionEngine.prototype.run;
  InspectionEngine.prototype.run = async function mockedRun(request, signal) {
    const isBuild = request.checkId === "buildA" || request.checkId === "buildB";
    const durationMs = request.checkId.startsWith("queue-") ? 1_000 : 180;
    tracker.active.add(request.runId);
    tracker.starts.push(request);
    tracker.maximum = Math.max(tracker.maximum, tracker.active.size);
    if (isBuild) {
      tracker.buildActive += 1;
      tracker.maximumBuild = Math.max(tracker.maximumBuild, tracker.buildActive);
    }
    let timer;
    let settled = false;
    const finish = (aborted) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      tracker.active.delete(request.runId);
      if (isBuild) tracker.buildActive -= 1;
      if (aborted) tracker.aborted += 1;
      resolvePromise({ findings: [], summary: summary() });
    };
    let resolvePromise;
    const result = new Promise((resolveResult) => {
      resolvePromise = resolveResult;
      timer = setTimeout(() => finish(false), durationMs);
      timer.unref?.();
    });
    const onAbort = () => finish(true);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return result;
  };

  pressureService = await WorkspaceService.create(root, { logger: noopLogger, trustStore, useWorkers: false });

  // Two ungrouped checks should be able to use both global scheduler slots.
  const parallel = await Promise.all([
    pressureService.runInspection({ checkId: "parallelA", language: "javascript", scope: { files: ["main.js"] }, trigger: "manual" }),
    pressureService.runInspection({ checkId: "parallelB", language: "javascript", scope: { files: ["main.js"] }, trigger: "manual" })
  ]);
  await Promise.all(parallel.map(({ run }) => waitForRun(pressureService, run.runId)));
  assert(tracker.maximum === 2, `Expected the scheduler to use two global slots; observed ${tracker.maximum}.`);
  assert((await pressureService.getStatus()).runningCount === 0, "Parallel checks left a running slot occupied.");

  // Build checks share the registry's serialized build resource group even
  // though another global slot is available.
  const builds = await Promise.all([
    pressureService.runInspection({ checkId: "buildA", trigger: "manual" }),
    pressureService.runInspection({ checkId: "buildB", trigger: "manual" })
  ]);
  await waitUntil(async () => {
    const status = await pressureService.getStatus();
    return status.runningCount === 1 && status.queuedRuns >= 1;
  }, 5_000, "serialized build queue");
  assert(tracker.maximumBuild === 1, `Build resource group ran concurrently (${tracker.maximumBuild}).`);
  await Promise.all(builds.map(({ run }) => waitForRun(pressureService, run.runId)));

  // Hold two workers open, then submit more than the 100-entry queue limit.
  const queued = await Promise.all(Array.from({ length: 106 }, (_, index) => pressureService.runInspection({
    checkId: `queue-${String(index).padStart(3, "0")}`,
    language: "javascript",
    scope: { files: ["main.js"] },
    trigger: "manual"
  })));
  await waitUntil(async () => {
    const status = await pressureService.getStatus();
    return status.queuedRuns >= 99 && status.queuedRuns <= 100 && status.runningCount === 2;
  }, 5_000, "100-entry inspection queue");
  const queueStatuses = await Promise.all(queued.map(({ run }) => pressureService.getRun({ runId: run.runId })));
  const queueFull = queueStatuses.filter(({ snapshot }) => snapshot.run.error?.code === "queue-full");
  assert(queueFull.length >= 1, "Submitting more than 100 queued inspections did not produce queue-full.");
  assert((await pressureService.getStatus()).queuedRuns <= 100, "Inspection queue exceeded its configured limit.");
  assert(tracker.maximum <= 2, `Global scheduler concurrency exceeded two (${tracker.maximum}).`);

  const beforeDispose = await pressureService.getStatus();
  assert(beforeDispose.runningCount === 2 && beforeDispose.queuedRuns > 0, "Pressure fixture did not leave both running and queued work before dispose.");
  await pressureService.dispose();
  assert(tracker.active.size === 0, "Workspace dispose returned while an inspection was still active.");
  assert(tracker.aborted >= beforeDispose.runningCount, "Dispose did not abort all running inspections.");
  const residual = [...pressureService.runs.values()].filter((run) => run.outcome === "queued" || run.outcome === "running");
  assert(residual.length === 0, `Workspace dispose left ${residual.length} queued/running run records.`);
  pressureService = undefined;
  originalRun && (InspectionEngine.prototype.run = originalRun);

  // A crashed worker must not poison the next run for the same execution key.
  const recoveryRootPath = join(parent, "recovery workspace");
  const recoveryTrustPath = join(parent, "recovery trust");
  const crashWorkerPath = join(parent, "crash-worker.mjs");
  await mkdir(recoveryRootPath, { recursive: true });
  await writeFile(join(recoveryRootPath, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
    build: { adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".", command: [process.execPath, "-e", "void 0"], parser: "build" }
  } }) + "\n", "utf8");
  await writeFile(crashWorkerPath, "throw new Error('pressure worker crash');\n", "utf8");
  const recoveryRoot = await canonicalizeWorkspaceRoot(recoveryRootPath);
  const recoveryTrust = new TrustStore(recoveryTrustPath);
  await recoveryTrust.grant(recoveryRoot);
  const recoveryService = await WorkspaceService.create(recoveryRoot, { logger: noopLogger, trustStore: recoveryTrust, useWorkers: true });
  const previousWorker = process.env.CODE_INSPECTION_WORKER_PATH;
  try {
    process.env.CODE_INSPECTION_WORKER_PATH = crashWorkerPath;
    const crashed = await recoveryService.runInspection({ checkId: "build", trigger: "manual" });
    const failed = await waitForRun(recoveryService, crashed.run.runId);
    assert(failed.outcome === "failed" && failed.error?.code === "worker-failed", "Worker crash was not surfaced as worker-failed.");

    process.env.CODE_INSPECTION_WORKER_PATH = resolve(repositoryRoot, "packages/runtime/dist/inspection-worker.js");
    const recovered = await recoveryService.runInspection({ checkId: "build", trigger: "manual" });
    const completed = await waitForRun(recoveryService, recovered.run.runId);
    assert(completed.outcome === "completed", `Inspection did not recover after a worker crash (${completed.outcome}).`);
  } finally {
    if (previousWorker === undefined) delete process.env.CODE_INSPECTION_WORKER_PATH;
    else process.env.CODE_INSPECTION_WORKER_PATH = previousWorker;
    await recoveryService.dispose();
    await rm(recoveryRootPath, { recursive: true, force: true });
  }

  process.stdout.write("Pressure smoke passed: two-slot concurrency, serialized build resources, 100-entry queue cap, dispose cancellation, and worker recovery.\n");
} finally {
  if (pressureService) await pressureService.dispose().catch(() => undefined);
  if (originalRun) InspectionEngine.prototype.run = originalRun;
  await rm(parent, { recursive: true, force: true });
}
