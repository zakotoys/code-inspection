import * as assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as vscode from "vscode";
import type { DetectorStatus, InspectionApi } from "../src/extension";
import type { SaveBatchPage } from "../src/save-history";
import type { SaveObservationSnapshot } from "../src/save-observations";
import type { DiagnosticSnapshot } from "../src/store";

async function saveSnapshot(): Promise<SaveObservationSnapshot> {
  return vscode.commands.executeCommand<SaveObservationSnapshot>(
    "codeInspection.showSaveObservations",
  );
}
async function snapshot(): Promise<DiagnosticSnapshot> {
  return vscode.commands.executeCommand<DiagnosticSnapshot>("codeInspection.showDiagnostics");
}
async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}; snapshot=${JSON.stringify(await snapshot())}`);
}
export async function run(): Promise<void> {
  const scenario = process.env.CODE_INSPECTION_TEST_SCENARIO;
  assert.ok(scenario === "empty" || scenario === "workspace" || scenario === "restart");
  const extension = vscode.extensions.getExtension("zakotoys.code-inspection");
  assert.ok(extension);
  const installedRoot = process.env.CODE_INSPECTION_INSTALLED_DIR;
  if (installedRoot) {
    const relative = path.relative(installedRoot, extension.extensionPath);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "Product must load from installed extensions directory",
    );
    assert.equal(extension.packageJSON.main, "./dist/extension.cjs");
    console.log(
      `PASS ${scenario}: installed VSIX product loaded from isolated extensions directory`,
    );
  }
  assert.equal(extension.isActive, false);
  const collection = vscode.languages.createDiagnosticCollection("g2-fixture");
  const folder = vscode.workspace.workspaceFolders?.[0];
  const outside = vscode.Uri.file(process.env.CODE_INSPECTION_OUTSIDE_FILE ?? "");
  const synthetic = folder ? vscode.Uri.joinPath(folder.uri, "synthetic.ts") : outside;
  const diag = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 1),
    "G2 existing warning",
    vscode.DiagnosticSeverity.Warning,
  );
  diag.source = "g2-fixture";
  collection.set(synthetic, [diag]);
  let client: Client | undefined;
  let api: InspectionApi | undefined;
  const remoteBatches = async (args: Record<string, unknown> = {}) => {
    assert.ok(client);
    const response = await client.callTool({ name: "get_save_batches", arguments: args });
    assert.ok("content" in response && response.structuredContent);
    return response.structuredContent as SaveBatchPage;
  };
  const remoteDiagnostics = async () => {
    assert.ok(client);
    const response = await client.callTool({ name: "get_diagnostics", arguments: {} });
    assert.ok("content" in response && !response.isError);
    const data = response.structuredContent as Record<string, unknown>;
    return data.diagnostics as DiagnosticSnapshot["diagnostics"];
  };
  try {
    const expected: DetectorStatus = {
      state: "ready",
      unsupportedReason: null,
      workspaceFolderCount: folder ? 1 : 0,
      diagnosticsEnabled: true,
      mcpEnabled: false,
      errors: 0,
      warnings: folder ? 1 : 0,
    };
    assert.deepEqual(await vscode.commands.executeCommand("codeInspection.showStatus"), expected);
    assert.equal(extension.isActive, true);

    assert.equal((await saveSnapshot()).latest, null);
    assert.deepEqual((await saveSnapshot()).pending, []);
    api = extension.exports as InspectionApi;
    const [connection, simultaneous] = await Promise.all([api.startMcp(), api.startMcp()]);
    assert.equal(connection.url, simultaneous.url, "Concurrent starts must share one listener");
    const status = await vscode.commands.executeCommand<DetectorStatus>(
      "codeInspection.showStatus",
    );
    assert.equal(status.mcpEnabled, true);
    client = new Client({ name: "extension-host-g3", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 3);
    const commandResult = await vscode.commands.executeCommand<{ diagnostics: unknown[] }>(
      "codeInspection.inspectMcp",
    );
    assert.ok(commandResult, "In-window MCP query must succeed without clipboard");
    assert.deepEqual(commandResult.diagnostics, await remoteDiagnostics());
    assert.equal(JSON.stringify(commandResult).includes(connection.token), false);
    assert.deepEqual(
      await remoteDiagnostics(),
      (await snapshot()).diagnostics.map((d) => ({ ...d, textTruncated: false })),
    );
    const denied = await client.callTool({
      name: "get_diagnostics",
      arguments: { uri: outside.toString() },
    });
    assert.equal(denied.isError, true);
    const initial = await snapshot();
    assert.equal(
      initial.warnings,
      folder ? 1 : 0,
      "seed includes existing in-scope diagnostics only",
    );
    collection.set(outside, [diag]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(!(await snapshot()).diagnostics.some((d) => d.uri === outside.toString()));
    collection.set(synthetic, [diag, diag]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      (await snapshot()).revision,
      initial.revision,
      "duplicate publication does not grow state",
    );
    collection.clear();
    await until(
      async () => (await snapshot()).diagnostics.length === 0,
      "synthetic diagnostics removed",
    );
    if (folder) {
      const tsExtension = vscode.extensions.getExtension("vscode.typescript-language-features");
      assert.ok(tsExtension, "Built-in TypeScript language service must be available");
      await tsExtension.activate();
      const uri = vscode.Uri.joinPath(folder.uri, "sample.ts");
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const replace = async (text: string) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          text,
        );
        assert.equal(await vscode.workspace.applyEdit(edit), true);
      };
      try {
        await replace("export const count: number = 2;\n");
        assert.equal(await document.save(), true);
        await until(
          async () => (await saveSnapshot()).latest?.state === "observed",
          "first save baseline completes",
        );
        const baseline = (await saveSnapshot()).latest;
        assert.ok(baseline?.state === "observed" && baseline.baseline);
        assert.deepEqual(baseline.added, []);
        assert.deepEqual(baseline.diagnostics, []);
        await replace('export const count: number = "wrong";\n');
        await until(
          async () =>
            (await snapshot()).diagnostics.some(
              (d) => d.uri === uri.toString() && d.code === 2322 && d.severity === "error",
            ),
          "real TS2322 appears before save",
        );
        assert.equal(document.isDirty, true, "G2 observes unsaved diagnostics");
        await until(
          async () =>
            (await remoteDiagnostics()).some((d) => d.code === 2322 && d.uri === uri.toString()),
          "MCP reads real TS2322",
        );
        assert.equal(await document.save(), true);
        const savedVersion = document.version;
        await until(async () => {
          const batch = (await saveSnapshot()).latest;
          return batch?.state === "observed" && batch.documentVersion === savedVersion;
        }, "saved TS2322 batch completes");
        const errorBatch = (await saveSnapshot()).latest;
        assert.ok(errorBatch?.state === "observed" && !errorBatch.baseline);
        assert.ok(errorBatch.added.some((d) => d.code === 2322));
        const observed = await snapshot();
        for (let i = 0; i < 3; i++)
          assert.deepEqual((await snapshot()).diagnostics, observed.diagnostics);
        await replace("export const count: number = 1;\n");
        await until(
          async () => !(await snapshot()).diagnostics.some((d) => d.uri === uri.toString()),
          "real TS2322 disappears after repair",
        );
        await until(
          async () => !(await remoteDiagnostics()).some((d) => d.uri === uri.toString()),
          "MCP observes repaired diagnostics",
        );
        assert.equal(await document.save(), true);
        const repairedVersion = document.version;
        await until(async () => {
          const batch = (await saveSnapshot()).latest;
          return batch?.state === "observed" && batch.documentVersion === repairedVersion;
        }, "saved repair batch completes");
        const repairBatch = (await saveSnapshot()).latest;
        assert.ok(repairBatch?.state === "observed");
        assert.deepEqual(repairBatch.diagnostics, []);
        assert.ok(repairBatch.resolved.some((d) => d.code === 2322));
        await replace("export const count: number = 2;\n");
        assert.equal(await document.save(), true);
        const pending = (await saveSnapshot()).pending.find(
          (entry) => entry.uri === uri.toString(),
        );
        assert.ok(pending);
        await replace("export const count: number = 3;\n");
        await until(
          async () => (await saveSnapshot()).latest?.state === "invalidated",
          "editing after save invalidates old observation",
        );
        const invalidated = (await saveSnapshot()).latest;
        assert.equal(invalidated?.batchId, pending.batchId);
        assert.equal(invalidated?.reason, "edited");
        assert.equal(invalidated?.diagnostics, null);
        console.log(
          `PASS ${scenario}: G4 baseline, saved TS2322 addition, saved repair, edit invalidation`,
        );
      } finally {
        await replace("export const count: number = 1;\n");
        await document.save();
      }
      console.log(
        `PASS ${scenario}: real TypeScript TS2322, unsaved update, save, repeated read, repair`,
      );
    }
    await until(
      async () => (await saveSnapshot()).pending.length === 0,
      "final save observation finishes",
    );
    const historyFirst = await remoteBatches({ limit: 1 });
    assert.ok("batches" in historyFirst);
    assert.deepEqual(await remoteBatches({ limit: 1 }), historyFirst);
    const all = await remoteBatches({ limit: 10 });
    assert.ok("batches" in all);
    if (folder) {
      assert.ok(
        all.batches.some(
          (record) =>
            !record.payloadOmitted &&
            record.batch.state === "observed" &&
            record.batch.added.some((d) => d.code === 2322),
        ),
      );
      assert.ok(
        all.batches.some(
          (record) =>
            !record.payloadOmitted &&
            record.batch.state === "observed" &&
            record.batch.resolved.some((d) => d.code === 2322),
        ),
      );
      assert.ok(all.batches.some((record) => record.batch.state === "invalidated"));
      const following = await remoteBatches({
        sessionId: historyFirst.sessionId,
        afterCursor: historyFirst.nextCursor,
        limit: 10,
      });
      assert.ok("batches" in following);
      assert.deepEqual(following.batches, all.batches.slice(1));
    } else assert.deepEqual(all.batches, []);
    const independent = new Client({ name: "independent-history-reader", version: "1.0.0" });
    try {
      await independent.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
        }),
      );
      const response = await independent.callTool({
        name: "get_save_batches",
        arguments: { limit: 10 },
      });
      assert.ok("content" in response);
      assert.deepEqual(response.structuredContent, all);
    } finally {
      await independent.close();
    }
    const firstCommand = await vscode.commands.executeCommand<SaveBatchPage>(
      "codeInspection.inspectSaveBatches",
    );
    assert.ok(firstCommand && "batches" in firstCommand);
    const nextCommand = await vscode.commands.executeCommand<SaveBatchPage>(
      "codeInspection.inspectSaveBatches",
    );
    assert.ok(nextCommand && "batches" in nextCommand);
    assert.deepEqual(nextCommand.batches, []);
    await vscode.commands.executeCommand("codeInspection.resetSaveBatchCursor");
    assert.deepEqual(
      await vscode.commands.executeCommand("codeInspection.inspectSaveBatches"),
      firstCommand,
    );
    console.log(
      `PASS ${scenario}: G5 MCP history, independent readers, replay, pagination, command continuation and reset`,
    );
    await vscode.commands.executeCommand("codeInspection.pause");
    assert.equal((await saveSnapshot()).state, "paused");
    assert.equal(
      (await vscode.commands.executeCommand<DetectorStatus>("codeInspection.showStatus")).state,
      "paused",
    );
    const pausedStatus = await client.callTool({ name: "get_detector_status", arguments: {} });
    assert.ok("content" in pausedStatus);
    assert.equal((pausedStatus.structuredContent as { state: string }).state, "paused");
    assert.equal((await saveSnapshot()).history.retainedCount, 0);
    const staleBeforePause = await remoteBatches({ sessionId: all.sessionId, afterCursor: 0 });
    assert.ok("reason" in staleBeforePause && staleBeforePause.reason === "SESSION_CHANGED");
    if (folder) {
      const pauseUri = vscode.Uri.joinPath(folder.uri, "sample.ts");
      const pauseDocument = await vscode.workspace.openTextDocument(pauseUri);
      const setText = async (text: string) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          pauseUri,
          new vscode.Range(
            pauseDocument.positionAt(0),
            pauseDocument.positionAt(pauseDocument.getText().length),
          ),
          text,
        );
        assert.ok(await vscode.workspace.applyEdit(edit));
      };
      await setText('export const count: number = "paused-error";\n');
      await until(
        async () =>
          (await remoteDiagnostics()).some((d) => d.uri === pauseUri.toString() && d.code === 2322),
        "current diagnostics still update while paused",
      );
      await pauseDocument.save();
      assert.equal((await saveSnapshot()).pending.length, 0);
      assert.equal((await saveSnapshot()).history.latestCursor, 0);
      await vscode.commands.executeCommand("codeInspection.resume");
      await setText('export const count: number = "paused-error";\n\n');
      await pauseDocument.save();
      await until(
        async () => (await saveSnapshot()).latest?.state === "observed",
        "resume creates a fresh baseline",
      );
      const resumed = (await saveSnapshot()).latest;
      assert.ok(resumed?.state === "observed" && resumed.baseline);
      assert.deepEqual(resumed.added, []);
      assert.ok(resumed.diagnostics.some((d) => d.code === 2322));
      await setText("export const count: number = 1;\n");
      await pauseDocument.save();
      await until(
        async () => (await saveSnapshot()).pending.length === 0,
        "post-resume save completes",
      );
    } else await vscode.commands.executeCommand("codeInspection.resume");
    assert.equal(
      (await vscode.commands.executeCommand<DetectorStatus>("codeInspection.showStatus")).state,
      "ready",
    );
    console.log(
      `PASS ${scenario}: G6 pause, clear history, status, resume baseline and continued diagnostics`,
    );
    const historySessionId = (await saveSnapshot()).history.sessionId;
    const historyEnd = (await saveSnapshot()).history.latestCursor;
    await client.close();
    client = undefined;
    await vscode.commands.executeCommand("codeInspection.stopMcp");
    await assert.rejects(fetch(connection.url, { signal: AbortSignal.timeout(2000) }));
    assert.equal(
      (await vscode.commands.executeCommand<DetectorStatus>("codeInspection.showStatus"))
        .mcpEnabled,
      false,
    );
    const restarted = await api.startMcp();
    assert.notEqual(restarted.sessionId, connection.sessionId);
    assert.notEqual(restarted.token, connection.token);
    client = new Client({ name: "restarted-transport-history-check", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(restarted.url), {
        requestInit: { headers: { Authorization: `Bearer ${restarted.token}` } },
      }),
    );
    const continued = await remoteBatches({
      sessionId: historySessionId,
      afterCursor: historyEnd,
    });
    assert.ok("batches" in continued);
    assert.deepEqual(continued.batches, []);
    assert.equal(
      continued.sessionId,
      historySessionId,
      "MCP restart preserves collection history session",
    );
    const record = process.env.CODE_INSPECTION_CONNECTION_RECORD;
    assert.ok(record);
    if (scenario === "restart") {
      const previous = JSON.parse(await readFile(record, "utf8"));
      assert.notEqual(restarted.sessionId, previous.sessionId);
      assert.notEqual(historySessionId, previous.historySessionId);
      const stale = await remoteBatches({ sessionId: previous.historySessionId, afterCursor: 0 });
      assert.ok("reason" in stale && stale.reason === "SESSION_CHANGED");
    }
    await writeFile(
      record,
      JSON.stringify({ url: restarted.url, sessionId: restarted.sessionId, historySessionId }),
    );
    await vscode.commands.executeCommand("codeInspection.pause");
    // Leave this server running: the outer runner verifies host shutdown closes the port.
    console.log(
      `PASS ${scenario}: MCP tools, real diagnostics, scope, concurrent start, stop and restart`,
    );
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["codeInspection.showStatus", "codeInspection.showDiagnostics"])
      assert.equal(commands.filter((c) => c === id).length, 1);
    console.log(
      `PASS ${scenario}: lazy activation, initial seed, workspace exclusion, duplicate and clear`,
    );
  } finally {
    await client?.close();
    collection.dispose();
  }
}
