import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TrustStore, canonicalizeWorkspaceRoot } from "../packages/core/dist/index.js";

const repositoryRoot = resolve(".");
const workspace = await canonicalizeWorkspaceRoot(resolve(process.argv[2] ?? "tests/fixtures/eslint-broken"));
const serverEntry = resolve(repositoryRoot, process.argv[3] ?? "packages/runtime/dist/mcp.js");
const dataDirectory = await mkdtemp(join(tmpdir(), "code-inspection-mcp-smoke-"));
await new TrustStore(dataDirectory).grant(workspace);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: workspace,
  env: { ...process.env, CODE_INSPECTION_DATA_DIR: dataDirectory, CODE_INSPECTION_IDLE_TIMEOUT_MS: "100" },
  stderr: "ignore"
});
const client = new Client({ name: "code-inspection-smoke", version: "0.1.0" });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert(JSON.stringify(toolNames) === JSON.stringify(["get_findings", "get_run", "run_inspection"]), `Unexpected MCP tools: ${toolNames.join(", ")}`);
  const queued = await client.callTool({ name: "run_inspection", arguments: { workspace, inspector: "eslint", response_format: "json" } });
  assert(!queued.isError && queued.structuredContent && typeof queued.structuredContent.runId === "string", `MCP run_inspection did not return a run ID: ${JSON.stringify(queued)}`);
  const runId = queued.structuredContent.runId;
  let run;
  for (;;) {
    const response = await client.callTool({ name: "get_run", arguments: { workspace, run_id: runId, response_format: "json" } });
    assert(!response.isError && response.structuredContent, "MCP get_run failed.");
    run = response.structuredContent.run;
    if (["completed", "failed", "cancelled", "superseded"].includes(run.outcome)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert(run.outcome === "completed", `MCP run ended as ${run.outcome}.`);
  const findings = await client.callTool({ name: "get_findings", arguments: { workspace, inspector: "eslint", response_format: "json" } });
  assert(!findings.isError && findings.structuredContent?.page?.total === 3, "MCP findings did not contain the expected three diagnostics.");
  process.stdout.write(`MCP smoke passed: ${toolNames.join(", ")} and ${findings.structuredContent.page.total} finding(s).\n`);
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  await rm(dataDirectory, { recursive: true, force: true });
}
