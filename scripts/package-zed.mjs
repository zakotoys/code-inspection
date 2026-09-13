import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadReleaseContext, repositoryRoot } from "./release/context.mjs";

const release = await loadReleaseContext();
await mkdir(release.artifacts.directory, { recursive: true });
const args = ["build", "--target", "wasm32-wasip2", "--release", "--manifest-path", join(repositoryRoot, "extensions/zed/Cargo.toml")];
const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn("cargo", args, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("close", (code) => resolvePromise(code ?? 1));
});
if (exitCode !== 0) process.exit(exitCode);
await cp(join(repositoryRoot, "extensions/zed/target/wasm32-wasip2/release/code_inspection_zed.wasm"), release.artifacts.zed.absolute);
