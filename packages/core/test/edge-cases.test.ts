import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeWorkspaceRoot, fileUriForPath, InspectionEngine,
  loadWorkspaceConfig, resolveWorkspacePath, TrustStore, WorkspaceConfigError,
  WorkspaceConfigSchema, WorkspaceTrustError, probeToolVersion, runTool
} from "../src/index.js";

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "inspection-edge-"));
  directories.push(directory);
  return canonicalizeWorkspaceRoot(directory);
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("configuration and path boundaries", () => {
  it("defaults to ESLint only when configuration is absent", async () => {
    const config = await loadWorkspaceConfig(await workspace());
    expect(config.checks.eslint.enabled).toBe(true);
    expect(config.checks.typescript.enabled).toBe(false);
    expect(config.checks.build.enabled).toBe(false);
  });

  it("does not share mutable default check state between workspaces", async () => {
    const first = await loadWorkspaceConfig(await workspace());
    const second = await loadWorkspaceConfig(await workspace());
    first.checks.eslint.enabled = false;
    first.checks.eslint.languages.push("python");
    expect(second.checks.eslint.enabled).toBe(true);
    expect(second.checks.eslint.languages).toEqual(["javascript", "typescript"]);
  });

  it.each(["{", "{}", '{"version":1}', '{"unknown":true}', '{"debounceMs":-1}',
    '{"maxFindings":0}', '{"checks":{"build":{"adapter":"command","command":[]}}}',
    '{"checks":{"eslint":{"adapter":"eslint","unknown":true}}}',
    '{"checks":{"missing":{"adapter":"unknown"}}}'])
  ("rejects invalid configuration: %s", async (value) => {
    const root = await workspace();
    await writeFile(join(root, ".code-inspection.json"), value);
    await expect(loadWorkspaceConfig(root)).rejects.toBeInstanceOf(WorkspaceConfigError);
  });

  it("rejects check paths that escape the workspace", async () => {
    const root = await workspace();
    await writeFile(join(root, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
      build: { adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: "../outside", command: ["node", "-e", ""], parser: "build" }
    } }), "utf8");
    await expect(loadWorkspaceConfig(root)).rejects.toBeInstanceOf(WorkspaceConfigError);
  });

  it("rejects compiler database and report paths that escape the workspace", async () => {
    const root = await workspace();
    const values = [
      { adapter: "clang-tidy", languages: ["c"], options: { compileCommands: "../compile_commands.json" } },
      { adapter: "checkstyle", languages: ["java"], options: { reportFile: "../../checkstyle.xml" } }
    ];
    for (const value of values) {
      await writeFile(join(root, ".code-inspection.json"), JSON.stringify({ version: 2, checks: {
        check: { ...value, enabled: true, scope: "project", cwd: "." }
      } }), "utf8");
      await expect(loadWorkspaceConfig(root)).rejects.toBeInstanceOf(WorkspaceConfigError);
    }
  });

  it("resolves encoded file URIs and nonexistent descendants", async () => {
    const root = await workspace();
    const file = join(root, "space # percent %", "new.js");
    expect(resolveWorkspacePath(root, fileUriForPath(file))).toBe(file);
    expect(resolveWorkspacePath(root, ".")).toBe(root);
  });

  it.each(["../outside.js", "https://example.com/code.js", "file:///%ZZ"])
  ("rejects invalid or escaping paths: %s", async (path) => {
    const root = await workspace();
    expect(() => resolveWorkspacePath(root, path)).toThrow(WorkspaceConfigError);
  });

  it("rejects missing descendants through a symlink outside the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveWorkspacePath(root, "linked/missing/file.js")).toThrow(WorkspaceConfigError);
  });

  it("validates configuration before granting trust and invalidates it when removed", async () => {
    const root = await workspace();
    const store = new TrustStore(await workspace());
    await store.grant(root);
    expect(await store.isTrusted(root)).toBe(true);
    await writeFile(join(root, ".code-inspection.json"), "{}", "utf8");
    await expect(store.requireTrusted(root)).rejects.toBeInstanceOf(WorkspaceTrustError);
    await expect(store.grant(root)).rejects.toBeInstanceOf(WorkspaceConfigError);
    await writeFile(join(root, ".code-inspection.json"), JSON.stringify({ version: 2 }), "utf8");
    await store.grant(root);
    expect(await store.isTrusted(root)).toBe(true);
    await rm(join(root, ".code-inspection.json"));
    expect(await store.isTrusted(root)).toBe(false);
    await store.revoke(root);
    await store.revoke(root);
  });
});

