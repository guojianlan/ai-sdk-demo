/**
 * Shell 命令的审批策略 + "已知安全命令"判定。
 *
 * 设计完全对齐 codex `is_known_safe_command`（路径见
 * tmp/codex-main-04-22/codex-rs/shell-command/src/command_safety/is_safe_command.rs）。
 * 我们项目里没有真正的 OS-level sandbox（不像 codex 用 seatbelt/landlock），所以
 * 这个判定是 LLM 时代的 "soft sandbox"——通过 prompt + 显式审批来兜底，能少弹一次
 * 就少弹一次（保持只读类命令体验流畅），但任何会"产生副作用"的命令一律弹审批。
 *
 * 三档策略：
 * - `never`     —— 任何 shell 命令直接跑（demo / 无人值守模式，危险）
 * - `untrusted` —— 已知安全命令直接跑，其它弹审批（默认）
 * - `always`    —— 任何 shell 命令都弹审批（最保守）
 */

export type ShellApprovalPolicy = "never" | "untrusted" | "always";

export const SHELL_APPROVAL_POLICIES: readonly ShellApprovalPolicy[] = [
  "never",
  "untrusted",
  "always",
] as const;

export const DEFAULT_SHELL_APPROVAL_POLICY: ShellApprovalPolicy = "untrusted";

export function normalizeShellApprovalPolicy(
  value: unknown,
): ShellApprovalPolicy {
  if (typeof value === "string") {
    if (value === "never" || value === "untrusted" || value === "always") {
      return value;
    }
  }
  return DEFAULT_SHELL_APPROVAL_POLICY;
}

// ---- A 类：无条件安全（不查参数） ----------------------------------------
//
// 一对一抄 codex `is_safe_to_call_with_exec` 的固定列表，没有取舍——这些命令
// 本身没办法产生持久副作用（grep / cat / echo / ls 等都是只读的）。如果想新增，
// 必须显式来这里加，并在 PR 描述里说清"为什么这条命令在我们 use case 是必要的"。

const ALWAYS_SAFE_COMMANDS = new Set<string>([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

// ---- B 类：有条件安全（查参数黑名单） -----------------------------------

const UNSAFE_BASE64_FLAGS = new Set(["-o", "--output"]);
const UNSAFE_FIND_FLAGS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);
const UNSAFE_RG_FLAGS_NO_VALUE = new Set(["--search-zip", "-z"]);
const UNSAFE_RG_FLAGS_WITH_VALUE = ["--pre", "--hostname-bin"] as const;

// ---- C 类：git 子命令白名单 ----------------------------------------------

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
]);

const SAFE_GIT_BRANCH_FLAGS = new Set([
  "--list",
  "-l",
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
]);

const UNSAFE_GIT_SUBCOMMAND_FLAGS = new Set([
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec",
  "--paginate",
]);

// 即使 git 子命令本身白名单，如果带这些「全局 option」会让原本只读的命令变危险。
// 比如 -c http.sslVerify=false / -c core.gitProxy=...，可以重定向到攻击者控制的代码。
const UNSAFE_GIT_GLOBAL_FLAGS = new Set([
  "-c",
  "--config",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--upload-pack",
  "--receive-pack",
]);

// ---- shell 复合命令支持 -------------------------------------------------

const SAFE_SHELL_OPERATORS = new Set(["&&", "||", ";", "|"]);

// ---- tokenizer -----------------------------------------------------------
//
// 极简 shell 词法分析。够用就行——只要能切出 token 列表 + 识别复合操作符。
// 不支持：变量替换 `$VAR`、命令替换 `$(...)` / `` `...` ``、重定向 `> < >> 2>&1`、
// 后台 `&`、heredoc。这些一旦出现，分析器会返回 null（→ 视为不安全 → 弹审批）。

type Token =
  | { kind: "word"; value: string }
  | { kind: "op"; value: "&&" | "||" | ";" | "|" };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  const len = input.length;
  let i = 0;
  let buf = "";
  let inSingle = false;
  let inDouble = false;

  function flushWord() {
    if (buf.length > 0) {
      tokens.push({ kind: "word", value: buf });
      buf = "";
    }
  }

  while (i < len) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < len) {
        // backslash 在双引号内只对几个字符有特殊含义（$ ` " \ 换行）；其它原样。
        const next = input[i + 1];
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          buf += next;
          i += 2;
          continue;
        }
        buf += ch;
      } else if (ch === "$" || ch === "`") {
        // 未引号化的 $ / ` 表示变量替换 / 命令替换 → 拒绝分析
        return null;
      } else {
        buf += ch;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < len) {
      buf += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      flushWord();
      i++;
      continue;
    }

    // 不支持的语法 → 直接判不安全
    if (ch === "$" || ch === "`" || ch === ">" || ch === "<" || ch === "&") {
      // && 是合法操作符，需要单独处理
      if (ch === "&" && input[i + 1] === "&") {
        flushWord();
        tokens.push({ kind: "op", value: "&&" });
        i += 2;
        continue;
      }
      // 其它 & < > $ ` 都拒绝
      return null;
    }

    if (ch === "|") {
      flushWord();
      if (input[i + 1] === "|") {
        tokens.push({ kind: "op", value: "||" });
        i += 2;
      } else {
        tokens.push({ kind: "op", value: "|" });
        i++;
      }
      continue;
    }

    if (ch === ";") {
      flushWord();
      tokens.push({ kind: "op", value: ";" });
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  if (inSingle || inDouble) return null;
  flushWord();
  return tokens;
}

