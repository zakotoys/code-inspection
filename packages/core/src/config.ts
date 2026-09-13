import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { CHECK_SCOPES, LANGUAGE_IDS, type CheckScope, type LanguageId } from "./types.js";

const DEFAULT_SOURCE_PATTERNS = ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];
const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"];

const CheckConfigSchema = z.object({
  adapter: z.string().min(1),
  enabled: z.boolean().default(true),
  languages: z.array(z.enum(LANGUAGE_IDS)).default([]),
  scope: z.enum(CHECK_SCOPES).optional(),
  cwd: z.string().min(1).default("."),
  exclude: z.array(z.string().min(1)).default(DEFAULT_EXCLUDES),
  patterns: z.array(z.string().min(1)).optional(),
  project: z.string().min(1).optional(),
  command: z.array(z.string().min(1)).min(1).optional(),
  parser: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  env: z.record(z.string(), z.string()).default({}),
  options: z.record(z.string(), z.unknown()).default({})
}).strict();

export type CheckConfig = z.infer<typeof CheckConfigSchema>;

const DEFAULT_CHECKS: Record<string, CheckConfig> = {
  eslint: {
    adapter: "eslint",
    enabled: true,
    languages: ["javascript", "typescript"],
    scope: "file",
    cwd: ".",
    exclude: DEFAULT_EXCLUDES,
    patterns: DEFAULT_SOURCE_PATTERNS,
    timeoutMs: 120000,
    env: {},
    options: {}
  },
  typescript: {
    adapter: "typescript",
    enabled: false,
    languages: ["javascript", "typescript"],
    scope: "project",
    cwd: ".",
    exclude: DEFAULT_EXCLUDES,
    project: "tsconfig.json",
    timeoutMs: 120000,
    env: {},
    options: {}
  },
  build: {
    adapter: "command",
    enabled: false,
    languages: [],
    scope: "workspace",
    cwd: ".",
    exclude: DEFAULT_EXCLUDES,
    command: ["npm", "run", "build"],
    parser: "build",
    timeoutMs: 120000,
    env: {},
    options: {}
  }
};

export const WorkspaceConfigSchema = z.object({
  version: z.literal(2),
  debounceMs: z.number().int().min(0).max(10000).default(300),
  maxFindings: z.number().int().min(1).max(10000).default(2000),
  // Use a factory so callers cannot mutate the shared template through one
  // parsed config and silently change defaults for another workspace.
  checks: z.record(z.string().min(1), CheckConfigSchema).default(() => cloneDefaultChecks())
}).strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type ConfiguredLanguageId = LanguageId;
export type ConfiguredCheckScope = CheckScope;

export class WorkspaceConfigError extends Error {
  readonly code = "configuration-error";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceConfigError";
  }
}

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({ version: 2 });
}

function cloneDefaultChecks(): Record<string, CheckConfig> {
  return Object.fromEntries(Object.entries(DEFAULT_CHECKS).map(([id, check]) => [id, {
    ...check,
    languages: [...check.languages],
    exclude: [...check.exclude],
    ...(check.patterns ? { patterns: [...check.patterns] } : {}),
    ...(check.project ? { project: check.project } : {}),
    ...(check.command ? { command: [...check.command] } : {}),
    ...(check.parser ? { parser: check.parser } : {}),
    env: { ...check.env },
    options: { ...check.options }
  }])) as Record<string, CheckConfig>;
}

export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  const configPath = join(root, ".code-inspection.json");
  try {
    const text = await readFile(configPath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new WorkspaceConfigError("Invalid JSON in " + configPath + ": " + formatError(error), { cause: error });
    }
    const parsed = WorkspaceConfigSchema.safeParse(value);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ");
      throw new WorkspaceConfigError("Invalid " + configPath + ": " + details);
    }
    // Semantic adapter/parser validation lives in the registry to keep the
    // schema extensible while still rejecting unusable workspace configs at load time.
    const { createInspectorRegistry } = await import("./registry.js");
    createInspectorRegistry().validate(parsed.data);
    validateWorkspaceConfigPaths(root, parsed.data);
    return parsed.data;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return defaultWorkspaceConfig();
    }
    throw error;
  }
}

