import { minimatch } from "minimatch";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Returns a workspace-relative POSIX path suitable for matching against a
 * user-provided glob. Invalid or escaping paths are deliberately rejected by
 * the caller before this helper is used.
 */
export function relativeMatchPath(root: string, value: string): string {
  const raw = value.startsWith("file:") ? fileURLToPath(value) : value;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  return relative(canonicalPath(root), canonicalPath(absolute)).replaceAll("\\", "/");
}

/** Resolve existing symlink segments while preserving a missing descendant. */
function canonicalPath(value: string): string {
  let current = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const realParent = resolve(realpathSync.native(current));
      return resolve(realParent, ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") return current;
      const parent = resolve(current, "..");
      if (parent === current) return current;
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const candidate = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
    return minimatch(normalized, candidate, {
      dot: true,
      nocase: process.platform === "win32",
      matchBase: !candidate.includes("/")
    });
  });
}

export function validatePatterns(patterns: readonly string[]): void {
  for (const pattern of patterns) {
    try {
      validateGlobDelimiters(pattern);
      minimatch.makeRe(pattern.replaceAll("\\", "/"));
    } catch (error) {
      throw new Error(`Invalid glob pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function validateGlobDelimiters(pattern: string): void {
  const stack: string[] = [];
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") {
      stack.push(character);
      continue;
    }
    if (character !== "]" && character !== "}" && character !== ")") continue;
    const expected = character === "]" ? "[" : character === "}" ? "{" : "(";
    if (stack.pop() !== expected) throw new Error(`Unbalanced glob delimiter ${character}.`);
  }
  if (stack.length > 0) throw new Error(`Unbalanced glob delimiter ${stack[stack.length - 1]}.`);
}

export function isExcludedPath(root: string, value: string, patterns: readonly string[]): boolean {
  const normalized = relativeMatchPath(root, value);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") return true;
  return matchesAnyPattern(normalized, patterns);
}

export function filterExcludedPaths(root: string, values: readonly string[], patterns: readonly string[]): string[] {
  return values.filter((value) => !isExcludedPath(root, value, patterns));
}
