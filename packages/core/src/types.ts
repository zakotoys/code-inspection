import type { WorkspaceConfig } from "./config.js";

export const LANGUAGE_IDS = [
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "rust",
  "c",
  "cpp"
] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

export const CHECK_SCOPES = ["file", "project", "workspace"] as const;
export type CheckScope = (typeof CHECK_SCOPES)[number];

// Check IDs are configuration keys. The registry validates their adapter at runtime.
export type CheckId = string;

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
  checkId: CheckId;
  language?: LanguageId | undefined;
  projectRoot?: string | undefined;
  executionKey?: string | undefined;
  scope: InspectionScope;
  trigger: RunTrigger;
  generation: number;
}

export interface RelatedInformation {
  message: string;
  file?: string | undefined;
  range?: Range | undefined;
}

export interface Finding {
  id: string;
  checkId: CheckId;
  source: string;
  language?: LanguageId | undefined;
  projectRoot?: string | undefined;
  executionKey?: string | undefined;
  code?: string | undefined;
  severity: FindingSeverity;
  message: string;
  file?: string | undefined;
  range?: Range | undefined;
  relatedInformation?: RelatedInformation[] | undefined;
  runId: string;
  generation: number;
  stale?: boolean | undefined;
}

export interface InspectionSummary {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  hintCount: number;
  durationMs: number;
  exitCode?: number | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  toolVersion?: string | undefined;
}

export interface InspectionOutput {
  findings: Finding[];
  summary: InspectionSummary;
}

export interface InspectionRun {
  runId: string;
  workspace: string;
  checkId: CheckId;
  language?: LanguageId | undefined;
  projectRoot?: string | undefined;
  executionKey?: string | undefined;
  scope: InspectionScope;
  trigger: RunTrigger;
  generation: number;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  outcome: RunOutcome;
  error?: InspectionErrorInfo | undefined;
  summary?: InspectionSummary | undefined;
}

export interface InspectionErrorInfo {
  code: string;
  message: string;
  details?: string | undefined;
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
  nextOffset?: number | undefined;
}

export interface InspectorContext {
  root: string;
  config: WorkspaceConfig;
  logger: Logger;
}

export interface RawDiagnostic {
  message: string;
  severity?: FindingSeverity | undefined;
  code?: string | undefined;
  file?: string | undefined;
  range?: Range | undefined;
  relatedInformation?: RelatedInformation[] | undefined;
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
