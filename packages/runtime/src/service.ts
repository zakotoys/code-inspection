import {
  InspectionCancelledError,
  InspectionEngine,
  InspectionExecutionError,
  WorkspaceConfigError,
  TrustStore,
  canonicalizeWorkspaceRoot,
  fileUriForPath,
  formatError,
  languagesForFile,
  LANGUAGE_IDS,
  LANGUAGE_CATALOG,
  loadWorkspaceConfig,
  locateProject,
  locateProjects,
  disambiguateHeaderLanguage,
  projectMarkers,
  relativeWorkspacePath,
  resolveWorkspacePath,
  createInspectorRegistry,
  type CheckScope,
  type Finding,
  type FindingsPage,
  type InspectionErrorInfo,
  type InspectionRun,
  type LanguageId,
  type RunSnapshot,
  type WorkspaceConfig
} from "@zakotoys/code-inspection-core";
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Logger } from "@zakotoys/code-inspection-core";
import type {
  CancelRunParams,
  CancelRunResult,
  ChangeParams,
  DeleteParams,
  GetFindingsParams,
  GetFindingsResult,
  GetRunParams,
  GetRunResult,
  InspectorCapability,
  LanguageCapability,
  ListInspectorsParams,
  ListInspectorsResult,
  ListProjectsParams,
  ListProjectsResult,
  RunInspectionParams,
  RunInspectionResult,
  SaveParams,
  SaveResult,
  ServiceApi,
  StatusResult
} from "./protocol.js";
import {
  parseCancelRunParams,
  parseChangeParams,
  parseDeleteParams,
  parseGetFindingsParams,
  parseGetRunParams,
  parseGetStatusParams,
  parseListInspectorsParams,
  parseListProjectsParams,
  parseRunInspectionParams,
  parseSaveParams
} from "./protocol.js";
import { isIgnoredWorkspacePath, watchWorkspace, type WorkspaceWatcher } from "./workspace-watcher.js";
import { canFallbackToInProcessWorker, runInspectionWorker } from "./worker-executor.js";

interface PreparedRequest {
  checkId: string;
  config: WorkspaceConfig;
  resolved: ReturnType<ReturnType<typeof createInspectorRegistry>["resolve"]>;
  files: string[];
  global: boolean;
  language?: LanguageId | undefined;
  projectRoot: string;
  scopeKind: CheckScope;
  executionKey: string;
  trigger: RunInspectionParams["trigger"];
}

interface ActiveRun {
  run: InspectionRun;
  config: WorkspaceConfig;
  engine: InspectionEngine;
  controller: AbortController;
  files: Set<string>;
  global: boolean;
  executionKey: string;
  resourceGroup: string;
  resourceLimit: number;
  schedulerQueued: boolean;
  slotAcquired: boolean;
  timer?: ReturnType<typeof setTimeout> | undefined;
  superseded: boolean;
}

const MAX_RETAINED_RUNS = 100;
const MAX_SCOPE_FILES = 100;
const MAX_CONCURRENT_RUNS = 2;
const MAX_QUEUED_RUNS = 100;
const DEFAULT_RESOURCE_GROUP = "default";
const DEFAULT_RESOURCE_LIMIT = Number.POSITIVE_INFINITY;

/**
 * The single owner of scheduling and normalized results for one workspace.
 * Every front-end (CLI, LSP, MCP) talks to this class through the IPC contract.
 */
export class WorkspaceService implements ServiceApi {
  readonly root: string;
  private readonly logger: Logger;
  private readonly trustStore: TrustStore;
  private readonly useWorkers: boolean;
  private readonly registry = createInspectorRegistry();
  private readonly runs = new Map<string, InspectionRun>();
  private readonly findings = new Map<string, Finding[]>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly latest = new Map<string, string>();
  private readonly dirtyFiles = new Set<string>();
  private readonly recentSaves = new Map<string, number>();
  private readonly schedulingTails = new Map<string, Promise<void>>();
  private readonly schedulerQueue: ActiveRun[] = [];
  private readonly resourceCounts = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly executions = new Set<Promise<void>>();
  private watcher: WorkspaceWatcher | undefined;
  private sequence = 0;
  private workspaceGeneration = 0;
  private runningCount = 0;
  private disposed = false;

  private constructor(root: string, logger: Logger, trustStore: TrustStore, config: WorkspaceConfig, useWorkers: boolean) {
    this.root = root;
    this.logger = logger;
    this.trustStore = trustStore;
    this.useWorkers = useWorkers;
  }

  static async create(inputRoot: string, options: { logger: Logger; trustStore?: TrustStore; useWorkers?: boolean }): Promise<WorkspaceService> {
    const root = await canonicalizeWorkspaceRoot(inputRoot);
    const config = await loadWorkspaceConfig(root);
    const service = new WorkspaceService(root, options.logger, options.trustStore ?? new TrustStore(), config, options.useWorkers ?? true);
    service.registry.validate(config);
    await service.startWatcher();
    return service;
  }

