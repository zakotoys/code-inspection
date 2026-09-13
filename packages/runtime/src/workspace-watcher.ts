import { lstat, readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

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
  const recentEvents = new Map<string, number>();
  let closed = false;

  const emit = (eventType: "rename" | "change", absolutePath?: string): void => {
    if (closed) return;
    const relativePath = absolutePath ? relative(root, absolutePath).replaceAll("\\", "/") : undefined;
    if (relativePath !== undefined && (relativePath === "" || relativePath === "." || relativePath.startsWith("../") || relativePath === "..")) {
      options.onChange(eventType);
      return;
    }
    const key = `${eventType}:${relativePath ?? "<unknown>"}`;
    const now = Date.now();
    const previous = recentEvents.get(key);
    if (previous !== undefined && now - previous < 50) return;
    recentEvents.set(key, now);
    if (recentEvents.size > 2048) {
      for (const [eventKey, eventAt] of recentEvents) {
        if (now - eventAt > 1000) recentEvents.delete(eventKey);
      }
    }
    options.onChange(eventType, relativePath);
  };

  const shouldSkipDirectory = (directory: string): boolean => {
    const segments = relative(root, directory).replaceAll("\\", "/").split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    return segments.some((segment) => [
      ".git", "node_modules", "dist", "coverage", "target", "build", "out", ".cache", ".next",
      ".ruff_cache", ".pytest_cache", ".mypy_cache", "__pycache__", ".gradle", ".idea", ".venv", "venv",
      ".tox", ".hypothesis", ".cargo", "bazel-out", "cmake-build-debug", "cmake-build-release"
    ].includes(segment));
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
      let watcher: FSWatcher;
      try {
        watcher = watch(directory, { persistent: false }, (eventType, filename) => {
          const name = filename ? String(filename).replaceAll("\\", "/") : undefined;
          // macOS reports the watched directory's own basename for metadata
          // changes (and Linux can do the same during a rename). Treat that as
          // an unknown/root event instead of constructing `dir/dir`.
          const changed = name
            ? (name === basename(directory) ? directory : resolve(directory, name))
            : undefined;
          emit(eventType === "rename" ? "rename" : "change", changed);
          if (!changed || !isPathWithin(root, changed)) return;
          void stat(changed).then(async (stats) => {
            if (stats.isDirectory()) await addDirectory(changed);
          }).catch(() => {
            if (eventType === "rename") removeSubtree(changed);
          });
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
      recentEvents.clear();
    }
  };
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
