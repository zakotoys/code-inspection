import * as assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { DiagnosticEntry } from "../src/diagnostics";
import { SaveObservations } from "../src/save-observations";

const uri = "file:///workspace/sample.ts";
const other = "file:///workspace/other.ts";
const error: DiagnosticEntry = {
  uri,
  severity: "error",
  message: "Type error",
  code: 2322,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const files = new Map<string, DiagnosticEntry[]>();
  let notifications = 0;
  const saves = new SaveObservations(
    (key) => files.get(key) ?? [],
    () => {
      notifications++;
    },
  );
  t.after(() => saves.dispose());
  return { saves, files, notifications: () => notifications };
}
function observed(saves: SaveObservations) {
  const latest = saves.snapshot().latest;
  assert.ok(latest?.state === "observed");
  return latest;
}

test("unsaved diagnostics create no batch; first completed save is a baseline even without diagnostic events", (t) => {
  const { saves, files } = setup(t);
  files.set(uri, [error]);
  saves.diagnosticsChanged(uri);
  t.mock.timers.tick(2500);
  assert.equal(saves.snapshot().latest, null);
  saves.saved(uri, 4);
  const id = saves.snapshot().pending[0]?.batchId;
  t.mock.timers.tick(499);
  assert.equal(saves.snapshot().latest, null);
  t.mock.timers.tick(1);
  const batch = observed(saves);
  assert.equal(batch.batchId, id);
  assert.equal(batch.documentVersion, 4);
  assert.equal(batch.baseline, true);
  assert.deepEqual(batch.diagnostics, [error]);
  assert.deepEqual(batch.added, []);
  assert.deepEqual(batch.resolved, []);
  assert.equal(batch.reason, "quiet-window");
  assert.equal(batch.finishedAt, new Date(4000).toISOString());
});

test("delayed diagnostics restart quiet window; successive saves show additions, no duplicates, and repairs", (t) => {
  const { saves, files } = setup(t);
  saves.saved(uri, 1);
  t.mock.timers.tick(500);
  saves.saved(uri, 2);
  const id = saves.snapshot().pending[0]?.batchId;
  t.mock.timers.tick(400);
  files.set(uri, [error]);
  saves.diagnosticsChanged(uri);
  t.mock.timers.tick(499);
  assert.equal(saves.snapshot().pending.length, 1);
  t.mock.timers.tick(1);
  assert.equal(observed(saves).batchId, id);
  assert.deepEqual(observed(saves).added, [error]);
  saves.saved(uri, 2);
  t.mock.timers.tick(500);
  assert.notEqual(observed(saves).batchId, id);
  assert.deepEqual(observed(saves).added, []);
  files.set(uri, []);
  saves.diagnosticsChanged(uri);
  saves.saved(uri, 3);
  t.mock.timers.tick(500);
  assert.deepEqual(observed(saves).resolved, [error]);
  assert.deepEqual(observed(saves).diagnostics, []);
});

test("continuous events finish at the fixed deadline, and late events cannot rewrite a completed batch", (t) => {
  const { saves, files } = setup(t);
  saves.saved(uri, 1);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(400);
    saves.diagnosticsChanged(uri);
  }
  files.set(uri, [error]);
  t.mock.timers.tick(400);
  const batch = observed(saves);
  assert.equal(batch.reason, "max-wait");
  assert.equal(batch.finishedAt, new Date(3000).toISOString());
  files.set(uri, []);
  saves.diagnosticsChanged(uri);
  t.mock.timers.tick(3000);
  assert.deepEqual(saves.snapshot().latest, batch);
  batch.diagnostics.length = 0;
  assert.deepEqual(observed(saves).diagnostics, [error]);
});

test("editing during observation invalidates it and never advances the baseline", (t) => {
  const { saves, files } = setup(t);
  saves.saved(uri, 1);
  t.mock.timers.tick(500);
  saves.saved(uri, 2);
  const id = saves.snapshot().pending[0]?.batchId;
  t.mock.timers.tick(100);
  saves.edited(uri);
  files.set(uri, [error]);
  saves.diagnosticsChanged(uri);
  t.mock.timers.tick(2500);
  assert.equal(saves.snapshot().latest?.batchId, id);
  assert.equal(saves.snapshot().latest?.state, "invalidated");
  assert.equal(saves.snapshot().latest?.reason, "edited");
  assert.equal(saves.snapshot().latest?.diagnostics, null);
  assert.equal(saves.snapshot().pending.length, 0);
  saves.saved(uri, 3);
  t.mock.timers.tick(500);
  assert.equal(observed(saves).documentVersion, 3);
  assert.deepEqual(observed(saves).added, [error]);
});

