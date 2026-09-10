import { type DiagnosticEntry, type DiagnosticInput, normalizeDiagnostics } from "./diagnostics";

export interface DiagnosticSnapshot {
  revision: number;
  observedAt: string;
  coverage: "published-workspace-diagnostics";
  errors: number;
  warnings: number;
  diagnostics: DiagnosticEntry[];
}

export class DiagnosticStore {
  private readonly files = new Map<string, DiagnosticEntry[]>();
  private revision = 0;
  private observedAt = new Date().toISOString();

  replace(uri: string, inputs: readonly DiagnosticInput[]): void {
    const entries = normalizeDiagnostics(uri, inputs);
    this.observedAt = new Date().toISOString();
    if (JSON.stringify(this.files.get(uri) ?? []) === JSON.stringify(entries)) return;
    if (entries.length) this.files.set(uri, entries);
    else this.files.delete(uri);
    this.revision++;
  }

  retain(allowed: (uri: string) => boolean): void {
    for (const uri of this.files.keys()) {
      if (!allowed(uri)) this.replace(uri, []);
    }
  }

  snapshot(): DiagnosticSnapshot {
    const diagnostics = structuredClone(
      [...this.files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([, entries]) => entries),
    );
    return {
      revision: this.revision,
      observedAt: this.observedAt,
      coverage: "published-workspace-diagnostics",
      errors: diagnostics.filter((d) => d.severity === "error").length,
      warnings: diagnostics.filter((d) => d.severity === "warning").length,
      diagnostics,
    };
  }
}
