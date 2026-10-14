import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Statement } from "better-sqlite3";
import { db, now, uuid } from "./db.js";
import { paths } from "./config.js";
import {
  SKILLS_DIR,
  deleteSkill,
  isValidSkillName,
  parseSkillMd,
  skillExists,
  writeSkillFile,
  type SkillWriteExtras,
} from "./skills.js";

/**
 * 技能安装与同步：技能可以像主流生态一样「从来源安装」，并记住来源以便日后「同步更新」。
 *
 * 来源四种（skill_sources.kind）：
 * - builtin：随平台分发的内置技能目录（仓库 skills-catalog/<id>/SKILL.md），source 记为 builtin:<id>；
 * - url：单个 Markdown 文件的 http(s) 直链；普通仓库主页 URL 会先按 Markdown 拉取、失败再退回 git；
 * - git：git 仓库（git: 前缀或 .git 结尾），浅克隆后扫描其中全部 SKILL.md，一次可装多个技能；
 * - local：本机文件（单个 .md）或目录（含 SKILL.md，或子目录各含 SKILL.md 的技能合集）。
 *
 * skill_sources 表登记每个已安装技能的来源与修订，syncSkill 据此重拉同源的全部技能：
 * 源里被删掉的技能本地同步移除，新增的自动补装，已有的一律覆盖。
 */

export type SkillSourceKind = "builtin" | "url" | "git" | "local";

export interface SkillSourceRow {
  name: string;
  source: string;
  kind: SkillSourceKind;
  revision: string;
  syncedAt: string;
}

export interface InstallOutcome {
  /** 本次落到本地的技能名（新增 + 覆盖） */
  names: string[];
  added: string[];
  updated: string[];
  /** 同步时源里已删除、随之本地移除的技能名 */
  removed: string[];
  kind: SkillSourceKind;
  source: string;
  revision: string;
}

export interface CatalogSkill {
  id: string;
  description: string;
  installed: boolean;
}

const MAX_SKILL_FILE = 2_000_000;
const MAX_SKILLS_PER_SOURCE = 50;
const GIT_TIMEOUT_MS = 60_000;

// 语句惰性准备：本模块可能在 migrate() 之前被导入（index.ts 的 import 链先于 main() 执行），
// 模块加载即 prepare 会在 skill_sources 表建立前崩溃。
const prepared = new Map<string, Statement>();
function stmt(sql: string): Statement {
  let s = prepared.get(sql);
  if (!s) {
    s = db.prepare(sql);
    prepared.set(sql, s);
  }
  return s;
}

const SQL_UPSERT_SOURCE = `
  INSERT INTO skill_sources (name, source, kind, revision, synced_at)
  VALUES (@name, @source, @kind, @revision, @syncedAt)
  ON CONFLICT(name) DO UPDATE SET
    source = excluded.source, kind = excluded.kind,
    revision = excluded.revision, synced_at = excluded.synced_at
`;
const SQL_SELECT_SOURCE = "SELECT name, source, kind, revision, synced_at FROM skill_sources WHERE name = ?";
const SQL_SELECT_SIBLINGS = "SELECT name, source, kind, revision, synced_at FROM skill_sources WHERE source = ?";
const SQL_DELETE_SOURCE = "DELETE FROM skill_sources WHERE name = ?";

function rowToInfo(row: { name: string; source: string; kind: string; revision: string; synced_at: string }): SkillSourceRow {
  return { name: row.name, source: row.source, kind: row.kind as SkillSourceKind, revision: row.revision, syncedAt: row.synced_at };
}

export function getSourceInfo(name: string): SkillSourceRow | undefined {
  const row = stmt(SQL_SELECT_SOURCE).get(name) as Parameters<typeof rowToInfo>[0] | undefined;
  return row ? rowToInfo(row) : undefined;
}

/** 删除技能时同步清掉来源登记（供删除路由调用，让「删了再装」回到干净状态）。 */
export function removeSkillSource(name: string): void {
  stmt(SQL_DELETE_SOURCE).run(name);
}

