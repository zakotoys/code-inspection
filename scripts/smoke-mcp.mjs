import { mkdtemp, rm } from "node:fs/promises";
import { withTimeout } from "./smoke-timeout.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TrustStore, canonicalizeWorkspaceRoot } from "../packages/core/dist/index.js";

const repositoryRoot = resolve(".");
const workspace = await canonicalizeWorkspaceRoot(resolve(process.argv[2] ?? "tests/fixtures/eslint-broken"));
const checkId = process.env.SMOKE_CHECK_ID ?? "eslint";
const expectedFindings = Number(process.env.SMOKE_EXPECTED_FINDINGS ?? 3);
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
const client = new Client({ name: "code-inspection-smoke", version: "0.2.0" });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await withTimeout(async () => {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert(JSON.stringify(toolNames) === JSON.stringify(["get_findings", "get_run", "list_inspectors", "list_projects", "run_inspection"]), `Unexpected MCP tools: ${toolNames.join(", ")}`);
    const capabilities = await client.callTool({ name: "list_inspectors", arguments: { workspace, response_format: "json" } });
    assert(!capabilities.isError && capabilities.structuredContent?.inspectors?.some((item) => item.id === checkId), `MCP capability listing did not expose ${checkId}: ${JSON.stringify(capabilities)}`);
    const projects = await client.callTool({ name: "list_projects", arguments: { workspace, check_id: checkId, response_format: "json" } });
    assert(!projects.isError && Array.isArray(projects.structuredContent?.projects), "MCP project listing failed.");
    const queued = await client.callTool({ name: "run_inspection", arguments: { workspace, check_id: checkId, ...(process.env.SMOKE_FILE ? { files: [process.env.SMOKE_FILE] } : {}), response_format: "json" } });
    assert(!queued.isError && queued.structuredContent && typeof queued.structuredContent.runId === "string", `MCP run_inspection did not return a run ID: ${JSON.stringify(queued)}`);
    const runId = queued.structuredContent.runId;
    let run;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await client.callTool({ name: "get_run", arguments: { workspace, run_id: runId, response_format: "json" } });
      assert(!response.isError && response.structuredContent, "MCP get_run failed.");
      run = response.structuredContent.run;
      if (["completed", "failed", "cancelled", "superseded"].includes(run.outcome)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert(run.outcome === "completed", `MCP run ended as ${run.outcome}.`);
    const findings = await client.callTool({ name: "get_findings", arguments: { workspace, check_id: checkId, response_format: "json" } });
    assert(!findings.isError && findings.structuredContent?.page?.total === expectedFindings, `MCP findings did not contain the expected ${expectedFindings} diagnostics.`);
    const first = await client.callTool({ name: "get_findings", arguments: { workspace, limit: 2 } });
    if (expectedFindings > 2) {
      assert(!first.isError && first.structuredContent?.page?.nextOffset === 2 && first.structuredContent.page.count === 2, "MCP first page was invalid.");
      const last = await client.callTool({ name: "get_findings", arguments: { workspace, offset: 2, limit: 2 } });
      assert(!last.isError && last.structuredContent?.page?.count === expectedFindings - 2 && last.structuredContent.page.hasMore === false, "MCP last page was invalid.");
    } else {
      assert(!first.isError && first.structuredContent?.page?.count === expectedFindings && first.structuredContent.page.hasMore === false, "MCP single page was invalid.");
    }
    const missing = await client.callTool({ name: "get_run", arguments: { workspace, run_id: "missing-run" } });
    assert(missing.isError === true, "MCP accepted an unknown run ID.");
    const invalid = await client.callTool({ name: "get_findings", arguments: { workspace, limit: 0 } });
    assert(invalid.isError === true, "MCP accepted an invalid page limit.");
    process.stdout.write(`MCP smoke passed: ${toolNames.join(", ")} and ${findings.structuredContent.page.total} finding(s).\n`);
  }, 30_000, "MCP smoke");
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  await rm(dataDirectory, { recursive: true, force: true });
}
