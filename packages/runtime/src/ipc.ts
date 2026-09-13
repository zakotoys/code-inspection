import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import {
  canonicalizeWorkspaceRoot,
  defaultDataDirectory,
  pathForWorkspaceKey,
  type Logger
} from "@zakotoys/code-inspection-core";
import {
  SERVICE_IDENTITY,
  SERVICE_PROTOCOL_VERSION,
  parseCancelRunParams,
  parseChangeParams,
  parseDeleteParams,
  parseGetFindingsParams,
  parseGetRunParams,
  parseGetStatusParams,
  parseListInspectorsParams,
  parseListProjectsParams,
  parseRunInspectionParams,
  parseSaveParams,
  parseServiceHandshakeParams,
  type DiscoveryRecord,
  type ServiceHandshakeParams,
  type ServiceHandshakeResult,
  type ServiceApi
} from "./protocol.js";
import { createStderrLogger } from "./logger.js";

const STARTUP_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 100;
const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const UNIX_SOCKET_PATH_LIMIT = 100;
// A newly spawned owner must remain available long enough for its parent
// client to read discovery, open the socket, and complete the handshake. The
// configured idle timeout applies after the first connection; using it during
// startup makes small test/embedding timeouts race the owner initialization.
const STARTUP_IDLE_GRACE_MS = 5_000;

export interface WorkspaceClient {
  readonly root: string;
  readonly api: ServiceApi;
  close(): void;
}

interface ConnectionWithSocket {
  connection: MessageConnection;
  socket: Socket;
}

export async function connectWorkspaceService(inputRoot: string, logger = createStderrLogger("client")): Promise<WorkspaceClient> {
  const root = await canonicalizeWorkspaceRoot(inputRoot);
  const paths = discoveryPaths(root);
  let record = await readDiscovery(paths.discoveryPath);
  let connection = record ? await tryConnect(record, root, logger) : undefined;
  if (!connection) {
    await startOwner(root, paths, logger);
    record = await waitForDiscovery(paths.discoveryPath, root);
    connection = await connectRecord(record, root);
  }
  const api = createClientApi(connection.connection);
  return {
    root,
    api,
    close: () => {
      connection.connection.dispose();
      connection.socket.destroy();
    }
  };
}

export interface ServiceOwner {
  readonly endpoint: string;
  readonly secret: string;
  close(): Promise<void>;
}

export interface ServiceOwnerOptions {
  idleTimeoutMs: number;
  onIdle: () => Promise<void> | void;
}

