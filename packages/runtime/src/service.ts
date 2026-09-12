import {
  InspectionCancelledError,
  InspectionEngine,
  InspectionExecutionError,
  WorkspaceConfigError,
  TrustStore,
  canonicalizeWorkspaceRoot,
  fileUriForPath,
  formatError,
  loadWorkspaceConfig,
  relativeWorkspacePath,
  resolveWorkspacePath,
  type Finding,
  type FindingsPage,
  type InspectionErrorInfo,
  type InspectionRun,
  type InspectorId,
  type RunSnapshot
} from "@zakotoys/code-inspection-core";
import { statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Logger } from "@zakotoys/code-inspection-core";
import type {
  CancelRunParams,
  CancelRunResult,
  ChangeParams,
  GetFindingsParams,
  GetFindingsResult,
  GetRunParams,
  GetRunResult,
  RunInspectionParams,
  RunInspectionResult,
  SaveParams,
  SaveResult,
  ServiceApi,
  StatusResult
} from "./protocol.js";

interface ActiveRun {
  run: InspectionRun;
  controller: AbortController;
  files: Set<string>;
  global: boolean;
  timer?: ReturnType<typeof setTimeout>;
  superseded: boolean;
}

const MAX_RETAINED_RUNS = 100;

export class WorkspaceService implements ServiceApi {
  readonly root: string;
  private readonly logger: Logger;
  private readonly trustStore: TrustStore;
  private engine: InspectionEngine;
  private readonly runs = new Map<string, InspectionRun>();
  private readonly findings = new Map<InspectorId, Finding[]>();
  private readonly active = new Map<InspectorId, ActiveRun>();
  private readonly latest = new Map<InspectorId, string>();
  private readonly dirtyFiles = new Set<string>();
  private readonly recentSaves = new Map<string, number>();
  private readonly schedulingTails = new Map<InspectorId, Promise<void>>();
  private watcher: FSWatcher | undefined;
  private sequence = 0;
  private generation = 0;

  private constructor(root: string, logger: Logger, trustStore: TrustStore, config: Awaited<ReturnType<typeof loadWorkspaceConfig>>) {
    this.root = root;
    this.logger = logger;
    this.trustStore = trustStore;
    this.engine = new InspectionEngine({ root, config }, logger);
  }

  static async create(inputRoot: string, options: { logger: Logger; trustStore?: TrustStore }): Promise<WorkspaceService> {
    const root = await canonicalizeWorkspaceRoot(inputRoot);
    const config = await loadWorkspaceConfig(root);
    const service = new WorkspaceService(root, options.logger, options.trustStore ?? new TrustStore(), config);
    service.startWatcher();
    return service;
  }

  async runInspection(params: RunInspectionParams): Promise<RunInspectionResult> {
    const previous = this.schedulingTails.get(params.inspector);
    const joinsPendingRequest = previous !== undefined;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.schedulingTails.set(params.inspector, current);
    await previous;
    try {
      return await this.scheduleInspection(params, joinsPendingRequest);
    } finally {
      release();
      if (this.schedulingTails.get(params.inspector) === current) this.schedulingTails.delete(params.inspector);
    }
  }

  private async scheduleInspection(params: RunInspectionParams, joinsPendingRequest: boolean): Promise<RunInspectionResult> {
    await this.requireTrusted();
    const inspector = params.inspector;
    const scopeFiles = this.normalizeScopeFiles(params.scope?.files);
    const current = this.active.get(inspector);
    if (current && current.run.outcome === "queued") {
      if (scopeFiles.length === 0) current.global = true;
      for (const file of scopeFiles) current.files.add(file);
      current.run.scope = this.scopeForFiles(current.files, current.global);
      return { run: cloneRun(current.run) };
    }

    if (current && current.run.outcome === "running") {
      if (joinsPendingRequest) return { run: cloneRun(current.run) };
      current.superseded = true;
      current.run.outcome = "superseded";
      current.run.endedAt = new Date().toISOString();
      current.controller.abort();
      this.active.delete(inspector);
    }

    const run: InspectionRun = {
      runId: this.nextRunId(inspector),
      workspace: this.root,
      inspector,
      scope: this.scopeForFiles(scopeFiles, scopeFiles.length === 0),
      trigger: params.trigger,
      generation: ++this.generation,
      outcome: "queued"
    };
    const active: ActiveRun = { run, controller: new AbortController(), files: new Set(scopeFiles), global: scopeFiles.length === 0, superseded: false };
    this.runs.set(run.runId, run);
    this.active.set(inspector, active);
    this.trimRuns();
    let config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
    try {
      config = await this.currentConfig();
      if (!config.inspectors[inspector].enabled) {
        throw new InspectionExecutionError("inspector-disabled", `The ${inspector} inspector is disabled in .code-inspection.json.`);
      }
    } catch (error) {
      this.failRun(active, error);
      return { run: cloneRun(run) };
    }
    const delay = params.trigger === "save" ? config.debounceMs : 0;
    active.timer = setTimeout(() => {
      void this.execute(active);
    }, delay);
    return { run: cloneRun(run) };
  }