/** 把 token 数组按操作符切成多个子命令，每段是 word 列表。 */
function splitByOperators(tokens: Token[]): string[][] | null {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const tok of tokens) {
    if (tok.kind === "op") {
      if (!SAFE_SHELL_OPERATORS.has(tok.value)) return null;
      if (current.length === 0) return null;
      segments.push(current);
      current = [];
    } else {
      current.push(tok.value);
    }
  }

  if (current.length > 0) segments.push(current);
  return segments.length > 0 ? segments : null;
}

// ---- 单个子命令的安全判定 ---------------------------------------------

function isSafeSubcommand(words: string[]): boolean {
  if (words.length === 0) return false;
  const cmd = words[0];

  if (ALWAYS_SAFE_COMMANDS.has(cmd)) return true;

  if (cmd === "base64") {
    return !words
      .slice(1)
      .some(
        (a) =>
          UNSAFE_BASE64_FLAGS.has(a) ||
          a.startsWith("--output=") ||
          (a.startsWith("-o") && a !== "-o"),
      );
  }

  if (cmd === "find") {
    return !words.slice(1).some((a) => UNSAFE_FIND_FLAGS.has(a));
  }

  if (cmd === "rg") {
    return !words.slice(1).some((a) => {
      if (UNSAFE_RG_FLAGS_NO_VALUE.has(a)) return true;
      for (const opt of UNSAFE_RG_FLAGS_WITH_VALUE) {
        if (a === opt || a.startsWith(`${opt}=`)) return true;
      }
      return false;
    });
  }

  if (cmd === "sed") {
    // 仅允许 `sed -n {N|M,N}p`（纯打印行，无副作用）
    if (words.length > 4) return false;
    if (words[1] !== "-n") return false;
    return isValidSedNArg(words[2]);
  }

  if (cmd === "git") {
    return isSafeGitInvocation(words);
  }

  return false;
}

function isValidSedNArg(arg: string | undefined): boolean {
  if (!arg) return false;
  if (!arg.endsWith("p")) return false;
  const core = arg.slice(0, -1);
  const parts = core.split(",");
  if (parts.length === 0 || parts.length > 2) return false;
  return parts.every((p) => p.length > 0 && /^\d+$/.test(p));
}

function isSafeGitInvocation(words: string[]): boolean {
  // 检查所有出现在子命令之前的 token 里是否有不安全的全局 option
  // 子命令位置 = 第一个不以 `-` 开头的 word（args[0] 已经是 `git` 本身）
  let subcommandIdx = -1;
  for (let i = 1; i < words.length; i++) {
    const arg = words[i];
    if (arg.startsWith("-")) {
      // 全局 option：直接看是否在不安全列表里
      const flagName = arg.split("=")[0];
      if (UNSAFE_GIT_GLOBAL_FLAGS.has(flagName)) return false;
      // 安全的全局 option（如 --no-pager）放过
      continue;
    }
    subcommandIdx = i;
    break;
  }

  if (subcommandIdx === -1) return false;
  const subcommand = words[subcommandIdx];
  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;

  const subArgs = words.slice(subcommandIdx + 1);

  // 子参数禁用 flag
  for (const a of subArgs) {
    if (UNSAFE_GIT_SUBCOMMAND_FLAGS.has(a)) return false;
    if (a.startsWith("--output=") || a.startsWith("--exec=")) return false;
  }

  if (subcommand === "branch") {
    // git branch 无 args 默认列出分支 → safe
    if (subArgs.length === 0) return true;
    // 所有 arg 都得是只读 flag
    return subArgs.every(
      (a) => SAFE_GIT_BRANCH_FLAGS.has(a) || a.startsWith("--format="),
    );
  }

  // status / log / diff / show 默认安全（已经过滤了不安全的子参数 flag）
  return true;
}

// ---- 顶层入口 ---------------------------------------------------------

/**
 * 判定一条 shell 命令是否在「已知安全」列表里。
 * 安全 = 命令本身只读 OR 写入是受控/可逆的，跑了不会产生持久副作用或外发数据。
 *
 * 不支持的语法（变量替换、命令替换、重定向、后台、heredoc 等）一律判不安全
 * → `untrusted` 策略下会弹审批，避免分析漏洞。
 */
export function isKnownSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const tokens = tokenize(trimmed);
  if (!tokens) return false;

  const segments = splitByOperators(tokens);
  if (!segments) return false;

  return segments.every((seg) => isSafeSubcommand(seg));
}

/** 给 `shell` tool 的 `needsApproval` 用。 */
export function shellNeedsApproval(
  command: string,
  policy: ShellApprovalPolicy,
): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return !isKnownSafeCommand(command);
}
