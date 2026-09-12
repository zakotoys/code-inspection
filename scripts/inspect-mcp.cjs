const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

class InspectionError extends Error {}
async function main() {
  if (process.stdin.isTTY) throw new InspectionError("[INPUT] 请通过标准输入传入复制的 MCP 配置。");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384)
      throw new InspectionError("[CONFIG] 配置超过大小限制，请重新复制 MCP 配置。");
  }
  if (!input.trim())
    throw new InspectionError("[INPUT] 未收到配置。请在开发宿主执行“复制 MCP 配置”。");
  let config;
  try {
    config = JSON.parse(input.replace(/^\uFEFF/, ""));
  } catch {
    throw new InspectionError(
      "[CONFIG] 输入不是 JSON 配置。复制终端命令会覆盖剪贴板；请先输入命令，再复制 MCP 配置，最后执行命令。也可直接使用“通过 MCP 查询当前诊断”命令。",
    );
  }
  const server = config?.servers?.["code-inspection"];
  if (!server)
    throw new InspectionError(
      "[CONFIG] 找不到 servers.code-inspection，请在开发宿主重新复制 MCP 配置。",
    );
  let url;
  try {
    url = new URL(server.url);
  } catch {
    throw new InspectionError("[CONFIG] MCP 地址格式错误，请重新复制配置。");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new InspectionError("[CONFIG] 此检查命令只连接本机 Code Inspection MCP 地址。");
  const authorization = server.headers?.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [a-f0-9]{64}$/.test(authorization))
    throw new InspectionError("[CONFIG] 访问令牌格式错误，请重新复制配置。");
  // A bounded preflight identifies transport/auth failures without printing arbitrary errors.
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new InspectionError(
      "[CONNECT] 无法连接本机 MCP 服务（或连接超时）。请保持开发宿主开启，启动 MCP 后重新复制配置。",
    );
  }
  await response.body?.cancel();
  if (response.status === 401)
    throw new InspectionError("[AUTH] 访问令牌已失效或不正确。服务重启后必须重新复制 MCP 配置。");
  if (response.status !== 400)
    throw new InspectionError(
      "[ENDPOINT] 地址未返回预期的 MCP 协议响应，请重新启动服务并复制配置。",
    );
  const client = new Client({ name: "code-inspection-manual-check", version: "0.0.1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: authorization } },
      }),
    );
    console.log("MCP tools:", (await client.listTools()).tools.map((tool) => tool.name).join(", "));
    for (const name of ["get_detector_status", "get_diagnostics"]) {
      const result = await client.callTool({ name, arguments: {} });
      if (!("content" in result) || result.isError)
        throw new InspectionError("[TOOL] MCP 工具未成功返回，请检查扩展状态。");
      console.log(name, JSON.stringify(result.structuredContent, null, 2));
    }
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  // Only our fixed messages are safe; input and transport exceptions can contain credentials.
  console.error(
    error instanceof InspectionError
      ? error.message
      : "[PROTOCOL] MCP 协议查询失败，请重新启动开发宿主和 MCP 服务后再试。",
  );
  process.exitCode = 1;
});
