import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { type SaveBatchPage, SaveHistory } from "../src/save-history";
import { type SaveBatch, SaveObservations } from "../src/save-observations";

function batch(message = "error"): SaveBatch {
  return {
    batchId: randomUUID(),
    uri: "file:///workspace/sample.ts",
    documentVersion: 1,
    savedAt: "2026-09-12T00:00:00.000Z",
    finishedAt: "2026-09-12T00:00:00.500Z",
    state: "observed",
    reason: "quiet-window",
    baseline: false,
    diagnostics: [
      {
        uri: "file:///workspace/sample.ts",
        severity: "error",
        message,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ],
    added: [],
    resolved: [],
  };
}
function page(result: SaveBatchPage) {
  assert.ok("batches" in result, JSON.stringify(result));
  return result;
}

test("independent readers can replay, paginate, catch up and wait without consuming or mutating batches", () => {
  const history = new SaveHistory();
  const a = batch();
  history.append(a);
  history.append(batch());
  history.append(batch());
  const first = page(history.read({ limit: 1 }));
  const secondReader = page(history.read({ limit: 1 }));
  assert.deepEqual(first, secondReader);
  assert.equal(first.batches[0]?.batch.batchId, a.batchId);
  assert.equal(first.nextCursor, 1);
  assert.equal(first.hasMore, true);
  const second = page(history.read({ sessionId: first.sessionId, afterCursor: 1, limit: 2 }));
  assert.deepEqual(
    second.batches.map((entry) => entry.cursor),
    [2, 3],
  );
  assert.equal(second.hasMore, false);
  const empty = page(history.read({ sessionId: first.sessionId, afterCursor: 3 }));
  assert.deepEqual(empty.batches, []);
  assert.equal(empty.nextCursor, 3);
  assert.equal(history.status().retainedCount, 3);
  if (a.state === "observed") a.diagnostics.length = 0;
  first.batches.length = 0;
  assert.deepEqual(page(history.read({ limit: 1 })), secondReader);
  history.append(batch());
  assert.deepEqual(
    page(history.read({ sessionId: first.sessionId, afterCursor: 3 })).batches.map((r) => r.cursor),
    [4],
  );
});

test("count eviction reports a gap and requires an explicit resume cursor; latest cursor survives reads", () => {
  const history = new SaveHistory();
  const sessionId = history.status().sessionId;
  for (let i = 0; i < 105; i++) history.append(batch());
  const status = history.status();
  assert.equal(status.retainedCount, 100);
  assert.equal(status.latestCursor, 105);
  assert.equal(status.oldestAvailableCursor, 6);
  assert.equal(status.resumeAfterCursor, 5);
  const expired = history.read({ sessionId, afterCursor: 4 });
  assert.ok("reason" in expired && expired.reason === "CURSOR_EXPIRED");
  assert.ok("code" in history.read());
  const resumed = page(
    history.read({ sessionId, afterCursor: status.resumeAfterCursor, limit: 10 }),
  );
  assert.equal(resumed.batches[0]?.cursor, 6);
  assert.equal(resumed.nextCursor, 15);
  assert.ok(resumed.hasMore);
});

test("byte eviction bounds retained serialization independently of record count", () => {
  const history = new SaveHistory();
  for (let i = 0; i < 50; i++) history.append(batch("x".repeat(60000)));
  const status = history.status();
  assert.ok(status.retainedCount < 50);
  assert.ok(status.retainedCount > 0);
  assert.ok(status.retainedBytes <= status.maxHistoryBytes);
  assert.ok(status.resumeAfterCursor > 0);
  let bytes = 0;
  let cursor = status.resumeAfterCursor;
  do {
    const next = page(
      history.read({ sessionId: status.sessionId, afterCursor: cursor, limit: 10 }),
    );
    for (const record of next.batches) bytes += Buffer.byteLength(JSON.stringify(record), "utf8");
    cursor = next.nextCursor;
  } while (cursor < status.latestCursor);
  assert.equal(bytes, status.retainedBytes);
});

test("oversized observations keep stable identity and explicit counts, never an apparently empty diagnostic list", () => {
  const history = new SaveHistory();
  const huge = batch("诊断".repeat(40000));
  huge.uri = `file:///${"界".repeat(12000)}`;
  history.append(huge);
  const response = page(history.read());
  const record = response.batches[0];
  assert.ok(record?.payloadOmitted);
  assert.equal(record.batch.batchId, huge.batchId);
  assert.equal(record.batch.counts?.diagnostics, 1);
  assert.equal(record.batch.uriTruncated, true);
  assert.equal("diagnostics" in record.batch, false);
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= response.maxRecordBytes);
  assert.deepEqual(history.read(), response);
});

test("bad arguments, missing session, future cursor and reset are distinguished", () => {
  const history = new SaveHistory();
  const sessionId = history.status().sessionId;
  assert.deepEqual(page(history.read()).batches, []);
  for (const query of [
    { afterCursor: -1 },
    { afterCursor: 1.5 },
    { afterCursor: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 11 },
  ]) {
    const invalid = history.read(query);
    assert.ok("code" in invalid && invalid.code === "INVALID_ARGUMENT");
  }
  const missing = history.read({ afterCursor: 1 });
  assert.ok("code" in missing && missing.code === "SESSION_REQUIRED");
  const ahead = history.read({ sessionId, afterCursor: 1 });
  assert.ok("reason" in ahead && ahead.reason === "CURSOR_AHEAD");
  history.append(batch());
  history.reset();
  assert.notEqual(history.status().sessionId, sessionId);
  assert.equal(history.status().retainedBytes, 0);
  assert.equal(history.status().latestCursor, 0);
  const old = history.read({ sessionId });
  assert.ok("reason" in old && old.reason === "SESSION_CHANGED");
});

test("observation completion order assigns cursors, invalidations are retained, workspace changes clear old history", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const saves = new SaveObservations(
    () => [],
    () => {},
  );
  t.after(() => saves.dispose());
  saves.saved("file:///a.ts", 1);
  const firstId = saves.snapshot().pending[0]?.batchId;
  t.mock.timers.tick(200);
  saves.saved("file:///b.ts", 1);
  saves.edited("file:///b.ts");
  t.mock.timers.tick(300);
  const result = page(saves.readBatches());
  assert.equal(result.batches.length, 2);
  assert.equal(result.batches[0]?.batch.state, "invalidated");
  assert.equal(result.batches[1]?.batch.batchId, firstId);
  assert.equal(result.batches[1]?.cursor, 2);
  saves.retain((uri) => uri !== "file:///b.ts");
  assert.deepEqual(page(saves.readBatches()).batches, []);
  const stale = saves.readBatches({ sessionId: result.sessionId, afterCursor: result.nextCursor });
  assert.ok("reason" in stale && stale.reason === "SESSION_CHANGED");
  saves.saved("file:///a.ts", 2);
  t.mock.timers.tick(500);
  assert.equal(page(saves.readBatches()).batches[0]?.cursor, 1);
});
