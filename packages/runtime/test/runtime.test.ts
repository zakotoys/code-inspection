import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TrustStore,
  WorkspaceTrustError,
  canonicalizeWorkspaceRoot,
  noopLogger,
  type InspectionRun
} from "@zakotoys/code-inspection-core";
import { WorkspaceService } from "../src/service.js";

const repoRoot = resolve(import.meta.dirname, "../../../");

async function serviceFor(fixture: string, trusted = true): Promise<WorkspaceService> {
  const root = await canonicalizeWorkspaceRoot(join(repoRoot, "tests/fixtures", fixture));
  const trustStore = new TrustStore(await mkdtemp(join(tmpdir(), "code-inspection-runtime-")));
  if (trusted) await trustStore.grant(root);
  return WorkspaceService.create(root, { logger: noopLogger, trustStore });
}

async function waitForRun(service: WorkspaceService, runId: string): Promise<InspectionRun> {
  for (;;) {
    const result = await service.getRun({ runId });
    if (["completed", "failed", "cancelled", "superseded"].includes(result.snapshot.run.outcome)) return result.snapshot.run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

describe("workspace service", () => {
  it("requires explicit trust before execution", async () => {
    const service = await serviceFor("eslint-clean", false);
    await expect(service.runInspection({ inspector: "eslint", trigger: "manual" })).rejects.toBeInstanceOf(WorkspaceTrustError);
    await service.dispose();
  });

  it("coalesces queued requests and exposes the shared result set", async () => {
    const service = await serviceFor("eslint-broken");
    const [first, second] = await Promise.all([
      service.runInspection({ inspector: "eslint", trigger: "manual" }),
      service.runInspection({ inspector: "eslint", scope: { files: ["broken.js"] }, trigger: "manual" })
    ]);
    expect(second.run.runId).toBe(first.run.runId);
    const run = await waitForRun(service, first.run.runId);
    expect(run.outcome).toBe("completed");
    const findings = await service.getFindings({ offset: 0, limit: 50, includeStale: false });
    expect(findings.page.total).toBe(3);
    await service.dispose();
  });

  it("marks saved findings stale while dirty and replaces them after a successful save", async () => {
    const service = await serviceFor("eslint-broken");
    const initial = await service.runInspection({ inspector: "eslint", trigger: "manual" });
    await waitForRun(service, initial.run.runId);
    await service.didChange({ file: "broken.js" });
    const stale = await service.getFindings({ offset: 0, limit: 50, includeStale: true });
    expect(stale.page.findings.every((finding) => finding.stale === true)).toBe(true);
    const saved = await service.didSave({ file: "broken.js" });
    expect(saved.runs).toHaveLength(1);
    const completed = await waitForRun(service, saved.runs[0]!.runId);
    expect(completed.outcome).toBe("completed");
    const current = await service.getFindings({ offset: 0, limit: 50, includeStale: false });
    expect(current.page.findings.every((finding) => finding.stale !== true)).toBe(true);
    await service.dispose();
  });

  it("clears a resolved finding after the saved file is fixed", async () => {
    const rootPath = await mkdtemp(join(repoRoot, "tests/fixtures/save-workflow-"));
    await writeFile(join(rootPath, "package.json"), '{"name":"save-workflow","private":true,"type":"module"}\n', "utf8");
    await writeFile(join(rootPath, "eslint.config.js"), 'export default [{ files: ["**/*.js"], rules: { "no-unused-vars": "error" } }];\n', "utf8");
    await writeFile(join(rootPath, "broken.js"), "const unused = 1;\n", "utf8");
    await writeFile(join(rootPath, ".code-inspection.json"), JSON.stringify({ version: 1, inspectors: { eslint: { enabled: true, cwd: ".", patterns: ["**/*.js"] } } }), "utf8");
    const root = await canonicalizeWorkspaceRoot(rootPath);
    const trustStore = new TrustStore(await mkdtemp(join(tmpdir(), "code-inspection-save-")));
    await trustStore.grant(root);
    const service = await WorkspaceService.create(root, { logger: noopLogger, trustStore });
    try {
      const first = await service.runInspection({ inspector: "eslint", trigger: "manual" });
      await waitForRun(service, first.run.runId);
      expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(1);
      await writeFile(join(rootPath, "broken.js"), "const used = 1;\nconsole.log(used);\n", "utf8");
      const saved = await service.didSave({ file: "broken.js" });
      await waitForRun(service, saved.runs[0]!.runId);
      expect((await service.getFindings({ offset: 0, limit: 50, includeStale: false })).page.total).toBe(0);
    } finally {
      await service.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("represents a failing build with an execution result and logs", async () => {
    const service = await serviceFor("build-failing");
    const started = await service.runInspection({ inspector: "build", trigger: "manual" });
    const run = await waitForRun(service, started.run.runId);
    expect(run.outcome).toBe("completed");
    expect(run.summary?.exitCode).toBe(4);
    expect(run.summary?.stderr).toContain("fixture build failed");
    await service.dispose();
  });
});
