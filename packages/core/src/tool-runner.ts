import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { formatError } from "./config.js";
import { InspectionCancelledError, InspectionExecutionError } from "./errors.js";
import type { Logger } from "./types.js";

export const MAX_TOOL_OUTPUT = 200_000;

export interface ToolRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
}

export interface ToolResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}

const versionCache = new Map<string, string>();

export async function probeToolVersion(command: string, options: Omit<ToolRunOptions, "signal"> & { signal?: AbortSignal }, args = ["--version"]): Promise<string> {
  const key = [command, JSON.stringify(args), options.cwd, JSON.stringify(options.env ?? {})].join("\u0000");
  const cached = versionCache.get(key);
  if (cached) return cached;
  const result = await runTool(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: Math.min(options.timeoutMs, 10_000),
    signal: options.signal,
    logger: options.logger
  });
  if (result.cancelled) throw new InspectionCancelledError();
  if (result.timedOut) throw new InspectionExecutionError("tool-version", `Unable to determine ${command} version before the probe timed out.`);
  if (result.exitCode !== 0) {
    throw new InspectionExecutionError("tool-version", `Unable to determine ${command} version (exit ${result.exitCode}).`, [result.stdout, result.stderr].filter(Boolean).join("\n") || undefined);
  }
  const version = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^[-=]+$/.test(line));
  if (!version) throw new InspectionExecutionError("tool-version", `The ${command} version probe returned no output.`);
  versionCache.set(key, version);
  return version;
}

export async function runTool(command: string, args: string[], options: ToolRunOptions): Promise<ToolResult> {
  if (options.signal?.aborted) throw new InspectionCancelledError();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new InspectionExecutionError("configuration-error", "Inspection tool timeout must be a positive finite number.");
  }
  const executable = platformExecutable(command);
  const windowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
  const childCommand = windowsScript ? (process.env.ComSpec ?? "cmd.exe") : executable;
  const childArgs = windowsScript ? ["/d", "/s", "/c", [executable, ...args].map(quoteWindowsArg).join(" ")] : args;
  return await new Promise<ToolResult>((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(childCommand, childArgs, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      rejectPromise(processError(command, error));
      return;
    }
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killRequested = false;
    let killerProcess: ReturnType<typeof spawn> | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length > MAX_TOOL_OUTPUT ? next.slice(0, MAX_TOOL_OUTPUT) : next;
    };
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (killerProcess && !killerProcess.killed) {
        try { killerProcess.kill(); } catch { /* The taskkill helper may already be gone. */ }
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const kill = (): void => {
      if (killRequested || !child.pid) return;
      killRequested = true;
      if (process.platform === "win32") {
        let killer: ReturnType<typeof spawn>;
        try {
          killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killerProcess = killer;
        } catch {
          try { child.kill(); } catch { /* The process may have exited already. */ }
          return;
        }
        const fallback = (): void => { try { child.kill(); } catch { /* The process may have exited already. */ } };
        // taskkill can itself become unavailable while the target is tearing
        // down. Keep a direct-child fallback so the caller never waits
        // forever for the child's close event.
        killer.once("error", fallback);
        killer.once("close", (code) => { killerProcess = undefined; if (code !== 0) fallback(); });
        return;
      }
      try {
        // A timeout/cancellation is an exceptional path. Kill the complete
        // detached process group immediately so a descendant that ignores
        // SIGTERM cannot outlive the direct child and leak past cleanup.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* The process may have exited already. */ }
      }
    };
    const onAbort = (): void => {
      // Preserve the first terminal reason when cancellation races the hard
      // deadline. This keeps timeout and explicit cancellation distinguishable
      // at the adapter boundary.
      if (timedOut) return;
      cancelled = true;
      kill();
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, stdoutDecoder.write(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, stderrDecoder.write(chunk)); });
    child.once("error", (error: unknown) => {
      // A kill can surface as an error on one platform before `close`; keep
      // the cancellation/deadline reason as the authoritative outcome.
      if (cancelled || timedOut) return;
      fail(processError(command, error));
    });
    child.once("close", (exitCode: number | null) => {
      stdout = append(stdout, stdoutDecoder.end());
      stderr = append(stderr, stderrDecoder.end());
      finish({ exitCode, stdout, stderr, cancelled, timedOut });
    });
    timeout = setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      stderr = append(stderr, "\nTool timed out after " + options.timeoutMs + "ms.");
      kill();
    }, options.timeoutMs);
    timeout.unref?.();
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    options.logger?.debug("Started inspection tool " + executable, { args, cwd: options.cwd });
  });
}

function platformExecutable(command: string): string {
  if (process.platform === "win32" && ["npm", "npx", "pnpm", "yarn", "bun", "go", "cargo", "mvn", "gradle", "pyright"].includes(command) && !/\.(?:cmd|bat)$/i.test(command)) {
    return command + ".cmd";
  }
  return command;
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function processError(command: string, error: unknown): InspectionExecutionError {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError?.code === "ENOENT") {
    return new InspectionExecutionError("missing-tool", "Inspection tool " + JSON.stringify(command) + " was not found. Install it in the project or add it to PATH.", formatError(error), { cause: error });
  }
  return new InspectionExecutionError("process-failed", "Unable to start inspection tool " + JSON.stringify(command) + ": " + formatError(error), undefined, { cause: error });
}
