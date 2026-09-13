import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeWorkspaceRoot,
  fileUriForPath,
  InspectionEngine,
  noopLogger,
  TrustStore
} from "@zakotoys/code-inspection-core";
import { WorkspaceService } from "../src/service.js";

afterEach(() => vi.restoreAllMocks());

describe("workspace watcher", () => {
  it.each(["preserved timestamp", "workspace basename"])(
    "invalidates findings and queued runs after a change with %s",
    async (scenario) => {
      const parent = await mkdtemp(join(tmpdir(), "inspection-watcher-"));
      let service: WorkspaceService | undefined;
      try {
        const root = await canonicalizeWorkspaceRoot(await mkdtemp(join(parent, "workspace-")));
        const file = join(root, scenario === "workspace basename" ? basename(root) : "source.js");
        const incoming = join(parent, "incoming.js");
        const oldTime = new Date(Date.now() - 60_000);
        await writeFile(file, "old content");
        await writeFile(incoming, "new content");
        await utimes(file, oldTime, oldTime);
        await utimes(incoming, oldTime, oldTime);
        await utimes(root, oldTime, oldTime);
        const trustStore = new TrustStore(join(parent, "trust"));
        await trustStore.grant(root);
        await delay(20);
        vi.spyOn(InspectionEngine.prototype, "run").mockImplementation(async (request) => ({
          findings: [{
            id: "finding", checkId: "eslint", source: "eslint", severity: "error",
            message: "old finding", file: fileUriForPath(file),
            runId: request.runId, generation: request.generation
          }],
          summary: { errorCount: 1, warningCount: 0, infoCount: 0, hintCount: 0, durationMs: 0 }
        }));
        service = await WorkspaceService.create(root, { logger: noopLogger, trustStore });
        const current = service;
        const initial = await current.runInspection({ checkId: "eslint", trigger: "manual" });
        await expect.poll(async () => (await current.getRun({ runId: initial.run.runId })).snapshot.run.outcome)
          .toBe("completed");
        const queued = await current.runInspection({ checkId: "eslint", trigger: "save" });
        if (scenario === "preserved timestamp") await rename(incoming, file);
        else await writeFile(file, "new content");
        await expect.poll(async () => (await current.getFindings({ offset: 0, limit: 10, includeStale: true })).page.findings[0]?.stale)
          .toBe(true);
        await expect.poll(async () => (await current.getRun({ runId: queued.run.runId })).snapshot.run.outcome)
          .toBe("superseded");
      } finally {
        await service?.dispose();
        await rm(parent, { recursive: true, force: true });
      }
    }
  );

  it("clears findings when a source file is deleted", async () => {
    const parent = await mkdtemp(join(tmpdir(), "inspection-watcher-delete-"));
    let service: WorkspaceService | undefined;
    try {
      const root = await canonicalizeWorkspaceRoot(await mkdtemp(join(parent, "workspace-")));
      const file = join(root, "source.js");
      await writeFile(file, "old content");
      const trustStore = new TrustStore(join(parent, "trust"));
      await trustStore.grant(root);
      vi.spyOn(InspectionEngine.prototype, "run").mockImplementation(async (request) => ({
        findings: [{ id: "finding", checkId: "eslint", source: "eslint", severity: "error", message: "old finding", file: fileUriForPath(file), runId: request.runId, generation: request.generation }],
        summary: { errorCount: 1, warningCount: 0, infoCount: 0, hintCount: 0, durationMs: 0 }
      }));
      service = await WorkspaceService.create(root, { logger: noopLogger, trustStore });
      const started = await service.runInspection({ checkId: "eslint", trigger: "manual" });
      await expect.poll(async () => (await service!.getRun({ runId: started.run.runId })).snapshot.run.outcome).toBe("completed");
      expect((await service.getFindings({ offset: 0, limit: 10, includeStale: true })).page.total).toBe(1);
      await rm(file);
      await expect.poll(async () => (await service!.getFindings({ offset: 0, limit: 10, includeStale: true })).page.total).toBe(0);
    } finally {
      await service?.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
