import { findingKey, type Finding, type FindingChanges } from "@zakotoys/code-inspection-core";

interface Baseline {
  configuration: string;
  complete: boolean;
  files: Map<string, Finding[]>;
}

export class FindingBaselines {
  private readonly baselines = new Map<string, Baseline>();

  observe(executionKey: string, configuration: string, files: string[] | undefined, findings: Finding[]): FindingChanges {
    let previous = this.baselines.get(executionKey);
    if (!previous || previous.configuration !== configuration) {
      previous = { configuration, complete: false, files: new Map() };
      this.baselines.set(executionKey, previous);
    }
    const incoming = new Map<string, Finding[]>();
    for (const finding of findings) {
      const file = finding.file ?? "";
      const entries = incoming.get(file) ?? [];
      entries.push(finding);
      incoming.set(file, entries);
    }
    const coveredFiles = files === undefined
      ? new Set(["", ...previous.files.keys(), ...incoming.keys()])
      : new Set(files);
    const changes: FindingChanges = { baseline: true, initializedFiles: [], added: [], resolved: [] };
    for (const file of [...coveredFiles].sort()) {
      const before = previous.files.get(file) ?? [];
      const after = incoming.get(file) ?? [];
      if (previous.complete || previous.files.has(file)) {
        changes.baseline = false;
        const beforeKeys = new Set(before.map(findingKey));
        const afterKeys = new Set(after.map(findingKey));
        changes.added.push(...after.filter((finding) => !beforeKeys.has(findingKey(finding))));
        changes.resolved.push(...before.filter((finding) => !afterKeys.has(findingKey(finding))));
      } else if (file) {
        changes.initializedFiles.push(file);
      }
      previous.files.set(file, structuredClone(after));
    }
    if (files === undefined) previous.complete = true;
    return structuredClone(changes);
  }

  forgetFile(file: string): void {
    for (const baseline of this.baselines.values()) baseline.files.delete(file);
  }

  clear(): void {
    this.baselines.clear();
  }
}
