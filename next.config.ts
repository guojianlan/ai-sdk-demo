import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // better-sqlite3 是 native module（C++ binding），不能被 Next.js bundler
  // 打包，必须在服务端运行时直接 require。Next.js 16 给的开关。
  serverExternalPackages: ["better-sqlite3"],
};

export default withWorkflow(nextConfig);
