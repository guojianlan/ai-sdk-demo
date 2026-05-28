import path from "node:path";
import { writeFile } from "node:fs/promises";

import { generateImage } from "ai";
import { z } from "zod";

import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";
import { resolveWorkspacePath } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

const imageGenerationInputSchema = z.object({
  prompt: z.string().min(1).describe("Text prompt for the image model."),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory relative to the workspace root. Defaults to .flow-artifacts/images.",
    ),
  fileName: z
    .string()
    .optional()
    .describe("Optional file name without path separators."),
  size: z
    .string()
    .optional()
    .describe("Optional provider-specific size, for example 1024x1024."),
});

export const imageGenerationTool = approvedTool({
  name: "image_generation",
  description: [
    "Generate an image from a text prompt with the configured OpenAI-compatible image model.",
    "The generated image is saved into the current workspace and the tool returns the file path.",
  ].join("\n"),
  inputSchema: imageGenerationInputSchema,
  getRuleContent: ({ prompt }) => prompt,
  getCwd: (ctx) => getWorkspaceToolContext(ctx).sandbox.workingDirectory,
  execute: async (
    { prompt, outputDir, fileName, size },
    { experimental_context, abortSignal },
  ) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    const workspaceRoot = sandbox.workingDirectory;

    try {
      const imageSize = normalizeImageSize(size);
      const result = await generateImage({
        model: gateway.imageModel(env.gateway.imageModelId),
        prompt,
        ...(imageSize ? { size: imageSize } : {}),
        abortSignal,
      });
      const image = result.image;
      const extension = extensionForMediaType(image.mediaType);
      const safeName = sanitizeFileName(fileName) ?? `${Date.now()}${extension}`;
      const relativeDir = outputDir?.trim() || ".flow-artifacts/images";
      const relativePath = path.posix.join(relativeDir, safeName);
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);

      await sandbox.mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, Buffer.from(image.uint8Array));

      return toolOk({
        prompt,
        model: env.gateway.imageModelId,
        path: path.relative(workspaceRoot, absolutePath),
        absolutePath,
        mediaType: image.mediaType,
        bytesWritten: image.uint8Array.byteLength,
        warnings: result.warnings,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  return ".png";
}

function sanitizeFileName(fileName: string | undefined): string | null {
  const trimmed = fileName?.trim();
  if (!trimmed) return null;
  const baseName = path.basename(trimmed).replace(/[^a-zA-Z0-9._-]/g, "-");
  return baseName || null;
}

function normalizeImageSize(
  size: string | undefined,
): `${number}x${number}` | undefined {
  const trimmed = size?.trim();
  if (!trimmed) return undefined;
  return /^\d+x\d+$/.test(trimmed)
    ? (trimmed as `${number}x${number}`)
    : undefined;
}