  async runInspection(params: RunInspectionParams): Promise<RunInspectionResult> {
    this.ensureAvailable();
    await this.requireTrusted();
    this.ensureAvailable();
    rejectLegacyRequestFields(params, "runInspection");
    const request = parseRunInspectionParams(params);
    const prepared = await this.prepare(request);
    this.ensureAvailable();
    // The configuration is loaded asynchronously after the initial trust
    // check. Re-check its hash before queuing so a file edit racing this call
    // cannot swap in a newly executable command under an old grant.
    await this.requireTrusted();
    this.ensureAvailable();
    const previous = this.schedulingTails.get(prepared.executionKey);
    const joinsPendingRequest = previous !== undefined;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.schedulingTails.set(prepared.executionKey, current);
    try {
      await previous;
      this.ensureAvailable();
      return this.schedulePrepared(prepared, joinsPendingRequest);
    } finally {
      release();
      if (this.schedulingTails.get(prepared.executionKey) === current) this.schedulingTails.delete(prepared.executionKey);
    }
  }

  private async prepare(params: RunInspectionParams): Promise<PreparedRequest> {
    const checkId = normalizeCheckId(params);
    const config = await this.currentConfig();
    const resolved = this.registry.resolve(config, checkId);
    const files = this.normalizeScopeFiles(params.scope?.files);
    const language = this.resolveLanguage(params.language, files, resolved.languages);
    if (language && resolved.languages.length > 0 && !resolved.languages.includes(language)) {
      throw new WorkspaceConfigError(`Check ${checkId} does not support language ${language}.`);
    }
    if (language && files.some((file) => {
      const candidates = languagesForFile(file);
      return candidates.length > 0 && !candidates.includes(language);
    })) {
      throw new WorkspaceConfigError(`Language ${language} does not match every requested source file.`);
    }
    if (resolved.languages.length > 0 && files.some((file) => {
      const candidates = languagesForFile(file);
      return candidates.length > 0 && !candidates.some((candidate) => resolved.languages.includes(candidate));
    })) {
      throw new WorkspaceConfigError(`Check ${checkId} does not support every requested source file.`);
    }
    const scopeKind = resolved.config.scope;
    const projectRoot = this.resolveProjectRoot(params.project, language, files, resolved.languages, scopeKind);
    this.validateScopeProject(params.project, language, files, resolved.languages, scopeKind, projectRoot);
    const global = scopeKind !== "file" || files.length === 0;
    const executionKey = [checkId, normalizeKeyPath(projectRoot), scopeKind].join("|");
    return {
      checkId,
      config,
      resolved,
      files,
      global,
      ...(language ? { language } : {}),
      projectRoot,
      scopeKind,
      executionKey,
      trigger: params.trigger
    };
  }

  private schedulePrepared(prepared: PreparedRequest, joinsPendingRequest: boolean): RunInspectionResult {
    const current = this.active.get(prepared.executionKey);
    if (current && current.run.outcome === "queued") {
      if (prepared.global) current.global = true;
      for (const file of prepared.files) current.files.add(file);
      current.run.scope = this.scopeForFiles(current.files, current.global);
      return { run: cloneRun(current.run) };
    }
    if (current && current.run.outcome === "running") {
      // Manual/CLI requests are idempotent while the same execution key is
      // already running. Save-triggered requests intentionally supersede the
      // old run so the newest generation wins.
      if (joinsPendingRequest || prepared.trigger !== "save") return { run: cloneRun(current.run) };
      current.superseded = true;
      current.run.outcome = "superseded";
      current.run.endedAt = new Date().toISOString();
      current.controller.abort();
      this.active.delete(prepared.executionKey);
    }

    const run: InspectionRun = {
      runId: this.nextRunId(prepared.checkId),
      workspace: this.root,
      checkId: prepared.checkId,
      ...(prepared.language ? { language: prepared.language } : {}),
      projectRoot: prepared.projectRoot,
      executionKey: prepared.executionKey,
      scope: this.scopeForFiles(prepared.files, prepared.global),
      trigger: prepared.trigger,
      generation: this.generationFor(prepared.executionKey),
      outcome: "queued"
    };
    const resourceGroup = prepared.resolved.definition.resourceGroup ?? DEFAULT_RESOURCE_GROUP;
    const resourceLimit = prepared.resolved.definition.resourceLimit ?? DEFAULT_RESOURCE_LIMIT;
    const active: ActiveRun = {
      run,
      config: prepared.config,
      engine: new InspectionEngine({ root: this.root, config: prepared.config, logger: this.logger }, this.logger, this.registry),
      controller: new AbortController(),
      files: new Set(prepared.files),
      global: prepared.global,
      executionKey: prepared.executionKey,
      resourceGroup,
      resourceLimit,
      schedulerQueued: false,
      slotAcquired: false,
      superseded: false
    };
    this.runs.set(run.runId, run);
    // Request preparation performs asynchronous trust/config work, so a
    // burst of callers can add runs between each timer callback. Reserve the
    // queue slot at creation time as well as in enqueue() to keep the public
    // queue bound hard even when those callbacks interleave.
    if (prepared.resolved.config.enabled && this.queuedRunCount() >= MAX_QUEUED_RUNS) {
      this.active.set(prepared.executionKey, active);
      this.failRun(active, new InspectionExecutionError("queue-full", `Inspection queue is full (limit ${MAX_QUEUED_RUNS}).`));
      return { run: cloneRun(run) };
    }
    this.active.set(prepared.executionKey, active);
    this.trimRuns();
    if (!prepared.resolved.config.enabled) {
      this.failRun(active, new InspectionExecutionError("inspector-disabled", `The ${prepared.checkId} check is disabled in .code-inspection.json.`));
      return { run: cloneRun(run) };
    }
    const delay = prepared.trigger === "save" ? prepared.config.debounceMs : 0;
    active.timer = setTimeout(() => { this.enqueue(active); }, delay);
    active.timer.unref?.();
    return { run: cloneRun(run) };
  }

