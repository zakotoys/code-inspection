import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import { withTimeout } from "./smoke-timeout.mjs";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { TrustStore } from "../packages/core/dist/index.js";

const repositoryRoot = resolve(".");
const workspace = resolve(process.argv[2] ?? "tests/fixtures/eslint-broken");
const lspEntry = resolve(repositoryRoot, process.argv[3] ?? "packages/runtime/dist/lsp.js");
const filePath = resolve(workspace, process.env.SMOKE_FILE ?? "broken.js");
const fileUri = pathToFileURL(filePath).href;
const workspaceUri = pathToFileURL(workspace).href;
const expected = Number(process.env.SMOKE_EXPECTED_FINDINGS ?? 3);
const languageId = process.env.SMOKE_LANGUAGE_ID ?? languageIdForFile(filePath);
let saveSent = false;
const dataDirectory = await mkdtemp(resolve(tmpdir(), "code-inspection-lsp-smoke-"));
if (process.env.CODE_INSPECTION_LSP_PRETRUST === "1") await new TrustStore(dataDirectory).grant(workspace);
const child = spawn(process.execPath, [lspEntry], {
  cwd: workspace,
  env: { ...process.env, CODE_INSPECTION_DATA_DIR: dataDirectory, CODE_INSPECTION_IDLE_TIMEOUT_MS: "100" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
const diagnosticWaiters = [];
connection.onNotification("textDocument/publishDiagnostics", (params) => {
  for (let index = diagnosticWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = diagnosticWaiters[index];
    if (!waiter || !waiter.matches(params)) continue;
    diagnosticWaiters.splice(index, 1);
    waiter.resolve(params);
  }
});

try {
  await withTimeout(async () => {
    connection.listen();
    const initialized = await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: workspaceUri,
      capabilities: {},
      initializationOptions: process.env.CODE_INSPECTION_LSP_TRUSTED === "false" ? {} : { trusted: true },
      workspaceFolders: [{ uri: workspaceUri, name: "fixture" }]
    });
    assert.equal(initialized.capabilities.textDocumentSync.change, 2);
    connection.sendNotification("initialized", {});
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: fileUri,
        languageId,
        version: 1,
        text: await readFile(filePath, "utf8")
      }
    });
    saveSent = true;
    connection.sendNotification("textDocument/didSave", { textDocument: { uri: fileUri } });
    const result = await waitForDiagnostics((params) => saveSent && params.uri === fileUri && params.diagnostics.length === expected);
    assert.equal(result.diagnostics.length, expected, `Expected ${expected} diagnostics, not a service error.`);
    for (const diagnostic of result.diagnostics) {
      if (process.env.SMOKE_CHECK_ID) assert.equal(diagnostic.source, `code-inspection/${process.env.SMOKE_CHECK_ID}`);
      assert.ok(diagnostic.severity >= 1 && diagnostic.severity <= 4);
      if (process.env.SMOKE_REQUIRE_CODE === "1") assert.ok(diagnostic.code);
      assert.ok(diagnostic.range.start.line >= 0 && diagnostic.range.start.character >= 0);
    }
    if (process.env.SMOKE_TEST_CHANGE === "1") {
      const changedText = `${await readFile(filePath, "utf8")}\n`;
      const staleDiagnostics = waitForDiagnostics((params) => params.uri === fileUri
        && params.diagnostics.length === expected
        && params.diagnostics.every((diagnostic) => String(diagnostic.message).startsWith("[stale] ")));
      connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: fileUri, version: 2 },
        contentChanges: [{ text: changedText }]
      });
      await staleDiagnostics;
      process.stdout.write("LSP stale-change smoke passed.\n");
    }
    process.stdout.write(`LSP smoke passed: ${result.diagnostics.length} diagnostic(s) for ${process.env.SMOKE_CHECK_ID ?? "configured checks"}.\n`);
    await connection.sendRequest("shutdown");
    connection.sendNotification("exit");
  }, 15_000, "LSP smoke");
} finally {
  connection.dispose();
  child.kill();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  await rm(dataDirectory, { recursive: true, force: true });
}

function waitForDiagnostics(matches) {
  return new Promise((resolvePromise) => {
    diagnosticWaiters.push({ matches, resolve: resolvePromise });
  });
}

function languageIdForFile(file) {
  const extension = extname(file).toLowerCase();
  return {
    ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
    ".py": "python", ".pyi": "python", ".java": "java", ".go": "go", ".rs": "rust",
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".h": "cpp"
  }[extension] ?? "plaintext";
}
