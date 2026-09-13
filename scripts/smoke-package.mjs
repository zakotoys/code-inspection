import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const coreManifest = JSON.parse(await readFile(join(repositoryRoot, "packages/core/package.json"), "utf8"));
const runtimeManifest = JSON.parse(await readFile(join(repositoryRoot, "packages/runtime/package.json"), "utf8"));
const consumerRoot = await mkdtemp(join(tmpdir(), "code-inspection-consumer-"));
const workspace = join(consumerRoot, "fixture with spaces");
const dataDirectory = join(consumerRoot, "state");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cliCommand = process.platform === "win32" ? join(consumerRoot, "node_modules", ".bin", "code-inspection.cmd") : join(consumerRoot, "node_modules", ".bin", "code-inspection");

async function run(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const windowsScript = process.platform === "win32" && command.endsWith(".cmd");
    const child = spawn(windowsScript ? (process.env.ComSpec ?? "cmd.exe") : command, windowsScript ? ["/d", "/s", "/c", command, ...args] : args, { cwd: options.cwd ?? consumerRoot, env: options.env ?? process.env, stdio: options.stdio ?? "pipe", shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tarballName(manifest) {
  return `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
}

try {
  await cp(join(repositoryRoot, "tests/fixtures/eslint-broken"), workspace, { recursive: true });
  await writeFile(join(consumerRoot, "package.json"), '{"name":"code-inspection-consumer","private":true,"version":"1.0.0"}\n', "utf8");
  const coreTarball = join(repositoryRoot, "artifacts", tarballName(coreManifest));
  const runtimeTarball = join(repositoryRoot, "artifacts", tarballName(runtimeManifest));
  const install = await run(npmCommand, ["install", "--no-audit", "--no-fund", "--ignore-scripts", coreTarball, runtimeTarball, "eslint@10.10.0"]);
  assert(install.code === 0, `Consumer install failed: ${install.stderr}`);
  const installedCore = JSON.parse(await readFile(join(consumerRoot, "node_modules/@zakotoys/code-inspection-core/package.json"), "utf8"));
  const installedRuntime = JSON.parse(await readFile(join(consumerRoot, "node_modules/@zakotoys/code-inspection-runtime/package.json"), "utf8"));
  assert(installedCore.name === coreManifest.name && installedCore.version === coreManifest.version, "Installed core tarball has unexpected package metadata.");
  assert(installedRuntime.name === runtimeManifest.name && installedRuntime.version === runtimeManifest.version, "Installed runtime tarball has unexpected package metadata.");
  const version = await run(cliCommand, ["--version"]);
  assert(version.code === 0 && version.stdout.trim() === runtimeManifest.version, `Installed CLI reported an unexpected version: ${version.stdout || version.stderr}`);
  const env = { ...process.env, CODE_INSPECTION_DATA_DIR: dataDirectory, CODE_INSPECTION_IDLE_TIMEOUT_MS: "1000" };
  const trust = await run(cliCommand, ["trust", workspace], { env });
  assert(trust.code === 0, `Consumer trust failed: ${trust.stderr}`);
  const inspect = await run(cliCommand, ["inspect", "--workspace", workspace, "--check", "eslint", "--json"], { env });
  assert(inspect.code === 1, `Consumer inspect returned ${inspect.code}: ${inspect.stderr}`);
  const runs = JSON.parse(inspect.stdout);
  assert(runs[0]?.summary?.errorCount === 3, "Consumer inspection did not report three ESLint errors.");
  const findings = await run(cliCommand, ["findings", "--workspace", workspace, "--json"], { env });
  assert(findings.code === 0, `Consumer findings failed: ${findings.stderr}`);
  assert(JSON.parse(findings.stdout).total === 3, "Consumer findings did not expose the shared result set.");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1300));
  const instanceDirectory = join(dataDirectory, "instances");
  const remaining = await readdir(instanceDirectory).catch(() => []);
  assert(remaining.length === 0, `Consumer service did not become idle: ${remaining.join(", ")}`);
  process.stdout.write("Package smoke passed: clean install, trust, inspect, findings, spaces, and idle shutdown.\n");
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}
