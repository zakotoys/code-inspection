import { lstat, readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "coverage", "target", "build", "out", ".cache", ".next",
  ".ruff_cache", ".pytest_cache", ".mypy_cache", "__pycache__", ".gradle", ".idea", ".venv", "venv",
  ".tox", ".hypothesis", ".cargo", "bazel-out", "cmake-build-debug", "cmake-build-release"
]);
const IGNORED_FILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "go.sum",
  "cargo.lock", "composer.lock", ".ds_store"
]);
const IGNORED_EXTENSIONS = new Set([
  ".class", ".pyc", ".pyo", ".o", ".obj", ".a", ".so", ".dylib", ".dll", ".exe", ".pdb", ".ilk"
]);

export interface WorkspaceWatcher {
  close(): void;
}

export interface WorkspaceWatcherOptions {
  onChange(eventType: "rename" | "change", relativePath?: string): void;
  onError?(error: unknown): void;
}

/**
 * A small cross-platform recursive watcher built on directory-level fs.watch.
 * Node's recursive option is unavailable on Linux, and relying on it silently
 * loses nested project changes. Symlinked directories are never traversed.
 */
export async function watchWorkspace(rootInput: string, options: WorkspaceWatcherOptions): Promise<WorkspaceWatcher> {
  const root = resolve(rootInput);
  const watchers = new Map<string, FSWatcher>();
  const pendingDirectories = new Set<string>();
  let closed = false;

  const emit = (eventType: "rename" | "change", absolutePath?: string): void => {
    if (closed) return;
    const relativePath = absolutePath ? relative(root, absolutePath).replaceAll("\\", "/") : undefined;
    if (relativePath !== undefined && (relativePath === "" || relativePath === "." || relativePath.startsWith("../") || relativePath === "..")) {
      options.onChange(eventType);
      return;
    }
    options.onChange(eventType, relativePath);
  };

  const shouldSkipDirectory = (directory: string): boolean => {
    const segments = relative(root, directory).replaceAll("\\", "/").split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    return segments.some(isIgnoredDirectorySegment);
  };

  const removeSubtree = (directory: string): void => {
    const target = normalizeDirectory(directory);
    for (const [watched, watcher] of watchers) {
      if (isPathWithin(target, watched)) {
        watcher.close();
        watchers.delete(watched);
      }
    }
    for (const pending of pendingDirectories) {
      if (isPathWithin(target, pending)) pendingDirectories.delete(pending);
    }
  };

  const addDirectory = async (directoryInput: string): Promise<void> => {
    if (closed) return;
    const directory = normalizeDirectory(directoryInput);
    if (shouldSkipDirectory(directory) || watchers.has(directory) || pendingDirectories.has(directory)) return;
    pendingDirectories.add(directory);
    try {
      let directoryStats;
      try {
        directoryStats = await lstat(directory);
      } catch {
        return;
      }
      if (closed || !directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return;
      const knownEntries = new Set<string>();
      let watcher: FSWatcher;
      try {
        watcher = watch(directory, { persistent: false }, (eventType, filename) => {
          const name = filename ? String(filename).replaceAll("\\", "/") : undefined;
          const normalizedEvent = eventType === "rename" ? "rename" : "change";
          if (!name) {
            emit(normalizedEvent);
            return;
          }
          const changed = resolve(directory, name);
          const processEntry = (): void => {
            emit(normalizedEvent, changed);
            if (!isPathWithin(root, changed)) return;
            void stat(changed).then(async (stats) => {
              knownEntries.add(name);
              if (stats.isDirectory()) await addDirectory(changed);
            }).catch(() => {
              knownEntries.delete(name);
              if (eventType === "rename") removeSubtree(changed);
            });
          };
          // macOS can report a watched directory's own basename for metadata
          // changes. Only treat that ambiguous name as a child when the child
          // exists now or was present before a deletion event.
          if (name === basename(directory) && !knownEntries.has(name)) {
            void lstat(changed).then(processEntry).catch(() => undefined);
            return;
          }
          processEntry();
        });
      } catch (error) {
        options.onError?.(error);
        return;
      }
      if (closed) {
        watcher.close();
        return;
      }
      watcher.on("error", (error) => {
        if (watchers.get(directory) === watcher) watchers.delete(directory);
        options.onError?.(error);
      });
      watcher.on("close", () => {
        if (watchers.get(directory) === watcher) watchers.delete(directory);
      });
      watcher.unref?.();
      watchers.set(directory, watcher);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        removeSubtree(directory);
        return;
      }
      if (closed) return;
      for (const entry of entries) knownEntries.add(entry.name);
      await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => addDirectory(resolve(directory, entry.name))));
    } finally {
      pendingDirectories.delete(directory);
    }
  };

  await addDirectory(root);
  return {
    close: () => {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      pendingDirectories.clear();
    }
  };
}

export function isIgnoredWorkspacePath(file: string): boolean {
  const segments = file.replaceAll("\\", "/").split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const filename = segments[segments.length - 1] ?? "";
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  return segments.some(isIgnoredDirectorySegment)
    || IGNORED_FILES.has(filename)
    || IGNORED_EXTENSIONS.has(extension);
}

function isIgnoredDirectorySegment(segment: string): boolean {
  // Cargo atomically creates its default output directory through a sibling
  // named `target` plus a six-character tempfile suffix.
  return IGNORED_DIRECTORIES.has(segment) || /^target[a-z0-9]{6}$/.test(segment);
}

function normalizeDirectory(value: string): string {
  return resolve(value);
}

function isPathWithin(parentInput: string, candidateInput: string): boolean {
  const parent = normalizeDirectory(parentInput);
  const candidate = normalizeDirectory(candidateInput);
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
