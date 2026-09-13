import { formatError } from "./config.js";
import { InspectionExecutionError } from "./errors.js";
import { createInspectorRegistry, type InspectorRegistry } from "./registry.js";
import type { Finding, InspectionOutput, InspectionRequest, InspectorContext, Logger } from "./types.js";
import { noopLogger } from "./types.js";

export { InspectionCancelledError, InspectionExecutionError } from "./errors.js";

export class InspectionEngine {
  private readonly context: InspectorContext;
  private readonly logger: Logger;
  private readonly registry: InspectorRegistry;

  constructor(context: InspectorContext, logger: Logger = noopLogger, registry = createInspectorRegistry()) {
    this.context = { ...context, logger };
    this.logger = logger;
    this.registry = registry;
  }

  async run(request: InspectionRequest, signal?: AbortSignal): Promise<InspectionOutput> {
    const startedAt = Date.now();
    const resolved = this.registry.resolve(this.context.config, request.checkId);
    if (!resolved.config.enabled) {
      throw new InspectionExecutionError("inspector-disabled", "The " + request.checkId + " check is disabled in .code-inspection.json.");
    }
    const executionContext = {
      ...this.context,
      checkId: resolved.id,
      ...(request.projectRoot ? { projectRoot: request.projectRoot } : {})
    };
    const output = await resolved.definition.execute(executionContext, request, resolved.config, signal);
    let findings: Finding[] = output.findings;
    if (findings.length > this.context.config.maxFindings) {
      this.logger.warn("Inspection findings exceeded the configured limit; keeping the first " + this.context.config.maxFindings + ".", { checkId: request.checkId, total: findings.length });
      findings = findings.slice(0, this.context.config.maxFindings);
    }
    const durationMs = Date.now() - startedAt;
    const summary = summarize(findings, durationMs, output.summary);
    this.logger.info("Inspection " + request.checkId + " completed", { durationMs, findings: findings.length });
    return { findings, summary };
  }
}

function summarize(findings: Finding[], durationMs: number, extra: Partial<InspectionOutput["summary"]>): InspectionOutput["summary"] {
  return {
    ...extra,
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
    infoCount: findings.filter((finding) => finding.severity === "info").length,
    hintCount: findings.filter((finding) => finding.severity === "hint").length,
    durationMs
  };
}

export function errorInfo(error: unknown): { code: string; message: string; details?: string } {
  if (error instanceof InspectionExecutionError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    };
  }
  return { code: "inspector-failed", message: formatError(error) };
}
