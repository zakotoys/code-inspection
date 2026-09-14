import { describe, expect, it } from "vitest";
import {
  createFinding, createInspectorRegistry, defaultWorkspaceConfig, diagnosticKey,
  InspectionEngine, normalizeFindings, noopLogger, type Finding
} from "../src/index.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return createFinding({
    checkId: "eslint", source: "eslint", severity: "error", message: "Unused variable",
    file: "file:///workspace/main.js", code: "no-unused-vars",
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
    runId: "first", generation: 0, ...overrides
  });
}

describe("finding identity", () => {
  it("deduplicates and sorts results independently of run, generation and input order", () => {
    const first = finding();
    const repeated = finding({ runId: "second", generation: 12, stale: true });
    const other = finding({ file: "file:///workspace/other.js" });
    expect(repeated.id).toBe(first.id);
    expect(normalizeFindings([other, first, repeated]).map((entry) => entry.id))
      .toEqual(normalizeFindings([repeated, other]).map((entry) => entry.id));
    expect(normalizeFindings([first, repeated])).toHaveLength(1);
  });

  it("distinguishes severity, complete ranges, check, source and project", () => {
    const first = finding();
    for (const override of [
      { severity: "warning" as const },
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } },
      { checkId: "other" }, { source: "other" }, { projectRoot: "/another-project" }
    ]) {
      const other = finding(override);
      expect(other.id).not.toBe(first.id);
      expect(normalizeFindings([first, other])).toHaveLength(2);
    }
    expect(diagnosticKey(finding({ severity: "warning" }))).not.toBe(diagnosticKey(first));
  });

  it("ignores related-information ordering but retains its content", () => {
    const related = [{ message: "first", file: "file:///workspace/a.js" }, { message: "second" }];
    expect(finding({ relatedInformation: related }).id)
      .toBe(finding({ relatedInformation: [...related].reverse() }).id);
    expect(finding({ relatedInformation: related }).id)
      .not.toBe(finding({ relatedInformation: related.slice(0, 1) }).id);
  });

  it("normalizes before limiting results and exposes incomplete output", async () => {
    const config = defaultWorkspaceConfig();
    config.maxFindings = 1;
    const registry = createInspectorRegistry();
    const resolved = registry.resolve(config, "eslint");
    let values = [finding(), finding({ runId: "duplicate" })];
    registry.resolve = () => ({
      ...resolved,
      definition: {
        ...resolved.definition,
        execute: async () => ({ findings: values, summary: { errorCount: 0, warningCount: 0, infoCount: 0, hintCount: 0, durationMs: 0 } })
      }
    });
    const engine = new InspectionEngine({ root: process.cwd(), config, logger: noopLogger }, noopLogger, registry);
    const request = { runId: "run", checkId: "eslint", scope: {}, trigger: "manual" as const, generation: 0 };
    expect((await engine.run(request)).summary).toMatchObject({ errorCount: 1 });
    expect((await engine.run(request)).summary.truncated).toBeUndefined();
    values = [finding(), finding({ message: "Another problem" })];
    const output = await engine.run(request);
    expect(output.findings).toHaveLength(1);
    expect(output.summary.truncated).toBe(true);
  });
});