  async getRun(params: GetRunParams): Promise<GetRunResult> {
    const run = this.runs.get(params.runId);
    if (!run) throw new Error(`Run not found: ${params.runId}`);
    return { snapshot: this.snapshot(run) };
  }

  async getFindings(params: GetFindingsParams): Promise<GetFindingsResult> {
    const values = [...this.findings.entries()]
      .filter(([inspector]) => !params.inspector || inspector === params.inspector)
      .flatMap(([, values]) => values)
      .filter((finding) => params.includeStale || !finding.stale)
      .filter((finding) => !params.file || finding.file === fileUriForPath(resolveWorkspacePath(this.root, params.file)));
    const sorted = values.sort((left, right) => (left.file ?? "").localeCompare(right.file ?? "") || (left.range?.start.line ?? -1) - (right.range?.start.line ?? -1) || left.message.localeCompare(right.message));
    const offset = Math.max(0, params.offset);
    const limit = Math.min(500, Math.max(1, params.limit));
    const findings = sorted.slice(offset, offset + limit);
    const page: FindingsPage = {
      total: sorted.length,
      count: findings.length,
      offset,
      findings,
      hasMore: offset + findings.length < sorted.length,
      ...(offset + findings.length < sorted.length ? { nextOffset: offset + findings.length } : {})
    };
    return { page, runs: [...this.latest.values()].map((runId) => this.runs.get(runId)).filter(isRun) };
  }

  async cancelRun(params: CancelRunParams): Promise<CancelRunResult> {
    const run = this.runs.get(params.runId);
    if (!run) throw new Error(`Run not found: ${params.runId}`);
    const active = this.active.get(run.inspector);
    if (active?.run.runId === run.runId) {
      if (active.timer) clearTimeout(active.timer);
      active.controller.abort();
      active.run.outcome = "cancelled";
      active.run.endedAt = new Date().toISOString();
      this.active.delete(run.inspector);
    }
    return { run: cloneRun(run) };
  }

  async didSave(params: SaveParams): Promise<SaveResult> {
    const file = this.normalizeScopeFiles([params.file])[0];
    if (!file) throw new Error("A saved file is required.");
    this.recentSaves.set(file, Date.now());
    while (this.recentSaves.size > 1000) {
      const oldest = this.recentSaves.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentSaves.delete(oldest);
    }
    this.dirtyFiles.delete(file);
    const runs: InspectionRun[] = [];
    const config = await this.currentConfig();
    const candidates: InspectorId[] = ["eslint", "typescript", "build"];
    for (const inspector of candidates) {
      if (!config.inspectors[inspector].enabled) continue;
      if (inspector === "eslint" && !isSourceFile(file)) continue;
      const result = await this.runInspection({ inspector, scope: { files: [file] }, trigger: "save" });
      runs.push(result.run);
    }
    return { runs };
  }

  async didChange(params: ChangeParams): Promise<void> {
    const file = this.normalizeScopeFiles([params.file])[0];
    if (file) {
      this.dirtyFiles.add(file);
      this.markFileStale(file);
      this.invalidateActiveRuns();
    }
  }

