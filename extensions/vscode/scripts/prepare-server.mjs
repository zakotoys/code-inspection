import { cp, mkdir, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const bundledRoot = resolve(extensionRoot, "../../packages/runtime/dist/bundles");
const serverRoot = resolve(extensionRoot, "server");
const lockPath = resolve(serverRoot, ".prepare.lock");

await mkdir(serverRoot, { recursive: true });
const release = await acquireLock(lockPath);
try {
  await cp(resolve(extensionRoot, "../../LICENSE"), resolve(extensionRoot, "LICENSE.txt"));
  await Promise.all(["lsp", "mcp", "service-host", "inspection-worker"].map((name) => rm(resolve(serverRoot, `${name}.js`), { force: true })));
  await cp(resolve(bundledRoot, "lsp.cjs"), resolve(serverRoot, "lsp.cjs"));
  await cp(resolve(bundledRoot, "mcp.cjs"), resolve(serverRoot, "mcp.cjs"));
  await cp(resolve(bundledRoot, "service-host.cjs"), resolve(serverRoot, "service-host.cjs"));
  await cp(resolve(bundledRoot, "inspection-worker.cjs"), resolve(serverRoot, "inspection-worker.cjs"));
} finally {
  await release();
}

async function acquireLock(path) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(path);
      return async () => {
        await rm(path, { recursive: true, force: true });
      };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      try {
        const details = await stat(path);
        if (Date.now() - details.mtimeMs > 120_000) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!statError || typeof statError !== "object" || statError.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the VS Code server preparation lock.");
      await delay(50);
    }
  }
}
