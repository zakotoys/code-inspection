import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { DetectorStatus } from "../src/extension";
import type { DiagnosticSnapshot } from "../src/store";

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
  try {
    const expected: DetectorStatus = {
      state: "ready",
      workspaceFolderCount: folder ? 1 : 0,
      diagnosticsEnabled: true,
      mcpEnabled: false,
      errors: 0,
      warnings: folder ? 1 : 0,
    };
    assert.deepEqual(await vscode.commands.executeCommand("codeInspection.showStatus"), expected);
    assert.equal(extension.isActive, true);
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
        await replace('export const count: number = "wrong";\n');
        await until(
          async () =>
            (await snapshot()).diagnostics.some(
              (d) => d.uri === uri.toString() && d.code === 2322 && d.severity === "error",
            ),
          "real TS2322 appears before save",
        );
        assert.equal(document.isDirty, true, "G2 observes unsaved diagnostics");
        assert.equal(await document.save(), true);
        const observed = await snapshot();
        for (let i = 0; i < 3; i++)
          assert.deepEqual((await snapshot()).diagnostics, observed.diagnostics);
        await replace("export const count: number = 1;\n");
        await until(
          async () => !(await snapshot()).diagnostics.some((d) => d.uri === uri.toString()),
          "real TS2322 disappears after repair",
        );
        assert.equal(await document.save(), true);
      } finally {
        await replace("export const count: number = 1;\n");
        await document.save();
      }
      console.log(
        `PASS ${scenario}: real TypeScript TS2322, unsaved update, save, repeated read, repair`,
      );
    }
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["codeInspection.showStatus", "codeInspection.showDiagnostics"])
      assert.equal(commands.filter((c) => c === id).length, 1);
    console.log(
      `PASS ${scenario}: lazy activation, initial seed, workspace exclusion, duplicate and clear`,
    );
  } finally {
    collection.dispose();
  }
}
