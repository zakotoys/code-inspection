import { z } from "zod";
import { LANGUAGE_IDS, RUN_TRIGGERS, type CheckId, type FindingsPage, type Finding, type InspectionRun, type InspectionScope, type LanguageId, type RunSnapshot, type RunTrigger, type CheckScope } from "@zakotoys/code-inspection-core";

const CHECK_ID_MAX_LENGTH = 128;
const PATH_MAX_LENGTH = 4096;
const MAX_SCOPE_FILES = 100;
const MAX_FINDINGS_OFFSET = 10_000_000;

const checkIdValue = z.string().trim().min(1).max(CHECK_ID_MAX_LENGTH);
const pathValue = z.string().min(1).max(PATH_MAX_LENGTH);
const languageValue = z.enum(LANGUAGE_IDS);
const triggerValue = z.enum(RUN_TRIGGERS);
const scopeValue = z.object({ files: z.array(pathValue).max(MAX_SCOPE_FILES).optional() }).strict();

const handshakeSchema = z.object({
  root: pathValue,
  secret: z.string().min(1).max(1024),
  protocolVersion: z.number().int().min(1).max(100),
  identity: pathValue
}).strict();

const runInspectionSchema = z.object({
  checkId: checkIdValue,
  language: languageValue.optional(),
  project: pathValue.optional(),
  scope: scopeValue.optional(),
  trigger: triggerValue
}).strict();

const getRunSchema = z.object({ runId: pathValue }).strict();
const getFindingsSchema = z.object({
  checkId: checkIdValue.optional(),
  language: languageValue.optional(),
  project: pathValue.optional(),
  file: pathValue.optional(),
  offset: z.number().int().min(0).max(MAX_FINDINGS_OFFSET).default(0),
  limit: z.number().int().min(1).max(500).default(50),
  includeStale: z.boolean().default(false)
}).strict();
const cancelRunSchema = z.object({ runId: pathValue }).strict();
const fileSchema = z.object({ file: pathValue }).strict();
const listInspectorsSchema = z.object({ includeDisabled: z.boolean().optional() }).strict();
const listProjectsSchema = z.object({ checkId: checkIdValue.optional(), language: languageValue.optional() }).strict();

function parseRequest<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
  throw new Error(`Invalid ${operation} request: ${details}`);
}

export function parseServiceHandshakeParams(value: unknown): ServiceHandshakeParams {
  return parseRequest(handshakeSchema, value, "initialize");
}

export function parseRunInspectionParams(value: unknown): RunInspectionParams {
  return parseRequest(runInspectionSchema, value, "runInspection") as RunInspectionParams;
}

export function parseGetRunParams(value: unknown): GetRunParams {
  return parseRequest(getRunSchema, value, "getRun");
}

export function parseGetFindingsParams(value: unknown): GetFindingsParams {
  return parseRequest(getFindingsSchema, value, "getFindings") as GetFindingsParams;
}

export function parseCancelRunParams(value: unknown): CancelRunParams {
  return parseRequest(cancelRunSchema, value, "cancelRun");
}

export function parseSaveParams(value: unknown): SaveParams {
  return parseRequest(fileSchema, value, "didSave");
}

export function parseChangeParams(value: unknown): ChangeParams {
  return parseRequest(fileSchema, value, "didChange");
}

export function parseDeleteParams(value: unknown): DeleteParams {
  return parseRequest(fileSchema, value, "didDelete");
}

export function parseListInspectorsParams(value: unknown): ListInspectorsParams {
  return parseRequest(listInspectorsSchema, value === undefined ? {} : value, "listInspectors") as ListInspectorsParams;
}

export function parseListProjectsParams(value: unknown): ListProjectsParams {
  return parseRequest(listProjectsSchema, value === undefined ? {} : value, "listProjects") as ListProjectsParams;
}

export function parseGetStatusParams(value: unknown): void {
  if (value !== undefined) throw new Error("Invalid getStatus request: parameters are not supported.");
}

/** The service protocol is intentionally versioned independently from npm packages. */
export const SERVICE_PROTOCOL_VERSION = 3;
export const SERVICE_IDENTITY = "code-inspection-service/0.2";

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
  /** Stable configuration key. */
  checkId: CheckId;
  language?: LanguageId | undefined;
  /** Workspace-relative project root or configuration path. */
  project?: string | undefined;
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
  checkId?: CheckId | undefined;
  language?: LanguageId | undefined;
  project?: string | undefined;
  file?: string | undefined;
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

export interface DeleteParams {
  file: string;
}

export interface InspectorCapability {
  id: string;
  adapter: string;
  displayName: string;
  enabled: boolean;
  languages: LanguageId[];
  scope: CheckScope;
  supportsFileScope: boolean;
  supportsCancellation: boolean;
  supportsTimeout: boolean;
  resourceGroup?: string;
  projectMarkers: string[];
  configured: boolean;
}

export interface ListInspectorsParams {
  includeDisabled?: boolean | undefined;
}

export interface ListInspectorsResult {
  inspectors: InspectorCapability[];
  languages: LanguageCapability[];
}

export interface ListProjectsParams {
  checkId?: CheckId | undefined;
  language?: LanguageId | undefined;
}

export interface ProjectCapability {
  root: string;
  language: LanguageId;
  marker?: string | undefined;
  configuration?: string | undefined;
}

export interface ListProjectsResult {
  projects: ProjectCapability[];
}

export interface LanguageCapability {
  id: LanguageId;
  displayName: string;
  extensions: string[];
}

export interface StatusResult {
  root: string;
  trusted: boolean;
  activeRuns: InspectionRun[];
  latestRuns: InspectionRun[];
  findingCount: number;
  queuedRuns: number;
  runningCount: number;
  maxConcurrentRuns: number;
  queueLimit: number;
  generation: number;
}

export interface ServiceApi {
  runInspection(params: RunInspectionParams): Promise<RunInspectionResult>;
  getRun(params: GetRunParams): Promise<GetRunResult>;
  getFindings(params: GetFindingsParams): Promise<GetFindingsResult>;
  cancelRun(params: CancelRunParams): Promise<CancelRunResult>;
  didSave(params: SaveParams): Promise<SaveResult>;
  didChange(params: ChangeParams): Promise<void>;
  didDelete(params: DeleteParams): Promise<void>;
  listInspectors(params?: ListInspectorsParams): Promise<ListInspectorsResult>;
  listProjects(params?: ListProjectsParams): Promise<ListProjectsResult>;
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
  checkId?: CheckId;
  language?: LanguageId;
  project?: string;
  file?: string;
  includeStale?: boolean;
}

export type ServiceFinding = Finding;