export async function startServiceOwner(rootInput: string, api: ServiceApi, logger = createStderrLogger("service"), suppliedEndpoint: string | undefined, suppliedSecret: string | undefined, options: ServiceOwnerOptions = { idleTimeoutMs: 30_000, onIdle: () => undefined }): Promise<ServiceOwner> {
  const root = await canonicalizeWorkspaceRoot(rootInput);
  const paths = discoveryPaths(root);
  const endpoint = suppliedEndpoint ?? paths.endpoint;
  const secret = suppliedSecret ?? randomBytes(32).toString("base64url");
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? Math.max(0, options.idleTimeoutMs) : 30_000;
  const server = createServer();
  let closed = false;
  const clients = new Set<ConnectionWithSocket>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hasAcceptedClient = false;
  let listening = false;
  const triggerIdle = (): void => {
    if (closed) return;
    try {
      void Promise.resolve(options.onIdle()).catch((error: unknown) => logger.error("Workspace service idle callback failed", error));
    } catch (error) {
      logger.error("Workspace service idle callback failed", error);
    }
  };
  const scheduleIdle = (): void => {
    if (closed || clients.size > 0 || idleTimer) return;
    const idleTimeout = hasAcceptedClient
      ? idleTimeoutMs
      : Math.max(idleTimeoutMs, STARTUP_IDLE_GRACE_MS);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void api.getStatus().then((status) => {
        if (closed) return;
        if (clients.size === 0 && status.activeRuns.length === 0) triggerIdle();
        else scheduleIdle();
      }).catch(() => {
        if (!closed && clients.size === 0) triggerIdle();
      });
    }, idleTimeout);
  };
  const clearIdle = (): void => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const onClient = (socket: Socket): void => {
    hasAcceptedClient = true;
    const connection = createConnection(socket, socket, logger);
    clients.add(connection);
    clearIdle();
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        connection.connection.dispose();
        socket.destroy();
      }
    }, 5_000);
    handshakeTimer.unref?.();
    connection.connection.onRequest("initialize", async (rawParams: unknown): Promise<ServiceHandshakeResult> => {
      const params = parseServiceHandshakeParams(rawParams);
      if (!params || params.root !== root || params.secret !== secret || params.protocolVersion !== SERVICE_PROTOCOL_VERSION || params.identity !== SERVICE_IDENTITY) {
        throw new Error("Workspace service handshake rejected: endpoint identity or secret is invalid.");
      }
      authenticated = true;
      clearTimeout(handshakeTimer);
      return { root, protocolVersion: SERVICE_PROTOCOL_VERSION, identity: SERVICE_IDENTITY, pid: process.pid };
    });
    for (const method of ["runInspection", "getRun", "getFindings", "cancelRun", "didSave", "didChange", "didDelete", "listInspectors", "listProjects", "getStatus"] as const) {
      connection.connection.onRequest(method, async (params: unknown) => {
        if (!authenticated) throw new Error("Workspace service handshake is required.");
        if (method === "getStatus") return (api.getStatus as () => Promise<unknown>).call(api);
        const handler = api[method] as (value: unknown) => Promise<unknown>;
        const parsed = parseIpcRequest(method, params);
        return handler.call(api, parsed);
      });
    }
    connection.connection.onClose(() => {
      clearTimeout(handshakeTimer);
      clients.delete(connection);
      if (!closed) scheduleIdle();
    });
    connection.connection.listen();
  };
  server.on("connection", onClient);
  server.on("error", (error) => logger.error("Workspace service listener error", error));
  if (process.platform !== "win32") {
    const endpointDirectory = dirname(endpoint);
    await mkdir(endpointDirectory, { recursive: true });
    await chmod(endpointDirectory, 0o700).catch((error: unknown) => logger.warn("Unable to restrict workspace socket directory permissions", error));
  }
  try {
    await listen(server, endpoint);
    listening = true;
    if (process.platform !== "win32") await chmod(endpoint, 0o600).catch((error: unknown) => logger.warn("Unable to restrict workspace socket permissions", error));
    await writeDiscovery(paths.discoveryPath, {
      root,
      endpoint,
      secret,
      pid: process.pid,
      identity: SERVICE_IDENTITY,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      startedAt: new Date().toISOString()
    });
    scheduleIdle();
  } catch (error) {
    // A failed discovery write or listener setup must not leave a reachable
    // endpoint that future clients could mistake for a healthy owner.
    closed = true;
    clearIdle();
    for (const connection of clients) {
      connection.connection.dispose();
      connection.socket.destroy();
    }
    clients.clear();
    await closeServer(server);
    if (listening) await rm(endpoint, { force: true }).catch(() => undefined);
    const current = await readDiscovery(paths.discoveryPath);
    if (current?.pid === process.pid && current.secret === secret) await rm(paths.discoveryPath, { force: true });
    throw error;
  }
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearIdle();
    for (const connection of clients) {
      connection.connection.dispose();
      // `MessageConnection.dispose()` removes protocol listeners but does not
      // guarantee that a raw net.Socket is destroyed. Close both explicitly so
      // server.close() cannot wait forever on an attached editor/agent.
      connection.socket.destroy();
    }
    await closeServer(server);
    await rm(endpoint, { force: true }).catch(() => undefined);
    const current = await readDiscovery(paths.discoveryPath);
    if (current?.pid === process.pid && current.secret === secret) await rm(paths.discoveryPath, { force: true });
  };
  return { endpoint, secret, close };
}

function createConnection(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream, logger: Logger): ConnectionWithSocket {
  const connection = createMessageConnection(new StreamMessageReader(readable), new StreamMessageWriter(writable), {
    error: (error) => logger.error("IPC connection error", error),
    warn: (message) => logger.warn(message),
    info: (message) => logger.info(message),
    log: (message) => logger.debug(message)
  });
  return { connection, socket: writable as Socket };
}

function createClientApi(connection: MessageConnection): ServiceApi {
  return {
    runInspection: (params) => connection.sendRequest("runInspection", params),
    getRun: (params) => connection.sendRequest("getRun", params),
    getFindings: (params) => connection.sendRequest("getFindings", params),
    cancelRun: (params) => connection.sendRequest("cancelRun", params),
    didSave: (params) => connection.sendRequest("didSave", params),
    didChange: (params) => connection.sendRequest("didChange", params),
    didDelete: (params) => connection.sendRequest("didDelete", params),
    listInspectors: (params) => connection.sendRequest("listInspectors", params),
    listProjects: (params) => connection.sendRequest("listProjects", params),
    getStatus: () => connection.sendRequest("getStatus")
  };
}

type IpcMethod = "runInspection" | "getRun" | "getFindings" | "cancelRun" | "didSave" | "didChange" | "didDelete" | "listInspectors" | "listProjects";

