import path from "node:path";

import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

/**
 * 天气 MCP 客户端。
 *
 * 启动时通过 stdio 把 mcp-servers/weather/server.ts 作为子进程拉起来，
 * 再让 AI SDK 的 MCP client 通过 `tools()` 把 server 暴露的 MCP 工具
 * 转成 AI SDK 原生 tool 格式（兼容 ToolLoopAgent 的 `tools` map）。
 *
 * 学到的概念：
 * - `Experimental_StdioMCPTransport({ command, args })` —— 子进程 + stdio MCP 的桥
 * - `createMCPClient({ transport })` —— MCP 客户端实例，封装 JSON-RPC 握手
 * - `client.tools()` —— 把 MCP 工具**动态注册**成 AI SDK 工具，支持任意 schema
 *   （不用我们自己写 Zod schema；MCP server 自描述）
 *
 * 生命周期：
 * - 这个 helper 每次调用都会新建一个 client + 新 spawn 一次子进程。
 * - 调用方应当在一次请求处理完后 `client.close()`，否则子进程会泄漏。
 * - 生产环境可以考虑复用（pool / singleton），但学习项目保持"每请求新建"最易理解。
 */

export async function createWeatherMCPClient() {
  // 路径：从仓库根找 server.ts。process.cwd() 在 Next.js 里是项目根。
  const serverPath = path.resolve(
    process.cwd(),
    "mcp-servers/weather/server.ts",
  );

  // 用项目本地 tsx 直接跑 TS 源文件，省去 build 步骤。
  // 生产构建可以换成 `node mcp-servers/weather/dist/server.js`。
  const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");

  const transport = new Experimental_StdioMCPTransport({
    command: tsxBin,
    args: [serverPath],
    // 让子进程也能看到环境变量，比如将来如果换成需要 API key 的天气源。
    env: process.env as Record<string, string>,
  });

  const client = await createMCPClient({
    transport,
    name: "weather-mcp-client",
    version: "0.1.0",
  });

  return client;
}

/**
 * 便捷函数：建 client → 拿 tools → 返回二者。
 * 调用方拿到 tools 喂给 agent，用完一定要调 client.close() 关闭子进程。
 */
export async function createWeatherToolset() {
  const client = await createWeatherMCPClient();
  const tools = await client.tools();
  return { client, tools };
}
