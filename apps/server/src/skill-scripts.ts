import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SKILLS_DIR, skillDirectory } from "./skills.js";
import { truncateForContext } from "./tools.js";
import { buildTerminalEnv } from "./host-terminal.js";

const execFileAsync = promisify(execFile);

/** @ 的数据来源与提示词注入都指向这个内置技能 */
export const WPS_SKILL_NAME = "wps365-skill";

const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

/**
 * 凭证边车：wps365-env 技能的提取脚本会把登录态（WPS_SID 等）写入 ~/.wps365/env.json。
 * 服务端与 run_skill_script 子进程都以它为兜底，环境变量里显式设置的值优先。
 */
function readSidecarEnv(): Record<string, string> {
  const merged: Record<string, string> = {};
  try {
    const sidecar = path.join(os.homedir(), ".wps365", "env.json");
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v) merged[k] = v;
    }
  } catch {
    // 边车不存在或损坏：继续用进程环境
  }
  return merged;
}

const WPS_ENV_KEYS = [
  "WPS_SID",
  "PRIVATE",
  "X_ORIGIN",
  "WPS_ENCRYPT",
  "CLOUD_IDE",
  "WPS_CLOUD_GATEWAY",
  "RAGFLOW_BASE_URL",
  "RAGFLOW_API_KEY",
] as const;

export function wpsEnv(): Record<string, string> {
  const merged = readSidecarEnv();
  for (const k of WPS_ENV_KEYS) {
    const v = process.env[k];
    if (v) merged[k] = v;
  }
  return merged;
}

/**
 * 只读边车凭证（不做进程环境覆盖）。wps365-env ensure --refresh 重导登录态后
 * 重试脚本时用它压在 env 最后：服务进程里若还留着启动时的旧 WPS_SID，
 * 不覆盖会让旧值压住刚刷新的边车，重试照样 401。
 */
export function wpsSidecarEnv(): Record<string, string> {
  return readSidecarEnv();
}

/** WPS 登录态是否已配置（决定同步按钮 / @ 数据源是否可用） */
export function wpsConfigured(): boolean {
  return Boolean(wpsEnv().WPS_SID);
}

function pythonBin(): string {
  return process.env.WPS_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

export interface SkillScriptResult {
  stdout: string;
  stderr: string;
}

/**
 * 在已安装技能目录内执行打包脚本（路径越狱防护：仅限技能目录下、仅限 .py）。
 * 子进程继承服务端环境 + WPS 边车凭证；禁止写 pyc 以免污染技能目录。
 * PYTHONWARNINGS=ignore：macOS 系统 Python（LibreSSL）跑 urllib3 v2 会把
 * NotOpenSSLWarning 刷进 stderr，污染结构化错误报告，只屏蔽 warning 通道、不影响报错。
 */
export async function runSkillScript(
  skill: string,
  script: string,
  args: string[] = [],
  timeoutMs = MAX_TIMEOUT_MS,
  agentId?: string,
  envOverride?: Record<string, string>
): Promise<SkillScriptResult> {
  if (!/^[\w\u4e00-\u9fa5-]{1,64}$/.test(skill)) throw new Error("技能名不合法");
  const skillDir = agentId ? skillDirectory(agentId, skill) : path.join(SKILLS_DIR, skill);
  if (!skillDir) throw new Error("技能不存在或不属于当前专家");
  const scriptAbs = path.resolve(skillDir, script);
  const rel = path.relative(path.resolve(skillDir), scriptAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("脚本路径必须位于技能目录内");
  if (!scriptAbs.toLowerCase().endsWith(".py")) throw new Error("只允许执行技能内的 .py 脚本");
  if (!fs.existsSync(scriptAbs)) throw new Error(`脚本不存在：${script}`);
  try {
    const res = await execFileAsync(pythonBin(), [scriptAbs, ...args], {
      cwd: skillDir,
      // 评审 P0-3：不再继承完整 process.env（里面有机密），只给终端白名单环境 +
      // WPS 边车凭证；脚本需要的环境应放进技能自身的 envOverride
      env: {
        ...buildTerminalEnv(process.env),
        ...wpsEnv(),
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONWARNINGS: "ignore",
        ...envOverride,
      },
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BUFFER,
      windowsHide: true,
    });
    return { stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (e.killed) throw new Error(`脚本执行超时（>${Math.round(timeoutMs / 1000)}s）`);
    // 非零退出：输出往往是结构化的错误报告（脚本约定把错误写 stdout/stderr），带回给调用方
    throw new Error(`${(e.stderr || e.stdout || e.message || "脚本执行失败").trim()}`);
  }
}

/**
 * 脚本输出的正文是给人读的 Markdown，机器可读数据统一放在末尾的 ```json 围栏块里。
 * 取最后一个围栏块并解析；不存在或损坏返回 null。
 */
export function extractLastJsonBlock<T = unknown>(stdout: string): T | null {
  const matches = [...stdout.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = matches.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last[1].trim()) as T;
  } catch {
    return null;
  }
}

const RunParams = Type.Object({
  skill: Type.String({ description: "Installed platform skill name, e.g. wps365-skill" }),
  script: Type.String({
    description:
      "Path to a bundled .py script, relative to the skill directory (e.g. skills/contacts/run.py). " +
      "Check the skill's docs (read_skill) for the exact script path and subcommands.",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: "Arguments for the script, e.g. [\"search\", \"李旭\"]. Never pass --confirm unless the user explicitly approved the operation.",
    })
  ),
});

/** run_skill_script：让专家在宿主机上运行技能自带脚本（wps365 等需要本机凭证与内网的能力） */
export function skillScriptTool(agentId?: string): ToolDefinition<typeof RunParams> {
  return {
    name: "run_skill_script",
    label: "运行技能脚本",
    description:
      "Execute a Python script bundled inside an installed platform skill on the host machine, " +
      "with the skill's own credentials/environment (e.g. WPS 365 login) already injected. " +
      "This is how you call office APIs that the sandbox (run_code) cannot reach: search contacts, list IM chats, " +
      "search cloud docs, read calendar/mail, etc. " +
      "Workflow: read the skill with read_skill first to learn script paths and subcommands, then run them here. " +
      "Each script ends its output with a ```json block containing the machine-readable result. " +
      "Scripts may perform real operations (send mail, create events) — only use --confirm after the user explicitly approved.",
    parameters: RunParams,
    execute: async (_id, params) => {
      const args = (params.args ?? []).map(String).slice(0, 64);
      try {
        const res = await runSkillScript(params.skill, params.script, args, MAX_TIMEOUT_MS, agentId);
        const text = `${res.stdout}${res.stderr ? (res.stdout ? "\n" : "") + res.stderr : ""}`.trim();
        return { content: [{ type: "text", text: truncateForContext(text) || "(no output)" }], details: undefined };
      } catch (err) {
        throw new Error(truncateForContext(String((err as Error).message ?? err)));
      }
    },
  };
}
