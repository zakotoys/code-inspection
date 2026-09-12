import * as vscode from "vscode";
import type { DetectorRuntimeStatus, EnvironmentSupport } from "./environment";
import type { SaveBatchQuery } from "./save-history";
import { type SaveObservationSnapshot, SaveObservations } from "./save-observations";
import { type DiagnosticSnapshot, DiagnosticStore } from "./store";

export class WorkspaceDiagnostics implements vscode.Disposable {
  private readonly store = new DiagnosticStore();
  private readonly subscriptions: vscode.Disposable[];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly batchesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeSaveObservations = this.batchesChanged.event;
  private readonly saves = new SaveObservations(
    (uri) => this.store.snapshot().diagnostics.filter((entry) => entry.uri === uri),
    () => this.batchesChanged.fire(),
  );

  constructor(private readonly support: EnvironmentSupport) {
    if (!support.supported) {
      this.subscriptions = [];
      return;
    }
    this.subscriptions = [
      vscode.languages.onDidChangeDiagnostics(({ uris }) => {
        for (const uri of uris) {
          this.refresh(uri);
          this.saves.diagnosticsChanged(uri.toString());
        }
        this.changed.fire();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.inScope(document.uri)) return;
        this.refresh(document.uri);
        this.saves.saved(document.uri.toString(), document.version);
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        if (contentChanges.length) this.saves.edited(document.uri.toString());
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.saves.forget(document.uri.toString(), "closed");
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.saves.retain((uri) => this.inScope(vscode.Uri.parse(uri)));
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

  detectorStatus(): DetectorRuntimeStatus {
    return {
      state: !this.support.supported ? "unsupported" : this.saves.isPaused() ? "paused" : "ready",
      diagnosticsEnabled: this.support.supported,
      unsupportedReason: this.support.reason,
    };
  }

  setPaused(paused: boolean): void {
    if (this.support.supported) this.saves.setPaused(paused);
  }

  snapshot(): DiagnosticSnapshot {
    return this.store.snapshot();
  }

  saveSnapshot(): SaveObservationSnapshot {
    return this.saves.snapshot();
  }

  saveBatches(query: SaveBatchQuery = {}) {
    return this.saves.readBatches(query);
  }

  saveHistoryStatus() {
    return this.saves.historyStatus();
  }

  dispose(): void {
    this.saves.dispose();
    this.batchesChanged.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
