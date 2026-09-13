#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalizeWorkspaceRoot,
  fileUriForPath,
  noopLogger,
  TrustStore
} from "../packages/core/dist/index.js";
import { connectWorkspaceService } from "../packages/runtime/dist/ipc.js";

const repositoryRoot = resolve(".");
const parent = await mkdtemp(join(tmpdir(), "code inspection 生命周期-"));
const workspacePath = join(parent, "workspace with spaces");
const stateDirectory = join(parent, "service state");
let client;
let childPids = new Set();

process.env.CODE_INSPECTION_DATA_DIR = stateDirectory;
process.env.CODE_INSPECTION_IDLE_TIMEOUT_MS = "200";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForRun(runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await client.api.getRun({ runId })).snapshot.run;
    if (["completed", "failed", "cancelled", "superseded"].includes(last.outcome)) return last;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${runId}; last outcome was ${last?.outcome ?? "unknown"}.`);
}

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (value) return Number(value);
    } catch {
      // The command has not started or has not written its marker yet.
    }
    await delay(25);
  }
  return undefined;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(50);
  }
  return !isProcessAlive(pid);
}

async function terminateProcess(pid) {
  if (!isProcessAlive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* The process may have exited already. */ }
  await waitForProcessExit(pid, 2_000);
}

async function waitForIdle() {
  const instances = join(stateDirectory, "instances");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const entries = await readdir(instances).catch(() => []);
    if (entries.length === 0) return;
    await delay(50);
  }
  const remaining = await readdir(instances).catch(() => []);
  throw new Error(`Workspace service did not clean up its discovery state: ${remaining.join(", ")}`);
}

try {
  await mkdir(workspacePath, { recursive: true });
  const root = await canonicalizeWorkspaceRoot(workspacePath);
  const sourceDirectory = join(root, "src");
  const targetDirectory = join(root, "target");
  const sourceFile = join(sourceDirectory, "非 ASCII file.js");
  const timeoutPidFile = join(targetDirectory, "timeout-child.pid");
  const cancelPidFile = join(targetDirectory, "cancel-child.pid");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"lifecycle-fixture","private":true}\n', "utf8");
  await writeFile(sourceFile, "export const value = 1;\n", "utf8");

  const emitCode = `process.stdout.write(${JSON.stringify(sourceFile)} + ":1:1: error: 生命周期诊断\\n")`;
  const treeCode = (pidFile) => [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)\"],{stdio:'ignore'});",
    `writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
    "setTimeout(()=>{},30000);"
  ].join("");
  const config = {
    version: 2,
    checks: {
      emit: {
        adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
        command: [process.execPath, "-e", emitCode], parser: "text", timeoutMs: 5_000
      },
      treeTimeout: {
        adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
        command: [process.execPath, "-e", treeCode(timeoutPidFile)], parser: "build", timeoutMs: 1_000
      },
      treeCancel: {
        adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
        command: [process.execPath, "-e", treeCode(cancelPidFile)], parser: "build", timeoutMs: 10_000
      }
    }
  };
  await writeFile(join(root, ".code-inspection.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const trustStore = new TrustStore(stateDirectory);
  await trustStore.grant(root);
  client = await connectWorkspaceService(root, noopLogger);

  const emitted = await client.api.runInspection({
    checkId: "emit",
    language: "javascript",
    scope: { files: ["src/非 ASCII file.js"] },
    trigger: "manual"
  });
  const emittedRun = await waitForRun(emitted.run.runId);
  assert(emittedRun.outcome === "completed", `Unicode path inspection ended as ${emittedRun.outcome}.`);
  assert(emittedRun.summary?.errorCount === 1, "Unicode path inspection did not produce one diagnostic.");
  const emittedFindings = await client.api.getFindings({ checkId: "emit", offset: 0, limit: 10, includeStale: false });
  assert(emittedFindings.page.total === 1, "Unicode path finding was not retained.");
  assert(emittedFindings.page.findings[0]?.file === fileUriForPath(sourceFile), "Finding URI was not normalized to the Unicode source path.");

  await unlink(timeoutPidFile).catch(() => undefined);
  const timeoutRequest = await client.api.runInspection({ checkId: "treeTimeout", trigger: "manual" });
  const timeoutPid = await waitForPath(timeoutPidFile);
  assert(timeoutPid !== undefined, "Timeout fixture did not start its child process.");
  childPids.add(timeoutPid);
  const timeoutRun = await waitForRun(timeoutRequest.run.runId);
  assert(timeoutRun.outcome === "failed" && timeoutRun.error?.code === "timeout", "Tool timeout was not reported distinctly.");
  assert(await waitForProcessExit(timeoutPid), "Timeout left a descendant process alive.");
  childPids.delete(timeoutPid);

  await unlink(cancelPidFile).catch(() => undefined);
  const cancelRequest = await client.api.runInspection({ checkId: "treeCancel", trigger: "manual" });
  const cancelPid = await waitForPath(cancelPidFile);
  assert(cancelPid !== undefined, "Cancellation fixture did not start its child process.");
  childPids.add(cancelPid);
  const cancelled = await client.api.cancelRun({ runId: cancelRequest.run.runId });
  assert(cancelled.run.outcome === "cancelled", "Cancellation did not transition the run immediately.");
  const cancelledRun = await waitForRun(cancelRequest.run.runId);
  assert(cancelledRun.outcome === "cancelled", `Cancellation ended as ${cancelledRun.outcome}.`);
  assert(await waitForProcessExit(cancelPid), "Cancellation left a descendant process alive.");
  childPids.delete(cancelPid);

  // A symlink that points outside the workspace must never become an
  // executable inspection scope. Symlink creation can require elevated rights
  // on Windows, so retain an explicit skip in environments that disallow it.
  const outsideFile = join(parent, "outside.js");
  const outsideLink = join(root, "outside-link.js");
  await writeFile(outsideFile, "export const outside = true;\n", "utf8");
  try {
    await symlink(outsideFile, outsideLink);
    await assertRejects(() => client.api.runInspection({ checkId: "emit", language: "javascript", scope: { files: ["outside-link.js"] }, trigger: "manual" }), "outside symlink scope");
  } catch (error) {
    if (!error || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    process.stdout.write("SKIP symlink escape check: symlink creation is unavailable on this host.\n");
  }

  client.close();
  client = undefined;
  await waitForIdle();
  process.stdout.write("Lifecycle smoke passed: Unicode/space paths, timeout, cancellation, descendant cleanup, symlink confinement, and idle shutdown.\n");
} finally {
  for (const pid of childPids) await terminateProcess(pid);
  try { client?.close(); } catch { /* Best-effort cleanup after a failed assertion. */ }
  await rm(parent, { recursive: true, force: true });
}

async function assertRejects(action, label) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`Expected ${label} to be rejected.`);
}
