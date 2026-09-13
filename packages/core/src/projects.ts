import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { resolveWorkspacePath } from "./config.js";
import type { LanguageId } from "./types.js";

export interface ProjectContext {
  root: string;
  language: LanguageId;
  marker?: string;
  configuration?: string;
}

export interface ProjectLocatorOptions {
  maxProjects?: number;
  includeHidden?: boolean;
}

const PROJECT_MARKERS: Record<LanguageId, readonly string[]> = {
  javascript: ["package.json", "tsconfig.json"],
  typescript: ["tsconfig.json", "package.json"],
  python: ["pyproject.toml", "ruff.toml", "pyrightconfig.json", "setup.cfg", "setup.py"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "mvnw", "mvnw.cmd", "gradlew", "gradlew.bat"],
  go: ["go.mod", "go.work"],
  rust: ["Cargo.toml"],
  c: ["compile_commands.json", "CMakeLists.txt"],
  cpp: ["compile_commands.json", "CMakeLists.txt"]
};

const GENERATED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "target", "coverage", ".cache", ".next", "out",
  ".gradle", ".idea", ".venv", "venv", "__pycache__", ".ruff_cache", ".pytest_cache", ".mypy_cache",
  ".tox", ".hypothesis", ".cargo", "bazel-out", "cmake-build-debug", "cmake-build-release"
]);

export function locateProject(root: string, language: LanguageId, file?: string, explicit?: string): ProjectContext {
  root = canonicalProjectRoot(root);
  if (explicit) {
    const resolved = resolveWorkspacePath(root, explicit);
    const projectRoot = isDirectory(resolved) ? resolved : dirname(resolved);
    return { root: projectRoot, language, configuration: resolved };
  }
  const start = file ? resolveWorkspacePath(root, file) : root;
  let current = existsSync(start) && isDirectory(start) ? start : dirname(start);
  for (;;) {
    for (const marker of PROJECT_MARKERS[language]) {
      const candidates = [join(current, marker)];
      if (language === "c" || language === "cpp") {
        candidates.push(
          join(current, "build", marker),
          join(current, "cmake-build-debug", marker),
          join(current, "cmake-build-release", marker),
          join(current, "out", "build", marker)
        );
      }
      const candidate = candidates.find((value) => existsSync(value));
      if (candidate) {
        return { root: current, language, marker, configuration: candidate };
      }
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current || !isInside(root, parent)) break;
    current = parent;
  }
  return { root, language };
}

export function projectMarkers(language: LanguageId): readonly string[] {
  return PROJECT_MARKERS[language];
}

/** Enumerate nested projects without crossing symlinked directories. */
export function locateProjects(rootInput: string, language: LanguageId, options: ProjectLocatorOptions = {}): ProjectContext[] {
  const root = canonicalProjectRoot(rootInput);
  const maxProjects = Math.max(1, options.maxProjects ?? 256);
  const projects = new Map<string, ProjectContext>();
  const ignored = GENERATED_DIRECTORIES;
  const visit = (directory: string): void => {
    if (projects.size >= maxProjects) return;
    const markers = PROJECT_MARKERS[language];
    for (const marker of markers) {
      const candidates = [join(directory, marker)];
      if (language === "c" || language === "cpp") candidates.push(
        join(directory, "build", marker),
        join(directory, "cmake-build-debug", marker),
        join(directory, "cmake-build-release", marker),
        join(directory, "out", "build", marker)
      );
      const configuration = candidates.find((candidate) => existsSync(candidate));
      if (configuration) {
        projects.set(directory, { root: directory, language, marker, configuration });
        break;
      }
    }
    if (projects.size >= maxProjects) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!options.includeHidden && entry.name.startsWith(".")) continue;
      if (ignored.has(entry.name.toLowerCase())) continue;
      visit(join(directory, entry.name));
      if (projects.size >= maxProjects) return;
    }
  };
  visit(root);
  return [...projects.values()].sort((left, right) => left.root.localeCompare(right.root));
}

/**
 * Header files are intentionally ambiguous by extension. When a compilation
 * database is available, use its compiler/source mix to select C or C++;
 * otherwise callers must require an explicit language.
 */
export function disambiguateHeaderLanguage(rootInput: string, fileInput: string, candidates: readonly LanguageId[]): LanguageId | undefined {
  if (!candidates.includes("c") || !candidates.includes("cpp") || extname(fileInput).toLowerCase() !== ".h") return candidates.length === 1 ? candidates[0] : undefined;
  const root = resolve(rootInput);
  const file = resolve(root, fileInput);
  const compileDatabaseCandidates = [
    join(root, "compile_commands.json"),
    join(root, "build", "compile_commands.json"),
    join(root, "cmake-build-debug", "compile_commands.json"),
    join(root, "cmake-build-release", "compile_commands.json"),
    join(root, "out", "build", "compile_commands.json")
  ];
  for (const database of compileDatabaseCandidates) {
    try {
      const value: unknown = JSON.parse(readFileSync(database, "utf8"));
      if (!Array.isArray(value)) continue;
      let hasCpp = false;
      let hasC = false;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const command = [record.command, record.arguments].flatMap((part) => Array.isArray(part) ? part : [part]).filter((part): part is string => typeof part === "string").join(" ").toLowerCase();
        const source = typeof record.file === "string" ? record.file.toLowerCase() : "";
        if (/(?:clang\+\+|g\+\+|c\+\+|\.cpp\b|\.cc\b|\.cxx\b)/.test(command + " " + source)) hasCpp = true;
        if (/(?:^|[\s/])(?:clang|gcc)(?:\s|$)|\.c\b/.test(command + " " + source)) hasC = true;
        if (typeof record.file === "string" && samePath(resolveCompileDatabaseFile(database, record), file)) {
          if (/(?:\+\+|\.cpp\b|\.cc\b|\.cxx\b)/.test(command + " " + source)) return "cpp";
          if (/(?:clang|gcc|\.c\b)/.test(command + " " + source)) return "c";
        }
      }
      if (hasCpp !== hasC) return hasCpp ? "cpp" : "c";
    } catch {
      // A malformed/partial compilation database cannot safely disambiguate.
    }
  }
  return undefined;
}

function resolveCompileDatabaseFile(database: string, record: Record<string, unknown>): string {
  const directoryValue = typeof record.directory === "string" && record.directory.length > 0 ? record.directory : ".";
  const databaseRoot = dirname(database);
  const directory = resolve(databaseRoot, directoryValue);
  const fileValue = typeof record.file === "string" ? record.file : "";
  return resolve(directory, fileValue);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replaceAll("\\", "/");
  const normalizedRight = resolve(right).replaceAll("\\", "/");
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonicalProjectRoot(input: string): string {
  const resolved = resolve(input);
  try { return resolve(realpathSync.native(resolved)); } catch { return resolved; }
}

function isInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rootKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const candidateKey = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${process.platform === "win32" ? "\\" : "/"}`);
}
