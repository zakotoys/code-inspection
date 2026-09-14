import { createHash } from "node:crypto";
import type { Finding, Range, RawDiagnostic } from "./types.js";

function rangeKey(range: Range | undefined): number[] | null {
  return range ? [range.start.line, range.start.character, range.end.line, range.end.character] : null;
}

export function diagnosticKey(diagnostic: RawDiagnostic): string {
  const related = (diagnostic.relatedInformation ?? []).map((item) => JSON.stringify([
    item.file ?? null, rangeKey(item.range), item.message
  ])).sort();
  return JSON.stringify([
    diagnostic.file ?? null,
    rangeKey(diagnostic.range),
    diagnostic.severity ?? "error",
    diagnostic.code ?? null,
    diagnostic.message,
    [...new Set(related)]
  ]);
}

export function findingKey(finding: Omit<Finding, "id">): string {
  return JSON.stringify([
    finding.checkId, finding.source, finding.language ?? null,
    finding.projectRoot ?? null, diagnosticKey(finding)
  ]);
}

export function createFinding(finding: Omit<Finding, "id">): Finding {
  return { ...finding, id: createHash("sha256").update(findingKey(finding)).digest("hex") };
}

export function normalizeFindings(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const normalized = createFinding(finding);
    unique.set(normalized.id, normalized);
  }
  return [...unique.values()].sort((left, right) =>
    (left.file ?? "").localeCompare(right.file ?? "")
    || (left.range?.start.line ?? -1) - (right.range?.start.line ?? -1)
    || (left.range?.start.character ?? -1) - (right.range?.start.character ?? -1)
    || left.id.localeCompare(right.id));
}
