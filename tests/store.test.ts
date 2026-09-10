import * as assert from "node:assert/strict";
import { test } from "node:test";
import { type DiagnosticInput, normalizeDiagnostics } from "../src/diagnostics";
import { DiagnosticStore } from "../src/store";

const error: DiagnosticInput = {
  severity: 0,
  message: "Mismatch",
  range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
  source: "ts",
  code: { value: 2322 },
};
test("normalization filters hints, keeps metadata and deduplicates", () => {
  const result = normalizeDiagnostics("file:///a.ts", [
    error,
    error,
    { ...error, severity: 1 },
    { ...error, severity: 2 },
    { ...error, severity: 3 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.code, 2322);
  assert.equal(result[0]?.range.start.character, 1);
});
test("replacement clears repaired problems without erasing other files", () => {
  const store = new DiagnosticStore();
  store.replace("a", [error]);
  store.replace("b", [{ ...error, severity: 1 }]);
  store.replace("a", []);
  assert.equal(store.snapshot().errors, 0);
  assert.equal(store.snapshot().warnings, 1);
});
test("repeated and reordered diagnostics do not advance revision", () => {
  const store = new DiagnosticStore();
  const warning = { ...error, severity: 1 };
  store.replace("a", [error, warning]);
  const revision = store.snapshot().revision;
  store.replace("a", [warning, error, error]);
  assert.equal(store.snapshot().revision, revision);
  store.replace("a", [{ ...error, message: "Changed" }]);
  assert.equal(store.snapshot().revision, revision + 1);
});
test("snapshots cannot mutate the store; workspace removal drops stale entries", () => {
  const store = new DiagnosticStore();
  store.replace("a", [error]);
  const snapshot = store.snapshot();
  const first = snapshot.diagnostics[0];
  assert.ok(first);
  first.range.start.line = 99;
  assert.equal(store.snapshot().diagnostics[0]?.range.start.line, 0);
  store.retain(() => false);
  assert.equal(store.snapshot().diagnostics.length, 0);
});
