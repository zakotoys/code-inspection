import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const artifactsDirectory = join(repositoryRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const args = ["build", "--locked", "--target", "wasm32-wasip2", "--release", "--manifest-path", join(repositoryRoot, "extensions/zed/Cargo.toml")];
const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn("cargo", args, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("close", (code) => resolvePromise(code ?? 1));
});
if (exitCode !== 0) process.exit(exitCode);
await cp(join(repositoryRoot, "extensions/zed/target/wasm32-wasip2/release/code_inspection_zed.wasm"), join(artifactsDirectory, `code-inspection-zed-${rootManifest.version}.wasm`));
