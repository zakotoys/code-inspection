import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
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
const diagnostics = new Promise((resolvePromise, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timed out waiting for LSP diagnostics.")), 10_000);
  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    if (params.uri === fileUri) {
      clearTimeout(timeout);
      resolvePromise(params);
    }
  });
});

try {
  connection.listen();
  await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: workspaceUri,
    capabilities: {},
    initializationOptions: process.env.CODE_INSPECTION_LSP_TRUSTED === "false" ? {} : { trusted: true },
    workspaceFolders: [{ uri: workspaceUri, name: "fixture" }]
  });
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
  if (!Array.isArray(result.diagnostics) || result.diagnostics.length === 0) throw new Error("LSP save produced no diagnostics for the broken fixture.");
  process.stdout.write(`LSP smoke passed: ${result.diagnostics.length} diagnostic(s).\n`);
  await connection.sendRequest("shutdown");
  connection.sendNotification("exit");
} finally {
  connection.dispose();
  child.kill();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  await rm(dataDirectory, { recursive: true, force: true });
}
