import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const bundledRoot = resolve(extensionRoot, "../../packages/runtime/dist/bundles");
const serverRoot = resolve(extensionRoot, "server");

await mkdir(serverRoot, { recursive: true });
await cp(resolve(extensionRoot, "../../LICENSE"), resolve(extensionRoot, "LICENSE.txt"));
await rm(resolve(serverRoot, "lsp.js"), { force: true });
await rm(resolve(serverRoot, "mcp.js"), { force: true });
await rm(resolve(serverRoot, "service-host.js"), { force: true });
await cp(resolve(bundledRoot, "lsp.js"), resolve(serverRoot, "lsp.js"));
await cp(resolve(bundledRoot, "mcp.js"), resolve(serverRoot, "mcp.js"));
await cp(resolve(bundledRoot, "service-host.js"), resolve(serverRoot, "service-host.js"));
