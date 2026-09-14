import { describe, expect, it } from "vitest";
import { createFinding, type Finding } from "@zakotoys/code-inspection-core";
import { FindingBaselines } from "../src/finding-baselines.js";

const firstFile = "file:///workspace/a.js";
const secondFile = "file:///workspace/b.js";

function finding(file = firstFile, message = "Unused variable"): Finding {
  return createFinding({ checkId: "eslint", source: "eslint", severity: "error", message, file, runId: "run", generation: 0 });
}

describe("finding baselines", () => {
  it("initializes the first result, ignores repeats and records additions and removals", () => {
    const baselines = new FindingBaselines();
    const original = finding();
    expect(baselines.observe("eslint", "config", [firstFile], [original]))
      .toEqual({ baseline: true, initializedFiles: [firstFile], added: [], resolved: [] });
    const repeated = { ...original, runId: "next", generation: 5 };
    expect(baselines.observe("eslint", "config", [firstFile], [repeated]).added).toEqual([]);
    const added = finding(firstFile, "New problem");
    expect(baselines.observe("eslint", "config", [firstFile], [repeated, added]).added).toEqual([added]);
    expect(baselines.observe("eslint", "config", [firstFile], [added]).resolved).toEqual([repeated]);
  });

  it("keeps independent file coverage, including files with no diagnostics", () => {
    const baselines = new FindingBaselines();
    const first = finding();
    const second = finding(secondFile);
    baselines.observe("eslint", "config", [firstFile], [first]);
    expect(baselines.observe("eslint", "config", [secondFile], [second]))
      .toMatchObject({ baseline: true, added: [], resolved: [] });
    expect(baselines.observe("eslint", "config", [firstFile], []).resolved).toEqual([first]);
    expect(baselines.observe("eslint", "config", [secondFile], [second]).resolved).toEqual([]);
    expect(baselines.observe("eslint", "config", [firstFile], [first]).added).toEqual([first]);
  });

  it("compares known files while initializing newly covered files", () => {
    const baselines = new FindingBaselines();
    const first = finding();
    const second = finding(secondFile);
    baselines.observe("eslint", "config", [firstFile], [first]);
    expect(baselines.observe("eslint", "config", [firstFile, secondFile], [second]))
      .toEqual({ baseline: false, initializedFiles: [secondFile], added: [], resolved: [first] });
  });

  it("expands partial coverage without treating unobserved files as additions", () => {
    const baselines = new FindingBaselines();
    const first = finding();
    const second = finding(secondFile);
    baselines.observe("eslint", "config", [firstFile], [first]);
    expect(baselines.observe("eslint", "config", undefined, [first, second]))
      .toMatchObject({ baseline: false, initializedFiles: [secondFile], added: [], resolved: [] });
    const third = finding("file:///workspace/c.js");
    expect(baselines.observe("eslint", "config", undefined, [first, second, third]).added).toEqual([third]);
    expect(baselines.observe("eslint", "config", [firstFile], []).resolved).toEqual([first]);
    expect(baselines.observe("eslint", "config", undefined, [second, third]).resolved).toEqual([]);
  });

  it("resets for configuration changes and does not equate deletion with repair", () => {
    const baselines = new FindingBaselines();
    const original = finding();
    baselines.observe("eslint", "config", undefined, [original]);
    baselines.forgetFile(firstFile);
    expect(baselines.observe("eslint", "config", undefined, []).resolved).toEqual([]);
    expect(baselines.observe("eslint", "new-config", undefined, [original]))
      .toMatchObject({ baseline: true, added: [], resolved: [] });
    expect(baselines.observe("typescript", "new-config", undefined, [original]).baseline).toBe(true);
    baselines.clear();
    expect(baselines.observe("eslint", "new-config", undefined, [original]).baseline).toBe(true);
  });

  it("keeps baseline data separate from returned changes and caller-owned results", () => {
    const baselines = new FindingBaselines();
    const original = finding();
    baselines.observe("eslint", "config", [firstFile], [original]);
    original.message = "mutated";
    const changes = baselines.observe("eslint", "config", [firstFile], []);
    expect(changes.resolved[0]?.message).toBe("Unused variable");
    baselines.observe("eslint", "config", [firstFile], [finding()]);
    expect(changes.resolved[0]?.message).toBe("Unused variable");
  });
});
