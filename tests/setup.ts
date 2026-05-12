/**
 * Vitest setupFile —— 在任何 module import 之前跑。
 *
 * `lib/env.ts` 在模块加载期就 crash 如果没 API key（这是 prod hardening 的故意
 * 设计）。单测里我们不真打 LLM，只是要"让 env.ts 能 import"——所以这里塞一个
 * 占位 key，纯本地、永远不出测试进程。
 */
process.env.OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY ?? "test-key";
