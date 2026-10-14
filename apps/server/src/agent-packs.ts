import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSkillName, writeSkillFile, skillExists } from "./skills.js";

/**
 * 专家包：让「专家」像插件一样可安装、可导入、可分享。
 *
 * 包格式 office-agent-package v1（纯 JSON，.json 文件即可分享）：
 * {
 *   "format": "office-agent-package",
 *   "version": 1,
 *   "name": "深度研究员",
 *   "description": "一句话说明",
 *   "tags": ["研究", "分析"],
 *   "highRisk": false,
 *   "systemPrompt": "专家系统提示词",
 *   "skills": { "资料调研": { "description": "...", "content": "..." } }
 * }
 *
 * 模型与供应商是平台环境属性，不进包——安装/导入时由用户现场选择。
 * 内置专家包放在仓库 agent-packs/*.json，随平台分发，一键安装。
 */

export const AGENT_PACKAGE_FORMAT = "office-agent-package";
export const AGENT_PACKAGE_VERSION = 1;
const MAX_PACKAGE_SKILLS = 20;
const MAX_SKILL_CONTENT = 200_000;

export interface AgentPackageSkill {
  description: string;
  content: string;
}

export interface AgentPackage {
  format: string;
  version: number;
  name: string;
  description: string;
  tags: string[];
  highRisk: boolean;
  systemPrompt: string;
  skills: Record<string, AgentPackageSkill>;
  /** 规范化时发现的问题（非法技能名、空内容等被跳过的项），安装/导入路由透出给前端 */
  warnings?: string[];
}

export interface AgentPackMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  skillCount: number;
}

/** 定位仓库内置专家包目录；优先环境变量，其次按 cwd 与模块位置探测。 */
export function findPacksRoot(cwd: string = process.cwd()): string | undefined {
  const candidates: Array<string | undefined> = [
    process.env.AGENT_PACKS_DIR,
    path.resolve(cwd, "agent-packs"),
    path.resolve(cwd, "..", "..", "agent-packs"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent-packs"),
  ];
  return candidates.filter((p): p is string => !!p).find((p) => fs.existsSync(p));
}

/** 内置专家包清单（供专家市场展示）。 */
export function listBuiltinPacks(cwd: string = process.cwd()): AgentPackMeta[] {
  const root = findPacksRoot(cwd);
  if (!root) return [];
  const out: AgentPackMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const pkg = normalizeAgentPackage(JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8")));
      out.push({
        id: entry.name.slice(0, -".json".length),
        name: pkg.name,
        description: pkg.description,
        tags: pkg.tags,
        skillCount: Object.keys(pkg.skills).length,
      });
    } catch {
      // 损坏的内置包不进市场
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function readBuiltinPack(id: string, cwd: string = process.cwd()): AgentPackage | undefined {
  if (!/^[\w\u4e00-\u9fa5-]{1,64}$/.test(id)) return undefined;
  const root = findPacksRoot(cwd);
  const file = root ? path.join(root, `${id}.json`) : undefined;
  if (!file || !fs.existsSync(file)) return undefined;
  return normalizeAgentPackage(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * 校验并规范化专家包：格式声明、名称、系统提示词必查；技能逐个校验，
 * 非法名/空内容的技能跳过并记入 warnings（不阻塞整包导入）。
 */
export function normalizeAgentPackage(
  raw: unknown,
  opts: { requireFormat?: boolean; warnings?: string[] } = {}
): AgentPackage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("专家包格式错误：根节点必须是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;
  if (opts?.requireFormat !== false) {
    if (obj.format !== AGENT_PACKAGE_FORMAT) {
      throw new Error(`不是有效的专家包（缺少 format: ${AGENT_PACKAGE_FORMAT} 声明）`);
    }
    if (obj.version !== AGENT_PACKAGE_VERSION) {
      throw new Error(`专家包版本不受支持：${String(obj.version)}`);
    }
  }
  const name = typeof obj.name === "string" ? obj.name.trim().slice(0, 30) : "";
  const systemPrompt = typeof obj.systemPrompt === "string" ? obj.systemPrompt.trim() : "";
  if (!name) throw new Error("专家包缺少 name");
  if (!systemPrompt) throw new Error("专家包缺少 systemPrompt");
  const warnings = opts?.warnings ?? [];
  const skills: Record<string, AgentPackageSkill> = {};
  if (obj.skills && typeof obj.skills === "object" && !Array.isArray(obj.skills)) {
    for (const [key, value] of Object.entries(obj.skills as Record<string, unknown>)) {
      if (Object.keys(skills).length >= MAX_PACKAGE_SKILLS) {
        warnings.push(`技能数量超过上限（${MAX_PACKAGE_SKILLS}），其余已跳过`);
        break;
      }
      if (!isValidSkillName(key) || !value || typeof value !== "object") {
        warnings.push(`技能「${key}」名称不合法，已跳过`);
        continue;
      }
      const v = value as Record<string, unknown>;
      const content = typeof v.content === "string" ? v.content.slice(0, MAX_SKILL_CONTENT) : "";
      if (!content.trim()) {
        warnings.push(`技能「${key}」内容为空，已跳过`);
        continue;
      }
      skills[key] = {
        description: typeof v.description === "string" ? v.description.slice(0, 200) : "",
        content,
      };
    }
  }
  return {
    format: AGENT_PACKAGE_FORMAT,
    version: AGENT_PACKAGE_VERSION,
    name,
    description: typeof obj.description === "string" ? obj.description.trim().slice(0, 200) : "",
    tags: Array.isArray(obj.tags)
      ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
      : [],
    highRisk: obj.highRisk === true,
    systemPrompt: systemPrompt.slice(0, 8000),
    skills,
    warnings,
  };
}

export interface PackageSkillInstallResult {
  installed: Array<{ requested: string; finalName: string }>;
}

/** 把包内技能写入平台技能库：冲突自动改名，已存在的一律不动（导入不覆盖既有内容）。 */
export function installPackageSkills(pkg: AgentPackage): PackageSkillInstallResult {
  const installed: PackageSkillInstallResult["installed"] = [];
  for (const [name, skill] of Object.entries(pkg.skills)) {
    let final = name;
    for (let i = 2; skillExists(final) && i < 100; i++) final = `${name}-${i}`;
    writeSkillFile(final, skill.description, skill.content);
    installed.push({ requested: name, finalName: final });
  }
  return { installed };
}

/** 打包一个专家：配置 + 勾选的技能（技能内容读平台技能库）。 */
export function buildAgentPackage(
  agent: { name: string; description: string; systemPrompt: string; tags: string[]; highRisk: boolean },
  skills: Array<{ name: string; description: string; content: string }>
): AgentPackage {
  const out: AgentPackage = {
    format: AGENT_PACKAGE_FORMAT,
    version: AGENT_PACKAGE_VERSION,
    name: agent.name,
    description: agent.description,
    tags: agent.tags,
    highRisk: agent.highRisk,
    systemPrompt: agent.systemPrompt,
    skills: {},
  };
  for (const s of skills) {
    out.skills[s.name] = { description: s.description, content: s.content };
  }
  return out;
}
