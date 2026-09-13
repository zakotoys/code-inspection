#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { z } from "zod";
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
  LANGUAGE_IDS,
  TrustStore,
  type Finding,
  type InspectionRun
} from "@zakotoys/code-inspection-core";
import { connectWorkspaceService, type WorkspaceClient } from "./ipc.js";
import { createStderrLogger } from "./logger.js";
import { VERSION } from "./version.js";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const logger = createStderrLogger("lsp");
let client: WorkspaceClient | undefined;
let root: string | undefined;
let executionTrusted = false;
const publishedUris = new Set<string>();
// LSP notifications are asynchronous. Serialize publication so an older
// snapshot cannot arrive after a newer save/change snapshot and overwrite it
// in the editor.
let publicationTail: Promise<void> = Promise.resolve();
// Preserve the order in which the client delivered didChange/didSave/delete
// notifications before making asynchronous IPC calls. Without this queue a
// fast save could complete before the preceding change request and publish a
// stale snapshot last.
let documentEventTail: Promise<void> = Promise.resolve();

const lspPath = z.string().min(1).max(4096);
const lspRunSchema = z.object({
  checkId: z.string().trim().min(1).max(128).optional(),
  language: z.enum(LANGUAGE_IDS).optional(),
  project: lspPath.optional(),
  files: z.array(lspPath).max(100).optional()
}).strict();
const lspListSchema = z.object({ includeDisabled: z.boolean().optional() }).strict();
const lspCancelSchema = z.object({ runId: lspPath }).strict();

function parseLspRequest<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const result = schema.safeParse(value === undefined ? {} : value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
  throw new Error(`Invalid ${operation} request: ${details}`);
}

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
      },
      workspace: {
        fileOperations: {
          didDelete: { filters: [{ scheme: "file", pattern: { glob: "**/*", matches: "file" } }] }
        }
      }
    },
    serverInfo: { name: "code-inspection", version: VERSION }
  };
});

connection.onNotification("codeInspection/trust", async () => {
  if (!root) return;
  await new TrustStore().grant(root);
  executionTrusted = true;
});

connection.onNotification("initialized", () => {
  void queuePublish().catch((error) => logger.debug("Unable to publish existing findings", error));
});

documents.onDidChangeContent((event) => {
  void queueDocumentEvent(() => markChanged(event.document.uri));
});

documents.onDidSave((event) => {
  void queueDocumentEvent(() => inspectSaved({ textDocument: { uri: event.document.uri } }));
});

connection.workspace.onDidDeleteFiles((event) => {
  void queueDocumentEvent(() => handleDeletedFiles(event.files));
});

connection.onRequest("codeInspection/run", async (rawParams: unknown = {}) => {
  if (!executionTrusted) throw new Error("The workspace is untrusted. Trust it in the editor or with code-inspection trust before running project tools.");
  const params = parseLspRequest(lspRunSchema, rawParams, "codeInspection/run");
  const activeClient = requireClient();
  const checkId = params.checkId ?? (await activeClient.api.listInspectors()).inspectors.find((item) => item.enabled)?.id;
  if (!checkId) throw new Error("No enabled inspection check is configured in .code-inspection.json.");
  const response = await activeClient.api.runInspection({ checkId, ...(params.language ? { language: params.language } : {}), ...(params.project ? { project: params.project } : {}), ...(params.files ? { scope: { files: params.files } } : {}), trigger: "manual" });
  void waitForRun(response.run.runId).then(() => queuePublish()).catch((error) => logger.error("Manual inspection failed", error));
  return response.run;
});

connection.onRequest("codeInspection/listInspectors", async (rawParams: unknown = {}) => {
  const params = parseLspRequest(lspListSchema, rawParams, "codeInspection/listInspectors");
  return requireClient().api.listInspectors(params);
});

connection.onRequest("codeInspection/cancel", async (rawParams: unknown) => {
  const params = parseLspRequest(lspCancelSchema, rawParams, "codeInspection/cancel");
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
    await queuePublish();
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
    // didChange marks the prior result stale immediately. Publish that state
    // instead of leaving the editor showing a result that no longer matches
    // the in-memory document until the next save completes.
    await queuePublish();
  } catch (error) {
    logger.debug("Unable to mark dirty file", error);
  }
}

async function handleDeletedFiles(files: Array<{ uri: string }>): Promise<void> {
  try {
    const activeClient = requireClient();
    for (const { uri } of files) {
      if (!uri.startsWith("file:")) continue;
      await activeClient.api.didDelete({ file: fileURLToPath(uri) });
    }
    await queuePublish();
  } catch (error) {
    logger.debug("Unable to clear deleted file findings", error);
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

function queuePublish(): Promise<void> {
  const next = publicationTail.then(() => publishAll(), () => publishAll());
  publicationTail = next.catch((error) => {
    logger.debug("Unable to publish diagnostics", error);
  });
  return next;
}

function queueDocumentEvent(task: () => Promise<void>): Promise<void> {
  const next = documentEventTail.then(task, task);
  documentEventTail = next.catch((error) => {
    logger.debug("Unable to process document event", error);
  });
  return next;
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
    ...(finding.code ? { code: finding.code } : {}),
    ...(finding.relatedInformation
      ? {
          relatedInformation: finding.relatedInformation.flatMap((related) => {
            if (!related.file || !related.range) return [];
            return [{
              location: { uri: related.file, range: related.range },
              message: related.message
            }];
          })
        }
      : {})
  };
}

function fullDocumentRange(uri: string): { start: { line: number; character: number }; end: { line: number; character: number } } {
  const document = uri ? documents.get(uri) : undefined;
  if (!document) return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length) };
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
  const trusted = value.trusted;
  if (typeof trusted !== "boolean") throw new Error("Invalid initializationOptions.trusted: expected a boolean.");
  return trusted;
}

documents.listen(connection);
connection.listen();
