import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InspectionCancelledError,
  InspectionExecutionError,
  type InspectionOutput,
  type InspectionRequest,
  type Logger,
  type WorkspaceConfig
} from "@zakotoys/code-inspection-core";

const WORKER_GRACE_MS = 1000;

export interface WorkerExecutionOptions {
  root: string;
  config: WorkspaceConfig;
  request: InspectionRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  logger: Logger;
}

interface WorkerResultMessage {
  type: "result";
  output: InspectionOutput;
}

interface WorkerErrorMessage {
  type: "error";
  error: { code: string; message: string; details?: string };
}

interface WorkerLogMessage {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details?: unknown;
}

/** Execute one inspection in an isolated worker and enforce a hard deadline. */
export function runInspectionWorker(options: WorkerExecutionOptions): Promise<InspectionOutput> {
  const workerPath = resolveWorkerPath();
  if (!workerPath) {
    return Promise.reject(new InspectionExecutionError("worker-unavailable", "The inspection worker bundle is missing. Rebuild the runtime package."));
  }
  return new Promise<InspectionOutput>((resolvePromise, rejectPromise) => {
    let worker: Worker | undefined;
    let settled = false;
    let cancelRequested = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (hardTimer) clearTimeout(hardTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const terminate = async (): Promise<void> => {
      if (!worker) return;
      try {
        await worker.terminate();
      } catch {
        // The worker may already have exited; termination is best effort.
      }
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Do not resolve the caller until the worker termination request has
      // completed. This prevents timed-out/cancelled tools from leaking a
      // live worker into the next inspection.
      void terminate().finally(action);
    };
    const onAbort = (): void => {
      if (settled) return;
      cancelRequested = true;
      try { worker?.postMessage({ type: "cancel" }); } catch { /* Worker may already be exiting. */ }
      terminationTimer = setTimeout(() => {
        settle(() => rejectPromise(new InspectionCancelledError()));
      }, WORKER_GRACE_MS);
      terminationTimer.unref?.();
    };

    try {
      worker = new Worker(workerPath, { argv: [], execArgv: [] });
    } catch (error) {
      settle(() => rejectPromise(new InspectionExecutionError("worker-unavailable", "Unable to start inspection worker: " + formatError(error), undefined, { cause: error })));
      return;
    }
    worker.on("message", (message: WorkerResultMessage | WorkerErrorMessage | WorkerLogMessage) => {
      if (message.type === "log") {
        options.logger[message.level](message.message, message.details);
      } else if (message.type === "result") {
        settle(() => cancelRequested ? rejectPromise(new InspectionCancelledError()) : resolvePromise(message.output));
      } else if (message.type === "error") {
        settle(() => {
          const error = message.error.code === "cancelled"
            ? new InspectionCancelledError(message.error.message)
            : new InspectionExecutionError(message.error.code, message.error.message, message.error.details);
          rejectPromise(error);
        });
      }
    });
    worker.once("error", (error) => settle(() => rejectPromise(new InspectionExecutionError("worker-failed", "Inspection worker failed: " + formatError(error), undefined, { cause: error }))));
    worker.once("exit", (code) => {
      if (settled) return;
      settle(() => rejectPromise(new InspectionExecutionError("worker-failed", `Inspection worker exited before returning a result (status ${code}).`)));
    });
    hardTimer = setTimeout(() => {
      settle(() => rejectPromise(new InspectionExecutionError("timeout", `Inspection worker exceeded the ${options.timeoutMs}ms deadline.`)));
    }, options.timeoutMs + WORKER_GRACE_MS);
    hardTimer.unref?.();
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    // A pre-aborted request must never start the inspection payload. The
    // cancellation timer still lets the worker terminate through the same
    // bounded grace path as an in-flight cancellation.
    if (settled || cancelRequested) return;
    try {
      worker.postMessage({ type: "run", root: options.root, config: options.config, request: options.request });
    } catch (error) {
      settle(() => rejectPromise(new InspectionExecutionError("worker-failed", "Unable to send inspection to worker: " + formatError(error), undefined, { cause: error })));
    }
  });
}

/** Source/test runners do not ship a sibling bundle; packaged runtimes must. */
export function canFallbackToInProcessWorker(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  try { return /[\\/]src[\\/]/.test(fileURLToPath(import.meta.url)); } catch { return false; }
}

function resolveWorkerPath(): string | undefined {
  const explicit = process.env.CODE_INSPECTION_WORKER_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates: string[] = [];
  try {
    const entry = fileURLToPath(import.meta.url);
    candidates.push(join(dirname(entry), `inspection-worker${runtimeEntryExtension(entry)}`));
  } catch { /* CJS bundle fallback below. */ }
  if (process.argv[1]) {
    const entry = process.argv[1];
    candidates.push(join(dirname(entry), `inspection-worker${runtimeEntryExtension(entry)}`));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function runtimeEntryExtension(entry: string): ".cjs" | ".js" {
  return extname(entry) === ".cjs" ? ".cjs" : ".js";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
