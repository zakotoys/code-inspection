#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  canonicalizeWorkspaceRoot,
  formatError,
  type Finding,
  type InspectorId
} from "@zakotoys/code-inspection-core";
import { connectWorkspaceService, type WorkspaceClient } from "./ipc.js";
import { createStderrLogger } from "./logger.js";

const server = new McpServer({ name: "code-inspection-mcp-server", version: "0.1.0" });
const clients = new Map<string, WorkspaceClient>();
const logger = createStderrLogger("mcp");

const workspaceSchema = z.string().min(1).default(process.cwd()).describe("Workspace directory. It must be a local filesystem path.");
const inspectorSchema = z.enum(["eslint", "typescript", "build"]).describe("Configured inspection to run.");
const formatSchema = z.enum(["json", "markdown"]).default("json").describe("Response format.");
const positionSchema = z.object({ line: z.number().int().min(0), character: z.number().int().min(0) });
const rangeSchema = z.object({ start: positionSchema, end: positionSchema });
const findingSchema = z.object({
  id: z.string(),
  inspector: inspectorSchema,
  source: z.string(),
  code: z.string().optional(),
  severity: z.enum(["error", "warning", "info", "hint"]),
  message: z.string(),
  file: z.string().optional(),
  range: rangeSchema.optional(),
  runId: z.string(),
  generation: z.number().int(),
  stale: z.boolean().optional()
});
const summarySchema = z.object({
  errorCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  infoCount: z.number().int().min(0),
  hintCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional()
});
const runSchema = z.object({
  runId: z.string(),
  workspace: z.string(),
  inspector: inspectorSchema,
  scope: z.object({ files: z.array(z.string()).optional() }),
  trigger: z.enum(["cli", "save", "manual", "mcp", "startup"]),
  generation: z.number().int(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  outcome: z.enum(["queued", "running", "completed", "failed", "cancelled", "superseded"]),
  error: z.object({ code: z.string(), message: z.string(), details: z.string().optional() }).optional(),
  summary: summarySchema.optional()
});
const snapshotSchema = z.object({
  run: runSchema,
  findings: z.array(findingSchema),
  freshness: z.object({ generation: z.number().int(), dirtyFiles: z.array(z.string()), stale: z.boolean() })
});
const findingsPageSchema = z.object({
  total: z.number().int().min(0),
  count: z.number().int().min(0),
  offset: z.number().int().min(0),
  findings: z.array(findingSchema),
  hasMore: z.boolean(),
  nextOffset: z.number().int().min(0).optional()
});

server.registerTool("run_inspection", {
  title: "Run Code Inspection",
  description: "Queue one configured workspace inspection and return its run record. Use get_run to wait for completion and get_findings to read normalized diagnostics. Execution requires that the workspace has been explicitly trusted locally.",
  inputSchema: z.object({
    workspace: workspaceSchema,
    inspector: inspectorSchema,
    files: z.array(z.string().min(1)).max(100).optional().describe("Optional workspace-relative files. TypeScript and build inspections may still check their full project."),
    response_format: formatSchema
  }).strict(),
  outputSchema: runSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async ({ workspace, inspector, files, response_format }) => {
  try {
    const client = await getClient(workspace);
    const response = await client.api.runInspection({ inspector: inspector as InspectorId, ...(files ? { scope: { files } } : {}), trigger: "mcp" });
    return toolResult(response.run, "Inspection queued.", response_format);
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_run", {
  title: "Get Inspection Run",
  description: "Read the current state, outcome, summary, and freshness metadata for one inspection run.",
  inputSchema: z.object({
    workspace: workspaceSchema,
    run_id: z.string().min(1).describe("Run ID returned by run_inspection."),
    response_format: formatSchema
  }).strict(),
  outputSchema: snapshotSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ workspace, run_id, response_format }) => {
  try {
    const client = await getClient(workspace);
    const response = await client.api.getRun({ runId: run_id });
    return toolResult(response.snapshot, "Inspection run status.", response_format);
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_findings", {
  title: "Get Inspection Findings",
  description: "Read the latest normalized findings from the shared workspace service. Results are paginated and identify stale results when a run failed or the inspected source changed.",
  inputSchema: z.object({
    workspace: workspaceSchema,
    inspector: inspectorSchema.optional(),
    file: z.string().min(1).optional().describe("Optional workspace-relative file filter."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(50),
    include_stale: z.boolean().default(false),
    response_format: formatSchema
  }).strict(),
  outputSchema: z.object({ page: findingsPageSchema, runs: z.array(runSchema) }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ workspace, inspector, file, offset, limit, include_stale, response_format }) => {
  try {
    const client = await getClient(workspace);
    const response = await client.api.getFindings({ ...(inspector ? { inspector: inspector as InspectorId } : {}), ...(file ? { file } : {}), offset, limit, includeStale: include_stale });
    return toolResult(response, formatFindings(response.page.findings), response_format);
  } catch (error) {
    return toolError(error);
  }
});

async function getClient(inputWorkspace: string): Promise<WorkspaceClient> {
  const root = await canonicalizeWorkspaceRoot(inputWorkspace);
  const existing = clients.get(root);
  if (existing) return existing;
  const client = await connectWorkspaceService(root, logger);
  clients.set(root, client);
  return client;
}

function toolResult(value: object, markdown: string, responseFormat: "json" | "markdown"): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } {
  return { content: [{ type: "text", text: responseFormat === "json" ? JSON.stringify(value, null, 2) : markdown }], structuredContent: value as Record<string, unknown> };
}

function toolError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  return { isError: true, content: [{ type: "text", text: `Code inspection request failed: ${formatError(error)}. Trust the workspace with \"code-inspection trust <workspace>\" and ensure the project tool is installed if this is an execution error.` }] };
}

function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No current findings.";
  return findings.map((finding) => {
    const location = finding.file ? `${finding.file}:${(finding.range?.start.line ?? 0) + 1}:${(finding.range?.start.character ?? 0) + 1}` : "workspace";
    return `- ${location} ${finding.severity}: ${finding.message}${finding.code ? ` (${finding.code})` : ""}${finding.stale ? " [stale]" : ""}`;
  }).join("\n");
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("code-inspection MCP server ready on stdio\n");
}

async function closeClients(): Promise<void> {
  for (const client of clients.values()) client.close();
  clients.clear();
  await server.close();
}

process.once("SIGINT", () => { void closeClients().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void closeClients().finally(() => process.exit(0)); });
void main().catch((error: unknown) => {
  process.stderr.write(`code-inspection MCP server failed: ${formatError(error)}\n`);
  process.exitCode = 1;
});