describe("build execution boundaries", () => {
  async function build(script: string, signal?: AbortSignal) {
    const root = await workspace();
    const config = WorkspaceConfigSchema.parse({ version: 2, checks: { build: {
      adapter: "command", enabled: true, languages: [], scope: "workspace", cwd: ".",
      command: [process.execPath, "-e", script], parser: "build", timeoutMs: 1000
    } } });
    return new InspectionEngine({ root, config }).run({
      runId: "edge-build", checkId: "build", scope: {}, trigger: "cli", generation: 1
    }, signal);
  }

  it("uses exit status even when a successful build writes stderr", async () => {
    const output = await build('process.stderr.write("warning")');
    expect(output.findings).toEqual([]);
    expect(output.summary).toMatchObject({ exitCode: 0, errorCount: 0, stderr: "warning" });
  });

  it("reports silent failures", async () => {
    const output = await build("process.exit(7)");
    expect(output.findings[0]).toMatchObject({ code: "exit-7", severity: "error" });
    expect(output.findings[0]?.message).toContain("status 7");
  });

  it("bounds both output streams", async () => {
    const output = await build('process.stdout.write("x".repeat(250000)); process.stderr.write("y".repeat(250000));');
    expect(output.summary.stdout).toHaveLength(200000);
    expect(output.summary.stderr).toHaveLength(200000);
  });

  it("cancels an active build", async () => {
    const controller = new AbortController();
    const pending = build("setInterval(() => {}, 1000)", controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      clearTimeout(timer);
    }
  });

  it("turns a tool deadline into a distinct timeout error", async () => {
    await expect(build("setTimeout(() => {}, 5000)")).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps the first terminal reason when cancellation races a timeout", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 150);
    try {
      const result = await runTool(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        cwd: root,
        timeoutMs: 100,
        signal: controller.signal
      });
      expect(result.timedOut).toBe(true);
      expect(result.cancelled).toBe(false);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("reports timeout before parsing a partial structured report", async () => {
    const root = await workspace();
    const config = WorkspaceConfigSchema.parse({ version: 2, checks: {
      ruff: {
        adapter: "ruff", enabled: true, languages: ["python"], scope: "workspace", cwd: ".",
        command: [process.execPath, "-e", "process.stdout.write('['); setTimeout(() => {}, 5000)"],
        parser: "ruff-json", timeoutMs: 1000
      }
    } });
    await expect(new InspectionEngine({ root, config }).run({
      runId: "partial-report", checkId: "ruff", language: "python", projectRoot: root, scope: {}, trigger: "cli", generation: 0
    })).rejects.toMatchObject({ code: "timeout" });
  });

  it("caches a successful tool version probe", async () => {
    const root = await workspace();
    const first = await probeToolVersion(process.execPath, { cwd: root, timeoutMs: 1000 });
    const second = await probeToolVersion(process.execPath, { cwd: root, timeoutMs: 1000 });
    expect(first).toMatch(/^v\d/);
    expect(second).toBe(first);
  });

  it("caps findings and summarizes the retained diagnostics", async () => {
    const root = await canonicalizeWorkspaceRoot(resolve(import.meta.dirname, "../../../tests/fixtures/eslint-broken"));
    const config = await loadWorkspaceConfig(root);
    config.maxFindings = 1;
    const output = await new InspectionEngine({ root, config }).run({
      runId: "limited", checkId: "eslint", scope: {}, trigger: "cli", generation: 1
    });
    expect(output.findings).toHaveLength(1);
    expect(output.summary.errorCount).toBe(1);
  });

  it("applies exclude globs before file-scoped ESLint execution", async () => {
    const root = await canonicalizeWorkspaceRoot(resolve(import.meta.dirname, "../../../tests/fixtures/eslint-broken"));
    const config = await loadWorkspaceConfig(root);
    config.checks.eslint.exclude = ["**/broken.js"];
    const output = await new InspectionEngine({ root, config }).run({
      runId: "excluded", checkId: "eslint", scope: { files: ["broken.js"] }, trigger: "cli", generation: 1
    });
    expect(output.findings).toEqual([]);
  });
});
