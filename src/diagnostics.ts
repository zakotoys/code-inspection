export interface DiagnosticInput {
  severity: number;
  message: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  source?: string;
  code?: string | number | { value: string | number };
}

export interface DiagnosticEntry {
  uri: string;
  severity: "error" | "warning";
  message: string;
  range: DiagnosticInput["range"];
  source?: string;
  code?: string | number;
}

export function normalizeDiagnostics(
  uri: string,
  inputs: readonly DiagnosticInput[],
): DiagnosticEntry[] {
  const unique = new Map<string, DiagnosticEntry>();
  for (const input of inputs) {
    if (input.severity !== 0 && input.severity !== 1) continue;
    const entry: DiagnosticEntry = {
      uri,
      severity: input.severity === 0 ? "error" : "warning",
      message: input.message,
      range: { start: { ...input.range.start }, end: { ...input.range.end } },
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.code !== undefined
        ? { code: typeof input.code === "object" ? input.code.value : input.code }
        : {}),
    };
    unique.set(JSON.stringify(entry), entry);
  }
  return [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry);
}
