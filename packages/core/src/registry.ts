import { WorkspaceConfigError, type CheckConfig, type WorkspaceConfig } from "./config.js";
import { DIAGNOSTIC_PARSER_IDS } from "./parsers.js";
import { validatePatterns } from "./matching.js";
import type { CheckScope, InspectionOutput, InspectionRequest, InspectorContext, LanguageId, Logger } from "./types.js";
import {
  runCheckstyle,
  runClangBuild,
  runClangTidy,
  runCommandBuild,
  runCargoCheck,
  runCargoClippy,
  runEslint,
  runGoVet,
  runGolangciLint,
  runJavaBuild,
  runPmd,
  runPyright,
  runRuff,
  runTypeScript
} from "./inspectors.js";

export interface InspectorExecutionContext extends InspectorContext {
  checkId: string;
  projectRoot?: string | undefined;
}

export interface InspectorDefinition {
  adapter: string;
  displayName: string;
  languages: readonly LanguageId[];
  defaultScope: CheckScope;
  supportsFileScope: boolean;
  /** Runs in a shared resource group (for example, build tools are serialized). */
  resourceGroup?: string;
  resourceLimit?: number;
  supportsCancellation?: boolean;
  supportsTimeout?: boolean;
  execute: (context: InspectorExecutionContext, request: InspectionRequest, config: CheckConfig, signal?: AbortSignal) => Promise<InspectionOutput>;
}

export interface ResolvedInspector {
  id: string;
  config: CheckConfig & { scope: CheckScope };
  definition: InspectorDefinition;
  languages: readonly LanguageId[];
}

const DEFINITIONS: readonly InspectorDefinition[] = [
  { adapter: "eslint", displayName: "ESLint", languages: ["javascript", "typescript"], defaultScope: "file", supportsFileScope: true, execute: runEslint },
  { adapter: "typescript", displayName: "TypeScript", languages: ["javascript", "typescript"], defaultScope: "project", supportsFileScope: false, execute: runTypeScript },
  { adapter: "command", displayName: "Configured build", languages: [], defaultScope: "workspace", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runCommandBuild },
  { adapter: "ruff", displayName: "Ruff", languages: ["python"], defaultScope: "file", supportsFileScope: true, execute: runRuff },
  { adapter: "pyright", displayName: "Pyright", languages: ["python"], defaultScope: "project", supportsFileScope: false, execute: runPyright },
  { adapter: "go-vet", displayName: "go vet", languages: ["go"], defaultScope: "project", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runGoVet },
  { adapter: "golangci-lint", displayName: "golangci-lint", languages: ["go"], defaultScope: "project", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runGolangciLint },
  { adapter: "cargo-check", displayName: "Cargo check", languages: ["rust"], defaultScope: "project", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runCargoCheck },
  { adapter: "cargo-clippy", displayName: "Cargo clippy", languages: ["rust"], defaultScope: "project", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runCargoClippy },
  { adapter: "checkstyle", displayName: "Checkstyle", languages: ["java"], defaultScope: "project", supportsFileScope: false, resourceGroup: "java", resourceLimit: 1, execute: runCheckstyle },
  { adapter: "pmd", displayName: "PMD", languages: ["java"], defaultScope: "project", supportsFileScope: false, resourceGroup: "java", resourceLimit: 1, execute: runPmd },
  { adapter: "java-build", displayName: "Java build", languages: ["java"], defaultScope: "project", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runJavaBuild },
  { adapter: "clang-tidy", displayName: "clang-tidy", languages: ["c", "cpp"], defaultScope: "file", supportsFileScope: true, resourceGroup: "build", resourceLimit: 1, execute: runClangTidy },
  { adapter: "clang-build", displayName: "Clang build", languages: ["c", "cpp"], defaultScope: "project", supportsFileScope: false, resourceGroup: "build", resourceLimit: 1, execute: runClangBuild }
];

export class InspectorRegistry {
  private readonly definitions: ReadonlyMap<string, InspectorDefinition>;

  constructor(definitions: readonly InspectorDefinition[] = DEFINITIONS) {
    this.definitions = new Map(definitions.map((definition) => [definition.adapter, definition]));
  }

  getAdapter(adapter: string): InspectorDefinition | undefined {
    return this.definitions.get(adapter);
  }

  listAdapters(): InspectorDefinition[] {
    return [...this.definitions.values()];
  }

  resolve(config: WorkspaceConfig, id: string): ResolvedInspector {
    const check = config.checks[id];
    if (!check) throw new WorkspaceConfigError("Unknown configured check: " + id);
    const definition = this.definitions.get(check.adapter);
    if (!definition) throw new WorkspaceConfigError("Unknown inspector adapter for " + id + ": " + check.adapter);
    const languages = check.languages.length > 0 ? check.languages : definition.languages;
    for (const language of languages) {
      if (!definition.languages.includes(language)) {
        throw new WorkspaceConfigError("Inspector " + id + " does not support language " + language);
      }
    }
    const scope = check.scope ?? definition.defaultScope;
    if (scope === "file" && !definition.supportsFileScope) {
      throw new WorkspaceConfigError("Inspector " + id + " does not support file scope.");
    }
    if (check.parser && !DIAGNOSTIC_PARSER_IDS.includes(check.parser as (typeof DIAGNOSTIC_PARSER_IDS)[number])) {
      throw new WorkspaceConfigError("Unknown diagnostic parser for " + id + ": " + check.parser);
    }
    if (check.adapter === "command" && (!check.command || check.command.length === 0)) {
      throw new WorkspaceConfigError("Configured command check " + id + " requires a command.");
    }
    try {
      validatePatterns(check.exclude);
      if (check.patterns) validatePatterns(check.patterns);
    } catch (error) {
      throw new WorkspaceConfigError("Invalid glob pattern for " + id + ": " + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    return { id, config: { ...check, scope }, definition, languages };
  }

  validate(config: WorkspaceConfig): void {
    for (const id of Object.keys(config.checks)) {
      if (id !== id.trim() || id.length > 128 || id.length === 0) {
        throw new WorkspaceConfigError("Invalid check ID: " + JSON.stringify(id));
      }
      this.resolve(config, id);
    }
  }

  enabled(config: WorkspaceConfig): ResolvedInspector[] {
    this.validate(config);
    return Object.entries(config.checks)
      .filter(([, check]) => check.enabled)
      .map(([id]) => this.resolve(config, id));
  }
}

export function createInspectorRegistry(): InspectorRegistry {
  return new InspectorRegistry();
}
