import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = resolve(repositoryRoot, "extensions/vscode");
const extensionManifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
const artifactsDirectory = join(repositoryRoot, "artifacts");
const stageRoot = await mkdtemp(join(tmpdir(), "code-inspection-vscode-"));
const stageNodeModules = join(stageRoot, "node_modules");
const copiedPackages = new Set();

async function copyPackage(name) {
  if (copiedPackages.has(name)) return;
  copiedPackages.add(name);
  const source = resolve(repositoryRoot, "node_modules", ...name.split("/"));
  const target = resolve(stageNodeModules, ...name.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });
  const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  for (const dependency of Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies })) {
    if (!dependency.startsWith("@types/")) await copyPackage(dependency);
  }
}

try {
  await cp(join(extensionRoot, "package.json"), join(stageRoot, "package.json"));
  await cp(join(extensionRoot, "dist"), join(stageRoot, "dist"), { recursive: true });
  await cp(join(extensionRoot, "server"), join(stageRoot, "server"), { recursive: true });
  await cp(join(repositoryRoot, "LICENSE"), join(stageRoot, "LICENSE.txt"));
  await cp(join(extensionRoot, ".vscodeignore"), join(stageRoot, ".vscodeignore"));
  await copyPackage("vscode-languageclient");
  await copyPackage("zod");
  await mkdir(artifactsDirectory, { recursive: true });
  const vsce = resolve(repositoryRoot, "node_modules/@vscode/vsce/vsce");
  const output = join(artifactsDirectory, `code-inspection-vscode-${extensionManifest.version}.vsix`);
  const exitCode = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [vsce, "package", "--out", output], { cwd: stageRoot, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
