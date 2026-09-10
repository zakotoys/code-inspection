import type {
  FindingsPage,
  Finding,
  InspectionRun,
  InspectionScope,
  InspectorId,
  RunSnapshot,
  RunTrigger
} from "@zakotoys/code-inspection-core";

export const SERVICE_PROTOCOL_VERSION = 1;
export const SERVICE_IDENTITY = "code-inspection-service/0.1";

export interface ServiceHandshakeParams {
  root: string;
  secret: string;
  protocolVersion: number;
  identity: string;
}

export interface ServiceHandshakeResult {
  root: string;
  protocolVersion: number;
  identity: string;
  pid: number;
}

export interface RunInspectionParams {
  inspector: InspectorId;
  scope?: InspectionScope;
  trigger: RunTrigger;
}

export interface RunInspectionResult {
  run: InspectionRun;
}

export interface GetRunParams {
  runId: string;
}

export interface GetRunResult {
  snapshot: RunSnapshot;
}

export interface GetFindingsParams {
  inspector?: InspectorId;
  file?: string;
  offset: number;
  limit: number;
  includeStale: boolean;
}

export interface GetFindingsResult {
  page: FindingsPage;
  runs: InspectionRun[];
}

export interface CancelRunParams {
  runId: string;
}

export interface CancelRunResult {
  run: InspectionRun;
}

export interface SaveParams {
  file: string;
}

export interface SaveResult {
  runs: InspectionRun[];
}

export interface ChangeParams {
  file: string;
}

export interface StatusResult {
  root: string;
  trusted: boolean;
  activeRuns: InspectionRun[];
  latestRuns: InspectionRun[];
  findingCount: number;
}

export interface ServiceApi {
  runInspection(params: RunInspectionParams): Promise<RunInspectionResult>;
  getRun(params: GetRunParams): Promise<GetRunResult>;
  getFindings(params: GetFindingsParams): Promise<GetFindingsResult>;
  cancelRun(params: CancelRunParams): Promise<CancelRunResult>;
  didSave(params: SaveParams): Promise<SaveResult>;
  didChange(params: ChangeParams): Promise<void>;
  getStatus(): Promise<StatusResult>;
}

export interface DiscoveryRecord {
  root: string;
  endpoint: string;
  secret: string;
  pid: number;
  identity: string;
  protocolVersion: number;
  startedAt: string;
}

export interface FindingFilter {
  inspector?: InspectorId;
  file?: string;
  includeStale?: boolean;
}

export type ServiceFinding = Finding;
