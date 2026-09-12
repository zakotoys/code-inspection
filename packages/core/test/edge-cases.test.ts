import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeWorkspaceRoot, fileUriForPath, InspectionEngine,
  loadWorkspaceConfig, resolveWorkspacePath, TrustStore, WorkspaceConfigError,
  WorkspaceConfigSchema, WorkspaceTrustError
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
    expect(config.inspectors.eslint.enabled).toBe(true);
    expect(config.inspectors.typescript.enabled).toBe(false);
    expect(config.inspectors.build.enabled).toBe(false);
  });

  it.each(["{", '{"version":2}', '{"unknown":true}', '{"debounceMs":-1}',
    '{"maxFindings":0}', '{"inspectors":{"build":{"command":[]}}}',
    '{"inspectors":{"eslint":{"unknown":true}}}'])
  ("rejects invalid configuration: %s", async (value) => {
    const root = await workspace();
    await writeFile(join(root, ".code-inspection.json"), value);
    await expect(loadWorkspaceConfig(root)).rejects.toBeInstanceOf(WorkspaceConfigError);
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

  it("invalidates trust when configuration is created or removed", async () => {
    const root = await workspace();
    const store = new TrustStore(await workspace());
    await store.grant(root);
    expect(await store.isTrusted(root)).toBe(true);
    await writeFile(join(root, ".code-inspection.json"), "{}");
    await expect(store.requireTrusted(root)).rejects.toBeInstanceOf(WorkspaceTrustError);
    await store.grant(root);
    await rm(join(root, ".code-inspection.json"));
    expect(await store.isTrusted(root)).toBe(false);
    await store.revoke(root);
    await store.revoke(root);
  });
});

describe("build execution boundaries", () => {
  async function build(script: string, signal?: AbortSignal) {
    const root = await workspace();
    const config = WorkspaceConfigSchema.parse({ inspectors: { build: {
      command: [process.execPath, "-e", script], timeoutMs: 1000
    } } });
    return new InspectionEngine({ root, config }).run({
      runId: "edge-build", inspector: "build", scope: {}, trigger: "cli", generation: 1
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

  it("caps findings and summarizes the retained diagnostics", async () => {
    const root = await canonicalizeWorkspaceRoot(resolve(import.meta.dirname, "../../../tests/fixtures/eslint-broken"));
    const config = await loadWorkspaceConfig(root);
    config.maxFindings = 1;
    const output = await new InspectionEngine({ root, config }).run({
      runId: "limited", inspector: "eslint", scope: {}, trigger: "cli", generation: 1
    });
    expect(output.findings).toHaveLength(1);
    expect(output.summary.errorCount).toBe(1);
  });
});
