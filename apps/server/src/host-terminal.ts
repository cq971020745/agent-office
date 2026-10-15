import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * 宿主机终端只继承这些环境变量。其余一律不传，避免 JWT_SECRET、WPS 凭证等
 * 服务端秘密进入用户命令能读到的进程环境。
 */
const SAFE_ENV_KEYS = new Set(
  [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "HOME",
    "USER",
    "USERNAME",
    "LOGNAME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "SystemDrive",
    "SYSTEMDRIVE",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "USERDOMAIN",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TERM",
    "PSModulePath",
    "PSMODULEPATH",
  ].map((key) => key.toLowerCase())
);

const SENSITIVE_ENV = /secret|token|password|api[_-]?key|credential|jwt|wps_/i;

/** 与 office-suite write-guard 使用同一组规则，拦截明显会毁掉系统或盘根的命令。 */
const DANGEROUS_COMMANDS: Array<{ re: RegExp; why: string }> = [
  { re: /rm\s+(?:-{1,2}[a-zA-Z-]+\s+)*-{1,2}[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:\/|~|\$HOME)(?:\s|\/\*|$)/, why: "递归删除根/家目录" },
  { re: /--no-preserve-root/, why: "绕过根目录删除保护" },
  { re: /del\s+\/[fsq]+\s+.*[a-zA-Z]:\\(?:\s|$)/i, why: "递归删除盘根目录" },
  { re: /(?:rd|rmdir)\s+\/s\s+\/q\s+.*[a-zA-Z]:\\(?:\s|$)/i, why: "递归删除盘根目录" },
  { re: /mkfs(?:\.|\s)/, why: "格式化文件系统" },
  { re: /dd\s+[^;\n]*of=\/dev\/(?:sd|hd|nvme)/, why: "覆写物理块设备" },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: "fork 炸弹" },
  { re: /\b(?:shutdown|reboot|poweroff|halt)\b/, why: "关机/重启" },
  { re: /\bformat\s+[a-zA-Z]:/i, why: "格式化磁盘" },
  { re: /(?:curl|wget)[^;\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, why: "下载并直接执行远程脚本" },
];

export function dangerousCommandReason(command: string): string | undefined {
  for (const { re, why } of DANGEROUS_COMMANDS) {
    if (re.test(command)) return why;
  }
  return undefined;
}

/** 从 Pi 准备好的环境里裁出终端可用的最小环境。 */
export function buildTerminalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV.test(key)) continue;
    if (!SAFE_ENV_KEYS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 宿主机终端：Windows 用 Pi 的 PowerShell，其他平台用 Bash。
 * 对模型统一叫 terminal。工作目录锁在任务工作区，不提权，不暴露会话密钥。
 */
export function createHostTerminalTool(workspace: string): ToolDefinition {
  const factory = process.platform === "win32" ? createPowerShellToolDefinition : createBashToolDefinition;
  const shellName = process.platform === "win32" ? "PowerShell" : "bash";
  const definition = factory(workspace, {
    exposeSessionEnvironment: false,
    spawnHook: (ctx) => ({
      command: ctx.command,
      cwd: workspace,
      env: buildTerminalEnv(ctx.env),
    }),
  });
  const tool = {
    ...definition,
    name: "terminal",
    label: "终端",
    description: `Run a ${shellName} command on the host, with the working directory fixed to this task workspace. The process keeps the server's current privileges and is not elevated. stdout and stderr are returned together. Use this for local scripts (.ps1, .py, .js, .bat, .cmd) and other workspace commands. ${definition.description ?? ""}`.trim(),
  } as ToolDefinition;
  const execute = tool.execute?.bind(tool);
  if (execute) {
    tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      const command = params && typeof params === "object" && "command" in params ? String(params.command ?? "") : "";
      const why = dangerousCommandReason(command);
      if (why) throw new Error(`命令包含破坏性操作（${why}），已被平台护栏拦截。请修改后重试。`);
      return execute(toolCallId, params, signal, onUpdate, ctx);
    };
  }
  return tool;
}
