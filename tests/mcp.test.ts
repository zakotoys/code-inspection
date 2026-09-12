import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LocalMcpService, type McpConnection } from "../src/mcp";
import { SaveHistory } from "../src/save-history";
import { DiagnosticStore } from "../src/store";

async function connect(connection: McpConnection): Promise<Client> {
  const client = new Client({ name: "g3-tests", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  return client;
}
function raw(
  connection: McpConnection,
  headers: Record<string, string>,
  body = "{}",
  method = "POST",
  path = "/mcp",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      connection.url,
      {
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.token}`,
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const uri = "file:///workspace/sample.ts";
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const entry = { severity: 0, message: "error", range, source: "ts", code: 2322 };
function source(store: DiagnosticStore, history = new SaveHistory()) {
  return {
    snapshot: () => store.snapshot(),
    detectorStatus: () => ({
      state: "ready" as const,
      diagnosticsEnabled: true,
      unsupportedReason: null,
    }),
    saveBatches: (query: import("../src/save-history").SaveBatchQuery) => history.read(query),
    saveHistoryStatus: () => history.status(),
    workspaceUris: () => ["file:///workspace"],
    inScope: (value: string) => value === uri,
  };
}

test("real MCP discovery, structured results, filtering, pagination and repair", async () => {
  const store = new DiagnosticStore();
  store.replace(uri, [entry, { ...entry, severity: 1 }]);
  const service = await LocalMcpService.start(source(store), "0.0.1");
  const client = await connect(service.connection());
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
      "get_detector_status",
      "get_diagnostics",
      "get_save_batches",
    ]);
    const status = await callTool(client, { name: "get_detector_status", arguments: {} });
    assert.equal(status.structuredContent?.sessionId, service.sessionId);
    const first = await callTool(client, { name: "get_diagnostics", arguments: { limit: 1 } });
    assert.equal(first.structuredContent?.total, 2);
    assert.equal(first.structuredContent?.nextOffset, 1);
    const next = await callTool(client, {
      name: "get_diagnostics",
      arguments: {
        offset: 1,
        limit: 1,
        sessionId: service.sessionId,
        revision: store.snapshot().revision,
      },
    });
    assert.equal(next.structuredContent?.nextOffset, null);
    assert.equal(
      (await callTool(client, { name: "get_diagnostics", arguments: { severity: "warning" } }))
        .structuredContent?.total,
      1,
    );
    assert.equal(
      (
        await callTool(client, {
          name: "get_diagnostics",
          arguments: { uri: "file:///outside.ts" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (await callTool(client, { name: "get_diagnostics", arguments: { offset: 1 } }))
        .structuredContent?.code,
      "PAGE_IDENTITY_REQUIRED",
    );
    store.replace(uri, []);
    assert.equal(
      (
        await callTool(client, {
          name: "get_diagnostics",
          arguments: { offset: 1, sessionId: service.sessionId, revision: 1 },
        })
      ).structuredContent?.code,
      "RESYNC_REQUIRED",
    );
    assert.equal(
      (await callTool(client, { name: "get_diagnostics", arguments: {} })).structuredContent?.total,
      0,
    );
    for (const args of [
      { limit: 101 },
      { offset: -1 },
      { severity: "hint" },
      { unexpected: true },
    ]) {
      const response = await callTool(client, { name: "get_diagnostics", arguments: args });
      assert.equal(response.isError, true, JSON.stringify(args));
    }
    const secondClient = await connect(service.connection());
    try {
      assert.equal(
        (await callTool(secondClient, { name: "get_detector_status", arguments: {} }))
          .structuredContent?.sessionId,
        service.sessionId,
      );
    } finally {
      await secondClient.close();
    }
  } finally {
    await client.close();
    await service.close();
  }
});

test("local HTTP rejects missing/wrong tokens, Host/Origin attacks, oversized/malformed bodies", async () => {
  const service = await LocalMcpService.start(source(new DiagnosticStore()), "0.0.1");
  const c = service.connection();
  try {
    assert.equal(await raw(c, { Authorization: "" }), 401);
    assert.equal(await raw(c, { Authorization: "Bearer wrong" }), 401);
    assert.equal(await raw(c, { Host: "attacker.example" }), 403);
    assert.equal(await raw(c, { Origin: "https://attacker.example" }), 403);
    assert.equal(await raw(c, { Origin: "null" }), 403);
    assert.equal(await raw(c, {}, "not json"), 400);
    assert.equal(await raw(c, {}, JSON.stringify({ text: "x".repeat(20000) })), 413);
    assert.equal(await raw(c, { "Content-Type": "text/plain" }), 415);
    assert.equal(await raw(c, {}, "", "GET"), 405);
    assert.equal(await raw(c, {}, "{}", "POST", "/other"), 404);
  } finally {
    await service.close();
  }
  await assert.rejects(raw(c, {}));
  await service.close();
  const restarted = await LocalMcpService.start(source(new DiagnosticStore()), "0.0.1");
  try {
    assert.notEqual(restarted.sessionId, c.sessionId);
    assert.notEqual(restarted.connection().token, c.token);
    assert.equal(await raw(restarted.connection(), { Authorization: `Bearer ${c.token}` }), 401);
  } finally {
    await restarted.close();
  }
});

test("oversized text is explicitly truncated and diagnostics remain bounded by page limit", async () => {
  const store = new DiagnosticStore();
  store.replace(uri, [{ ...entry, message: "x".repeat(9000) }]);
  const service = await LocalMcpService.start(source(store), "0.0.1");
  const client = await connect(service.connection());
  try {
    const response = await callTool(client, { name: "get_diagnostics", arguments: {} });
    const entries = response.structuredContent?.diagnostics as {
      message: string;
      textTruncated: boolean;
    }[];
    assert.equal(entries[0]?.message.length, 8192);
    assert.equal(entries[0]?.textTruncated, true);
  } finally {
    await client.close();
    await service.close();
  }
});

async function callTool(
  client: Client,
  params: { name: string; arguments: Record<string, unknown> },
) {
  const response = await client.callTool(params);
  assert.ok("content" in response, "Expected tool result rather than an interactive request");
  return response as { structuredContent?: Record<string, unknown>; isError?: boolean };
}

test("manual inspection CLI reads copied config through stdin without printing credentials", async () => {
  const service = await LocalMcpService.start(source(new DiagnosticStore()), "0.0.1");
  const connection = service.connection();
  try {
    const child = spawn(process.execPath, ["scripts/inspect-mcp.cjs"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(
      JSON.stringify({
        servers: {
          "code-inspection": {
            type: "http",
            url: connection.url,
            headers: { Authorization: `Bearer ${connection.token}` },
          },
        },
      }),
    );
    assert.equal(await exited, 0, output);
    assert.match(output, /get_detector_status/);
    assert.match(output, /get_diagnostics/);
    assert.match(output, /"total": 0/);
    assert.equal(output.includes(connection.token), false);
  } finally {
    await service.close();
  }
});

test("manual CLI distinguishes configuration, authentication and stopped-service failures", async () => {
  const run = (input: string) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/inspect-mcp.cjs"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
      child.stdin.end(input);
    });
  for (const [input, expected] of [
    ["", "[INPUT]"],
    ["Get-Clipboard -Raw | npm run mcp:inspect", "[CONFIG]"],
    ["null", "[CONFIG]"],
  ] as const) {
    const result = await run(input);
    assert.equal(result.code, 1);
    assert.ok(result.output.includes(expected));
  }
  const service = await LocalMcpService.start(source(new DiagnosticStore()), "0.0.1");
  const c = service.connection();
  const config = (token: string) =>
    JSON.stringify({
      servers: { "code-inspection": { url: c.url, headers: { Authorization: `Bearer ${token}` } } },
    });
  try {
    const stale = await run(config("0".repeat(64)));
    assert.equal(stale.code, 1);
    assert.ok(stale.output.includes("[AUTH]"));
    assert.equal(stale.output.includes("0".repeat(64)), false);
  } finally {
    await service.close();
  }
  const stopped = await run(config(c.token));
  assert.equal(stopped.code, 1);
  assert.ok(stopped.output.includes("[CONNECT]"));
  assert.equal(stopped.output.includes(c.token), false);
});

test("MCP save history supports independent readers, expiry recovery, session reset and bounded results", async () => {
  const store = new DiagnosticStore();
  const history = new SaveHistory();
  const append = (message = "saved error") =>
    history.append({
      batchId: randomUUID(),
      uri,
      documentVersion: 1,
      savedAt: "2026-09-12T00:00:00.000Z",
      finishedAt: "2026-09-12T00:00:00.500Z",
      state: "observed",
      reason: "quiet-window",
      baseline: false,
      diagnostics: [{ uri, severity: "error", message, range, code: 2322 }],
      added: [],
      resolved: [],
    });
  append();
  append();
  append();
  const service = await LocalMcpService.start(source(store, history), "0.0.1");
  const firstClient = await connect(service.connection());
  const otherClient = await connect(service.connection());
  const query = (client: Client, args: Record<string, unknown> = {}) =>
    callTool(client, { name: "get_save_batches", arguments: args });
  try {
    const [first, same] = await Promise.all([
      query(firstClient, { limit: 1 }),
      query(otherClient, { limit: 1 }),
    ]);
    assert.deepEqual(first, same);
    assert.equal(first.isError, undefined);
    const data = first.structuredContent;
    assert.ok(data);
    assert.equal(data.nextCursor, 1);
    assert.equal(data.hasMore, true);
    const sessionId = data.sessionId;
    assert.notEqual(sessionId, service.sessionId);
    const next = await query(firstClient, { sessionId, afterCursor: 1, limit: 10 });
    assert.equal(next.structuredContent?.nextCursor, 3);
    assert.equal(next.structuredContent?.hasMore, false);
    assert.deepEqual(await query(otherClient, { limit: 1 }), first);
    assert.deepEqual(
      (await query(firstClient, { sessionId, afterCursor: 3 })).structuredContent?.batches,
      [],
    );
    const status = await callTool(firstClient, { name: "get_detector_status", arguments: {} });
    assert.ok(status.structuredContent);
    assert.equal(
      (status.structuredContent.saveHistory as { sessionId: string }).sessionId,
      sessionId,
    );
    for (const args of [
      { limit: 11 },
      { afterCursor: -1 },
      { sessionId: "wrong" },
      { extra: true },
    ])
      assert.equal((await query(firstClient, args)).isError, true);
    assert.equal(
      (await query(firstClient, { afterCursor: 1 })).structuredContent?.code,
      "SESSION_REQUIRED",
    );
    assert.equal(
      (await query(firstClient, { sessionId, afterCursor: 100 })).structuredContent?.reason,
      "CURSOR_AHEAD",
    );
    for (let i = 0; i < 101; i++) append();
    const expired = await query(firstClient, { sessionId, afterCursor: 1 });
    assert.equal(expired.isError, true);
    assert.equal(expired.structuredContent?.reason, "CURSOR_EXPIRED");
    const resume = await query(firstClient, {
      sessionId,
      afterCursor: expired.structuredContent?.resumeAfterCursor,
    });
    assert.equal(resume.isError, undefined);
    const previousEnd = history.status().latestCursor;
    append("x".repeat(80000));
    const large = await query(firstClient, { sessionId, afterCursor: previousEnd });
    const records = large.structuredContent?.batches as { payloadOmitted: boolean }[];
    assert.equal(records[0]?.payloadOmitted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") < 2 * 1024 * 1024);
    history.reset();
    const oldSession = await query(firstClient, { sessionId, afterCursor: 0 });
    assert.equal(oldSession.isError, true);
    assert.equal(oldSession.structuredContent?.reason, "SESSION_CHANGED");
    assert.deepEqual((await query(otherClient)).structuredContent?.batches, []);
    for (let i = 0; i < 10; i++) append("x".repeat(60000));
    const fullPage = await query(otherClient, { limit: 10 });
    const fullPageBatches = fullPage.structuredContent?.batches;
    assert.ok(Array.isArray(fullPageBatches));
    assert.equal(fullPageBatches.length, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(fullPage), "utf8") < 2 * 1024 * 1024);
  } finally {
    await firstClient.close();
    await otherClient.close();
    await service.close();
  }
});