/** 技能名取自 frontmatter name，其次目录名/文件名；不合法字符归一为中划线。 */
function toSkillName(raw: string): string {
  const cleaned = raw
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return isValidSkillName(cleaned) ? cleaned : `skill-${uuid().slice(0, 8)}`;
}

/** 定位仓库内置技能目录；优先环境变量，其次按 cwd 与模块位置探测（与 packages.ts 同套路）。 */
function findCatalogRoot(cwd: string = process.cwd()): string | undefined {
  const candidates: Array<string | undefined> = [
    process.env.SKILLS_CATALOG_DIR,
    path.resolve(cwd, "skills-catalog"),
    path.resolve(cwd, "..", "..", "skills-catalog"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills-catalog"),
  ];
  return candidates.filter((p): p is string => !!p).find((p) => fs.existsSync(path.join(p, ".")));
}

/** 内置技能目录清单（供「技能市场」展示与一键安装）。 */
export function listBuiltinSkills(): CatalogSkill[] {
  const root = findCatalogRoot();
  if (!root) return [];
  const out: CatalogSkill[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const parsed = parseSkillMd(fs.readFileSync(file, "utf8"));
    out.push({ id: entry.name, description: parsed.description, installed: skillExists(entry.name) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

interface SkillUnit {
  name: string;
  description: string;
  /** 目录型技能：整目录拷贝（保留 SKILL.md 之外的配套文件）。 */
  dir?: string;
  /** 单文件型技能：直接写 SKILL.md。 */
  content?: string;
  /** 来源 SKILL.md 声明的扩展 frontmatter（argument-hint/alias/metadata/allowed-tools），落盘时保留。 */
  extras?: SkillWriteExtras;
}

/** 从解析结果提取扩展 frontmatter（无值字段不落盘）。 */
function extrasOf(parsed: ReturnType<typeof parseSkillMd>): SkillWriteExtras {
  return {
    argumentHint: parsed.argumentHint,
    alias: parsed.alias,
    metadata: parsed.metadata,
    allowedTools: parsed.allowedTools,
  };
}

/** 递归收集含 SKILL.md 的目录（根目录命中即停，不再向内层找）；跳过 .git 与 node_modules。 */
function collectSkillDirs(dir: string, depth: number, out: string[]): void {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    out.push(dir);
    return;
  }
  if (depth >= 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    collectSkillDirs(path.join(dir, entry.name), depth + 1, out);
  }
}

/** 目录 → 技能单元：名字取 frontmatter name，缺省用目录名。 */
function unitFromDir(dir: string): SkillUnit {
  const parsed = parseSkillMd(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  return {
    name: toSkillName(parsed.name || path.basename(dir)),
    description: parsed.description,
    dir,
    extras: extrasOf(parsed),
  };
}

function unitsFromRoot(root: string): SkillUnit[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (!/\.md$/i.test(root)) throw new Error("本地技能文件必须是 .md");
    const parsed = parseSkillMd(fs.readFileSync(root, "utf8"));
    return [
      {
        name: toSkillName(parsed.name || path.basename(root, ".md")),
        description: parsed.description,
        content: parsed.body,
        extras: extrasOf(parsed),
      },
    ];
  }
  const dirs: string[] = [];
  collectSkillDirs(root, 0, dirs);
  if (!dirs.length) throw new Error("目录中未找到 SKILL.md（支持根目录单个技能或子目录合集）");
  return dirs.map(unitFromDir);
}

/** git 浅克隆到临时目录，返回 { 删除临时目录的回调, 技能单元, 修订号 }。 */
function cloneToTemp(url: string): { cleanup: () => void; units: SkillUnit[]; revision: string } {
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skill-"));
  } catch {
    throw new Error("创建临时目录失败，无法克隆 git 仓库");
  }
  try {
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", url, tmp], { timeout: GIT_TIMEOUT_MS, stdio: "pipe" });
    let revision = "";
    try {
      revision = execFileSync("git", ["-C", tmp, "rev-parse", "--short", "HEAD"], { timeout: 10_000 }).toString().trim();
    } catch {
      // 拿不到修订号不阻塞安装
    }
    const dirs: string[] = [];
    collectSkillDirs(tmp, 0, dirs);
    if (!dirs.length) throw new Error("仓库中未找到 SKILL.md，无法作为技能来源安装");
    return { cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }), units: dirs.map(unitFromDir), revision };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("未找到 git 命令，无法从 git 仓库安装技能");
    }
    throw err instanceof Error && err.message.includes("SKILL.md")
      ? err
      : new Error(`git 克隆失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

async function fetchMarkdown(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "office-platform-skill-installer" },
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type)) throw new Error("URL 返回的是网页而非 Markdown 技能文件");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SKILL_FILE) throw new Error("技能文件过大（超过 2MB）");
  return buf.toString("utf8");
}

/** 来源识别：git: 前缀 / .git 结尾 → git；http(s) → 先按 Markdown 直链、失败退回 git；本地存在路径 → local；内置目录命中 → builtin。 */
async function resolveUnits(raw: string): Promise<{ kind: SkillSourceKind; normalized: string; revision: string; units: SkillUnit[]; cleanup?: () => void }> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("请填写技能来源");

  if (trimmed.startsWith("git:")) {
    const url = normalizeGitUrl(trimmed);
    const cloned = cloneToTemp(url);
    return { kind: "git", normalized: trimmed, revision: cloned.revision, units: cloned.units, cleanup: cloned.cleanup };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (/\.git$/i.test(trimmed)) {
      const cloned = cloneToTemp(trimmed);
      return { kind: "git", normalized: trimmed, revision: cloned.revision, units: cloned.units, cleanup: cloned.cleanup };
    }
    try {
      const text = await fetchMarkdown(trimmed);
      const parsed = parseSkillMd(text);
      return {
        kind: "url",
        normalized: trimmed,
        // 内容指纹作为修订基线：后续漂移检测对比同源最新内容哈希
        revision: sha12(text),
        units: [
          {
            name: toSkillName(
              parsed.name || decodeURIComponent(new URL(trimmed).pathname.split("/").pop() || "skill").replace(/\.md$/i, "")
            ),
            description: parsed.description,
            content: parsed.body,
            extras: extrasOf(parsed),
          },
        ],
      };
    } catch (err) {
      // 可能是仓库主页而非直链：退回 git 克隆
      if (!/\.(md|markdown|txt)(\?|$)/i.test(trimmed)) {
        const cloned = cloneToTemp(trimmed);
        return { kind: "git", normalized: trimmed, revision: cloned.revision, units: cloned.units, cleanup: cloned.cleanup };
      }
      throw err;
    }
  }

  const localCandidate = path.resolve(trimmed);
  if (fs.existsSync(localCandidate)) {
    return { kind: "local", normalized: localCandidate, revision: hashDir(localCandidate), units: unitsFromRoot(localCandidate) };
  }

  // 登记过的内置来源带 builtin: 前缀（如同步时重拉），剥掉后按目录名查内置目录
  const builtinId = trimmed.startsWith("builtin:") ? trimmed.slice("builtin:".length).trim() : trimmed;
  const catalogRoot = findCatalogRoot();
  if (builtinId && catalogRoot && fs.existsSync(path.join(catalogRoot, builtinId, "SKILL.md"))) {
    const dir = path.join(catalogRoot, builtinId);
    return { kind: "builtin", normalized: `builtin:${builtinId}`, revision: hashDir(dir), units: [unitFromDir(dir)] };
  }

  throw new Error("无法识别的技能来源：请填写内置技能名、https:// 直链/仓库地址、git: 仓库地址或本机路径");
}

function commitUnit(unit: SkillUnit, source: string, kind: SkillSourceKind, revision: string, overwrite: boolean): "added" | "updated" {
  const existed = skillExists(unit.name);
  if (existed && !overwrite) throw new Error(`技能「${unit.name}」已存在，如需覆盖请选择覆盖安装`);
  if (existed) deleteSkill(unit.name);
  if (unit.dir) {
    fs.mkdirSync(path.join(SKILLS_DIR, unit.name), { recursive: true });
    copyDir(unit.dir, path.join(SKILLS_DIR, unit.name));
    // 目录拷贝后用规范 frontmatter 重写 SKILL.md（补 name 字段、统一格式、保留扩展字段）
    const parsed = parseSkillMd(fs.readFileSync(path.join(unit.dir, "SKILL.md"), "utf8"));
    writeSkillFile(unit.name, parsed.description, parsed.body, unit.extras ?? extrasOf(parsed));
  } else {
    writeSkillFile(unit.name, unit.description, unit.content ?? "", unit.extras);
  }
  stmt(SQL_UPSERT_SOURCE).run({ name: unit.name, source, kind, revision, syncedAt: now() });
  return existed ? "updated" : "added";
}

function copyDir(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDir(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

/** git:github.com/u/r → https://github.com/u/r；scp 风格（git@host:path）与已带协议的原样保留。 */
function normalizeGitUrl(raw: string): string {
  let url = raw.startsWith("git:") ? raw.slice(4).trim() : raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^[\w-]+@[\w.-]+:/.test(url)) url = `https://${url}`;
  return url;
}

/** 目录内容指纹：相对路径 + 文件 sha256 排序后整体哈希（local/builtin 漂移检测用）。 */
function hashDir(dir: string): string {
  const items: string[] = [];
  const walk = (d: string, rel: string): void => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = path.join(d, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile()) {
        items.push(`${relPath}:${createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`);
      }
    }
  };
  try {
    walk(dir, "");
  } catch {
    return "";
  }
  return createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 12);
}

