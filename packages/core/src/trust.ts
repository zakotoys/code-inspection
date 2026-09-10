import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDirectory, formatError, pathForWorkspaceKey } from "./config.js";

interface TrustRecord {
  root: string;
  grantedAt: string;
  configHash: string;
}

export class WorkspaceTrustError extends Error {
  readonly code = "workspace-untrusted";

  constructor(root: string) {
    super(`Workspace execution is not trusted: ${root}. Run \"code-inspection trust ${root}\" or pass --trust once.`);
    this.name = "WorkspaceTrustError";
  }
}

export class TrustStore {
  readonly dataDirectory: string;

  constructor(dataDirectory = defaultDataDirectory()) {
    this.dataDirectory = dataDirectory;
  }

  async isTrusted(root: string): Promise<boolean> {
    const record = await this.readRecord(root);
    return record?.root === root && record.configHash === await workspaceConfigHash(root);
  }

  async grant(root: string): Promise<void> {
    const directory = join(this.dataDirectory, "trust");
    await mkdir(directory, { recursive: true });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const filePath = join(directory, `${pathForWorkspaceKey(root)}.json`);
    const record: TrustRecord = { root, grantedAt: new Date().toISOString(), configHash: await workspaceConfigHash(root) };
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600);
    }
  }

  async revoke(root: string): Promise<void> {
    const filePath = join(this.dataDirectory, "trust", `${pathForWorkspaceKey(root)}.json`);
    await rm(filePath, { force: true });
  }

  async requireTrusted(root: string): Promise<void> {
    if (!(await this.isTrusted(root))) {
      throw new WorkspaceTrustError(root);
    }
  }

  private async readRecord(root: string): Promise<TrustRecord | undefined> {
    const filePath = join(this.dataDirectory, "trust", `${pathForWorkspaceKey(root)}.json`);
    try {
      const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (isTrustRecord(value)) {
        return value;
      }
      return undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw new Error(`Unable to read workspace trust state: ${formatError(error)}`, { cause: error });
    }
  }
}

function isTrustRecord(value: unknown): value is TrustRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.root === "string" && typeof record.grantedAt === "string" && typeof record.configHash === "string";
}

async function workspaceConfigHash(root: string): Promise<string> {
  try {
    const config = await readFile(join(root, ".code-inspection.json"));
    return createHash("sha256").update(config).digest("hex");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw new Error(`Unable to read workspace inspection configuration: ${formatError(error)}`, { cause: error });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
