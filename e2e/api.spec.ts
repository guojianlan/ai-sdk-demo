import { expect, test } from "@playwright/test";

/**
 * /api/workspaces 烟测：返回结构正确 + 至少包含当前项目。
 */
test("GET /api/workspaces returns current project", async ({ request }) => {
  const response = await request.get("/api/workspaces");
  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as {
    workspaces: Array<{
      root: string;
      name: string;
      description: string;
      isCurrentProject: boolean;
    }>;
  };

  expect(Array.isArray(body.workspaces)).toBe(true);
  expect(body.workspaces.length).toBeGreaterThan(0);

  const current = body.workspaces.find((w) => w.isCurrentProject);
  expect(current).toBeDefined();
  expect(current?.root).toMatch(/ai-sdk-demo$/);
});
