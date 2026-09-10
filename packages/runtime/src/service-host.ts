import { canonicalizeWorkspaceRoot, TrustStore } from "@zakotoys/code-inspection-core";
import { createStderrLogger } from "./logger.js";
import { startServiceOwner } from "./ipc.js";
import { WorkspaceService } from "./service.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputRoot = args.root;
  if (!inputRoot) throw new Error("The workspace service requires --root.");
  const root = await canonicalizeWorkspaceRoot(inputRoot);
  const logger = createStderrLogger("service");
  const service = await WorkspaceService.create(root, { logger, trustStore: new TrustStore() });
  let owner: Awaited<ReturnType<typeof startServiceOwner>> | undefined;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await service.dispose();
    await owner?.close();
  };
  owner = await startServiceOwner(root, service, logger, args.endpoint, process.env.CODE_INSPECTION_SERVICE_SECRET, {
    idleTimeoutMs: Number(process.env.CODE_INSPECTION_IDLE_TIMEOUT_MS ?? 30_000),
    onIdle: async () => {
      await shutdown();
      process.exit(0);
    }
  });
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("uncaughtException", (error) => logger.error("Uncaught service error", error));
  process.once("unhandledRejection", (error) => logger.error("Unhandled service rejection", error));
  logger.info(`Workspace service ready for ${root}`);
}

function parseArgs(args: string[]): { root?: string; endpoint?: string } {
  const result: { root?: string; endpoint?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      const value = args[++index];
      if (value) result.root = value;
    } else if (arg === "--endpoint") {
      const value = args[++index];
      if (value) result.endpoint = value;
    }
  }
  return result;
}

main().catch((error: unknown) => {
  process.stderr.write(`code-inspection service failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
