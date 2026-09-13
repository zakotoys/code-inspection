import { extname } from "node:path";
import { LANGUAGE_IDS, type LanguageId } from "./types.js";

export interface LanguageDefinition {
  id: LanguageId;
  displayName: string;
  extensions: readonly string[];
  vscodeIds: readonly string[];
  zedIds: readonly string[];
  saveTrigger: boolean;
}

export const LANGUAGE_CATALOG: readonly LanguageDefinition[] = [
  {
    id: "javascript",
    displayName: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    vscodeIds: ["javascript", "javascriptreact"],
    zedIds: ["JavaScript", "JavaScript (Babel)"],
    saveTrigger: true
  },
  {
    id: "typescript",
    displayName: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    vscodeIds: ["typescript", "typescriptreact"],
    zedIds: ["TypeScript", "TSX"],
    saveTrigger: true
  },
  {
    id: "python",
    displayName: "Python",
    extensions: [".py", ".pyi"],
    vscodeIds: ["python"],
    zedIds: ["Python"],
    saveTrigger: true
  },
  {
    id: "java",
    displayName: "Java",
    extensions: [".java"],
    vscodeIds: ["java"],
    zedIds: ["Java"],
    saveTrigger: true
  },
  {
    id: "go",
    displayName: "Go",
    extensions: [".go"],
    vscodeIds: ["go"],
    zedIds: ["Go"],
    saveTrigger: true
  },
  {
    id: "rust",
    displayName: "Rust",
    extensions: [".rs"],
    vscodeIds: ["rust"],
    zedIds: ["Rust"],
    saveTrigger: true
  },
  {
    id: "c",
    displayName: "C",
    extensions: [".c", ".h"],
    vscodeIds: ["c"],
    zedIds: ["C"],
    saveTrigger: true
  },
  {
    id: "cpp",
    displayName: "C++",
    extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx", ".h"],
    vscodeIds: ["cpp"],
    zedIds: ["C++"],
    saveTrigger: true
  }
] as const;

const byId = new Map(LANGUAGE_CATALOG.map((definition) => [definition.id, definition]));
const byExtension = new Map<string, LanguageId[]>();
for (const definition of LANGUAGE_CATALOG) {
  for (const extension of definition.extensions) {
    const values = byExtension.get(extension) ?? [];
    values.push(definition.id);
    byExtension.set(extension, values);
  }
}

export function getLanguageDefinition(id: LanguageId): LanguageDefinition {
  const definition = byId.get(id);
  if (!definition) throw new Error(`Unknown language: ${id}`);
  return definition;
}

export function languageIds(): readonly LanguageId[] {
  return LANGUAGE_IDS;
}

export function languagesForFile(file: string): LanguageId[] {
  const extension = extname(file).toLowerCase();
  return [...(byExtension.get(extension) ?? [])];
}

export function languageForFile(file: string): LanguageId | undefined {
  const values = languagesForFile(file);
  return values.length === 1 ? values[0] : undefined;
}

export function isSupportedSourceFile(file: string): boolean {
  return languagesForFile(file).length > 0;
}

export function languageForEditorId(editorId: string): LanguageId | undefined {
  return LANGUAGE_CATALOG.find((definition) => definition.vscodeIds.includes(editorId) || definition.zedIds.includes(editorId))?.id;
}

export function vscodeLanguageIds(): string[] {
  return [...new Set(LANGUAGE_CATALOG.flatMap((definition) => definition.vscodeIds))];
}

export function zedLanguageIds(): string[] {
  return [...new Set(LANGUAGE_CATALOG.flatMap((definition) => definition.zedIds))];
}
