import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findPacksRoot } from "./agent-packs.js";
import { extractLastJsonBlock } from "./skill-scripts.js";

const execFileAsync = promisify(execFile);

/**
 * WPS 环境闸门：内置专家包「紫金个人知识库助手」自带的 wps365-env 技能。
 * 登录态（WPS_SID）过期/缺失时不再把网关 401 原文抛给用户，而是按该技能的约定
 * 执行 `ensure [--refresh]`——从本机紫金协作客户端重新导入会话写入 ~/.wps365/env.json，
 * 校验通过后由调用方重试同步。包技能只挂专家私有目录、不进平台技能库，
 * 所以这里不经过 runSkillScript（那套只认 SKILLS_DIR / 专家目录），直接执行包内脚本。
 *
 * 经验来自 pitfalls-and-experience 技能：stdout/stderr 都可能是结构化报告，不能吞；
 * macOS 读钥匙串会弹授权（点「允许」）；缺 pycryptodome 时脚本会给出安装指引。
 */

const ENV_PACK_ID = "紫金个人知识库助手";
const GATE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

export interface EnvGateResult {
  ok: boolean;
  ready: boolean;
  action: string;
  message: string;
}

/** 网关会话失效（WPS_SID 缺失/过期）的报错特征，命中后值得跑一轮 ensure --refresh */
export function isWpsSessionError(message: string): boolean {
  return /401001003|not\s+fount\s+session|not\s+found\s+session|status[_\s-]?code["':=\s]+40[13]/i.test(message);
}

/** 剥掉 Python 警告行（NotOpenSSLWarning 等），只留真实错误内容 */
export function stripWarningNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/NotOpenSSLWarning|urllib3 v2 only supports|warnings\.warn|Warning:/i.test(line))
    .join("\n")
    .trim();
}

/** 按踩坑经验补平台相关提示（macOS 钥匙串授权等） */
function withPlatformHints(message: string): string {
  if (
    process.platform === "darwin" &&
    /钥匙串|keychain|解密|decrypt/i.test(message) &&
    !message.includes("允许")
  ) {
    return `${message}（若 macOS 弹出钥匙串授权，请点「允许」后重试）`;
  }
  return message;
}

function envGateScript(): string | undefined {
  const root = findPacksRoot();
  if (!root) return undefined;
  const script = path.join(root, ENV_PACK_ID, "skills", "wps365-env", "run.py");
  return fs.existsSync(script) ? script : undefined;
}

/**
 * 运行环境闸门：ensure（缺凭证时自动导入）或 ensure --refresh（强制重导）。
 * 返回脚本 JSON 报告；脚本不存在或输出无法解析时也返回结构化结果，不抛异常，
 * 让调用方决定如何向用户解释。
 */
export async function runEnvGate(refresh: boolean): Promise<EnvGateResult> {
  const script = envGateScript();
  if (!script) {
    return {
      ok: false,
      ready: false,
      action: "missing",
      message: "请在本机完成紫金协作登录，或检查 ~/.wps365/env.json 与 WPS_SID 环境变量",
    };
  }
  try {
    const res = await execFileAsync(
      process.env.WPS_PYTHON || (process.platform === "win32" ? "python" : "python3"),
      [script, "ensure", ...(refresh ? ["--refresh"] : [])],
      {
        cwd: path.dirname(script),
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONWARNINGS: "ignore" },
        timeout: GATE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BUFFER,
        windowsHide: true,
      }
    );
    return parseGateOutput(res.stdout, res.stderr);
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (e.killed) {
      return { ok: false, ready: false, action: "timeout", message: "环境脚本执行超时，请重试" };
    }
    // 非零退出时脚本仍会输出结构化报告（未检测到紫金协作、缺依赖等），照常解析
    return parseGateOutput(e.stdout ?? "", e.stderr ?? e.message ?? "");
  }
}

function parseGateOutput(stdout: string, stderr: string): EnvGateResult {
  const json = extractLastJsonBlock<Partial<EnvGateResult>>(stdout);
  if (json && typeof json.ok === "boolean") {
    const message = withPlatformHints(stripWarningNoise(json.message ?? "")) || "环境脚本未返回说明";
    return {
      ok: json.ok,
      ready: json.ready === true,
      action: json.action ?? "unknown",
      message,
    };
  }
  const detail = stripWarningNoise(`${stdout}\n${stderr}`.trim()).slice(0, 300);
  return { ok: false, ready: false, action: "failed", message: detail || "环境脚本执行失败" };
}
