import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

await mkdir(resolve("artifacts"), { recursive: true });
const args = ["build", "--target", "wasm32-wasip2", "--release", "--manifest-path", "extensions/zed/Cargo.toml"];
const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn("cargo", args, { stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("close", (code) => resolvePromise(code ?? 1));
});
if (exitCode !== 0) process.exit(exitCode);
await cp(resolve("extensions/zed/target/wasm32-wasip2/release/code_inspection_zed.wasm"), resolve("artifacts/code-inspection-zed-0.1.0.wasm"));
