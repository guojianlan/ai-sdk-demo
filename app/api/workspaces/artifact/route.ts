import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveWorkspacePath } from "@/lib/workspaces";

const IMAGE_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceRoot = url.searchParams.get("workspaceRoot")?.trim();
  const artifactPath = url.searchParams.get("path")?.trim();

  if (!workspaceRoot || !artifactPath) {
    return Response.json(
      { error: "workspaceRoot and path are required." },
      { status: 400 },
    );
  }

  const mediaType = IMAGE_MEDIA_TYPES.get(
    path.extname(artifactPath).toLowerCase(),
  );
  if (!mediaType) {
    return Response.json(
      { error: "Only image artifacts can be previewed." },
      { status: 400 },
    );
  }

  try {
    const absolutePath = resolveWorkspacePath(workspaceRoot, artifactPath);
    const bytes = await fs.readFile(absolutePath);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": mediaType,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to read artifact.",
      },
      { status: 404 },
    );
  }
}
