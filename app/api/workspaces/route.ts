import { listAvailableWorkspaces } from "@/lib/workspaces";

export async function GET() {
  const workspaces = await listAvailableWorkspaces();

  return Response.json({ workspaces });
}
