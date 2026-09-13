import { parentPort } from "node:worker_threads";
import {
  InspectionCancelledError,
  InspectionEngine,
  InspectionExecutionError,
  type InspectionRequest,
  type InspectionOutput,
  type Logger,
  type WorkspaceConfig
} from "@zakotoys/code-inspection-core";

interface WorkerRunMessage {
  type: "run";
  root: string;
  config: WorkspaceConfig;
  request: InspectionRequest;
}

interface WorkerCancelMessage {
  type: "cancel";
}

const logger: Logger = {
  debug: (message, details) => parentPort?.postMessage({ type: "log", level: "debug", message, details }),
  info: (message, details) => parentPort?.postMessage({ type: "log", level: "info", message, details }),
  warn: (message, details) => parentPort?.postMessage({ type: "log", level: "warn", message, details }),
  error: (message, details) => parentPort?.postMessage({ type: "log", level: "error", message, details })
};

let controller: AbortController | undefined;
let running = false;

parentPort?.on("message", (message: WorkerRunMessage | WorkerCancelMessage) => {
  if (message.type === "cancel") {
    controller?.abort();
    return;
  }
  if (running || message.type !== "run") return;
  running = true;
  controller = new AbortController();
  void execute(message).finally(() => {
    running = false;
    controller = undefined;
  });
});

async function execute(message: WorkerRunMessage): Promise<void> {
  try {
    const engine = new InspectionEngine({ root: message.root, config: message.config, logger }, logger);
    const output = await engine.run(message.request, controller?.signal);
    parentPort?.postMessage({ type: "result", output } satisfies { type: "result"; output: InspectionOutput });
  } catch (error) {
    const execution = error instanceof InspectionExecutionError ? error : new InspectionExecutionError("inspector-failed", error instanceof Error ? error.message : String(error));
    parentPort?.postMessage({
      type: "error",
      error: {
        code: execution.code,
        message: execution.message,
        ...(execution.details ? { details: execution.details } : {})
      }
    });
    if (error instanceof InspectionCancelledError) return;
  }
}