function parseIpcRequest(method: IpcMethod, params: unknown): unknown {
  switch (method) {
    case "runInspection": return parseRunInspectionParams(params);
    case "getRun": return parseGetRunParams(params);
    case "getFindings": return parseGetFindingsParams(params);
    case "cancelRun": return parseCancelRunParams(params);
    case "didSave": return parseSaveParams(params);
    case "didChange": return parseChangeParams(params);
    case "didDelete": return parseDeleteParams(params);
    case "listInspectors": return parseListInspectorsParams(params);
    case "listProjects": return parseListProjectsParams(params);
  }
}

async function tryConnect(record: DiscoveryRecord, root: string, logger: Logger): Promise<ConnectionWithSocket | undefined> {
  try {
    return await connectRecord(record, root);
  } catch (error) {
    logger.debug("Existing service endpoint is unavailable; attempting owner startup", { message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

async function connectRecord(record: DiscoveryRecord, root: string): Promise<ConnectionWithSocket> {
  if (record.root !== root || record.identity !== SERVICE_IDENTITY || record.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new Error("Workspace service discovery record is incompatible with this runtime.");
  }
  const socket = await openSocket(record.endpoint);
  const connection = createConnection(socket, socket, createStderrLogger("ipc"));
  try {
    connection.connection.listen();
    const result = await connection.connection.sendRequest<ServiceHandshakeResult>("initialize", {
      root,
      secret: record.secret,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      identity: SERVICE_IDENTITY
    } satisfies ServiceHandshakeParams);
    if (result.root !== root || result.identity !== SERVICE_IDENTITY || result.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
      throw new Error("Workspace service returned an incompatible handshake.");
    }
    return connection;
  } catch (error) {
    connection.connection.dispose();
    socket.destroy();
    throw error;
  }
}

async function startOwner(root: string, paths: ReturnType<typeof discoveryPaths>, logger: Logger): Promise<void> {
  await mkdir(paths.directory, { recursive: true });
  if (process.platform !== "win32") await chmod(paths.directory, 0o700);
  let lock;
  try {
    lock = await open(paths.lockPath, "wx");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    try {
      await waitForDiscovery(paths.discoveryPath, root);
    } catch (waitError) {
      if (!(await isStaleStartup(paths))) throw waitError;
      await rm(paths.lockPath, { force: true });
      await startOwner(root, paths, logger);
    }
    return;
  }
  try {
    const ownerState = await reconcileDiscovery(root, paths);
    if (ownerState === "healthy" || ownerState === "changed") return;
    if (ownerState === "live-incompatible") {
      throw new Error("A live workspace service with an incompatible protocol is already running. Stop or update that service before retrying.");
    }
    const serviceScript = resolveServiceEntryPath();
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [serviceScript, "--root", root, "--endpoint", paths.endpoint], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CODE_INSPECTION_SERVICE_SECRET: randomBytes(32).toString("base64url") }
    });
    child.once("error", (error) => logger.error("Workspace service process failed to start", error));
    child.unref();
    await waitForDiscovery(paths.discoveryPath, root);
  } catch (error) {
    logger.error("Unable to start workspace service", error);
    throw error;
  } finally {
    await lock.close();
    await rm(paths.lockPath, { force: true });
  }
}

async function isStaleStartup(paths: ReturnType<typeof discoveryPaths>): Promise<boolean> {
  try {
    const lock = await stat(paths.lockPath);
    if (Date.now() - lock.mtimeMs < STARTUP_TIMEOUT_MS * 6) return false;
  } catch {
    return false;
  }
  const record = await readDiscovery(paths.discoveryPath);
  if (!record) {
    try {
      const socket = await openSocket(paths.endpoint);
      socket.destroy();
      return false;
    } catch {
      return true;
    }
  }
  try {
    const socket = await openSocket(record.endpoint);
    socket.destroy();
    return false;
  } catch {
    return true;
  }
}

type OwnerState = "healthy" | "cleared" | "changed" | "live-incompatible";

async function reconcileDiscovery(root: string, paths: ReturnType<typeof discoveryPaths>): Promise<OwnerState> {
  const record = await readDiscovery(paths.discoveryPath);
  if (!record || record.root !== root) {
    try {
      const socket = await openSocket(paths.endpoint);
      socket.destroy();
      return "live-incompatible";
    } catch {
      await rm(paths.endpoint, { force: true }).catch(() => undefined);
      return "cleared";
    }
  }
  try {
    const connection = await connectRecord(record, root);
    connection.connection.dispose();
    connection.socket.destroy();
    return "healthy";
  } catch {
    const current = await readDiscovery(paths.discoveryPath);
    if (!sameDiscovery(current, record)) return "changed";
    try {
      const socket = await openSocket(record.endpoint);
      socket.destroy();
      return "live-incompatible";
    } catch {
      const latest = await readDiscovery(paths.discoveryPath);
      if (!sameDiscovery(latest, record)) return "changed";
      await rm(record.endpoint, { force: true }).catch(() => undefined);
      await rm(paths.discoveryPath, { force: true }).catch(() => undefined);
      return "cleared";
    }
  }
}

function sameDiscovery(left: DiscoveryRecord | undefined, right: DiscoveryRecord): boolean {
  return left?.root === right.root && left.endpoint === right.endpoint && left.secret === right.secret && left.pid === right.pid && left.identity === right.identity && left.protocolVersion === right.protocolVersion && left.startedAt === right.startedAt;
}

async function waitForDiscovery(discoveryPath: string, root: string): Promise<DiscoveryRecord> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const record = await readDiscovery(discoveryPath);
    if (record && record.root === root) {
      try {
        await openSocket(record.endpoint).then((socket) => socket.destroy());
        return record;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_DELAY_MS));
  }
  throw new Error(`Timed out waiting for the workspace service at ${discoveryPath}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function openSocket(endpoint: string): Promise<Socket> {
  return await new Promise<Socket>((resolvePromise, reject) => {
    const socket = connect(endpoint);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to workspace service endpoint after ${SOCKET_CONNECT_TIMEOUT_MS}ms.`));
    }, SOCKET_CONNECT_TIMEOUT_MS);
    timeout.unref?.();
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(socket);
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Workspace service endpoint closed before connecting."));
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.once("close", onClose);
  });
}

