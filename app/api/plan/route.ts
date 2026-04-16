import { streamPlan } from "@/lib/plan-generator";
import { gatewayApiKey } from "@/lib/gateway";

/**
 * POST /api/plan
 *
 * body: { task: string, workspaceName?: string, workspaceRoot?: string }
 *
 * 返回一个文本流；流的内容是不断膨胀的 plan JSON（streamObject 的 text 表示）。
 * 客户端用 `@ai-sdk/react` 的 `experimental_useObject({ api: '/api/plan', schema })`
 * 来订阅，每次到一批新字段就会拿到一个 partial 对象（不含 array.length、某些字段可能还是
 * undefined，这是 streamObject 的正常流式语义）。
 */
export async function POST(request: Request) {
  if (!gatewayApiKey) {
    return new Response(
      "Missing OPENAI_COMPAT_API_KEY (or GEMINI_API_KEY) in .env.local",
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    task?: string;
    workspaceName?: string;
    workspaceRoot?: string;
  };

  const task = body.task?.trim();
  if (!task) {
    return new Response("Missing task.", { status: 400 });
  }

  const result = streamPlan({
    task,
    workspaceContext: {
      name: body.workspaceName,
      root: body.workspaceRoot,
    },
  });

  return result.toTextStreamResponse();
}
