import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const DEFAULT_SOURCE_PATTERNS = ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];
const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"];
const DEFAULT_PATH_CONFIG = { enabled: true, cwd: ".", exclude: DEFAULT_EXCLUDES };

const InspectorPathSchema = z.object({
  enabled: z.boolean().default(true),
  cwd: z.string().min(1).default("."),
  exclude: z.array(z.string().min(1)).default(DEFAULT_EXCLUDES)
}).strict();

const EslintConfigSchema = InspectorPathSchema.extend({
  patterns: z.array(z.string().min(1)).default(DEFAULT_SOURCE_PATTERNS)
}).strict();

const TypeScriptConfigSchema = InspectorPathSchema.extend({
  project: z.string().min(1).default("tsconfig.json")
}).strict();

const BuildConfigSchema = InspectorPathSchema.extend({
  command: z.array(z.string().min(1)).min(1).default(["npm", "run", "build"]),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  env: z.record(z.string(), z.string()).default({})
}).strict();

export const WorkspaceConfigSchema = z.object({
  version: z.literal(1).default(1),
  debounceMs: z.number().int().min(0).max(10000).default(300),
  maxFindings: z.number().int().min(1).max(10000).default(2000),
  inspectors: z.object({
    eslint: EslintConfigSchema.default({ ...DEFAULT_PATH_CONFIG, patterns: DEFAULT_SOURCE_PATTERNS }),
    typescript: TypeScriptConfigSchema.default({ ...DEFAULT_PATH_CONFIG, enabled: false, project: "tsconfig.json" }),
    build: BuildConfigSchema.default({ ...DEFAULT_PATH_CONFIG, enabled: false, command: ["npm", "run", "build"], timeoutMs: 120000, env: {} })
  }).strict().default({
    eslint: { ...DEFAULT_PATH_CONFIG, patterns: DEFAULT_SOURCE_PATTERNS },
    typescript: { ...DEFAULT_PATH_CONFIG, enabled: false, project: "tsconfig.json" },
    build: { ...DEFAULT_PATH_CONFIG, enabled: false, command: ["npm", "run", "build"], timeoutMs: 120000, env: {} }
  })
}).strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export class WorkspaceConfigError extends Error {
  readonly code = "configuration-error";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceConfigError";
  }
}

export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  const configPath = join(root, ".code-inspection.json");
  try {
    const text = await readFile(configPath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new WorkspaceConfigError(`Invalid JSON in ${configPath}: ${formatError(error)}`, { cause: error });
    }
    const parsed = WorkspaceConfigSchema.safeParse(value);
    if (!parsed.success) {
      throw new WorkspaceConfigError(`Invalid ${configPath}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    return parsed.data;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return WorkspaceConfigSchema.parse({});
    }
    throw error;
  }
}

export async function canonicalizeWorkspaceRoot(input: string): Promise<string> {
  const candidate = resolve(input);
  try {
    const { realpath } = await import("node:fs/promises");
    return normalize(await realpath(candidate));
  } catch (error) {
    throw new WorkspaceConfigError(`Workspace does not exist or cannot be read: ${candidate}`, { cause: error });
  }
}

export function resolveWorkspacePath(root: string, candidate: string): string {
  if (candidate.includes("://") && !candidate.startsWith("file://")) {
    throw new WorkspaceConfigError(`Unsupported path URI: ${candidate}`);
  }
  const raw = candidate.startsWith("file://") ? fileURLToPathSafe(candidate) : candidate;
  const resolved = normalize(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
  const checked = existingRealPath(resolved);
  if (!isPathInside(root, checked)) {
    throw new WorkspaceConfigError(`Path escapes the workspace: ${candidate}`);
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
    throw new WorkspaceConfigError(`Invalid file URI: ${value}`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rootKey = normalizeForComparison(root).replace(/[\\/]$/, "");
  const candidateKey = normalizeForComparison(candidate).replace(/[\\/]$/, "");
  const pathRelation = relative(rootKey, candidateKey);
  return pathRelation === "" || (pathRelation !== ".." && !pathRelation.startsWith(`..${sep}`) && !isAbsolute(pathRelation));
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
        throw new WorkspaceConfigError(`Path cannot be resolved: ${value}`, { cause: error });
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