  async getRun(params: GetRunParams): Promise<GetRunResult> {
    this.ensureAvailable();
    const request = parseGetRunParams(params);
    const run = this.runs.get(request.runId);
    if (!run) throw new Error(`Run not found: ${request.runId}`);
    return { snapshot: this.snapshot(run) };
  }

  async getFindings(params: GetFindingsParams): Promise<GetFindingsResult> {
    this.ensureAvailable();
    rejectLegacyRequestFields(params, "getFindings");
    const request = parseGetFindingsParams(params);
    const config = await this.currentConfig();
    if (request.checkId) this.registry.resolve(config, request.checkId);
    const requestedCheck = request.checkId;
    const requestedProject = request.project ? projectRootForSelector(this.root, request.project) : undefined;
    const requestedFile = request.file ? relativeWorkspacePath(this.root, request.file) : undefined;
    const fileUri = requestedFile ? fileUriForPath(resolveWorkspacePath(this.root, requestedFile)) : undefined;
    const values = [...this.findings.values()]
      .flatMap((items) => items)
      .filter((finding) => !requestedCheck || finding.checkId === requestedCheck)
      .filter((finding) => !request.language || finding.language === request.language)
      .filter((finding) => !requestedProject || finding.projectRoot === requestedProject)
      .filter((finding) => !fileUri || finding.file === fileUri)
      .filter((finding) => request.includeStale || finding.stale !== true);
    const sorted = values.sort((left, right) => (left.file ?? "").localeCompare(right.file ?? "") || (left.range?.start.line ?? -1) - (right.range?.start.line ?? -1) || left.message.localeCompare(right.message));
    const offset = request.offset;
    const limit = request.limit;
    const pageFindings = sorted.slice(offset, offset + limit);
    const page: FindingsPage = {
      total: sorted.length,
      count: pageFindings.length,
      offset,
      findings: pageFindings,
      hasMore: offset + pageFindings.length < sorted.length,
      ...(offset + pageFindings.length < sorted.length ? { nextOffset: offset + pageFindings.length } : {})
    };
    const latestRuns = [...new Set(this.latest.values())]
      .map((runId) => this.runs.get(runId))
      .filter(isRun)
      .filter((run) => !requestedCheck || run.checkId === requestedCheck)
      .filter((run) => !request.language || run.language === request.language)
      .filter((run) => !requestedProject || run.projectRoot === requestedProject)
      .filter((run) => !requestedFile || runMatchesFile(this.root, run, requestedFile))
      .map(cloneRun);
    return { page, runs: latestRuns };
  }

  async cancelRun(params: CancelRunParams): Promise<CancelRunResult> {
    this.ensureAvailable();
    const request = parseCancelRunParams(params);
    const run = this.runs.get(request.runId);
    if (!run) throw new Error(`Run not found: ${request.runId}`);
    const key = run.executionKey ?? run.checkId;
    const active = this.active.get(key);
    if (active?.run.runId === run.runId) {
      if (active.timer) clearTimeout(active.timer);
      active.timer = undefined;
      active.schedulerQueued = false;
      const queuedIndex = this.schedulerQueue.indexOf(active);
      if (queuedIndex >= 0) this.schedulerQueue.splice(queuedIndex, 1);
      active.controller.abort();
      active.run.outcome = "cancelled";
      active.run.endedAt = new Date().toISOString();
      this.latest.set(key, active.run.runId);
      this.active.delete(key);
      this.drainScheduler();
    }
    return { run: cloneRun(run) };
  }

  async didSave(params: SaveParams): Promise<SaveResult> {
    this.ensureAvailable();
    const request = parseSaveParams(params);
    const file = this.normalizeScopeFiles([request.file])[0];
    if (!file) throw new Error("A saved file is required.");
    this.recentSaves.set(file, Date.now());
    while (this.recentSaves.size > 1000) {
      const oldest = this.recentSaves.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentSaves.delete(oldest);
    }
    this.dirtyFiles.delete(file);
    const config = await this.currentConfig();
    const fileLanguages = languagesForFile(file);
    const runs: InspectionRun[] = [];
    for (const [checkId, check] of Object.entries(config.checks)) {
      if (!check.enabled) continue;
      const resolved = this.registry.resolve(config, checkId);
      const languages = resolved.languages;
      const languageMatches = languages.length === 0 || fileLanguages.some((language) => languages.includes(language));
      if (!languageMatches) continue;
      if (resolved.config.scope === "file" && !resolved.definition.supportsFileScope) continue;
      const language = chooseSaveLanguage(file, languages, this.root);
      const result = await this.runInspection({
        checkId,
        ...(language ? { language } : {}),
        scope: { files: [file] },
        trigger: "save"
      });
      runs.push(result.run);
    }
    return { runs };
  }