  async getStatus(): Promise<StatusResult> {
    const trusted = await this.trustStore.isTrusted(this.root);
    return {
      root: this.root,
      trusted,
      activeRuns: [...this.active.values()].map((active) => cloneRun(active.run)),
      latestRuns: [...this.latest.values()].map((runId) => this.runs.get(runId)).filter(isRun).map(cloneRun),
      findingCount: [...this.findings.values()].reduce((total, values) => total + values.length, 0)
    };
  }

  async dispose(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    for (const active of this.active.values()) {
      if (active.timer) clearTimeout(active.timer);
      active.controller.abort();
    }
    this.active.clear();
  }

  private async execute(active: ActiveRun): Promise<void> {
    if (active.superseded || active.run.outcome !== "queued") return;
    active.run.outcome = "running";
    active.run.startedAt = new Date().toISOString();
    try {
      const output = await this.engine.run({
        runId: active.run.runId,
        inspector: active.run.inspector,
        scope: this.scopeForFiles(active.files, active.global),
        trigger: active.run.trigger,
        generation: active.run.generation
      }, active.controller.signal);
      if (active.superseded || active.run.outcome !== "running") return;
      active.run.summary = output.summary;
      active.run.outcome = "completed";
      active.run.endedAt = new Date().toISOString();
      this.replaceFindings(active, output.findings);
      this.latest.set(active.run.inspector, active.run.runId);
    } catch (error) {
      if (active.superseded || active.run.outcome !== "running") return;
      active.run.endedAt = new Date().toISOString();
      if (error instanceof InspectionCancelledError) {
        active.run.outcome = "cancelled";
      } else {
        active.run.outcome = "failed";
        active.run.error = errorInfo(error);
        this.markFindingsStale(active.run.inspector);
      }
    } finally {
      if (this.active.get(active.run.inspector)?.run.runId === active.run.runId) {
        this.active.delete(active.run.inspector);
      }
      this.trimRuns();
    }
  }

  private replaceFindings(active: ActiveRun, incoming: Finding[]): void {
    const existing = this.findings.get(active.run.inspector) ?? [];
    const scopeFiles = active.global ? new Set<string>() : active.files;
    const retained = active.run.inspector === "eslint" && scopeFiles.size > 0
      ? existing.filter((finding) => !finding.file || !scopeFiles.has(this.relativeFileFromUri(finding.file)))
      : [];
    this.findings.set(active.run.inspector, [...retained, ...incoming]);
  }

  private markFileStale(file: string): void {
    for (const [inspector, existing] of this.findings) {
      this.findings.set(inspector, existing.map((finding) => finding.file && this.relativeFileFromUri(finding.file) === file ? { ...finding, stale: true } : finding));
    }
  }

  private invalidateActiveRuns(): void {
    this.generation += 1;
    for (const active of this.active.values()) {
      if (active.timer) clearTimeout(active.timer);
      active.superseded = true;
      active.run.outcome = "superseded";
      active.run.endedAt = new Date().toISOString();
      active.controller.abort();
    }
    this.active.clear();
  }

  private startWatcher(): void {
    const watcherStartedAt = Date.now();
    const onChange = (_eventType: string, filename: string | Buffer | null): void => {
      const watchedFile = filename ? String(filename).replaceAll("\\", "/") : undefined;
      if (isInitialWatcherEvent(this.root, watchedFile, watcherStartedAt)) return;
      let relativeFile = watchedFile;
      if (watchedFile && isAbsolute(watchedFile)) {
        try {
          relativeFile = relativeWorkspacePath(this.root, watchedFile);
        } catch {
          relativeFile = undefined;
        }
      }
      if (!relativeFile) {
        this.markAllFindingsStale();
        this.invalidateActiveRuns();
        return;
      }
      if (isIgnoredExternalPath(relativeFile)) return;
      const savedAt = this.recentSaves.get(relativeFile);
      if (savedAt !== undefined) {
        if (Date.now() - savedAt < 1500) return;
        this.recentSaves.delete(relativeFile);
      }
      if (relativeFile === ".code-inspection.json") this.markAllFindingsStale();
      else this.markFileStale(relativeFile);
      this.invalidateActiveRuns();
    };
    try {
      this.watcher = watch(this.root, { recursive: true }, onChange);
    } catch {
      this.watcher = watch(this.root, onChange);
    }
    this.watcher.unref?.();
  }

