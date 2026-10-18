/**
 * 计划模式辅助：对齐 Pi 官方 plan-mode 的只读命令白名单与计划提示。
 * 来源精简自 pi-mono coding-agent/examples/extensions/plan-mode/utils.ts。
 */

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s+-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
  // Windows PowerShell 只读常用命令
  /^\s*Get-(Content|ChildItem|Item|Location|Process|Command|Help|Date)\b/i,
  /^\s*Select-String\b/i,
  /^\s*Test-Path\b/i,
  /^\s*Resolve-Path\b/i,
  /^\s*dir\b/i,
  /^\s*type\b/i,
  /^\s*where\.exe\b/i,
];

/** 计划模式下 terminal 是否允许执行（只读白名单且非破坏性）。 */
export function isSafePlanCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(trimmed));
  return !isDestructive && isSafe;
}

/**
 * 计划阶段首轮指令：只读探索 + 输出 Plan 编号步骤与复选框清单。
 * 兼容任务详情页的 awaiting_approval 勾选确认。
 */
export const PLAN_MODE_INSTRUCTION = `[PLAN MODE ACTIVE - 本轮为规划阶段]
你处于计划模式：只读探索，禁止改动系统或工作区。

限制：
- 不要调用会写入/修改/删除文件的工具（workspace_write、workspace_edit、write_skill、run_code、knowledge_upload_document 等）
- terminal 仅可用于只读查询命令；不要运行会改状态的命令
- 可以读取文件、列出目录、检索网页

你的唯一任务：基于下面的用户任务，输出一份执行清单供用户确认。格式要求：
1. 先用一句话概括整体方案
2. 然后输出 Markdown 复选框列表，每项一行：
- [ ] <将要执行的具体动作，写明将运行哪些命令、创建/修改/删除哪些文件、影响范围与风险>
3. 清单后另起一段，用 "Plan:" 标题列出编号步骤（与上面清单对应）：

Plan:
1. First step
2. Second step

要求：按执行顺序、每项具体可核查；除该清单与 Plan 外不要输出其他内容，也不要开始执行。清单末尾加一行「请确认后执行」。`;
