import type { Logger } from "@zakotoys/code-inspection-core";

export function createStderrLogger(prefix: string): Logger {
  const write = (level: string, message: string, details?: unknown): void => {
    const suffix = details === undefined ? "" : ` ${safeJson(details)}`;
    process.stderr.write(`[${prefix}] ${level}: ${message}${suffix}\n`);
  };
  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details)
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