  private markAllFindingsStale(): void {
    for (const [inspector, existing] of this.findings) {
      this.findings.set(inspector, existing.map((finding) => ({ ...finding, stale: true })));
    }
  }

  private markFindingsStale(inspector: InspectorId): void {
    const existing = this.findings.get(inspector) ?? [];
    this.findings.set(inspector, existing.map((finding) => ({ ...finding, stale: true })));
  }

  private snapshot(run: InspectionRun): RunSnapshot {
    const currentFindings = (this.findings.get(run.inspector) ?? []).filter((finding) => finding.runId === run.runId || finding.stale);
    return {
      run: cloneRun(run),
      findings: currentFindings,
      freshness: {
        generation: this.generation,
        dirtyFiles: [...this.dirtyFiles],
        stale: currentFindings.some((finding) => finding.stale === true) || run.outcome === "failed"
      }
    };
  }

  private normalizeScopeFiles(files: string[] | undefined): string[] {
    if (!files) return [];
    if (files.length > 100) throw new Error("A run may include at most 100 files.");
    return [...new Set(files.map((file) => relativeWorkspacePath(this.root, file)))];
  }

  private scopeForFiles(files: Iterable<string>, global = false): { files?: string[] } {
    if (global) return {};
    const values = [...files];
    return values.length > 0 ? { files: values } : {};
  }

  private relativeFileFromUri(file: string): string {
    try {
      return relativeWorkspacePath(this.root, file);
    } catch {
      return file;
    }
  }

  private nextRunId(inspector: InspectorId): string {
    this.sequence += 1;
    return `${inspector}-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  private trimRuns(): void {
    while (this.runs.size > MAX_RETAINED_RUNS) {
      const first = this.runs.keys().next().value as string | undefined;
      if (!first || [...this.active.values()].some((active) => active.run.runId === first)) break;
      this.runs.delete(first);
    }
  }

  private async requireTrusted(): Promise<void> {
    await this.trustStore.requireTrusted(this.root);
  }

  private async currentConfig(): Promise<Awaited<ReturnType<typeof loadWorkspaceConfig>>> {
    const config = await loadWorkspaceConfig(this.root);
    this.engine = new InspectionEngine({ root: this.root, config }, this.logger);
    return config;
  }

  private failRun(active: ActiveRun, error: unknown): void {
    if (active.timer) clearTimeout(active.timer);
    active.run.outcome = "failed";
    active.run.endedAt = new Date().toISOString();
    active.run.error = errorInfo(error);
    this.active.delete(active.run.inspector);
    this.markFindingsStale(active.run.inspector);
    this.trimRuns();
  }
}

function isSourceFile(file: string): boolean {
  return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"].includes(file.slice(file.lastIndexOf(".")));
}

function isIgnoredExternalPath(file: string): boolean {
  const firstSegment = file.replaceAll("\\", "/").split("/")[0]?.toLowerCase();
  return firstSegment !== undefined && [".git", "node_modules", "dist", "coverage", "target", ".cache", ".next", "out", "build"].includes(firstSegment);
}

function isInitialWatcherEvent(root: string, watchedFile: string | undefined, watcherStartedAt: number): boolean {
  if (!watchedFile) return false;
  // macOS can replay events for paths that existed before watch() was attached.
  const target = resolve(root, watchedFile);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) return false;
  try {
    const stats = statSync(target);
    // Replacements can preserve mtime, but still update the metadata change time.
    // Keep events on the startup millisecond because their ordering is ambiguous.
    return Math.max(stats.mtimeMs, stats.ctimeMs) < watcherStartedAt;
  } catch {
    return false;
  }
}

function cloneRun(run: InspectionRun): InspectionRun {
  return JSON.parse(JSON.stringify(run)) as InspectionRun;
}

function isRun(value: InspectionRun | undefined): value is InspectionRun {
  return value !== undefined;
}

function errorInfo(error: unknown): InspectionErrorInfo {
  if (error instanceof InspectionExecutionError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof WorkspaceConfigError) return { code: error.code, message: error.message };
  return { code: "inspector-failed", message: formatError(error) };
}
