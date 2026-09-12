import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { withTimeout } from "./smoke-timeout.mjs";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { TrustStore } from "../packages/core/dist/index.js";

const repositoryRoot = resolve(".");
const workspace = resolve(process.argv[2] ?? "tests/fixtures/eslint-broken");
const lspEntry = resolve(repositoryRoot, process.argv[3] ?? "packages/runtime/dist/lsp.js");
const filePath = resolve(workspace, "broken.js");
const fileUri = pathToFileURL(filePath).href;
const workspaceUri = pathToFileURL(workspace).href;
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
const diagnostics = new Promise((resolvePromise) => {
  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    if (params.uri === fileUri) {
      resolvePromise(params);
    }
  });
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
        languageId: "javascript",
        version: 1,
        text: await readFile(filePath, "utf8")
      }
    });
    connection.sendNotification("textDocument/didSave", { textDocument: { uri: fileUri } });
    const result = await diagnostics;
    assert.equal(result.diagnostics.length, 3, "Expected three ESLint diagnostics, not a service error.");
    for (const diagnostic of result.diagnostics) {
      assert.equal(diagnostic.source, "code-inspection/eslint");
      assert.equal(diagnostic.severity, 1);
      assert.ok(diagnostic.code);
      assert.ok(diagnostic.range.start.line >= 0 && diagnostic.range.start.character >= 0);
    }
    process.stdout.write(`LSP smoke passed: ${result.diagnostics.length} diagnostic(s).\n`);
    await connection.sendRequest("shutdown");
    connection.sendNotification("exit");
  }, 15_000, "LSP smoke");
} finally {
  connection.dispose();
  child.kill();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  await rm(dataDirectory, { recursive: true, force: true });
}