  async didChange(params: ChangeParams): Promise<void> {
    this.ensureAvailable();
    const request = parseChangeParams(params);
    const file = this.normalizeScopeFiles([request.file])[0];
    if (!file) return;
    this.dirtyFiles.add(file);
    this.markFileStale(file);
    await this.invalidateForFile(file);
  }

  async didDelete(params: DeleteParams): Promise<void> {
    this.ensureAvailable();
    const request = parseDeleteParams(params);
    const file = this.normalizeScopeFiles([request.file])[0];
    if (!file) return;
    this.recentSaves.delete(file);
    this.dirtyFiles.delete(file);
    this.clearFileFindings(file);
    await this.invalidateForFile(file);
  }

  async listInspectors(params: ListInspectorsParams = {}): Promise<ListInspectorsResult> {
    this.ensureAvailable();
    const request = parseListInspectorsParams(params);
    const config = await this.currentConfig();
    const inspectors: InspectorCapability[] = [];
    for (const [id, check] of Object.entries(config.checks)) {
      const resolved = this.registry.resolve(config, id);
      if (!request.includeDisabled && !check.enabled) continue;
      const markers = [...new Set(resolved.languages.flatMap((language) => [...projectMarkers(language)]))];
      inspectors.push({
        id,
        adapter: resolved.definition.adapter,
        displayName: resolved.definition.displayName,
        enabled: check.enabled,
        languages: [...resolved.languages],
        scope: resolved.config.scope,
        supportsFileScope: resolved.definition.supportsFileScope,
        supportsCancellation: resolved.definition.supportsCancellation ?? true,
        supportsTimeout: resolved.definition.supportsTimeout ?? true,
        ...(resolved.definition.resourceGroup ? { resourceGroup: resolved.definition.resourceGroup } : {}),
        projectMarkers: markers,
        configured: true
      });
    }
    const languages: LanguageCapability[] = LANGUAGE_CATALOG.map((definition) => ({ id: definition.id, displayName: definition.displayName, extensions: [...definition.extensions] }));
    return { inspectors, languages };
  }

  async listProjects(params: ListProjectsParams = {}): Promise<ListProjectsResult> {
    this.ensureAvailable();
    rejectLegacyRequestFields(params, "listProjects");
    const request = parseListProjectsParams(params);
    const config = await this.currentConfig();
    let languages: LanguageId[];
    if (request.language) {
      languages = [request.language];
    } else if (request.checkId) {
      languages = [...this.registry.resolve(config, request.checkId).languages];
    } else {
      languages = [...LANGUAGE_IDS];
    }
    // A check may advertise multiple source languages (for example ESLint or
    // TypeScript). They can resolve to the same project root, which must be
    // exposed once so callers do not schedule duplicate project runs.
    const projects = new Map<string, ReturnType<typeof locateProjects>[number]>();
    for (const language of languages) {
      for (const project of locateProjects(this.root, language)) {
        // Most adapters (for example ESLint and TypeScript) intentionally
        // expose one project entry even when they cover two source languages.
        // C and C++ are different compiler modes, however, and the same root
        // can legitimately provide both capabilities through one compilation
        // database. Keep those entries distinct so discovery does not erase a
        // language that callers explicitly requested.
        const key = language === "c" || language === "cpp" ? `${project.root}|${language}` : project.root;
        if (!projects.has(key)) projects.set(key, project);
      }
    }
    return {
      projects: [...projects.values()].sort((left, right) => left.root.localeCompare(right.root) || left.language.localeCompare(right.language))
    };
  }

  async getStatus(params?: unknown): Promise<StatusResult> {
    this.ensureAvailable();
    parseGetStatusParams(params);
    const trusted = await this.trustStore.isTrusted(this.root);
    return {
      root: this.root,
      trusted,
      activeRuns: [...this.active.values()].map((active) => cloneRun(active.run)),
      latestRuns: [...new Set(this.latest.values())].map((runId) => this.runs.get(runId)).filter(isRun).map(cloneRun),
      findingCount: [...this.findings.values()].reduce((total, values) => total + values.length, 0),
      queuedRuns: this.queuedRunCount(),
      runningCount: this.runningCount,
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      queueLimit: MAX_QUEUED_RUNS,
      generation: this.workspaceGeneration
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const active of this.active.values()) {
      if (active.timer) clearTimeout(active.timer);
      if (active.run.outcome === "queued" || active.run.outcome === "running") {
        active.run.outcome = "cancelled";
        active.run.endedAt = new Date().toISOString();
      }
      active.controller.abort();
    }
    for (const queued of this.schedulerQueue) {
      if (queued.run.outcome === "queued") {
        queued.run.outcome = "cancelled";
        queued.run.endedAt = new Date().toISOString();
      }
      queued.schedulerQueued = false;
    }
    this.schedulerQueue.length = 0;
    this.active.clear();
    if (this.executions.size > 0) await Promise.allSettled([...this.executions]);
  }