function validateWorkspaceConfigPaths(root: string, config: WorkspaceConfig): void {
  for (const [checkId, check] of Object.entries(config.checks)) {
    try {
      const cwd = resolveWorkspacePath(root, check.cwd);
      if (check.project) resolveWorkspacePath(root, resolve(cwd, check.project));
      validateOptionPath(root, checkId, check.options, "compileCommands");
      validateOptionPath(root, checkId, check.options, "reportFile");
    } catch (error) {
      throw new WorkspaceConfigError(`Invalid path in check ${checkId}: ${formatError(error)}`, { cause: error });
    }
  }
}

function validateOptionPath(root: string, checkId: string, options: Record<string, unknown>, key: string): void {
  const value = options[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceConfigError(`Check ${checkId} option ${key} must be a non-empty workspace path.`);
  }
  // These adapter options are resolved against the discovered project root at
  // execution time. Validate the workspace-relative form up front as well so
  // trust cannot be granted to a configuration that later reaches outside the
  // workspace through ../ or an external file URI.
  resolveWorkspacePath(root, value);
}

export async function canonicalizeWorkspaceRoot(input: string): Promise<string> {
  const candidate = resolve(input);
  try {
    const { realpath } = await import("node:fs/promises");
    return normalize(await realpath(candidate));
  } catch (error) {
    throw new WorkspaceConfigError("Workspace does not exist or cannot be read: " + candidate, { cause: error });
  }
}

export function resolveWorkspacePath(root: string, candidate: string): string {
  if (candidate.includes("://") && !candidate.startsWith("file://")) {
    throw new WorkspaceConfigError("Unsupported path URI: " + candidate);
  }
  const raw = candidate.startsWith("file://") ? fileURLToPathSafe(candidate) : candidate;
  const resolved = normalize(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
  const checked = existingRealPath(resolved);
  if (!isPathInside(root, checked)) {
    throw new WorkspaceConfigError("Path escapes the workspace: " + candidate);
  }
  return checked;
}

export function relativeWorkspacePath(root: string, candidate: string): string {
  const resolved = resolveWorkspacePath(root, candidate);
  return relative(root, resolved) || ".";
}

export function fileUriForPath(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function pathForWorkspaceKey(root: string): string {
  const normalized = normalizeForComparison(root).replaceAll("\\", "/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function defaultDataDirectory(): string {
  if (process.env.CODE_INSPECTION_DATA_DIR) {
    return resolve(process.env.CODE_INSPECTION_DATA_DIR);
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "code-inspection");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "code-inspection");
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "code-inspection");
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileURLToPathSafe(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? fileURLToPath(url) : value;
  } catch {
    throw new WorkspaceConfigError("Invalid file URI: " + value);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  // The caller normally supplies a canonical root, but this helper is public
  // and is also used before canonicalization during project discovery. Compare
  // against the real root so a symlinked temporary directory is not mistaken
  // for an escaping path.
  let canonicalRoot = root;
  try { canonicalRoot = normalize(realpathSync.native(root)); } catch { /* keep the lexical root when it does not exist */ }
  const rootKey = normalizeForComparison(canonicalRoot).replace(/[\\/]$/, "");
  const candidateKey = normalizeForComparison(candidate).replace(/[\\/]$/, "");
  const pathRelation = relative(rootKey, candidateKey);
  return pathRelation === "" || (pathRelation !== ".." && !pathRelation.startsWith(".." + sep) && !isAbsolute(pathRelation));
}

function normalizeForComparison(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function existingRealPath(value: string): string {
  let current = value;
  const missing: string[] = [];
  for (;;) {
    try {
      const realParent = normalize(realpathSync.native(current));
      return normalize(join(realParent, ...missing.reverse()));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new WorkspaceConfigError("Path cannot be resolved: " + value, { cause: error });
      }
      const parent = dirname(current);
      if (parent === current) return value;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function configDirectory(root: string): string {
  return dirname(resolve(root, ".code-inspection.json"));
}