function sha12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// ---------- 技能演进闭环（P2-4）：漂移检测（「有更新」）与批量同步 ----------

export interface SkillUpdateInfo {
  source: string;
  kind: SkillSourceKind;
  /** 该来源下的本地技能名 */
  skills: string[];
  hasUpdate: boolean;
  /** 源端最新修订/指纹（git 为 short sha，url/local/builtin 为内容指纹） */
  latest: string;
  /** 无法判断的原因（网络失败、git 缺失等），为空表示判断成功 */
  note: string;
}

/** 取远端/源头的最新指纹。baseline 为空串表示此前未建立基线（旧数据安装时未记指纹）。 */
async function latestFingerprint(kind: SkillSourceKind, source: string): Promise<string> {
  if (kind === "git") {
    const out = execFileSync("git", ["ls-remote", normalizeGitUrl(source), "HEAD"], {
      timeout: 20_000,
      stdio: "pipe",
    }).toString();
    const sha = out.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("git ls-remote 未返回有效提交号");
    return sha;
  }
  if (kind === "url") return sha12(await fetchMarkdown(source));
  if (kind === "local") return hashDir(source);
  if (kind === "builtin") {
    const id = source.startsWith("builtin:") ? source.slice("builtin:".length).trim() : source;
    const root = findCatalogRoot();
    if (!root || !id || !fs.existsSync(path.join(root, id))) return "";
    return hashDir(path.join(root, id));
  }
  return "";
}