  private enqueue(active: ActiveRun): void {
    active.timer = undefined;
    if (this.disposed || active.superseded || active.run.outcome !== "queued") return;
    if (active.schedulerQueued) return;
    // The active run is already included in queuedRunCount once it reaches
    // this callback. Reject only a genuinely over-capacity queue; the 100th
    // accepted run must still be allowed to enter the scheduler.
    if (this.queuedRunCount() > MAX_QUEUED_RUNS) {
      this.failRun(active, new InspectionExecutionError("queue-full", `Inspection queue is full (limit ${MAX_QUEUED_RUNS}).`));
      return;
    }
    active.schedulerQueued = true;
    this.schedulerQueue.push(active);
    this.drainScheduler();
  }

  private drainScheduler(): void {
    if (this.disposed) return;
    for (;;) {
      const index = this.schedulerQueue.findIndex((candidate) => this.canStart(candidate));
      if (index < 0) return;
      const [active] = this.schedulerQueue.splice(index, 1);
      if (!active) return;
      active.schedulerQueued = false;
      if (active.superseded || active.run.outcome !== "queued" || this.active.get(active.executionKey) !== active) continue;
      this.acquireSlot(active);
      const execution = this.execute(active).finally(() => {
        this.releaseSlot(active);
        this.drainScheduler();
      });
      this.executions.add(execution);
      void execution.then(() => this.executions.delete(execution), () => this.executions.delete(execution));
    }
  }

  private canStart(active: ActiveRun): boolean {
    if (this.runningCount >= MAX_CONCURRENT_RUNS) return false;
    const current = this.resourceCounts.get(active.resourceGroup) ?? 0;
    return current < active.resourceLimit;
  }

  private queuedRunCount(): number {
    let count = this.schedulerQueue.length;
    for (const active of this.active.values()) {
      if (active.run.outcome === "queued" && !active.schedulerQueued) count += 1;
    }
    return count;
  }

  private acquireSlot(active: ActiveRun): void {
    active.slotAcquired = true;
    this.runningCount += 1;
    this.resourceCounts.set(active.resourceGroup, (this.resourceCounts.get(active.resourceGroup) ?? 0) + 1);
  }

  private releaseSlot(active: ActiveRun): void {
    if (!active.slotAcquired) return;
    active.slotAcquired = false;
    this.runningCount = Math.max(0, this.runningCount - 1);
    const next = (this.resourceCounts.get(active.resourceGroup) ?? 1) - 1;
    if (next > 0) this.resourceCounts.set(active.resourceGroup, next);
    else this.resourceCounts.delete(active.resourceGroup);
  }

  private async execute(active: ActiveRun): Promise<void> {
    if (active.superseded || active.run.outcome !== "queued") return;
    active.run.outcome = "running";
    active.run.startedAt = new Date().toISOString();
    try {
      const request = {
        runId: active.run.runId,
        checkId: active.run.checkId,
        ...(active.run.language ? { language: active.run.language } : {}),
        projectRoot: active.run.projectRoot,
        executionKey: active.executionKey,
        scope: this.scopeForFiles(active.files, active.global),
        trigger: active.run.trigger,
        generation: active.run.generation
      } as const;
      const output = this.useWorkers
        ? await this.executeIsolated(active, request)
        : await active.engine.run(request, active.controller.signal);
      if (active.superseded || active.run.outcome !== "running") return;
      active.run.summary = output.summary;
      active.run.outcome = "completed";
      active.run.endedAt = new Date().toISOString();
      this.replaceFindings(active, output.findings);
      this.latest.set(active.executionKey, active.run.runId);
    } catch (error) {
      if (active.superseded || active.run.outcome !== "running") return;
      active.run.endedAt = new Date().toISOString();
      if (error instanceof InspectionCancelledError) active.run.outcome = "cancelled";
      else {
        active.run.outcome = "failed";
        active.run.error = errorInfo(error);
        this.markFindingsStale(active.executionKey);
      }
      // The latest attempt is useful even when it did not produce a fresh
      // result; clients need its error/cancellation outcome to explain stale
      // findings.
      this.latest.set(active.executionKey, active.run.runId);
    } finally {
      if (this.active.get(active.executionKey)?.run.runId === active.run.runId) this.active.delete(active.executionKey);
      this.trimRuns();
    }
  }

  private async executeIsolated(active: ActiveRun, request: Parameters<InspectionEngine["run"]>[0]): Promise<Awaited<ReturnType<InspectionEngine["run"]>>> {
    try {
      return await runInspectionWorker({
        root: this.root,
        config: active.config,
        request,
        timeoutMs: active.config.checks[active.run.checkId]?.timeoutMs ?? 120000,
        signal: active.controller.signal,
        logger: this.logger
      });
    } catch (error) {
      // Source-level test runners and embedders may not have a compiled worker
      // sibling. Keep those environments usable while packaged runtimes always
      // have the worker bundle and therefore remain isolated.
      if (error instanceof InspectionExecutionError && error.code === "worker-unavailable" && canFallbackToInProcessWorker()) {
        return active.engine.run(request, active.controller.signal);
      }
      throw error;
    }
  }

