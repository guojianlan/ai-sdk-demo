import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveWorkspacePath } from "@/lib/workspaces";

/**
 * `resolveWorkspacePath` 是所有 workspace 工具（read/write/edit/list/search）
 * 的路径安全闸：任何用户传入的 relative path 都得过这里把 `..` 逃逸拒掉。
 *
 * 走纯函数 unit test：只依赖 node:path 解析逻辑，不碰文件系统，cross-platform
 * 行为也只跟 path 模块走，跑得快、跑得稳。
 */
describe("resolveWorkspacePath", () => {
  const root = "/tmp/fake-workspace";

  it("默认返回 workspace 根目录", () => {
    expect(resolveWorkspacePath(root)).toBe(root);
  });

  it("接受工作区内的相对路径", () => {
    expect(resolveWorkspacePath(root, "src/index.ts")).toBe(
      path.join(root, "src/index.ts"),
    );
  });

  it("接受当前目录写法（.）", () => {
    expect(resolveWorkspacePath(root, ".")).toBe(root);
  });

  it("拒绝单层 .. 逃逸", () => {
    expect(() => resolveWorkspacePath(root, "../escape")).toThrow(
      /outside the selected workspace/,
    );
  });

  it("拒绝多层 .. 逃逸", () => {
    expect(() => resolveWorkspacePath(root, "../../../etc/passwd")).toThrow(
      /outside the selected workspace/,
    );
  });

  it("拒绝指向工作区外的绝对路径", () => {
    expect(() => resolveWorkspacePath(root, "/etc/passwd")).toThrow(
      /outside the selected workspace/,
    );
  });

  it("接受指向工作区内的绝对路径", () => {
    const inside = path.join(root, "src/index.ts");
    expect(resolveWorkspacePath(root, inside)).toBe(inside);
  });

  it("规范化路径里的 .（不逃逸时无害）", () => {
    expect(resolveWorkspacePath(root, "./src/./index.ts")).toBe(
      path.join(root, "src/index.ts"),
    );
  });

  it("允许 .. 在路径中间但最终仍在工作区内", () => {
    // src/../docs/readme.md 等价于 docs/readme.md，没逃出根
    expect(resolveWorkspacePath(root, "src/../docs/readme.md")).toBe(
      path.join(root, "docs/readme.md"),
    );
  });
});