/**
 * 按来源分组检测漂移：源端指纹与登记的 revision 不一致即「有更新」。
 * revision 为空（本功能上线前安装的旧技能）视为基线未知——提示先同步，不误报有更新。
 */
export async function listSkillUpdates(): Promise<SkillUpdateInfo[]> {
  const rows = stmt("SELECT name, source, kind, revision, synced_at FROM skill_sources ORDER BY name").all() as Array<
    Parameters<typeof rowToInfo>[0]
  >;
  const groups = new Map<string, { kind: SkillSourceKind; skills: string[]; revision: string }>();
  for (const r of rows.map(rowToInfo)) {
    const g = groups.get(r.source);
    if (g) g.skills.push(r.name);
    else groups.set(r.source, { kind: r.kind, skills: [r.name], revision: r.revision });
  }
  const out: SkillUpdateInfo[] = [];
  await Promise.allSettled(
    [...groups.entries()].map(async ([source, g]) => {
      const base: SkillUpdateInfo = { source, kind: g.kind, skills: g.skills, hasUpdate: false, latest: "", note: "" };
      try {
        const latest = await latestFingerprint(g.kind, source);
        if (!latest) {
          out.push({ ...base, note: "来源不可读，无法判断是否有更新" });
          return;
        }
        if (g.kind === "git") {
          const stored = g.revision;
          out.push({ ...base, latest: latest.slice(0, 7), hasUpdate: !!stored && !latest.startsWith(stored) });
        } else {
          if (!g.revision) {
            out.push({ ...base, latest, note: "未建立基线（同步一次后开始检测更新）" });
            return;
          }
          out.push({ ...base, latest, hasUpdate: latest !== g.revision });
        }
      } catch (err) {
        out.push({ ...base, note: `检测失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
      }
    })
  );
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

/** 批量同步全部有登记的来源（每个来源一次 syncSkill）；单个失败不影响其余。 */
export async function syncAllSkills(): Promise<{ sources: string[]; failed: Array<{ source: string; error: string }> }> {
  const rows = stmt("SELECT DISTINCT source FROM skill_sources ORDER BY source").all() as Array<{ source: string }>;
  const sources: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  for (const { source } of rows) {
    const first = (
      stmt("SELECT name FROM skill_sources WHERE source = ? ORDER BY name LIMIT 1").get(source) as
        | { name: string }
        | undefined
    )?.name;
    if (!first) continue;
    try {
      await syncSkill(first);
      sources.push(source);
    } catch (err) {
      failed.push({ source, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { sources, failed };
}

/** 从来源安装技能（可多技能）；默认不覆盖同名技能。 */
export async function installSkillFromSource(raw: string, opts: { overwrite?: boolean } = {}): Promise<InstallOutcome> {
  const resolved = await resolveUnits(raw);
  try {
    if (resolved.units.length > MAX_SKILLS_PER_SOURCE) {
      throw new Error(`来源包含 ${resolved.units.length} 个技能，超过单次安装上限（${MAX_SKILLS_PER_SOURCE}）`);
    }
    const added: string[] = [];
    const updated: string[] = [];
    for (const unit of resolved.units) {
      const status = commitUnit(unit, resolved.normalized, resolved.kind, resolved.revision, opts.overwrite === true);
      (status === "added" ? added : updated).push(unit.name);
    }
    return { names: [...added, ...updated], added, updated, removed: [], kind: resolved.kind, source: resolved.normalized, revision: resolved.revision };
  } finally {
    resolved.cleanup?.();
  }
}

/**
 * 同步：按登记的来源重拉该来源下全部技能——源里仍在的一律覆盖刷新，
 * 源里已删除的本地随之移除，源里新增的自动补装。
 */
export async function syncSkill(name: string): Promise<InstallOutcome> {
  const row = getSourceInfo(name);
  if (!row) throw new Error("该技能不是通过安装获得的（或来源记录已清除），无法同步");

  const resolved = await resolveUnits(row.source);
  try {
    const added: string[] = [];
    const updated: string[] = [];
    for (const unit of resolved.units) {
      const status = commitUnit(unit, row.source, resolved.kind, resolved.revision, true);
      (status === "added" ? added : updated).push(unit.name);
    }
    const removed: string[] = [];
    for (const sibling of (stmt(SQL_SELECT_SIBLINGS).all(row.source) as Array<Parameters<typeof rowToInfo>[0]>).map(rowToInfo)) {
      if (!resolved.units.some((u) => u.name === sibling.name)) {
        deleteSkill(sibling.name);
        stmt(SQL_DELETE_SOURCE).run(sibling.name);
        removed.push(sibling.name);
      }
    }
    return { names: [...added, ...updated], added, updated, removed, kind: resolved.kind, source: resolved.normalized, revision: resolved.revision };
  } finally {
    resolved.cleanup?.();
  }
}