  private replaceFindings(active: ActiveRun, incoming: Finding[]): void {
    const existing = this.findings.get(active.executionKey) ?? [];
    const retained = active.global
      ? []
      : existing.filter((finding) => !finding.file || !active.files.has(this.relativeFileFromUri(finding.file)));
    const normalized = incoming.map((finding) => ({
      ...finding,
      checkId: active.run.checkId,
      ...(active.run.projectRoot ? { projectRoot: active.run.projectRoot } : {}),
      executionKey: active.executionKey,
      ...(active.run.language && !finding.language ? { language: active.run.language } : {})
    }));
    this.findings.set(active.executionKey, [...retained, ...normalized]);
  }

  private markFileStale(file: string): void {
    for (const [key, existing] of this.findings) {
      this.findings.set(key, existing.map((finding) => finding.file && this.relativeFileFromUri(finding.file) === file ? { ...finding, stale: true } : finding));
    }
  }

  private clearFileFindings(file: string): void {
    for (const [key, existing] of this.findings) {
      const retained = existing.filter((finding) => !finding.file || this.relativeFileFromUri(finding.file) !== file);
      if (retained.length === 0) this.findings.delete(key);
      else this.findings.set(key, retained);
    }
  }

  private async invalidateForFile(file: string): Promise<void> {
    if (this.disposed) return;
    const keys = new Set<string>();
    const absoluteFile = resolve(this.root, file);
    for (const active of this.active.values()) {
      if (active.files.has(file) || (active.global && isPathWithin(active.run.projectRoot ?? this.root, absoluteFile))) {
        keys.add(active.executionKey);
      }
    }
    for (const [key, existing] of this.findings) {
      if (existing.some((finding) => {
        if (finding.file && this.relativeFileFromUri(finding.file) === file) return true;
        return Boolean(finding.projectRoot && isPathWithin(finding.projectRoot, absoluteFile));
      })) keys.add(key);
    }
    // A new or previously clean file may not have an existing finding or run.
    // Derive its affected execution keys from the configured checks so the
    // next save cannot reuse an older generation silently.
    try {
      const config = await this.currentConfig();
      const fileLanguages = languagesForFile(file);
      for (const [checkId, check] of Object.entries(config.checks)) {
        if (!check.enabled) continue;
        const resolved = this.registry.resolve(config, checkId);
        if (resolved.languages.length > 0 && !fileLanguages.some((language) => resolved.languages.includes(language))) continue;
        const candidates = resolved.languages.length === 0
          ? [undefined]
          : fileLanguages.filter((language) => resolved.languages.includes(language));
        const effectiveCandidates = candidates.length > 0 ? candidates : resolved.languages.length === 1 ? [resolved.languages[0]] : [];
        for (const language of effectiveCandidates) {
          const projectRoot = this.resolveProjectRoot(undefined, language, [file], resolved.languages, resolved.config.scope);
          keys.add([checkId, normalizeKeyPath(projectRoot), resolved.config.scope].join("|"));
        }
      }
    } catch (error) {
      this.logger.debug("Unable to derive affected inspection projects for file change", error);
    }
    if (this.disposed) return;
    if (keys.size === 0) return;
    this.workspaceGeneration += 1;
    for (const key of keys) {
      this.bumpGeneration(key);
      this.invalidateKey(key);
      this.markFindingsStale(key);
    }
  }

  private invalidateAllRuns(): void {
    if (this.disposed) return;
    this.workspaceGeneration += 1;
    const keys = new Set([...this.active.keys(), ...this.findings.keys(), ...this.latest.keys()]);
    for (const key of keys) {
      this.bumpGeneration(key);
      this.invalidateKey(key);
      this.markFindingsStale(key);
    }
  }

  private invalidateKey(key: string): void {
    const active = this.active.get(key);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.timer = undefined;
    active.schedulerQueued = false;
    const queuedIndex = this.schedulerQueue.indexOf(active);
    if (queuedIndex >= 0) this.schedulerQueue.splice(queuedIndex, 1);
    active.superseded = true;
    active.run.outcome = "superseded";
    active.run.endedAt = new Date().toISOString();
    active.controller.abort();
    this.active.delete(key);
    this.drainScheduler();
  }

