import { spawn } from "node:child_process";

import { defineHook } from "./define";
import type {
  HookEvent,
  HookPayload,
  HookPayloadFor,
  HookResult,
  RegisteredHook,
} from "./types";

const DEFAULT_COMMAND_TIMEOUT_SEC = 600;
const OUTPUT_LIMIT = 20_000;

export interface CommandHookConfig<E extends HookEvent = HookEvent> {
  event: E;
  matcher?: string;
  command: string;
  timeoutSec?: number;
  statusMessage?: string;
  cwd: string;
  name: string;
}

export function commandHook<E extends HookEvent>(
  config: CommandHookConfig<E>,
): RegisteredHook<E> {
  const timeoutSec = config.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC;
  const hook = defineHook<E>({
    event: config.event,
    name: config.name,
    matcher: config.matcher,
    handler: (payload, ctx) =>
      runCommandHook(payload, {
        command: config.command,
        cwd: config.cwd,
        timeoutMs: timeoutSec * 1000,
        statusMessage: config.statusMessage,
        signal: ctx.signal,
      }),
  });
  hook.timeoutMs = timeoutSec * 1000 + 500;
  return hook;
}

async function runCommandHook<E extends HookEvent>(
  payload: HookPayloadFor<E>,
  options: {
    command: string;
    cwd: string;
    timeoutMs: number;
    statusMessage?: string;
    signal?: AbortSignal;
  },
): Promise<HookResult | void> {
  const input = JSON.stringify(commandInput(payload, options.cwd));
  const result = await runShellCommand(options.command, input, options);

  if (result.timedOut) {
    return {
      decision: "deny",
      reason: `${options.statusMessage ?? "Hook command"} timed out after ${Math.round(options.timeoutMs / 1000)}s`,
    };
  }

  if (result.exitCode !== 0) {
    const reason = trimOutput(
      result.stderr || result.stdout || `Hook command exited with code ${result.exitCode}`,
    );
    return {
      decision: "deny",
      reason,
      additionalContexts: [`Hook command failed: ${reason}`],
    };
  }

  return parseCommandStdout(result.stdout);
}

function commandInput(payload: HookPayload, cwd: string): Record<string, unknown> {
  const base = {
    session_id: payload.sessionId,
    cwd,
    hook_event_name: payload.event,
  };

  switch (payload.event) {
    case "PreToolUse":
      return {
        ...base,
        tool_name: payload.toolName,
        tool_input: payload.input,
      };
    case "PostToolUse":
      return {
        ...base,
        tool_name: payload.toolName,
        tool_input: payload.input,
        tool_response: payload.result,
        duration_ms: payload.durationMs,
      };
    case "UserPromptSubmit":
      return { ...base, prompt: payload.prompt };
    case "SessionStart":
      return base;
    case "Stop":
      return {
        ...base,
        finish_reason: payload.finishReason,
        step: payload.step,
        last_assistant_message: payload.lastAssistantMessage,
      };
  }
}

function parseCommandStdout(stdout: string): HookResult | void {
  const trimmed = stdout.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  const obj = parsed as Record<string, unknown>;
  const hookSpecific = objectValue(obj.hookSpecificOutput);
  const contexts = stringArray(obj.additionalContexts);
  const additionalContext =
    stringValue(obj.additionalContext) ??
    stringValue(hookSpecific?.additionalContext);
  if (additionalContext) contexts.push(additionalContext);

  const rawDecision = stringValue(obj.decision);
  const continueProcessing =
    boolValue(obj.continueProcessing) ??
    boolValue(objectValue(obj.universal)?.continueProcessing);
  const reason =
    stringValue(obj.reason) ??
    stringValue(obj.stopReason) ??
    stringValue(objectValue(obj.universal)?.stopReason);
  const systemMessage =
    stringValue(obj.systemMessage) ??
    stringValue(objectValue(obj.universal)?.systemMessage);

  if (rawDecision === "block" || rawDecision === "deny" || continueProcessing === false) {
    return {
      decision: "deny",
      reason: reason ?? "blocked by command hook",
      additionalContexts: contexts,
      systemMessage,
    };
  }

  return {
    decision: rawDecision === "approve" ? "allow" : normalizeDecision(rawDecision),
    reason,
    additionalContexts: contexts.length > 0 ? contexts : undefined,
    systemMessage,
  };
}

function runShellCommand(
  command: string,
  input: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-lc", command], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: { exitCode: number | null; timedOut: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: result.exitCode,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        timedOut: result.timedOut,
      });
    };

    const abort = () => {
      child.kill("SIGTERM");
      finish({ exitCode: null, timedOut: false });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: null, timedOut: true });
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", (error) => {
      stderr = appendLimited(stderr, error.message);
      finish({ exitCode: null, timedOut: false });
    });
    child.on("close", (code) => finish({ exitCode: code, timedOut: false }));
    child.stdin?.end(input);
  });
}

function appendLimited(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  if (next.length <= OUTPUT_LIMIT) return next;
  return next.slice(0, OUTPUT_LIMIT);
}

function trimOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= OUTPUT_LIMIT) return trimmed;
  return `${trimmed.slice(0, OUTPUT_LIMIT)}\n[truncated]`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeDecision(value: string | undefined): HookResult["decision"] | undefined {
  if (value === "allow" || value === "deny" || value === "ask") return value;
  return undefined;
}
