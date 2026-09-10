import * as vscode from "vscode";
import { type DiagnosticSnapshot, DiagnosticStore } from "./store";

export class WorkspaceDiagnostics implements vscode.Disposable {
  private readonly store = new DiagnosticStore();
  private readonly subscriptions: vscode.Disposable[];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor() {
    this.subscriptions = [
      vscode.languages.onDidChangeDiagnostics(({ uris }) => {
        for (const uri of uris) this.refresh(uri);
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.store.retain((uri) => this.inScope(vscode.Uri.parse(uri)));
        this.seed();
        this.changed.fire();
      }),
    ];
    this.seed();
  }

  private inScope(uri: vscode.Uri): boolean {
    return uri.scheme === "file" && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
  }

  private refresh(uri: vscode.Uri): void {
    this.store.replace(
      uri.toString(),
      this.inScope(uri) ? vscode.languages.getDiagnostics(uri) : [],
    );
  }

  private seed(): void {
    for (const [uri] of vscode.languages.getDiagnostics()) this.refresh(uri);
  }

  snapshot(): DiagnosticSnapshot {
    return this.store.snapshot();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
