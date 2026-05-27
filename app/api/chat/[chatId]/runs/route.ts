import { listChatRunRecords } from "@/lib/persistence";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;
  const normalized = chatId?.trim();
  if (!normalized) {
    return new Response("missing chatId", { status: 400 });
  }

  return Response.json({ runs: listChatRunRecords(normalized) });
}
