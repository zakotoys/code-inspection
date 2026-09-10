import type { WorkspaceConfig } from "./config.js";

export const INSPECTOR_IDS = ["eslint", "typescript", "build"] as const;
export type InspectorId = (typeof INSPECTOR_IDS)[number];

export const RUN_OUTCOMES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded"
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const RUN_TRIGGERS = ["cli", "save", "manual", "mcp", "startup"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const FINDING_SEVERITIES = ["error", "warning", "info", "hint"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface InspectionScope {
  files?: string[];
}

export interface InspectionRequest {
  runId: string;
  inspector: InspectorId;
  scope: InspectionScope;
  trigger: RunTrigger;
  generation: number;
}

export interface Finding {
  id: string;
  inspector: InspectorId;
  source: string;
  code?: string;
  severity: FindingSeverity;
  message: string;
  file?: string;
  range?: Range;
  runId: string;
  generation: number;
  stale?: boolean;
}

export interface InspectionSummary {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  hintCount: number;
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface InspectionOutput {
  findings: Finding[];
  summary: InspectionSummary;
}

export interface InspectionRun {
  runId: string;
  workspace: string;
  inspector: InspectorId;
  scope: InspectionScope;
  trigger: RunTrigger;
  generation: number;
  startedAt?: string;
  endedAt?: string;
  outcome: RunOutcome;
  error?: InspectionErrorInfo;
  summary?: InspectionSummary;
}

export interface InspectionErrorInfo {
  code: string;
  message: string;
  details?: string;
}

export interface RunSnapshot {
  run: InspectionRun;
  findings: Finding[];
  freshness: {
    generation: number;
    dirtyFiles: string[];
    stale: boolean;
  };
}

export interface FindingsPage {
  total: number;
  count: number;
  offset: number;
  findings: Finding[];
  hasMore: boolean;
  nextOffset?: number;
}

export interface InspectorContext {
  root: string;
  config: WorkspaceConfig;
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
