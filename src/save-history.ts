import { randomUUID } from "node:crypto";
import type { SaveBatch } from "./save-observations";

const MAX_RECORDS = 100;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
export interface SaveBatchQuery {
  sessionId?: string;
  afterCursor?: number;
  limit?: number;
}
export type StoredSaveBatch =
  | { cursor: number; payloadOmitted: false; batch: SaveBatch }
  | {
      cursor: number;
      payloadOmitted: true;
      batch: Pick<
        SaveBatch,
        "batchId" | "uri" | "documentVersion" | "savedAt" | "finishedAt" | "state" | "reason"
      > & {
        uriTruncated: boolean;
        baseline?: boolean;
        counts?: { diagnostics: number; added: number; resolved: number };
      };
    };
export interface SaveHistoryStatus {
  sessionId: string;
  latestCursor: number;
  oldestAvailableCursor: number;
  resumeAfterCursor: number;
  retainedCount: number;
  retainedBytes: number;
  maxRecords: number;
  maxHistoryBytes: number;
  maxRecordBytes: number;
}
export type SaveBatchPage = SaveHistoryStatus &
  (
    | { batches: StoredSaveBatch[]; nextCursor: number; hasMore: boolean }
    | { code: "RESYNC_REQUIRED"; reason: "SESSION_CHANGED" | "CURSOR_EXPIRED" | "CURSOR_AHEAD" }
    | { code: "SESSION_REQUIRED" | "INVALID_ARGUMENT" }
  );

/** Bounded, append-only within one workspace-history session. Reads never consume records. */
export class SaveHistory {
  private sessionId = randomUUID();
  private cursor = 0;
  private bytes = 0;
  private readonly records: { value: StoredSaveBatch; bytes: number }[] = [];

  append(batch: SaveBatch): void {
    const cursor = ++this.cursor;
    let value: StoredSaveBatch = { cursor, payloadOmitted: false, batch };
    let bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > MAX_RECORD_BYTES) {
      value = {
        cursor,
        payloadOmitted: true,
        batch: {
          batchId: batch.batchId,
          uri: batch.uri.slice(0, 8192),
          uriTruncated: batch.uri.length > 8192,
          documentVersion: batch.documentVersion,
          savedAt: batch.savedAt,
          finishedAt: batch.finishedAt,
          state: batch.state,
          reason: batch.reason,
          ...(batch.state === "observed"
            ? {
                baseline: batch.baseline,
                counts: {
                  diagnostics: batch.diagnostics.length,
                  added: batch.added.length,
                  resolved: batch.resolved.length,
                },
              }
            : {}),
        },
      };
      bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    }
    this.records.push({ value: structuredClone(value), bytes });
    this.bytes += bytes;
    while (this.records.length > MAX_RECORDS || this.bytes > MAX_HISTORY_BYTES) {
      const removed = this.records.shift();
      if (removed) this.bytes -= removed.bytes;
    }
  }

  status(): SaveHistoryStatus {
    const oldestAvailableCursor = this.records[0]?.value.cursor ?? this.cursor + 1;
    return {
      sessionId: this.sessionId,
      latestCursor: this.cursor,
      oldestAvailableCursor,
      resumeAfterCursor: oldestAvailableCursor - 1,
      retainedCount: this.records.length,
      retainedBytes: this.bytes,
      maxRecords: MAX_RECORDS,
      maxHistoryBytes: MAX_HISTORY_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES,
    };
  }

  read({ sessionId, afterCursor = 0, limit = 5 }: SaveBatchQuery = {}): SaveBatchPage {
    const status = this.status();
    if (
      !Number.isSafeInteger(afterCursor) ||
      afterCursor < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10
    )
      return { ...status, code: "INVALID_ARGUMENT" };
    if (sessionId === undefined && afterCursor !== 0)
      return { ...status, code: "SESSION_REQUIRED" };
    if (sessionId !== undefined && sessionId !== status.sessionId)
      return { ...status, code: "RESYNC_REQUIRED", reason: "SESSION_CHANGED" };
    if (afterCursor < status.resumeAfterCursor)
      return { ...status, code: "RESYNC_REQUIRED", reason: "CURSOR_EXPIRED" };
    if (afterCursor > status.latestCursor)
      return { ...status, code: "RESYNC_REQUIRED", reason: "CURSOR_AHEAD" };
    const batches = this.records
      .filter((record) => record.value.cursor > afterCursor)
      .slice(0, limit)
      .map((record) => record.value);
    const nextCursor = batches.at(-1)?.cursor ?? afterCursor;
    return {
      ...status,
      batches: structuredClone(batches),
      nextCursor,
      hasMore: nextCursor < status.latestCursor,
    };
  }

  reset(): void {
    this.sessionId = randomUUID();
    this.cursor = 0;
    this.bytes = 0;
    this.records.length = 0;
  }
}
