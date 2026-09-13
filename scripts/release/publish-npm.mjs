import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { loadReleaseContext } from "./context.mjs";

const registry = "https://registry.npmjs.org";
const { values } = parseArgs({
  options: {
    version: { type: "string" },
    tag: { type: "string", default: "latest" },
    "dry-run": { type: "boolean", default: false }
  },
  strict: true
});
const context = await loadReleaseContext();
const version = values.version ?? context.version;
const npmTag = values.tag;

if (version !== context.version) throw new Error(`Requested version ${version} does not match manifest version ${context.version}.`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(npmTag)) throw new Error(`Invalid npm dist-tag: ${npmTag}`);

function integrity(contents) {
  return `sha512-${createHash("sha512").update(contents).digest("base64")}`;
}

async function registryIntegrity(name) {
  const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry lookup for ${name}@${version} failed with HTTP ${response.status}.`);
  const metadata = await response.json();
  if (typeof metadata.dist?.integrity !== "string") throw new Error(`Registry metadata for ${name}@${version} has no integrity.`);
  return metadata.dist.integrity;
}

async function runNpm(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env, windowsHide: true });
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`npm ${args[0]} failed with exit code ${code}.`);
}

async function verifyPublished(name, expectedIntegrity) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const publishedIntegrity = await registryIntegrity(name);
    if (publishedIntegrity === expectedIntegrity) return;
    if (publishedIntegrity && publishedIntegrity !== expectedIntegrity) throw new Error(`Published integrity mismatch for ${name}@${version}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`Timed out waiting for ${name}@${version} to become visible in the npm registry.`);
}

for (const packageInfo of [context.packages.core, context.packages.runtime]) {
  const details = await stat(packageInfo.tarball.absolute).catch(() => undefined);
  if (!details?.isFile() || details.size === 0) throw new Error(`Missing package artifact: ${packageInfo.tarball.absolute}`);
  const localIntegrity = integrity(await readFile(packageInfo.tarball.absolute));
  const publishedIntegrity = await registryIntegrity(packageInfo.name);
  if (publishedIntegrity) {
    if (publishedIntegrity !== localIntegrity) throw new Error(`Refusing to skip ${packageInfo.name}@${version}: registry and local tarball integrity differ.`);
    process.stdout.write(`Already published with matching integrity: ${packageInfo.name}@${version}\n`);
    continue;
  }

  const args = ["publish", packageInfo.tarball.absolute, "--access", "public", "--tag", npmTag, "--registry", registry];
  if (values["dry-run"]) {
    await runNpm([...args, "--dry-run", "--json"]);
    process.stdout.write(`Dry run passed: ${packageInfo.name}@${version}\n`);
    continue;
  }
  await runNpm([...args, "--provenance"]);
  await verifyPublished(packageInfo.name, localIntegrity);
  process.stdout.write(`Published and verified: ${packageInfo.name}@${version}\n`);
}

