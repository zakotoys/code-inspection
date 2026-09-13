import { build } from "esbuild";
import { rm } from "node:fs/promises";

const shared = {
  outdir: "dist/bundles",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
  legalComments: "eof"
};

await Promise.all(
  ["lsp", "mcp", "service-host", "inspection-worker"].flatMap((name) => [
    rm(`dist/bundles/${name}.js`, { force: true }),
    rm(`dist/bundles/${name}.js.map`, { force: true })
  ])
);

await Promise.all([
  build({
    ...shared,
    entryPoints: ["dist/lsp.js", "dist/service-host.js", "dist/inspection-worker.js"],
    external: ["eslint", "typescript"]
  }),
  build({
    ...shared,
    entryPoints: ["dist/mcp.js"],
    // Bundling the MCP SDK together with Zod 4 can reorder Zod's generated
    // initializers. Keep Zod as the one runtime dependency of this bundle.
    external: ["eslint", "typescript", "zod", "zod/*"]
  })
]);
