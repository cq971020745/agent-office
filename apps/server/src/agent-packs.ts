import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCatalogSkillDir } from "./skill-install.js";
import { installOwnedSkill, isValidSkillName, listOwnedSkills, locateSkillDir, skillExists, writeSkillFile } from "./skills.js";
import { zipFiles, type ZipFile } from "./zip-pack.js";

/**
 * 专家包：一位专家连同它自己的技能目录，可安装、可导入、可分享。
 *
 * v1 是单个 JSON，技能正文内联在 skills.<name>.content。
 * v2 是目录或 zip：根上 pack.json，技能就在同级 skills/<name>/（含 references 和脚本）。
 * 不从 skills-catalog 取技能。安装写入该专家的私有技能目录，不进入平台技能库。
 *
 * 模型与供应商是平台环境属性，不进包。
 * 内置包放在仓库 agent-packs/：单个 *.json，或 <id>/pack.json。
 */

export const AGENT_PACKAGE_FORMAT = "office-agent-package";
export const AGENT_PACKAGE_VERSION = 1;
export const AGENT_PACKAGE_VERSION_DIR = 2;
const MAX_PACKAGE_SKILLS = 20;
const MAX_SKILL_CONTENT = 200_000;

export interface AgentPackageSkill {
  description: string;
  content: string;
  /** 安装时要整目录复制的来源。只在读取内置包或解压导入包时填上，不写回清单。 */
  sourceDir?: string;
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

function packIdOk(id: string): boolean {
  return /^[\w\u4e00-\u9fa5-]{1,64}$/.test(id);
}

function metaOf(id: string, pkg: AgentPackage): AgentPackMeta {
  return {
    id,
    name: pkg.name,
    description: pkg.description,
    tags: pkg.tags,
    skillCount: Object.keys(pkg.skills).length,
  };
}

/** 内置专家包清单（供专家市场展示）。同名时目录包优先于单个 JSON。 */
export function listBuiltinPacks(cwd: string = process.cwd()): AgentPackMeta[] {
  const root = findPacksRoot(cwd);
  if (!root) return [];
  const out: AgentPackMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    try {
      if (entry.isDirectory() && packIdOk(entry.name) && fs.existsSync(path.join(root, entry.name, "pack.json"))) {
        const pkg = readBuiltinPack(entry.name, cwd);
        if (pkg) out.push(metaOf(entry.name, pkg));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!packIdOk(id) || fs.existsSync(path.join(root, id, "pack.json"))) continue;
      const pkg = normalizeAgentPackage(JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8")));
      out.push(metaOf(id, pkg));
    } catch {
      // 损坏的内置包不进市场
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 目录包的技能只认包内 skills/<name>/，不回退到平台技能市场。 */
function attachSkillSources(pkg: AgentPackage, packDir?: string): AgentPackage {
  if (!packDir) return pkg;
  for (const [name, skill] of Object.entries(pkg.skills)) {
    const local = path.join(packDir, "skills", name);
    if (fs.existsSync(path.join(local, "SKILL.md"))) skill.sourceDir = local;
  }
  return pkg;
}

export function readBuiltinPack(id: string, cwd: string = process.cwd()): AgentPackage | undefined {
  if (!packIdOk(id)) return undefined;
  const root = findPacksRoot(cwd);
  if (!root) return undefined;
  const dir = path.join(root, id);
  const manifest = path.join(dir, "pack.json");
  if (fs.existsSync(manifest)) {
    return attachSkillSources(normalizeAgentPackage(JSON.parse(fs.readFileSync(manifest, "utf8"))), dir);
  }
  const file = path.join(root, `${id}.json`);
  if (!fs.existsSync(file)) return undefined;
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
    if (obj.version !== AGENT_PACKAGE_VERSION && obj.version !== AGENT_PACKAGE_VERSION_DIR) {
      throw new Error(`专家包版本不受支持：${String(obj.version)}`);
    }
  }
  const version = obj.version === AGENT_PACKAGE_VERSION_DIR ? AGENT_PACKAGE_VERSION_DIR : AGENT_PACKAGE_VERSION;
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
      if (!content.trim() && version !== AGENT_PACKAGE_VERSION_DIR) {
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
    version,
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

/**
 * 把包内技能写入平台技能库。
 * 技能名与内置目录同名时，整目录覆盖安装（含 references 和脚本）。
 * 其余技能冲突时自动改名，不覆盖已有内容。
 */
export function installPackageSkills(pkg: AgentPackage): PackageSkillInstallResult {
  const installed: PackageSkillInstallResult["installed"] = [];
  for (const [name, skill] of Object.entries(pkg.skills)) {
    if (installCatalogSkillDir(name, name)) {
      installed.push({ requested: name, finalName: name });
      continue;
    }
    let final = name;
    for (let i = 2; skillExists(final) && i < 100; i++) final = `${name}-${i}`;
    writeSkillFile(final, skill.description, skill.content);
    installed.push({ requested: name, finalName: final });
  }
  return { installed };
}

export interface ExpertSkillInstallResult extends PackageSkillInstallResult {
  warnings: string[];
}

/** 把专家包里的技能装进该专家的私有目录。同名不改名，也不写入平台技能库。 */
export function installExpertSkills(agentId: string, pkg: AgentPackage): ExpertSkillInstallResult {
  const installed: ExpertSkillInstallResult["installed"] = [];
  const warnings: string[] = [];
  for (const [name, skill] of Object.entries(pkg.skills)) {
    const ok = installOwnedSkill(agentId, name, {
      dir: skill.sourceDir,
      description: skill.description,
      content: skill.content,
    });
    if (!ok) {
      warnings.push(`技能「${name}」没有可安装的目录或正文，已跳过`);
      continue;
    }
    installed.push({ requested: name, finalName: name });
  }
  return { installed, warnings };
}

function skillFiles(dir: string, prefix: string, out: ZipFile[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "__pycache__" || entry.name === "node_modules" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) skillFiles(path.join(dir, entry.name), rel, out);
    else if (entry.isFile()) out.push({ name: rel, data: fs.readFileSync(path.join(dir, entry.name)) });
  }
}

/**
 * 导出可分享的专家包 zip：pack.json + skills/<name>/整目录。
 * 该专家私有技能总会打进去；names 里再追加勾选的平台技能。
 */
export function buildExpertPackZip(
  agent: { name: string; description: string; systemPrompt: string; tags: string[]; highRisk: boolean },
  agentId: string,
  names: string[]
): Buffer {
  const wanted = new Set(listOwnedSkills(agentId).map((skill) => skill.name));
  for (const name of names) {
    if (isValidSkillName(name)) wanted.add(name);
  }
  const skills: Record<string, { description: string }> = {};
  const files: ZipFile[] = [];
  for (const name of wanted) {
    const dir = locateSkillDir(agentId, name);
    if (!dir) continue;
    const parsed = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const desc = /^description:\s*(.*)$/m.exec(parsed)?.[1]?.trim() ?? name;
    skills[name] = { description: desc.slice(0, 200) };
    skillFiles(dir, `skills/${name}`, files);
  }
  const manifest = {
    format: AGENT_PACKAGE_FORMAT,
    version: AGENT_PACKAGE_VERSION_DIR,
    name: agent.name,
    description: agent.description,
    tags: agent.tags,
    highRisk: agent.highRisk,
    systemPrompt: agent.systemPrompt,
    skills,
  };
  files.unshift({ name: "pack.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") });
  return zipFiles(files);
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
