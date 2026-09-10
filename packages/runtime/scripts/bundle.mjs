import { build } from "esbuild";

await build({
  entryPoints: ["dist/lsp.js", "dist/mcp.js", "dist/service-host.js"],
  outdir: "dist/bundles",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["eslint", "typescript"],
  sourcemap: true,
  legalComments: "eof"
});