function discoveryPaths(root: string): { directory: string; discoveryPath: string; lockPath: string; endpoint: string } {
  const directory = join(defaultDataDirectory(), "instances");
  const key = pathForWorkspaceKey(root);
  const endpointKey = `${key}-${pathForWorkspaceKey(directory).slice(0, 8)}`;
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\code-inspection-${endpointKey}`
    : unixSocketEndpoint(directory, endpointKey);
  return { directory, discoveryPath: join(directory, `${key}.json`), lockPath: join(directory, `${key}.lock`), endpoint };
}

function unixSocketEndpoint(directory: string, endpointKey: string): string {
  const preferred = join(directory, `${endpointKey}.sock`);
  if (preferred.length < UNIX_SOCKET_PATH_LIMIT) return preferred;
  const userKey = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const filename = `${endpointKey}.sock`;
  const candidates = [join(tmpdir(), `code-inspection-${userKey}`), join("/tmp", `code-inspection-${userKey}`)];
  const short = candidates.find((candidate) => join(candidate, filename).length < UNIX_SOCKET_PATH_LIMIT);
  if (!short) throw new Error("Unable to create a workspace IPC socket: the system temporary path is too long.");
  return join(short, filename);
}

async function readDiscovery(filePath: string): Promise<DiscoveryRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isDiscoveryRecord(value) ? value : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeDiscovery(filePath: string, record: DiscoveryRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      // Windows does not replace an existing file with rename on all
      // supported Node versions. The startup lock serializes this brief
      // replacement window, so remove only the path we own and retry.
      if (process.platform !== "win32" || !isNodeError(error) || !["EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
      await rm(filePath, { force: true });
      await rename(temporaryPath, filePath);
    }
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function resolveServiceEntryPath(): string {
  const explicit = process.env.CODE_INSPECTION_SERVICE_PATH;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  try {
    const entry = fileURLToPath(import.meta.url);
    candidates.push(join(dirname(entry), `service-host${runtimeEntryExtension(entry)}`));
  } catch { /* CJS bundle path below. */ }
  if (process.argv[1]) {
    try {
      const entry = realpathSync(process.argv[1]);
      candidates.push(join(dirname(entry), `service-host${runtimeEntryExtension(entry)}`));
    } catch { /* Try the package path below. */ }
  }
  const found = candidates.find((candidate) => {
    try { return requireLikeExists(candidate); } catch { return false; }
  });
  if (!found) throw new Error("Unable to locate the runtime service-host entry point. Set CODE_INSPECTION_SERVICE_PATH or rebuild the runtime package.");
  return found;
}

function runtimeEntryExtension(entry: string): ".cjs" | ".js" {
  return extname(entry) === ".cjs" ? ".cjs" : ".js";
}

function requireLikeExists(path: string): boolean {
  // Keep the existence check local to this module without introducing a
  // synchronous import solely for a single startup branch.
  try {
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    try {
      server.close(() => resolvePromise());
    } catch {
      // `close` throws when listen failed or a previous shutdown already
      // completed; either state is terminal for this owner.
      resolvePromise();
    }
  });
}

function isDiscoveryRecord(value: unknown): value is DiscoveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.root === "string" && typeof record.endpoint === "string" && typeof record.secret === "string" && typeof record.pid === "number" && typeof record.identity === "string" && typeof record.protocolVersion === "number" && typeof record.startedAt === "string";
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
