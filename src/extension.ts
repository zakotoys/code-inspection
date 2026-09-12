import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as vscode from "vscode";
import { type DetectorRuntimeStatus, environmentSupport } from "./environment";
import { LocalMcpService, type McpConnection } from "./mcp";
import { WorkspaceDiagnostics } from "./vscode-source";

export interface DetectorStatus extends DetectorRuntimeStatus {
  workspaceFolderCount: number;
  mcpEnabled: boolean;
  errors: number;
  warnings: number;
}
export interface InspectionApi {
  startMcp(): Promise<McpConnection>;
  stopMcp(): Promise<void>;
}
let shutdown: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): InspectionApi {
  const support = environmentSupport(
    vscode.env.remoteName,
    vscode.env.uiKind === vscode.UIKind.Web,
  );
  const source = new WorkspaceDiagnostics(support);
  const output = vscode.window.createOutputChannel("Code Inspection");
  const definitionsChanged = new vscode.EventEmitter<void>();
  let reportRequested = false;
  let saveReportRequested = false;
  const renderSaves = () => {
    const snapshot = source.saveSnapshot();
    output.clear();
    output.appendLine(
      "保存观测：此视图展示最近结束批次；历史可通过 MCP 续读；首次为基线，安静期不代表检查完成。等待中再次编辑会使该次观测失效。",
    );
    output.appendLine(JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  let service: LocalMcpService | undefined;
  let starting: Promise<LocalMcpService> | undefined;
  let stopping: Promise<void> | undefined;
  let disposed = false;
  const version = context.extension.packageJSON.version as string;
  const render = () => {
    const snapshot = source.snapshot();
    output.clear();
    output.appendLine(
      `当前工作区已发布诊断（0 基位置）；空列表不代表全项目检查通过。MCP ${service ? "已启动" : "未启动"}。`,
    );
    output.appendLine(JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  const publish = () => {
    if (disposed) return;
    if (reportRequested) render();
    definitionsChanged.fire();
  };
  const startMcp = async (): Promise<McpConnection> => {
    if (disposed) throw new Error("扩展已停止，请重新加载窗口。");
    if (!vscode.workspace.isTrusted) throw new Error("请先信任工作区，再启动 MCP 服务。");
    if (!support.supported) throw new Error("当前仅支持本地桌面 VS Code 的 MCP 服务。");
    if (stopping) await stopping;
    if (disposed) throw new Error("扩展已停止。");
    starting ??= LocalMcpService.start(
      {
        snapshot: () => source.snapshot(),
        detectorStatus: () => source.detectorStatus(),
        saveBatches: (query) => source.saveBatches(query),
        saveHistoryStatus: () => source.saveHistoryStatus(),
        workspaceUris: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()),
        inScope: (value) => {
          try {
            const uri = vscode.Uri.parse(value, true);
            return (
              uri.scheme === "file" &&
              uri.toString() === value &&
              !uri.query &&
              !uri.fragment &&
              vscode.workspace.getWorkspaceFolder(uri) !== undefined
            );
          } catch {
            return false;
          }
        },
      },
      version,
    )
      .then((created) => {
        service = created;
        publish();
        return created;
      })
      .catch((error: unknown) => {
        starting = undefined;
        throw error;
      });
    return (await starting).connection();
  };
  const stopMcp = (): Promise<void> => {
    stopping ??= (async () => {
      const pending = starting;
      try {
        const current = pending ? await pending : service;
        await current?.close();
      } finally {
        service = undefined;
        starting = undefined;
        publish();
      }
    })().finally(() => {
      stopping = undefined;
    });
    return stopping;
  };
  shutdown = async () => {
    disposed = true;
    await stopMcp();
  };
  const commandStart = async () => {
    try {
      const connection = await startMcp();
      void vscode.window.showInformationMessage(
        `MCP 已启动：${connection.url}。在 MCP 列表选择 Code Inspection，或执行“复制 MCP 配置”。`,
      );
      return { url: connection.url, sessionId: connection.sessionId };
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : "MCP 启动失败。",
      );
      return undefined;
    }
  };
  let batchPosition: { sessionId: string; afterCursor: number } | undefined;
  let batchRead: Promise<Record<string, unknown> | undefined> | undefined;
  const queryMcp = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> => {
    if (!service) {
      void vscode.window.showInformationMessage("请先执行“启动 MCP 服务”，再通过 MCP 查询。");
      return undefined;
    }
    const connection = service.connection();
    const client = new Client({ name: "code-inspection-window-check", version });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
        }),
      );
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      const response = await client.callTool({ name, arguments: args });
      if (!("content" in response) || !response.structuredContent)
        throw new Error("Missing tool result");
      reportRequested = false;
      saveReportRequested = false;
      output.clear();
      output.appendLine(
        response.isError
          ? "MCP 工具返回错误，读取位置未前移。"
          : "通过本机 HTTP / MCP 查询成功（本次查询结果）。",
      );
      output.appendLine(`MCP tools: ${tools.join(", ")}`);
      output.appendLine(JSON.stringify(response.structuredContent, null, 2));
      if (response.isError && name === "get_save_batches")
        output.appendLine(
          "需要重读保留历史时，执行“重置保存批次读取位置”。历史缺口不能当作没有错误；请另外查询当前诊断重新建立上下文。",
        );
      output.show(true);
      return response.structuredContent as Record<string, unknown>;
    } catch {
      void vscode.window.showErrorMessage("MCP 查询失败，请停止并重新启动 MCP 服务后重试。");
      return undefined;
    } finally {
      await client.close();
    }
  };
  const setPaused = async (paused: boolean) => {
    if (!support.supported) {
      void vscode.window.showInformationMessage("当前环境不支持检测；仅支持本地桌面 VS Code。");
      return source.detectorStatus();
    }
    source.setPaused(paused);
    void vscode.window.showInformationMessage(
      paused
        ? "保存观测已暂停；待定批次和旧历史已清空，当前诊断仍可查询。重载窗口后恢复运行并重新建立基线。"
        : "保存观测已恢复；每个文件下一次保存重新建立基线，不补发暂停期间历史。",
    );
    return source.detectorStatus();
  };
  context.subscriptions.push(
    source,
    output,
    definitionsChanged,
    source.onDidChangeSaveObservations(() => {
      if (saveReportRequested) renderSaves();
    }),
    source.onDidChange(() => {
      if (reportRequested) render();
    }),
    {
      dispose: () => {
        disposed = true;
        void stopMcp().catch(() => {});
      },
    },
    vscode.lm.registerMcpServerDefinitionProvider("codeInspection", {
      onDidChangeMcpServerDefinitions: definitionsChanged.event,
      provideMcpServerDefinitions: () => {
        if (!service) return [];
        const c = service.connection();
        return [
          new vscode.McpHttpServerDefinition(
            "Code Inspection",
            vscode.Uri.parse(c.url),
            { Authorization: `Bearer ${c.token}` },
            version,
          ),
        ];
      },
    }),
    vscode.commands.registerCommand("codeInspection.pause", () => setPaused(true)),
    vscode.commands.registerCommand("codeInspection.resume", () => setPaused(false)),
    vscode.commands.registerCommand("codeInspection.showSaveObservations", () => {
      reportRequested = false;
      saveReportRequested = true;
      const snapshot = renderSaves();
      output.show(true);
      return snapshot;
    }),
    vscode.commands.registerCommand("codeInspection.inspectMcp", () =>
      queryMcp("get_diagnostics", {}),
    ),
    vscode.commands.registerCommand("codeInspection.inspectSaveBatches", () => {
      batchRead ??= (async () => {
        const page = await queryMcp("get_save_batches", { ...batchPosition, limit: 5 });
        if (
          page &&
          !("code" in page) &&
          typeof page.sessionId === "string" &&
          typeof page.nextCursor === "number"
        )
          batchPosition = { sessionId: page.sessionId, afterCursor: page.nextCursor };
        return page;
      })().finally(() => {
        batchRead = undefined;
      });
      return batchRead;
    }),
    vscode.commands.registerCommand("codeInspection.resetSaveBatchCursor", () => {
      if (batchRead) {
        void vscode.window.showInformationMessage("请等待当前批次读取结束，再重置读取位置。");
        return;
      }
      const status = source.saveHistoryStatus();
      batchPosition = { sessionId: status.sessionId, afterCursor: status.resumeAfterCursor };
      void vscode.window.showInformationMessage(
        "读取位置已重置到最早保留批次之前。再次执行“通过 MCP 续读保存批次”；已淘汰历史无法恢复，缓存未被删除。",
      );
    }),
    vscode.commands.registerCommand("codeInspection.startMcp", commandStart),
    vscode.commands.registerCommand("codeInspection.stopMcp", async () => {
      await stopMcp();
      void vscode.window.showInformationMessage("MCP 已停止；本地诊断采集继续运行。");
    }),
    vscode.commands.registerCommand("codeInspection.copyMcpConfig", async () => {
      if (!service) {
        void vscode.window.showInformationMessage("请先执行“启动 MCP 服务”。");
        return;
      }
      const c = service.connection();
      await vscode.env.clipboard.writeText(
        JSON.stringify(
          {
            servers: {
              "code-inspection": {
                type: "http",
                url: c.url,
                headers: { Authorization: `Bearer ${c.token}` },
              },
            },
          },
          null,
          2,
        ),
      );
      void vscode.window.showInformationMessage(
        "VS Code 格式的 MCP 配置已复制，包含临时访问令牌；不要提交或公开。重启服务后需重新复制。",
      );
    }),
    vscode.commands.registerCommand("codeInspection.showDiagnostics", () => {
      reportRequested = true;
      saveReportRequested = false;
      const snapshot = render();
      output.show(true);
      return snapshot;
    }),
    vscode.commands.registerCommand("codeInspection.showStatus", (): DetectorStatus => {
      const snapshot = source.snapshot();
      const status: DetectorStatus = {
        ...source.detectorStatus(),
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        mcpEnabled: service !== undefined,
        errors: snapshot.errors,
        warnings: snapshot.warnings,
      };
      void vscode.window.showInformationMessage(
        `Code Inspection 状态 ${status.state}${status.unsupportedReason ? `（${status.unsupportedReason}，仅支持本地桌面）` : ""}；当前已知错误 ${status.errors}，警告 ${status.warnings}；MCP ${status.mcpEnabled ? "已启动" : "未启动"}。`,
      );
      return status;
    }),
  );
  return { startMcp, stopMcp };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
