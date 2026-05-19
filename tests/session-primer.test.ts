import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSessionPrimer } from "@/lib/session-primer";

/**
 * `buildSessionPrimer` 的向下收集行为是 prompt 装配链路的入口：
 * - 从 cwd 向上找项目根（默认 `.git` marker）
 * - 从 root 向下到 cwd 逐目录收集 AGENTS.md / AGENTS.override.md
 * - 每个目录只取第一个命中（override 优先于普通）
 * - 总预算 32 KiB，超出按顺序截断后续文件
 *
 * 用 tmp 目录 fixture 跑——不引入 mock-fs，行为更贴近真实 fs。
 */

async function writeFile(dir: string, name: string, content: string) {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

describe("buildSessionPrimer 向下收集", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-primer-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // 固定 env 字段，让 environmentContext 在不同机器上稳定
  const stableEnv = {
    currentDate: "2026-05-18",
    timezone: "UTC",
    shell: "zsh",
  } as const;

  it("workspace 根有 AGENTS.md：单段、不带路径后缀", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "root rules\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      ...stableEnv,
    });

    expect(primer.sources).toHaveLength(1);
    expect(primer.sources[0]?.displayPath).toBe("AGENTS.md");
    expect(primer.userInstructions).toContain("# AGENTS.md instructions\n");
    expect(primer.userInstructions).not.toContain("(AGENTS.md)");
    expect(primer.userInstructions).toContain("root rules");
  });

  it("子目录 workspace：从项目根向下收集，外层在前内层在后", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "outer rules\n");
    await writeFile(tmpRoot, "packages/app/AGENTS.md", "inner rules\n");

    const innerCwd = path.join(tmpRoot, "packages/app");
    const primer = await buildSessionPrimer({
      workspaceRoot: innerCwd,
      ...stableEnv,
    });

    expect(primer.sources.map((s) => s.displayPath)).toEqual([
      path.join("..", "..", "AGENTS.md"),
      "AGENTS.md",
    ]);

    // 外层 section 在前，内层 section 在后
    const outerIdx = primer.userInstructions!.indexOf("outer rules");
    const innerIdx = primer.userInstructions!.indexOf("inner rules");
    expect(outerIdx).toBeGreaterThan(-1);
    expect(innerIdx).toBeGreaterThan(outerIdx);

    // 内层显示路径就是 "AGENTS.md"（相对 workspaceRoot），不该再加路径后缀
    expect(primer.userInstructions).toContain("# AGENTS.md instructions\n");
    // 外层显示路径是 ../../AGENTS.md，应进 header
    expect(primer.userInstructions).toContain(
      `# AGENTS.md instructions (${path.join("..", "..", "AGENTS.md")})`,
    );
  });

  it("AGENTS.override.md 在同目录优先于 AGENTS.md", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "base rules\n");
    await writeFile(tmpRoot, "AGENTS.override.md", "override rules\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      ...stableEnv,
    });

    expect(primer.sources).toHaveLength(1);
    expect(primer.sources[0]?.displayPath).toBe("AGENTS.override.md");
    expect(primer.userInstructions).toContain("override rules");
    expect(primer.userInstructions).not.toContain("base rules");
  });

  it("空白 AGENTS.md（trim 后为空）被跳过", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "   \n\t\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      ...stableEnv,
    });

    expect(primer.sources).toHaveLength(0);
    expect(primer.userInstructions).toBeNull();
    // combined 只剩 environmentContext
    expect(primer.combined).toBe(primer.environmentContext);
  });

  it("没有任何 AGENTS.md：userInstructions 为 null", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      ...stableEnv,
    });

    expect(primer.sources).toEqual([]);
    expect(primer.userInstructions).toBeNull();
  });

  it("总预算超限：第二份文档被截断，truncated=true", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    const outerContent = "A".repeat(80);
    const innerContent = "B".repeat(200);
    await writeFile(tmpRoot, "AGENTS.md", outerContent);
    await writeFile(tmpRoot, "sub/AGENTS.md", innerContent);

    const primer = await buildSessionPrimer({
      workspaceRoot: path.join(tmpRoot, "sub"),
      maxTotalBytes: 100,
      ...stableEnv,
    });

    expect(primer.sources).toHaveLength(2);
    const [outer, inner] = primer.sources;
    expect(outer?.truncated).toBe(false);
    expect(outer?.sizeBytes).toBe(80);
    expect(inner?.truncated).toBe(true);
    expect(inner?.sizeBytes).toBe(200);
    // 内层只剩 20 字节预算
    expect(primer.userInstructions).toContain("B".repeat(20));
    expect(primer.userInstructions).not.toContain("B".repeat(21));
  });

  it("maxTotalBytes=0：完全禁用 user_instructions 收集", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "should not appear\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      maxTotalBytes: 0,
      ...stableEnv,
    });

    expect(primer.sources).toEqual([]);
    expect(primer.userInstructions).toBeNull();
    expect(primer.combined).toBe(primer.environmentContext);
  });

  it("projectRootMarkers=[]：不向上找根，只看 cwd 自身那一层", async () => {
    // 在 tmp 外层有 .git，子目录里也有 AGENTS.md，但禁用向上搜索
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "outer rules\n");
    await writeFile(tmpRoot, "sub/AGENTS.md", "inner rules\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: path.join(tmpRoot, "sub"),
      projectRootMarkers: [],
      ...stableEnv,
    });

    // 只该看到 sub/AGENTS.md，外层不被收集
    expect(primer.sources).toHaveLength(1);
    expect(primer.sources[0]?.displayPath).toBe("AGENTS.md");
    expect(primer.userInstructions).toContain("inner rules");
    expect(primer.userInstructions).not.toContain("outer rules");
  });

  it("自定义候选文件名顺序：第一个命中的赢", async () => {
    await writeFile(tmpRoot, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFile(tmpRoot, "AGENTS.md", "agents rules\n");
    await writeFile(tmpRoot, "CLAUDE.md", "claude rules\n");

    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      candidateFilenames: ["CLAUDE.md", "AGENTS.md"],
      ...stableEnv,
    });

    expect(primer.sources).toHaveLength(1);
    expect(primer.sources[0]?.displayPath).toBe("CLAUDE.md");
    expect(primer.userInstructions).toContain("claude rules");
    expect(primer.userInstructions).not.toContain("agents rules");
  });

  it("environmentContext 包含覆盖的 cwd / shell / date / timezone", async () => {
    const primer = await buildSessionPrimer({
      workspaceRoot: tmpRoot,
      currentDate: "2026-05-18",
      timezone: "Asia/Shanghai",
      shell: "zsh",
    });

    expect(primer.environmentContext).toContain(`<cwd>${tmpRoot}</cwd>`);
    expect(primer.environmentContext).toContain("<shell>zsh</shell>");
    expect(primer.environmentContext).toContain(
      "<current_date>2026-05-18</current_date>",
    );
    expect(primer.environmentContext).toContain(
      "<timezone>Asia/Shanghai</timezone>",
    );
  });
});
