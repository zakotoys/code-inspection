import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"));
}

function npmTarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export async function loadReleaseContext() {
  const [root, core, runtime, vscode] = await Promise.all([
    readJson("package.json"),
    readJson("packages/core/package.json"),
    readJson("packages/runtime/package.json"),
    readJson("extensions/vscode/package.json")
  ]);
  const version = root.version;
  const artifactsDirectory = resolve(repositoryRoot, "artifacts");
  const artifact = (name) => ({ name, absolute: join(artifactsDirectory, name) });
  return {
    version,
    tag: `v${version}`,
    manifests: { root, core, runtime, vscode },
    packages: {
      core: {
        name: core.name,
        manifest: core,
        tarball: artifact(npmTarballName(core.name, version))
      },
      runtime: {
        name: runtime.name,
        manifest: runtime,
        tarball: artifact(npmTarballName(runtime.name, version))
      }
    },
    artifacts: {
      directory: artifactsDirectory,
      vscode: artifact(`code-inspection-vscode-${version}.vsix`),
      zed: artifact(`code-inspection-zed-${version}.wasm`),
      checksums: artifact("SHA256SUMS")
    }
  };
}