  private async startWatcher(): Promise<void> {
    const watcherStartedAt = Date.now();
    const onChange = (eventType: string, filename: string | Buffer | null): void => {
      if (this.disposed) return;
      const watchedFile = filename ? String(filename).replaceAll("\\", "/") : undefined;
      if (isInitialWatcherEvent(this.root, watchedFile, watcherStartedAt)) return;
      let relativeFile = watchedFile;
      if (watchedFile && isAbsolute(watchedFile)) {
        try { relativeFile = relativeWorkspacePath(this.root, watchedFile); } catch { relativeFile = undefined; }
      }
      if (!relativeFile) {
        this.markAllFindingsStale();
        this.invalidateAllRuns();
        return;
      }
      if (isIgnoredWorkspacePath(relativeFile)) return;
      let exists = true;
      try {
        const stats = statSync(resolve(this.root, relativeFile));
        exists = stats.isFile();
        if (stats.isDirectory()) {
          this.invalidateAllRuns();
          return;
        }
      }
      catch { exists = false; }
      if (eventType === "rename" && !exists) {
        this.recentSaves.delete(relativeFile);
        this.dirtyFiles.delete(relativeFile);
        this.clearFileFindings(relativeFile);
        void this.invalidateForFile(relativeFile).catch((error) => this.logger.debug("Unable to process deleted file", error));
        return;
      }
      const savedAt = this.recentSaves.get(relativeFile);
      if (savedAt !== undefined) {
        if (Date.now() - savedAt < 1500) return;
        this.recentSaves.delete(relativeFile);
      }
      if (relativeFile === ".code-inspection.json") this.markAllFindingsStale();
      else this.markFileStale(relativeFile);
      if (relativeFile === ".code-inspection.json") this.invalidateAllRuns();
      else void this.invalidateForFile(relativeFile).catch((error) => this.logger.debug("Unable to process changed file", error));
    };
    this.watcher = await watchWorkspace(this.root, {
      onChange: (eventType, relativeFile) => onChange(eventType, relativeFile ?? null),
      onError: (error) => this.logger.debug("Workspace watcher event error", error)
    });
  }

  private markAllFindingsStale(): void {
    for (const [key, existing] of this.findings) this.findings.set(key, existing.map((finding) => ({ ...finding, stale: true })));
  }

  private markFindingsStale(executionKey: string): void {
    const existing = this.findings.get(executionKey) ?? [];
    this.findings.set(executionKey, existing.map((finding) => ({ ...finding, stale: true })));
  }

  private snapshot(run: InspectionRun): RunSnapshot {
    const key = run.executionKey ?? run.checkId;
    const currentFindings = (this.findings.get(key) ?? []).filter((finding) => finding.runId === run.runId || finding.stale === true);
    return {
      run: cloneRun(run),
      findings: currentFindings,
      freshness: {
        generation: this.generationFor(key),
        dirtyFiles: [...this.dirtyFiles],
        stale: currentFindings.some((finding) => finding.stale === true) || run.outcome === "failed"
      }
    };
  }

  private normalizeScopeFiles(files: string[] | undefined): string[] {
    if (!files) return [];
    if (files.length > MAX_SCOPE_FILES) throw new Error(`A run may include at most ${MAX_SCOPE_FILES} files.`);
    return [...new Set(files.map((file) => relativeWorkspacePath(this.root, file)))];
  }

  private scopeForFiles(files: Iterable<string>, global = false): { files?: string[] } {
    if (global) return {};
    const values = [...files];
    return values.length > 0 ? { files: values } : {};
  }

  private relativeFileFromUri(file: string): string {
    try { return relativeWorkspacePath(this.root, file); } catch { return file; }
  }