test("a new save supersedes the pending identity; separate files have independent windows and baselines", (t) => {
  const { saves, files } = setup(t);
  saves.saved(uri, 1);
  const old = saves.snapshot().pending[0]?.batchId;
  t.mock.timers.tick(300);
  saves.saved(uri, 2);
  assert.equal(saves.snapshot().latest?.batchId, old);
  assert.equal(saves.snapshot().latest?.reason, "saved-again");
  saves.saved(other, 10);
  t.mock.timers.tick(300);
  files.set(uri, [error]);
  saves.diagnosticsChanged(uri);
  t.mock.timers.tick(200);
  assert.equal(observed(saves).uri, other);
  assert.equal(saves.snapshot().pending.length, 1);
  t.mock.timers.tick(300);
  assert.equal(observed(saves).uri, uri);
  assert.equal(observed(saves).documentVersion, 2);
  assert.notEqual(observed(saves).batchId, old);
});

test("closing, workspace removal and disposal release observations and reset appropriate baselines", (t) => {
  const { saves, notifications } = setup(t);
  saves.saved(uri, 1);
  saves.forget(uri, "closed");
  assert.equal(saves.snapshot().latest?.reason, "closed");
  t.mock.timers.tick(2000);
  saves.saved(uri, 2);
  t.mock.timers.tick(500);
  assert.equal(observed(saves).baseline, true);
  saves.saved(other, 1);
  saves.retain((key) => key === uri);
  assert.equal(saves.snapshot().pending.length, 0);
  assert.equal(saves.snapshot().latest, null);
  saves.saved(uri, 3);
  saves.dispose();
  const count = notifications();
  t.mock.timers.tick(3000);
  saves.saved(uri, 4);
  assert.equal(notifications(), count);
  assert.equal(saves.snapshot().latest, null);
  assert.equal(saves.snapshot().pending.length, 0);
});

test("a transient unsaved error repaired before save creates no new problem; sessions differ after restart", (t) => {
  const { saves, files } = setup(t);
  saves.saved(uri, 1);
  t.mock.timers.tick(500);
  files.set(uri, [error]);
  saves.diagnosticsChanged(uri);
  files.set(uri, []);
  saves.diagnosticsChanged(uri);
  saves.saved(uri, 5);
  t.mock.timers.tick(500);
  assert.deepEqual(observed(saves).added, []);
  assert.deepEqual(observed(saves).resolved, []);
  const fresh = new SaveObservations(
    () => [],
    () => {},
  );
  assert.notEqual(fresh.snapshot().sessionId, saves.snapshot().sessionId);
  fresh.dispose();
});

test("pause cancels pending work, clears history, remains idempotent and resumes with a fresh baseline", (t) => {
  const { saves, files, notifications } = setup(t);
  saves.saved(uri, 1);
  t.mock.timers.tick(500);
  const oldSession = saves.historyStatus().sessionId;
  saves.saved(uri, 2);
  t.mock.timers.tick(100);
  saves.setPaused(true);
  assert.equal(saves.snapshot().state, "paused");
  assert.equal(saves.snapshot().pending.length, 0);
  assert.equal(saves.snapshot().latest, null);
  assert.equal(saves.historyStatus().retainedCount, 0);
  assert.notEqual(saves.historyStatus().sessionId, oldSession);
  const pausedSession = saves.historyStatus().sessionId;
  const count = notifications();
  files.set(uri, [error]);
  saves.saved(uri, 3);
  saves.diagnosticsChanged(uri);
  saves.setPaused(true);
  t.mock.timers.tick(3000);
  assert.equal(notifications(), count);
  assert.equal(saves.historyStatus().latestCursor, 0);
  assert.equal(saves.historyStatus().sessionId, pausedSession);
  saves.setPaused(false);
  const resumedSession = saves.historyStatus().sessionId;
  assert.notEqual(resumedSession, pausedSession);
  saves.setPaused(false);
  assert.equal(saves.historyStatus().sessionId, resumedSession);
  saves.saved(uri, 4);
  t.mock.timers.tick(500);
  assert.equal(observed(saves).baseline, true);
  assert.deepEqual(observed(saves).added, []);
  assert.deepEqual(observed(saves).diagnostics, [error]);
});
