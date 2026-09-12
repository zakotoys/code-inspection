#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type Diagnostic,
  type DidSaveTextDocumentParams,
  type InitializeParams,
  type InitializeResult
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  canonicalizeWorkspaceRoot,
  TrustStore,
  type Finding,
  type InspectionRun,
  type InspectorId
} from "@zakotoys/code-inspection-core";
import { connectWorkspaceService, type WorkspaceClient } from "./ipc.js";
import { createStderrLogger } from "./logger.js";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const logger = createStderrLogger("lsp");
let client: WorkspaceClient | undefined;
let root: string | undefined;
let executionTrusted = false;
const publishedUris = new Set<string>();

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  root = await workspaceRoot(params);
  const trustFlag = trustedInitialization(params.initializationOptions);
  if (trustFlag === true) {
    executionTrusted = true;
    await new TrustStore().grant(root);
  } else if (trustFlag === false) {
    executionTrusted = false;
  } else {
    executionTrusted = await new TrustStore().isTrusted(root);
  }
  client = await connectWorkspaceService(root, logger);
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false }
      }
    },
    serverInfo: { name: "code-inspection", version: "0.1.0" }
  };
});

connection.onNotification("codeInspection/trust", async () => {
  if (!root) return;
  await new TrustStore().grant(root);
  executionTrusted = true;
});

connection.onNotification("initialized", () => {
  void publishAll().catch((error) => logger.debug("Unable to publish existing findings", error));
});

documents.onDidChangeContent((event) => {
  void markChanged(event.document.uri);
});

documents.onDidSave((event) => {
  void inspectSaved({ textDocument: { uri: event.document.uri } });
});

connection.onRequest("codeInspection/run", async (params: { inspector?: InspectorId; files?: string[] } = {}) => {
  if (!executionTrusted) throw new Error("The workspace is untrusted. Trust it in the editor or with code-inspection trust before running project tools.");
  const activeClient = requireClient();
  const inspector = params.inspector ?? "eslint";
  const response = await activeClient.api.runInspection({ inspector, ...(params.files ? { scope: { files: params.files } } : {}), trigger: "manual" });
  void waitForRun(response.run.runId).then(() => publishAll()).catch((error) => logger.error("Manual inspection failed", error));
  return response.run;
});

connection.onRequest("codeInspection/cancel", async (params: { runId: string }) => {
  return requireClient().api.cancelRun({ runId: params.runId });
});

connection.onShutdown(async () => {
  client?.close();
});

async function inspectSaved(event: DidSaveTextDocumentParams): Promise<void> {
  try {
    if (!executionTrusted) throw new Error("The workspace is untrusted. Trust it in the editor or with code-inspection trust before running project tools.");
    const activeClient = requireClient();
    const savedFile = fileURLToPath(event.textDocument.uri);
    const response = await activeClient.api.didSave({ file: savedFile });
    for (const run of response.runs) {
      await waitForRun(run.runId);
    }
    await publishAll();
  } catch (error) {
    logger.error("Save inspection failed", error);
    const uri = event.textDocument.uri;
    connection.sendDiagnostics({ uri, diagnostics: [{ severity: DiagnosticSeverity.Error, source: "code-inspection", message: error instanceof Error ? error.message : String(error), range: fullDocumentRange(uri) }] });
  }
}

async function markChanged(uri: string): Promise<void> {
  try {
    const activeClient = requireClient();
    await activeClient.api.didChange({ file: fileURLToPath(uri) });
  } catch (error) {
    logger.debug("Unable to mark dirty file", error);
  }
}

async function publishAll(): Promise<void> {
  const activeClient = requireClient();
  const grouped = new Map<string, Diagnostic[]>();
  let offset = 0;
  for (;;) {
    const response = await activeClient.api.getFindings({ offset, limit: 500, includeStale: true });
    for (const finding of response.page.findings) {
      if (!finding.file) continue;
      const uri = finding.file;
      const values = grouped.get(uri) ?? [];
      values.push(toDiagnostic(finding));
      grouped.set(uri, values);
    }
    if (!response.page.hasMore) break;
    offset = response.page.nextOffset ?? offset + response.page.count;
  }
  for (const uri of publishedUris) {
    if (!grouped.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  for (const [uri, diagnostics] of grouped) {
    connection.sendDiagnostics({ uri, diagnostics });
    publishedUris.add(uri);
  }
}

async function waitForRun(runId: string): Promise<InspectionRun> {
  const activeClient = requireClient();
  for (;;) {
    const response = await activeClient.api.getRun({ runId });
    if (["completed", "failed", "cancelled", "superseded"].includes(response.snapshot.run.outcome)) {
      return response.snapshot.run;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function toDiagnostic(finding: Finding): Diagnostic {
  return {
    severity: finding.severity === "error" ? DiagnosticSeverity.Error : finding.severity === "warning" ? DiagnosticSeverity.Warning : finding.severity === "info" ? DiagnosticSeverity.Information : DiagnosticSeverity.Hint,
    range: finding.range ?? fullDocumentRange(finding.file ?? ""),
    message: finding.stale ? `[stale] ${finding.message}` : finding.message,
    source: `code-inspection/${finding.source}`,
    ...(finding.code ? { code: finding.code } : {})
  };
}

function fullDocumentRange(_uri: string): { start: { line: number; character: number }; end: { line: number; character: number } } {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}

async function workspaceRoot(params: InitializeParams): Promise<string> {
  const candidate = params.rootUri ?? params.workspaceFolders?.[0]?.uri;
  return canonicalizeWorkspaceRoot(candidate ? fileURLToPath(candidate) : process.cwd());
}

function requireClient(): WorkspaceClient {
  if (!client || !root) throw new Error("Code inspection language server is not initialized.");
  return client;
}

function trustedInitialization(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || !("trusted" in value)) return undefined;
  return value.trusted === true;
}

documents.listen(connection);
connection.listen();