  private nextRunId(checkId: string): string {
    this.sequence += 1;
    return `${checkId}-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  private generationFor(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private bumpGeneration(key: string): number {
    const next = this.generationFor(key) + 1;
    this.generations.set(key, next);
    return next;
  }

  private trimRuns(): void {
    while (this.runs.size > MAX_RETAINED_RUNS) {
      const first = this.runs.keys().next().value as string | undefined;
      if (!first || [...this.active.values()].some((active) => active.run.runId === first)) break;
      this.runs.delete(first);
    }
  }

  private async requireTrusted(): Promise<void> { await this.trustStore.requireTrusted(this.root); }

  private ensureAvailable(): void {
    if (this.disposed) throw new InspectionExecutionError("service-disposed", "The workspace service has been disposed and cannot accept new requests.");
  }

  private async currentConfig(): Promise<WorkspaceConfig> {
    const config = await loadWorkspaceConfig(this.root);
    this.registry.validate(config);
    return config;
  }

  private failRun(active: ActiveRun, error: unknown): void {
    if (active.timer) clearTimeout(active.timer);
    active.run.outcome = "failed";
    active.run.endedAt = new Date().toISOString();
    active.run.error = errorInfo(error);
    this.latest.set(active.executionKey, active.run.runId);
    this.active.delete(active.executionKey);
    this.markFindingsStale(active.executionKey);
    this.trimRuns();
  }

  private resolveLanguage(requested: LanguageId | undefined, files: string[], supported: readonly LanguageId[]): LanguageId | undefined {
    if (requested) return requested;
    const detected = files.flatMap((file) => languagesForFile(file));
    const unique = [...new Set(detected)];
    const matching = supported.filter((language) => unique.includes(language));
    if (matching.length === 1) return matching[0];
    if (supported.length === 0) return undefined;
    const headerLanguage = disambiguateHeaderLanguage(this.root, files[0] ?? "", supported);
    if (headerLanguage) return headerLanguage;
    return supported.length === 1 ? supported[0] : undefined;
  }

  private resolveProjectRoot(explicit: string | undefined, language: LanguageId | undefined, files: string[], supported: readonly LanguageId[], scope: CheckScope): string {
    if (scope === "workspace") return this.root;
    const effectiveLanguage = language ?? (supported.length === 1 ? supported[0] : undefined);
    if (explicit) {
      const resolved = resolveWorkspacePath(this.root, explicit);
      try {
        return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
      } catch {
        return dirname(resolved);
      }
    }
    if (!effectiveLanguage) return this.root;
    return locateProject(this.root, effectiveLanguage, files[0]).root;
  }

  /**
   * A project-scoped tool has one cwd/configuration. Never silently run it
   * against the first file's project when a request spans nested projects.
   */
  private validateScopeProject(
    explicit: string | undefined,
    language: LanguageId | undefined,
    files: string[],
    supported: readonly LanguageId[],
    scope: CheckScope,
    projectRoot: string
  ): void {
    if (scope === "workspace" || files.length === 0) return;
    const rootForComparison = normalizeKeyPath(projectRoot);
    if (explicit) {
      for (const file of files) {
        if (!isPathWithin(projectRoot, resolve(this.root, file))) {
          throw new WorkspaceConfigError("Requested files must be inside the explicitly selected project.");
        }
      }
      return;
    }
    if (files.length < 2) return;
    const projectRoots = new Set<string>();
    for (const file of files) {
      const fileLanguage = languageForProjectFile(this.root, file, language, supported);
      if (!fileLanguage) continue;
      projectRoots.add(normalizeKeyPath(locateProject(this.root, fileLanguage, file).root));
    }
    if (projectRoots.size > 1 || (projectRoots.size === 1 && !projectRoots.has(rootForComparison))) {
      throw new WorkspaceConfigError("Requested files belong to different projects; submit one inspection per project.");
    }
  }
}

function normalizeCheckId(params: RunInspectionParams): string {
  const value = params.checkId;
  if (!value || !value.trim()) throw new WorkspaceConfigError("An inspection checkId is required.");
  return value.trim();
}

function rejectLegacyRequestFields(value: unknown, operation: string): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "inspector") || Object.prototype.hasOwnProperty.call(record, "projectRoot")) {
    throw new WorkspaceConfigError(`${operation} accepts checkId and project in protocol v2; legacy inspector/projectRoot fields are not supported.`);
  }
}

function chooseSaveLanguage(file: string, supported: readonly LanguageId[], root: string): LanguageId | undefined {
  const detected = languagesForFile(file);
  const matching = detected.filter((language) => supported.includes(language));
  const headerLanguage = disambiguateHeaderLanguage(root, file, matching);
  if (headerLanguage) return headerLanguage;
  return matching.length === 1 ? matching[0] : undefined;
}

function languageForProjectFile(root: string, file: string, requested: LanguageId | undefined, supported: readonly LanguageId[]): LanguageId | undefined {
  const candidates = languagesForFile(file).filter((candidate) => supported.length === 0 || supported.includes(candidate));
  if (requested && candidates.includes(requested)) return requested;
  const headerLanguage = disambiguateHeaderLanguage(root, file, candidates);
  if (headerLanguage) return headerLanguage;
  return candidates.length === 1 ? candidates[0] : supported.length === 1 ? supported[0] : undefined;
}

function normalizeKeyPath(value: string): string {
  return resolve(value).replaceAll("\\", "/");
}

function projectRootForSelector(root: string, selector: string): string {
  const resolved = resolveWorkspacePath(root, selector);
  try {
    return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    return dirname(resolved);
  }
}

function runMatchesFile(root: string, run: InspectionRun, file: string): boolean {
  if (run.scope.files) return run.scope.files.includes(file);
  return isPathWithin(run.projectRoot ?? root, resolve(root, file));
}

function isPathWithin(parent: string, candidate: string): boolean {
  const parentPath = resolve(parent).replace(/[\\/]$/, "");
  const candidatePath = resolve(candidate);
  const parentKey = process.platform === "win32" ? parentPath.toLowerCase() : parentPath;
  const candidateKey = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  return candidateKey === parentKey || candidateKey.startsWith(parentKey + (process.platform === "win32" ? "\\" : "/"));
}

function isInitialWatcherEvent(root: string, watchedFile: string | undefined, watcherStartedAt: number): boolean {
  if (!watchedFile) return false;
  const target = resolve(root, watchedFile);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) return false;
  try {
    const stats = statSync(target);
    return Math.max(stats.mtimeMs, stats.ctimeMs) <= watcherStartedAt;
  } catch {
    return false;
  }
}

function cloneRun(run: InspectionRun): InspectionRun {
  return JSON.parse(JSON.stringify(run)) as InspectionRun;
}

function isRun(value: InspectionRun | undefined): value is InspectionRun { return value !== undefined; }

function errorInfo(error: unknown): InspectionErrorInfo {
  if (error instanceof InspectionExecutionError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  if (error instanceof WorkspaceConfigError) return { code: error.code, message: error.message };
  return { code: "inspector-failed", message: formatError(error) };
}
