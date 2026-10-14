import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { db, now } from "./db.js";
import { paths } from "./config.js";

/**
 * 平台技能：{agentDir}/skills/<name>/SKILL.md（pi 的全局技能发现目录，每任务会话自动发现）。
 * pi 仅在会话启用内置 read/bash 工具时才把技能写进系统提示词；本平台会话只有自研工作区工具，
 * 因此由 runner 调 buildSkillsPrompt() 注入技能清单（渐进披露：只注入元数据），
 * 模型按需用 read_skill 工具加载正文与 scripts/references 等资源文件。
 */

export const SKILLS_DIR = path.join(paths.agentDir, "skills");

/** frontmatter 的扩展字段（对齐 Agent Skills 规范 name/description/license/compatibility/metadata/allowed-tools + 平台扩展）。 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** 用户可用 /名称 直接调用（user-invocable: true 或存在 argument-hint） */
  userInvocable: boolean;
  /** 斜杠调用的参数提示 */
  argumentHint: string;
  /** 别名（逗号分隔），/别名 同样可调用 */
  alias: string;
  metadata: Record<string, string>;
  allowedTools: string[];
}

interface ParsedSkill extends SkillFrontmatter {
  body: string;
}

function parseFrontmatterLine(header: string, key: string): string {
  const line = header
    .split(/\r?\n/)
    .find((l) => new RegExp(`^${key}\\s*:`).test(l.trim()));
  if (!line) return "";
  return line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

/** 解析 SKILL.md 的 frontmatter 与正文；无 frontmatter 时整篇视为正文（全字段为默认值）。 */
export function parseSkillMd(raw: string): ParsedSkill {
  const empty: SkillFrontmatter = {
    name: "",
    description: "",
    userInvocable: false,
    argumentHint: "",
    alias: "",
    metadata: {},
    allowedTools: [],
  };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { ...empty, body: raw.trim() };
  const [, header, body] = m;
  // metadata 是映射字段（metadata: { author: x } 或多行嵌套），提取其子键
  const metadata: Record<string, string> = {};
  const metaMatch = /^metadata\s*:\s*\{([^}]*)\}/m.exec(header);
  if (metaMatch) {
    for (const pair of metaMatch[1].split(",")) {
      const i = pair.indexOf(":");
      if (i > 0) metadata[pair.slice(0, i).trim()] = pair.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  const splitList = (value: string): string[] =>
    value
      ? value
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const argumentHint = parseFrontmatterLine(header, "argument-hint");
  return {
    name: parseFrontmatterLine(header, "name"),
    description: parseFrontmatterLine(header, "description"),
    userInvocable: /^\s*user-invocable\s*:\s*true\s*$/im.test(header),
    argumentHint,
    alias: parseFrontmatterLine(header, "alias"),
    metadata,
    allowedTools: splitList(parseFrontmatterLine(header, "allowed-tools")),
    body: body.trim(),
  };
}

/** 技能目录名约束：中文/字母/数字/中划线/下划线，防止路径逃逸。 */
export function isValidSkillName(name: string): boolean {
  return /^[\w\u4e00-\u9fa5-]{1,64}$/.test(name);
}

export interface SkillMeta extends SkillFrontmatter {
  name: string;
  updatedAt: string;
  size: number;
}

/** 汇总 frontmatter 与目录名：user-invocable 缺省时由 argument-hint/alias 推断。 */
function toMeta(dirName: string, parsed: ParsedSkill, stat: fs.Stats): SkillMeta {
  const userInvocable = parsed.userInvocable || !!parsed.argumentHint || !!parsed.alias;
  return {
    name: dirName,
    description: parsed.description || dirName,
    userInvocable,
    argumentHint: parsed.argumentHint,
    alias: parsed.alias,
    metadata: parsed.metadata,
    allowedTools: parsed.allowedTools,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
  };
}

function readSkillFile(name: string): { parsed: ParsedSkill; stat: fs.Stats } | undefined {
  if (!isValidSkillName(name)) return undefined;
  const file = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.statSync(file);
  return { parsed: parseSkillMd(fs.readFileSync(file, "utf8")), stat };
}

export function listSkills(): SkillMeta[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out: SkillMeta[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readSkillFile(entry.name);
    if (!meta) continue;
    out.push(toMeta(entry.name, meta.parsed, meta.stat));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): (SkillMeta & { content: string }) | undefined {
  const meta = readSkillFile(name);
  if (!meta) return undefined;
  const full = toMeta(name, meta.parsed, meta.stat);
  return {
    ...full,
    content: meta.parsed.body,
  };
}

export function skillExists(name: string): boolean {
  return isValidSkillName(name) && fs.existsSync(path.join(SKILLS_DIR, name, "SKILL.md"));
}

/** 附加的 frontmatter 字段（覆盖安装/同步时保留扩展元数据）。 */
export interface SkillWriteExtras {
  argumentHint?: string;
  alias?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export function writeSkillFile(
  name: string,
  description: string,
  content: string,
  extras: SkillWriteExtras = {}
): void {
  const dir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`name: ${name}`, `description: ${description.replace(/\r?\n/g, " ")}`];
  if (extras.argumentHint) lines.push(`argument-hint: ${extras.argumentHint.replace(/\r?\n/g, " ")}`);
  if (extras.alias) lines.push(`alias: ${extras.alias.replace(/\r?\n/g, " ")}`);
  if (extras.allowedTools?.length) lines.push(`allowed-tools: ${extras.allowedTools.join(", ")}`);
  const metaEntries = Object.entries(extras.metadata ?? {}).filter(([, v]) => v !== "");
  if (metaEntries.length) {
    lines.push(`metadata: { ${metaEntries.map(([k, v]) => `${k}: ${v}`).join(", ")} }`);
  }
  const frontmatter = `---\n${lines.join("\n")}\n---\n\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + content.trim() + "\n", "utf8");
}

export function createSkill(name: string, description: string, content: string, extras?: SkillWriteExtras): void {
  if (!isValidSkillName(name)) throw new Error("技能名只能包含中文、字母、数字、中划线或下划线");
  if (skillExists(name)) throw new Error("同名技能已存在");
  writeSkillFile(name, description, content, extras);
}

export function updateSkill(name: string, description: string, content: string, extras?: SkillWriteExtras): void {
  if (!isValidSkillName(name) || !skillExists(name)) throw new Error("技能不存在");
  // 更新不传 extras 时保留原 frontmatter 的扩展字段
  const prev = readSkillFile(name)!.parsed;
  const merged: SkillWriteExtras = {
    argumentHint: extras?.argumentHint ?? prev.argumentHint,
    alias: extras?.alias ?? prev.alias,
    metadata: extras?.metadata ?? prev.metadata,
    allowedTools: extras?.allowedTools ?? prev.allowedTools,
  };
  writeSkillFile(name, description, content, merged);
}

export function deleteSkill(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const dir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------- 专家↔技能绑定（agent_skills 表；无行 = 使用全部技能） ----------

/** 专家显式绑定的技能名；空数组表示未绑定任何技能，undefined 表示未显式配置（用全部）。 */
export function getAgentSkillBinding(agentId: string): string[] | undefined {
  try {
    const rows = db.prepare("SELECT skill_name FROM agent_skills WHERE agent_id = ?").all(agentId) as {
      skill_name: string;
    }[];
    // 无绑定行 = 未显式配置 = 使用全部平台技能（v1 兼容语义，勿改为返回 []）
    return rows.length ? rows.map((r) => r.skill_name) : undefined;
  } catch {
    // agent_skills 表尚未建（ migrate 未跑）时按未绑定处理
    return undefined;
  }
}

export function setAgentSkillBinding(agentId: string, skills: string[]): void {
  const del = db.prepare("DELETE FROM agent_skills WHERE agent_id = ?");
  const ins = db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_name) VALUES (?, ?)");
  const tx = db.transaction(() => {
    del.run(agentId);
    for (const name of new Set(skills)) {
      if (isValidSkillName(name) && skillExists(name)) ins.run(agentId, name);
    }
  });
  tx();
}

export function deleteAgentSkillBinding(agentId: string): void {
  try {
    db.prepare("DELETE FROM agent_skills WHERE agent_id = ?").run(agentId);
  } catch {
    // 表不存在时无需清理
  }
}

// ---------- 渐进披露：系统提示词只注入技能清单，正文按需 read_skill ----------

const MAX_META_TOTAL = 4_000;

/** 组装注入系统提示词的技能段：仅元数据（name/description/参数提示），正文由模型调 read_skill 获取。 */
export function buildSkillsPrompt(agentId?: string): string {
  let skills = listSkills();
  if (agentId) {
    const binding = getAgentSkillBinding(agentId);
    if (binding !== undefined) skills = skills.filter((s) => binding.includes(s.name));
  }
  if (!skills.length) return "";
  const lines: string[] = [];
  let total = 0;
  for (const s of skills) {
    const hint = s.argumentHint ? `（参数：${s.argumentHint}）` : "";
    const line = `- ${s.name}${hint}: ${s.description}`;
    if (total + line.length > MAX_META_TOTAL) break;
    lines.push(line);
    total += line.length;
  }
  if (!lines.length) return "";
  return [
    "You have the following reusable skills. When a task matches one of them, FIRST call the read_skill tool with the skill's name to load its full instructions, then follow them.",
    "Users may also invoke a skill directly with \"/<skill name> [args]\"; the platform expands it before your turn starts.",
    ...lines,
  ].join("\n");
}

// ---------- read_skill 工具（渐进披露的第二级） ----------

const MAX_SKILL_READ_CHARS = 50_000;

/** 读取技能目录内的文件（正文或 scripts/references/assets 资源），路径严格限制在该技能目录内。 */
export function readSkillResource(name: string, relPath = ""): string {
  const skillRoot = path.join(SKILLS_DIR, name);
  const target = path.resolve(skillRoot, relPath || "SKILL.md");
  const rootWithSep = skillRoot.endsWith(path.sep) ? skillRoot : skillRoot + path.sep;
  if (!target.startsWith(rootWithSep) && target !== skillRoot) {
    throw new Error(`path escapes the skill directory: ${relPath}`);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`file not found in skill "${name}": ${relPath || "SKILL.md"}`);
  }
  const raw = fs.readFileSync(target, "utf8");
  if (raw.length <= MAX_SKILL_READ_CHARS) return raw;
  return `${raw.slice(0, MAX_SKILL_READ_CHARS)}\n[truncated: file exceeds ${MAX_SKILL_READ_CHARS} chars]`;
}

/** read_skill 工具：读取技能正文（SKILL.md）或其目录下的资源文件（references/scripts 等，相对路径）。 */
export function readSkillTool(): ToolDefinition {
  return {
    name: "read_skill",
    label: "读取技能",
    description:
      "Load the full instructions of a platform skill by name (SKILL.md), or one of its bundled resource files via the optional path (relative to the skill directory, e.g. references/api.md, scripts/clean.py). Call this before following a skill listed in <platform_skills>.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name exactly as listed in <platform_skills>" }),
      path: Type.Optional(
        Type.String({ description: "Optional relative path of a resource file inside the skill directory" })
      ),
    }),
    execute: async (_id, params) => {
      const { name, path: relPath } = params as { name?: string; path?: string };
      const skillName = (name ?? "").trim();
      if (!skillName || !isValidSkillName(skillName)) {
        throw new Error("invalid skill name");
      }
      recordSkillUsage(skillName);
      const text = readSkillResource(skillName, (relPath ?? "").trim());
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

// ---------- 激活计数（P2-4）：read_skill 与斜杠调用埋点，反哺市场精选 ----------

const SQL_UPSERT_USAGE = `
  INSERT INTO skill_usage (name, count, last_used_at) VALUES (?, 1, ?)
  ON CONFLICT(name) DO UPDATE SET count = count + 1, last_used_at = excluded.last_used_at
`;

/** 技能被激活（read_skill 读取或斜杠展开）时 +1；计数失败不致命。 */
export function recordSkillUsage(name: string): void {
  try {
    db.prepare(SQL_UPSERT_USAGE).run(name, now());
  } catch {
    // skill_usage 表尚未建立等场景，静默跳过
  }
}

export function getSkillUsageMap(): Record<string, { count: number; lastUsedAt: string | null }> {
  const out: Record<string, { count: number; lastUsedAt: string | null }> = {};
  try {
    const rows = db.prepare("SELECT name, count, last_used_at FROM skill_usage").all() as Array<{
      name: string;
      count: number;
      last_used_at: string | null;
    }>;
    for (const r of rows) out[r.name] = { count: r.count, lastUsedAt: r.last_used_at };
  } catch {
    // 表未建立（未迁移）时返回空
  }
  return out;
}

// ---------- 斜杠调用：服务端展开（用户 /技能名 [参数] → 技能正文 + $ARGUMENTS 替换） ----------

export interface SlashExpansion {
  skill: string;
  args: string;
  prompt: string;
}

/** 把 ${1:-默认值} 语法替换为参数（无参数时用默认值）；$ARGUMENTS 直接替换为参数。 */
export function expandSkillArguments(body: string, args: string): string {
  const trimmed = args.trim();
  let out = body.replace(/\$\{1:-([^}]*)\}/g, (_all, dflt: string) => (trimmed ? args : dflt));
  out = out.split("$ARGUMENTS").join(args);
  return out;
}

/**
 * 展开用户输入中的技能斜杠调用（如「/周报生成 销售条线」）。
 * 命中规则：首个 /词 精确等于技能名 > alias > 唯一前缀。未命中返回原输入。
 */
export function expandSkillSlash(input: string): string {
  const m = /^\/([\w\u4e00-\u9fa5-]{1,64})(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return input;
  const token = m[1];
  const args = (m[2] ?? "").trim();
  const skills = listSkills();
  const exact = skills.find((s) => s.name === token);
  const byAlias = skills.find((s) => s.alias.split(/[,\s]+/).filter(Boolean).includes(token));
  const prefixed = skills.filter((s) => s.name.startsWith(token));
  const match = exact ?? byAlias ?? (prefixed.length === 1 ? prefixed[0] : undefined);
  if (!match) return input;
  const file = path.join(SKILLS_DIR, match.name, "SKILL.md");
  if (!fs.existsSync(file)) return input;
  recordSkillUsage(match.name);
  const body = parseSkillMd(fs.readFileSync(file, "utf8")).body;
  const expanded = expandSkillArguments(body, args);
  if (args && expanded === body) {
    return `${body}\n\n用户参数：${args}`;
  }
  return expanded;
}

// ---------- 内置示例技能（每技能幂等播种，不覆盖用户修改） ----------

const SEED_SKILLS: Array<{ name: string; description: string; argumentHint: string; body: string[] }> = [
  {
    name: "周报生成",
    description: "把零散工作要点整理成结构化周报，输出 周报.md",
    argumentHint: "[主题或重点，可留空]",
    body: [
      "# 周报生成技能",
      "",
      "当用户要求写周报时，按以下结构输出到 周报.md：",
      "1. 本周概览（3 句以内）",
      "2. 关键进展（分条，每条含结果与数据）",
      "3. 数据亮点（用表格呈现关键指标）",
      "4. 风险与阻塞",
      "5. 下周计划（可执行的动作项）",
      "",
      "写作重点：$ARGUMENTS",
      "",
      "要求：语言精炼、结论先行；没有数据支撑的表述不要写。",
    ],
  },
  {
    name: "会议纪要",
    description: "把会议要点整理成标准纪要，输出 纪要.md",
    argumentHint: "<会议主题或原始记录>",
    body: [
      "# 会议纪要技能",
      "",
      "会议内容：$ARGUMENTS",
      "",
      "把用户提供的会议要点整理为 纪要.md，结构：",
      "1. 会议信息（主题/时间/参会人，未知则留空）",
      "2. 结论与决议（编号列出）",
      "3. 行动项表格（事项/负责人/截止时间）",
      "",
      "保留原始语义，不虚构未提到的内容。",
    ],
  },
  {
    name: "邮件润色",
    description: "润色工作邮件：语气专业礼貌、条理清晰，输出 email-draft.md",
    argumentHint: "<邮件草稿或要点>",
    body: [
      "# 邮件润色技能",
      "",
      "请润色以下工作邮件：$ARGUMENTS",
      "",
      "要求：",
      "1. 语气专业礼貌、条理清晰，保留原意，不添加虚构信息；",
      "2. 先给出润色后的完整正文（含主题行），再附 2-3 条备选开头；",
      "3. 将最终版本保存为工作区中的 email-draft.md，并在回复中给出全文。",
    ],
  },
];

/** 首次使用时播种示例技能，让「技能」页开箱可见；逐技能判断（缺哪个补哪个），不覆盖已有内容。 */
export function ensureSeedSkills(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  for (const seed of SEED_SKILLS) {
    if (skillExists(seed.name)) continue;
    writeSkillFile(seed.name, seed.description, seed.body.join("\n"), { argumentHint: seed.argumentHint });
  }
}
