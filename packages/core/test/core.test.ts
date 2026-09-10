import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InspectionEngine,
  InspectionExecutionError,
  TrustStore,
  WorkspaceConfigError,
  canonicalizeWorkspaceRoot,
  loadWorkspaceConfig,
  resolveWorkspacePath,
  type InspectionRequest
} from "../src/index.js";

const repoRoot = resolve(import.meta.dirname, "../../../");

function request(inspector: InspectionRequest["inspector"]): InspectionRequest {
  return { runId: `test-${inspector}`, inspector, scope: {}, trigger: "cli", generation: 1 };
}

describe("inspection engine", () => {
  it("normalizes structured ESLint diagnostics into zero-based UTF-16 ranges", async () => {
    const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures/eslint-broken"));
    const config = await loadWorkspaceConfig(root);
    const output = await new InspectionEngine({ root, config }).run(request("eslint"));

    expect(output.findings.length).toBe(3);
    expect(output.findings[0]?.file).toContain("broken.js");
    expect(output.findings[0]?.range?.start).toEqual({ line: 0, character: 6 });
    expect(output.summary.errorCount).toBe(3);
  });

  it("maps TypeScript compiler diagnostics without parsing console output", async () => {
    const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures/typescript-broken"));
    const config = await loadWorkspaceConfig(root);
    const output = await new InspectionEngine({ root, config }).run(request("typescript"));

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]?.source).toBe("typescript");
    expect(output.findings[0]?.code).toBe("2322");
    expect(output.findings[0]?.range?.start.line).toBe(0);
  });

  it("returns build status and bounded process output as a normalized failure", async () => {
    const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures/build-failing"));
    const config = await loadWorkspaceConfig(root);
    const output = await new InspectionEngine({ root, config }).run(request("build"));

    expect(output.findings[0]?.code).toBe("exit-4");
    expect(output.summary.exitCode).toBe(4);
    expect(output.summary.stderr).toContain("fixture build failed");
  });

  it("reports a missing project tool as an execution error", async () => {
    const root = await canonicalizeWorkspaceRoot(await mkdtemp(join(tmpdir(), "code-inspection-no-tool-")));
    const config = await loadWorkspaceConfig(root);

    await expect(new InspectionEngine({ root, config }).run(request("eslint"))).rejects.toMatchObject<Partial<InspectionExecutionError>>({ code: "missing-tool" });
  });
});

describe("workspace paths and trust", () => {
  it("rejects paths outside the canonical workspace", async () => {
    const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures/eslint-clean"));
    expect(() => resolveWorkspacePath(root, "../eslint-broken/broken.js")).toThrow(WorkspaceConfigError);
  });

  it("stores explicit trust outside the workspace and invalidates it after config changes", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "code-inspection-trust-"));
    const workspace = await mkdtemp(join(tmpdir(), "code-inspection-trusted-workspace-"));
    await writeFile(join(workspace, ".code-inspection.json"), '{"version":1}\n', "utf8");
    const root = await canonicalizeWorkspaceRoot(workspace);
    const store = new TrustStore(dataDirectory);

    try {
      expect(await store.isTrusted(root)).toBe(false);
      await store.grant(root);
      expect(await store.isTrusted(root)).toBe(true);
      await writeFile(join(workspace, ".code-inspection.json"), '{"version":1,"debounceMs":500}\n', "utf8");
      expect(await store.isTrusted(root)).toBe(false);
      await store.revoke(root);
      expect(await store.isTrusted(root)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
