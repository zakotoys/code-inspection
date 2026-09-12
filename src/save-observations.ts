import { randomUUID } from "node:crypto";
import type { DiagnosticEntry } from "./diagnostics";
import { type SaveBatchQuery, SaveHistory, type SaveHistoryStatus } from "./save-history";

const QUIET_MS = 500;
const MAX_WAIT_MS = 2000;
interface SaveIdentity {
  batchId: string;
  uri: string;
  documentVersion: number;
  savedAt: string;
}
type InvalidReason = "edited" | "saved-again" | "closed" | "workspace-removed";
export type SaveBatch = SaveIdentity & { finishedAt: string } & (
    | {
        state: "observed";
        reason: "quiet-window" | "max-wait";
        baseline: boolean;
        diagnostics: DiagnosticEntry[];
        added: DiagnosticEntry[];
        resolved: DiagnosticEntry[];
      }
    | { state: "invalidated"; reason: InvalidReason; diagnostics: null }
  );
export interface SaveObservationSnapshot {
  sessionId: string;
  history: SaveHistoryStatus;
  state: "active" | "paused";
  quietMs: number;
  maxWaitMs: number;
  pending: SaveIdentity[];
  latest: SaveBatch | null;
}
interface Pending {
  identity: SaveIdentity;
  quiet: ReturnType<typeof setTimeout>;
  deadline: ReturnType<typeof setTimeout>;
}

/** Per-file save observations. Diagnostics have no document-version guarantee. */
export class SaveObservations {
  private readonly history = new SaveHistory();
  private readonly pending = new Map<string, Pending>();
  private readonly baselines = new Map<string, DiagnosticEntry[]>();
  private latest: SaveBatch | null = null;
  private disposed = false;
  private paused = false;

  constructor(
    private readonly read: (uri: string) => DiagnosticEntry[],
    private readonly changed: () => void,
  ) {}

  saved(uri: string, documentVersion: number): void {
    if (this.disposed || this.paused) return;
    this.invalidate(uri, "saved-again");
    const identity = {
      batchId: randomUUID(),
      uri,
      documentVersion,
      savedAt: new Date().toISOString(),
    };
    this.pending.set(uri, {
      identity,
      quiet: setTimeout(() => this.finish(uri, "quiet-window"), QUIET_MS),
      deadline: setTimeout(() => this.finish(uri, "max-wait"), MAX_WAIT_MS),
    });
    this.changed();
  }

  diagnosticsChanged(uri: string): void {
    const pending = this.pending.get(uri);
    if (!pending) return;
    clearTimeout(pending.quiet);
    pending.quiet = setTimeout(() => this.finish(uri, "quiet-window"), QUIET_MS);
  }

  edited(uri: string): void {
    this.invalidate(uri, "edited");
  }

  forget(uri: string, reason: "closed" | "workspace-removed"): void {
    this.invalidate(uri, reason);
    this.baselines.delete(uri);
  }

  retain(allowed: (uri: string) => boolean): void {
    for (const uri of new Set([...this.pending.keys(), ...this.baselines.keys()]))
      if (!allowed(uri)) this.forget(uri, "workspace-removed");
    this.history.reset();
    this.latest = null;
    this.changed();
  }

  private take(uri: string): Pending | undefined {
    const pending = this.pending.get(uri);
    if (pending) {
      clearTimeout(pending.quiet);
      clearTimeout(pending.deadline);
      this.pending.delete(uri);
    }
    return pending;
  }

  private invalidate(uri: string, reason: InvalidReason): void {
    const pending = this.take(uri);
    if (!pending) return;
    this.latest = {
      ...pending.identity,
      finishedAt: new Date().toISOString(),
      state: "invalidated",
      reason,
      diagnostics: null,
    };
    this.history.append(this.latest);
    this.changed();
  }

  private finish(uri: string, reason: "quiet-window" | "max-wait"): void {
    const pending = this.take(uri);
    if (!pending || this.disposed) return;
    const diagnostics = structuredClone(this.read(uri));
    const previous = this.baselines.get(uri);
    const oldKeys = new Set((previous ?? []).map((entry) => JSON.stringify(entry)));
    const newKeys = new Set(diagnostics.map((entry) => JSON.stringify(entry)));
    this.latest = {
      ...pending.identity,
      finishedAt: new Date().toISOString(),
      state: "observed",
      reason,
      baseline: previous === undefined,
      diagnostics,
      added:
        previous === undefined
          ? []
          : diagnostics.filter((entry) => !oldKeys.has(JSON.stringify(entry))),
      resolved: (previous ?? []).filter((entry) => !newKeys.has(JSON.stringify(entry))),
    };
    this.baselines.set(uri, structuredClone(diagnostics));
    this.history.append(this.latest);
    this.changed();
  }

  snapshot(): SaveObservationSnapshot {
    return structuredClone({
      sessionId: this.history.status().sessionId,
      history: this.history.status(),
      state: this.paused ? "paused" : "active",
      quietMs: QUIET_MS,
      maxWaitMs: MAX_WAIT_MS,
      pending: [...this.pending.values()].map((entry) => entry.identity),
      latest: this.latest,
    });
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    for (const uri of this.pending.keys()) this.take(uri);
    this.baselines.clear();
    this.history.reset();
    this.latest = null;
    this.changed();
  }

  isPaused(): boolean {
    return this.paused;
  }

  readBatches(query: SaveBatchQuery = {}) {
    return this.history.read(query);
  }

  historyStatus() {
    return this.history.status();
  }

  dispose(): void {
    this.history.reset();
    this.disposed = true;
    for (const uri of this.pending.keys()) this.take(uri);
    this.baselines.clear();
    this.latest = null;
  }
}
