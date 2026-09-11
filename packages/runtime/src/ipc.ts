import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
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
  type DiscoveryRecord,
  type ServiceHandshakeParams,
  type ServiceHandshakeResult,
  type ServiceApi
} from "./protocol.js";
import { createStderrLogger } from "./logger.js";

const STARTUP_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 100;
const UNIX_SOCKET_PATH_LIMIT = 100;

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
  const server = createServer();
  let closed = false;
  const clients = new Set<MessageConnection>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleIdle = (): void => {
    if (clients.size > 0 || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void api.getStatus().then((status) => {
        if (clients.size === 0 && status.activeRuns.length === 0) void options.onIdle();
        else scheduleIdle();
      }).catch(() => {
        if (clients.size === 0) void options.onIdle();
      });
    }, options.idleTimeoutMs);
  };
  const clearIdle = (): void => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const onClient = (socket: Socket): void => {
    const connection = createConnection(socket, socket, logger);
    clients.add(connection.connection);
    clearIdle();
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        connection.connection.dispose();
        socket.destroy();
      }
    }, 5_000);
    handshakeTimer.unref?.();
    connection.connection.onRequest("initialize", async (params: ServiceHandshakeParams): Promise<ServiceHandshakeResult> => {
      if (!params || params.root !== root || params.secret !== secret || params.protocolVersion !== SERVICE_PROTOCOL_VERSION || params.identity !== SERVICE_IDENTITY) {
        throw new Error("Workspace service handshake rejected: endpoint identity or secret is invalid.");
      }
      authenticated = true;
      clearTimeout(handshakeTimer);
      return { root, protocolVersion: SERVICE_PROTOCOL_VERSION, identity: SERVICE_IDENTITY, pid: process.pid };
    });
    for (const method of ["runInspection", "getRun", "getFindings", "cancelRun", "didSave", "didChange", "getStatus"] as const) {
      connection.connection.onRequest(method, async (params: unknown) => {
        if (!authenticated) throw new Error("Workspace service handshake is required.");
        const handler = api[method] as (value: unknown) => Promise<unknown>;
        return handler.call(api, params);
      });
    }
    connection.connection.onClose(() => {
      clearTimeout(handshakeTimer);
      clients.delete(connection.connection);
      scheduleIdle();
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
  await listen(server, endpoint);
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
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearIdle();
    for (const connection of clients) connection.dispose();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
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
    getStatus: () => connection.sendRequest("getStatus")
  };
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
    const entryPath = process.argv[1];
    if (!entryPath) throw new Error("Unable to locate the runtime entry point for the workspace service.");
    const serviceScript = join(dirname(realpathSync(entryPath)), "service-host.js");
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
    const onError = (error: Error): void => {
      socket.removeListener("connect", onConnect);
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      socket.removeListener("error", onError);
      resolvePromise(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
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
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
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
