import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: process.cwd(),
  },
  // better-sqlite3 是 native module（C++ binding），不能被 Next.js bundler
  // 打包，必须在服务端运行时直接 require。Next.js 16 给的开关。
  //
  // @vscode/ripgrep 同样不能 bundle —— 它的 `rgPath` 指向真实文件系统里的
  // `node_modules/@vscode/ripgrep/bin/rg` 二进制；bundler 把路径改写成
  // `/ROOT/node_modules/...` 导致运行时 ENOENT，每次 grep 都退化成 Node 兜底（慢 5-10x）。
  // 把它声明成 external 后 `rgPath` 在 server runtime 才计算出真路径。
  serverExternalPackages: ["better-sqlite3", "@vscode/ripgrep"],
};

export default nextConfig;
