import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadReleaseContext, repositoryRoot } from "./context.mjs";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    artifacts: { type: "boolean", default: false }
  },
  strict: true
});

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const repositoryUrl = "https://github.com/zakotoys/code-inspection.git";
const registryUrl = "https://registry.npmjs.org/";
const context = await loadReleaseContext();
const requestedVersion = values.version ?? context.version;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tomlString(source, section, key, path) {
  let currentSection = "";
  for (const line of source.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (currentSection !== section) continue;
    const valueMatch = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`));
    if (valueMatch) return valueMatch[1];
  }
  throw new Error(`Missing ${section ? `[${section}].` : ""}${key} in ${path}.`);
}

function assertPackageMetadata(manifest, directory) {
  assert(manifest.repository?.type === "git", `${manifest.name} must declare a git repository.`);
  assert(manifest.repository?.url === repositoryUrl, `${manifest.name} repository URL must be ${repositoryUrl}.`);
  assert(manifest.repository?.directory === directory, `${manifest.name} repository directory must be ${directory}.`);
  assert(manifest.homepage === "https://github.com/zakotoys/code-inspection#readme", `${manifest.name} has an invalid homepage.`);
  assert(manifest.bugs?.url === "https://github.com/zakotoys/code-inspection/issues", `${manifest.name} has an invalid bugs URL.`);
  assert(manifest.publishConfig?.access === "public", `${manifest.name} must publish with public access.`);
  assert(manifest.publishConfig?.registry === registryUrl, `${manifest.name} must publish to ${registryUrl}.`);
  assert(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, `${manifest.name} must declare npm keywords.`);
}

assert(semverPattern.test(requestedVersion), `Release version "${requestedVersion}" is not valid SemVer.`);
assert(requestedVersion === context.version, `Requested version ${requestedVersion} does not match root version ${context.version}.`);

const versions = [
  ["packages/core/package.json", context.manifests.core.version],
  ["packages/runtime/package.json", context.manifests.runtime.version],
  ["extensions/vscode/package.json", context.manifests.vscode.version]
];
for (const [path, version] of versions) assert(version === context.version, `${path} version ${version} does not match ${context.version}.`);
assert(context.manifests.root.private === true, "The monorepo root must remain private.");
assert(context.manifests.runtime.dependencies?.[context.packages.core.name] === context.version, "Runtime must depend on the exact release version of core.");
assertPackageMetadata(context.manifests.core, "packages/core");
assertPackageMetadata(context.manifests.runtime, "packages/runtime");

const [lock, extensionToml, cargoToml, cargoLock, runtimeVersionSource] = await Promise.all([
  readFile(join(repositoryRoot, "package-lock.json"), "utf8").then(JSON.parse),
  readFile(join(repositoryRoot, "extensions/zed/extension.toml"), "utf8"),
  readFile(join(repositoryRoot, "extensions/zed/Cargo.toml"), "utf8"),
  readFile(join(repositoryRoot, "extensions/zed/Cargo.lock"), "utf8"),
  readFile(join(repositoryRoot, "packages/runtime/src/version.ts"), "utf8")
]);

for (const path of ["", "packages/core", "packages/runtime", "extensions/vscode"]) {
  assert(lock.packages?.[path]?.version === context.version, `package-lock.json entry "${path || "."}" does not match ${context.version}.`);
}
assert(lock.packages?.["packages/runtime"]?.dependencies?.[context.packages.core.name] === context.version, "package-lock.json does not pin runtime to the release version of core.");
assert(tomlString(extensionToml, "", "version", "extensions/zed/extension.toml") === context.version, "Zed extension manifest version does not match.");
assert(tomlString(cargoToml, "package", "version", "extensions/zed/Cargo.toml") === context.version, "Zed Cargo manifest version does not match.");
const zedLockPackage = cargoLock.split("[[package]]").find((block) => /^\s*name = "code_inspection_zed"\s*$/m.test(block));
assert(zedLockPackage && tomlString(zedLockPackage, "", "version", "extensions/zed/Cargo.lock") === context.version, "Zed Cargo lock version does not match.");
assert(runtimeVersionSource.includes(`export const VERSION = "${context.version}" as const;`), "Runtime version constant does not match the release version.");

if (values.artifacts) {
  const distributables = [
    context.packages.core.tarball,
    context.packages.runtime.tarball,
    context.artifacts.vscode,
    context.artifacts.zed
  ];
  for (const artifact of distributables) {
    const details = await stat(artifact.absolute).catch(() => undefined);
    assert(details?.isFile() && details.size > 0, `Missing or empty release artifact: artifacts/${artifact.name}`);
  }
  const checksums = [];
  for (const artifact of [...distributables].sort((left, right) => left.name.localeCompare(right.name))) {
    const digest = createHash("sha256").update(await readFile(artifact.absolute)).digest("hex");
    checksums.push(`${digest}  ${artifact.name}`);
  }
  await writeFile(context.artifacts.checksums.absolute, `${checksums.join("\n")}\n`, "utf8");
  process.stdout.write(`Verified four release artifacts and wrote artifacts/${context.artifacts.checksums.name}.\n`);
}

process.stdout.write(`Release metadata verified for ${context.tag}.\n`);

