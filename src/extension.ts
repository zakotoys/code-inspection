import * as vscode from "vscode";
import { WorkspaceDiagnostics } from "./vscode-source";

export interface DetectorStatus {
  state: "ready";
  workspaceFolderCount: number;
  diagnosticsEnabled: true;
  mcpEnabled: false;
  errors: number;
  warnings: number;
}

export function activate(context: vscode.ExtensionContext): void {
  const source = new WorkspaceDiagnostics();
  const output = vscode.window.createOutputChannel("Code Inspection");
  let reportRequested = false;
  const render = () => {
    const snapshot = source.snapshot();
    output.clear();
    output.appendLine(
      "当前工作区已发布诊断（0 基位置）；空列表不代表全项目检查通过。MCP 尚未启用。",
    );
    output.appendLine(JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  context.subscriptions.push(
    source,
    output,
    source.onDidChange(() => {
      if (reportRequested) render();
    }),
    vscode.commands.registerCommand("codeInspection.showDiagnostics", () => {
      reportRequested = true;
      const snapshot = render();
      output.show(true);
      return snapshot;
    }),
    vscode.commands.registerCommand("codeInspection.showStatus", (): DetectorStatus => {
      const snapshot = source.snapshot();
      const status: DetectorStatus = {
        state: "ready",
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        diagnosticsEnabled: true,
        mcpEnabled: false,
        errors: snapshot.errors,
        warnings: snapshot.warnings,
      };
      void vscode.window.showInformationMessage(
        `Code Inspection 已就绪；当前已知错误 ${status.errors}，警告 ${status.warnings}；MCP 尚未启用。`,
      );
      return status;
    }),
  );
}
