import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

const languageClients = new Map<string, LanguageClient>();
let lastRunId: string | undefined;
let lastRunClient: LanguageClient | undefined;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Code Inspection");
  context.subscriptions.push(output);
  const runtimePath = vscode.workspace.getConfiguration("codeInspection").get<string>("runtimePath", "");
  const bundledLsp = context.asAbsolutePath("server/lsp.js");
  const startClients = async (): Promise<void> => {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const currentUris = new Set(workspaceFolders.map((folder) => folder.uri.toString()));
    for (const [uri, client] of languageClients) {
      if (!currentUris.has(uri)) {
        languageClients.delete(uri);
        await client.stop();
      }
    }
    for (const [index, workspaceFolder] of workspaceFolders.entries()) {
      const uri = workspaceFolder.uri.toString();
      if (languageClients.has(uri)) continue;
      const command = runtimePath || process.execPath;
      const args = runtimePath ? [] : [bundledLsp];
      const serverOptions: ServerOptions = {
        run: { command, args, options: { cwd: workspaceFolder.uri.fsPath } },
        debug: { command, args, options: { cwd: workspaceFolder.uri.fsPath } }
      };
      const clientOptions: LanguageClientOptions = {
        documentSelector: [
          { scheme: "file", language: "javascript" },
          { scheme: "file", language: "javascriptreact" },
          { scheme: "file", language: "typescript" },
          { scheme: "file", language: "typescriptreact" }
        ],
        initializationOptions: { trusted: vscode.workspace.isTrusted },
        workspaceFolder
      };
      const client = new LanguageClient(`codeInspection-${index}`, "Code Inspection", serverOptions, clientOptions);
      languageClients.set(uri, client);
      context.subscriptions.push(client);
      try {
        await client.start();
      } catch (error) {
        languageClients.delete(uri);
        output.appendLine(`Unable to start inspection for ${workspaceFolder.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (workspaceFolders.length === 0) output.appendLine("Code Inspection is waiting for a workspace.");
  };

  await startClients();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void startClients(); }));

  context.subscriptions.push(vscode.commands.registerCommand("codeInspection.run", async () => {
    const inspector = vscode.workspace.getConfiguration("codeInspection").get<"eslint" | "typescript" | "build">("defaultInspector", "eslint");
    try {
      const client = clientForActiveEditor();
      if (!client) throw new Error("No workspace language server is available.");
      const result = await client.sendRequest<{ runId: string }>("codeInspection/run", { inspector });
      lastRunId = result?.runId;
      lastRunClient = client;
      output.appendLine(`Started ${inspector} inspection${lastRunId ? ` (${lastRunId})` : ""}.`);
      output.show(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`Code Inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("codeInspection.cancel", async () => {
    if (!lastRunId) {
      void vscode.window.showInformationMessage("Code Inspection has no active run to cancel.");
      return;
    }
    try {
      await lastRunClient?.sendRequest("codeInspection/cancel", { runId: lastRunId });
      output.appendLine(`Cancelled ${lastRunId}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Code Inspection cancel failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  const definitionChanges = registerMcpProvider(context, bundledLsp);
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    for (const client of languageClients.values()) void client.sendNotification("codeInspection/trust");
    definitionChanges?.fire();
  }));
}

function registerMcpProvider(context: vscode.ExtensionContext, _bundledLsp: string): vscode.EventEmitter<void> | undefined {
  const api = vscode.lm;
  if (!api) return undefined;
  const bundledMcp = context.asAbsolutePath("server/mcp.js");
  const definitionChanges = new vscode.EventEmitter<void>();
  context.subscriptions.push(definitionChanges);
  context.subscriptions.push(api.registerMcpServerDefinitionProvider("codeInspection", {
    onDidChangeMcpServerDefinitions: definitionChanges.event,
    provideMcpServerDefinitions: async () => {
      if (!vscode.workspace.isTrusted) return [];
      return (vscode.workspace.workspaceFolders ?? []).map((workspaceFolder) => {
        const definition = new vscode.McpStdioServerDefinition("Code Inspection", process.execPath, [bundledMcp], { CODE_INSPECTION_WORKSPACE: workspaceFolder.uri.fsPath }, "0.1.0");
        definition.cwd = workspaceFolder.uri;
        return definition;
      });
    },
    resolveMcpServerDefinition: async (definition) => definition
  }));
  return definitionChanges;
}

export async function deactivate(): Promise<void> {
  await Promise.all([...languageClients.values()].map((client) => client.stop()));
  languageClients.clear();
}

function clientForActiveEditor(): LanguageClient | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = editorUri ? vscode.workspace.getWorkspaceFolder(editorUri) : vscode.workspace.workspaceFolders?.[0];
  return activeFolder ? languageClients.get(activeFolder.uri.toString()) : undefined;
}
