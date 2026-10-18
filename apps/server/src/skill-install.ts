import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Statement } from "better-sqlite3";
import { db, now, uuid } from "./db.js";
import { isZip, unzipTo } from "./zip-pack.js";
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
 * 来源五种（skill_sources.kind）：
 * - builtin：随平台分发的内置技能目录（仓库 skills-catalog/<id>/SKILL.md），source 记为 builtin:<id>；
 * - url：单个 Markdown 文件的 http(s) 直链；
 * - git：git 仓库或 GitHub 主页；浅克隆失败时对 github.com 回退下载 zipball；
 * - local：本机文件（单个 .md）或目录（含 SKILL.md，或子目录各含 SKILL.md 的技能合集），含用户 ~/.agents/skills；
 * - zip：技能包压缩文件（本机 .zip、https://…zip，或上传的 zip）。
 *
 * skill_sources 表登记每个已安装技能的来源与修订，syncSkill 据此重拉同源的全部技能：
 * 源里被删掉的技能本地同步移除，新增的自动补装，已有的一律覆盖。
 */

export type SkillSourceKind = "builtin" | "url" | "git" | "local" | "zip";

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
const ZIP_TIMEOUT_MS = 60_000;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;

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

/** 把内置技能目录（含 references、脚本）覆盖安装到平台技能库。目录不存在时返回 false。 */
export function installCatalogSkillDir(id: string, destName: string): boolean {
  if (!isValidSkillName(id) || !isValidSkillName(destName)) return false;
  const root = findCatalogRoot();
  if (!root) return false;
  const from = path.join(root, id);
  if (!fs.existsSync(path.join(from, "SKILL.md"))) return false;
  const dest = path.join(SKILLS_DIR, destName);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyDir(from, dest);
  return true;
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

function execErrorDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; message?: string };
    if (e.code === "ENOENT") return "未找到 git 命令，无法从 git 仓库安装技能";
    const stderr = (typeof e.stderr === "string" ? e.stderr : e.stderr?.toString?.("utf8") ?? "").trim();
    if (stderr) {
      const lines = stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^cloning into/i.test(l));
      const fatal = lines.find((l) => /fatal:|error:/i.test(l));
      return fatal ?? lines[lines.length - 1] ?? stderr;
    }
    if (e.message) return e.message.split(/\r?\n/)[0] ?? e.message;
  }
  return String(err);
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" };
}

/** git 浅克隆到临时子目录（目标路径事先不存在，避免 Windows 上空目录克隆失败）。 */
function cloneToTemp(url: string): { cleanup: () => void; units: SkillUnit[]; revision: string } {
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skill-"));
  } catch {
    throw new Error("创建临时目录失败，无法克隆 git 仓库");
  }
  const dest = path.join(tmp, "src");
  try {
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", url, dest], {
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      windowsHide: true,
    });
    let revision = "";
    try {
      revision = execFileSync("git", ["-C", dest, "rev-parse", "--short", "HEAD"], {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv(),
        windowsHide: true,
      })
        .toString()
        .trim();
    } catch {
      // 拿不到修订号不阻塞安装
    }
    const units = unitsFromUnpackedRoot(dest);
    return { cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }), units, revision };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (err instanceof Error && err.message.includes("SKILL.md")) throw err;
    throw new Error(`git 克隆失败：${execErrorDetail(err)}`);
  }
}

function unitsFromUnpackedRoot(root: string, skillFilter?: string): SkillUnit[] {
  const units = unitsFromRoot(root);
  if (!skillFilter) return units;
  const hit = units.filter(
    (u) => u.name === skillFilter || (u.dir && path.basename(u.dir) === skillFilter)
  );
  if (!hit.length) throw new Error(`来源中未找到技能「${skillFilter}」`);
  return hit;
}

function unpackZipBuffer(buf: Buffer): { root: string; cleanup: () => void } {
  if (!isZip(buf)) throw new Error("不是有效的 zip 技能包");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skill-zip-"));
  try {
    unzipTo(buf, tmp);
    return { root: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`技能包解压失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function materializeZip(buf: Buffer, skillFilter?: string): { cleanup: () => void; units: SkillUnit[]; revision: string } {
  const unpacked = unpackZipBuffer(buf);
  try {
    if (fs.existsSync(path.join(unpacked.root, "pack.json"))) {
      unpacked.cleanup();
      throw new Error("这是专家包，请用「导入专家包」安装；技能包只需含 SKILL.md 的 zip");
    }
    const units = unitsFromUnpackedRoot(unpacked.root, skillFilter);
    return { cleanup: unpacked.cleanup, units, revision: sha12(buf.toString("binary")) };
  } catch (err) {
    if (String((err as Error).message ?? err).includes("专家包")) throw err;
    unpacked.cleanup();
    throw err;
  }
}

interface GithubRepoRef {
  owner: string;
  repo: string;
  skill?: string;
}

/** 识别 GitHub 仓库：主页、.git、git:github.com/…、owner/repo@skill。 */
function parseGithubRepo(raw: string): GithubRepoRef | undefined {
  const trimmed = raw.trim().replace(/^git:/, "");
  const full =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(trimmed) ??
    /^github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(trimmed);
  if (full) return { owner: full[1]!, repo: full[2]!.replace(/\.git$/i, "") };
  const short = /^([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?$/.exec(trimmed);
  if (short && !trimmed.includes("\\") && !/^[a-zA-Z]:/.test(trimmed)) {
    return { owner: short[1]!, repo: short[2]!.replace(/\.git$/i, ""), skill: short[3] };
  }
  return undefined;
}

async function fetchBinary(url: string, accept: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ZIP_TIMEOUT_MS),
    headers: { "user-agent": "office-platform-skill-installer", accept },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error("技能包过大（超过 20MB）");
  return buf;
}

async function fetchGithubZip(owner: string, repo: string): Promise<Buffer> {
  const urls = [
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`,
    `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
  ];
  let last = "";
  for (const url of urls) {
    try {
      const buf = await fetchBinary(url, "application/zip,application/octet-stream,*/*");
      if (isZip(buf)) return buf;
      last = "返回的不是 zip";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`无法下载 GitHub 技能包（${owner}/${repo}）：${last}`);
}

function filterUnits(units: SkillUnit[], skillFilter?: string, cleanup?: () => void): SkillUnit[] {
  if (!skillFilter) return units;
  const hit = units.filter((u) => u.name === skillFilter || (u.dir && path.basename(u.dir) === skillFilter));
  if (!hit.length) {
    cleanup?.();
    throw new Error(`来源中未找到技能「${skillFilter}」`);
  }
  return hit;
}

/** GitHub 优先走 zipball（不依赖本机 git、错误更明确），失败再浅克隆。 */
async function materializeGithub(
  url: string,
  skillFilter?: string
): Promise<{ cleanup: () => void; units: SkillUnit[]; revision: string }> {
  const gh = parseGithubRepo(url);
  const filter = skillFilter || gh?.skill;
  let zipErr = "";
  if (gh) {
    try {
      const buf = await fetchGithubZip(gh.owner, gh.repo);
      const loaded = materializeZip(buf, filter);
      // zipball 没有 git sha，空修订以免被误报「有更新」
      return { ...loaded, revision: "" };
    } catch (err) {
      zipErr = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    const cloned = cloneToTemp(url);
    return { ...cloned, units: filterUnits(cloned.units, filter, cloned.cleanup) };
  } catch (gitErr) {
    const gitMsg = gitErr instanceof Error ? gitErr.message : String(gitErr);
    throw new Error(zipErr ? `${gitMsg}；zip 下载也失败：${zipErr}` : gitMsg);
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

function isHomeAgentsAlias(raw: string): boolean {
  const t = raw.trim().replace(/\\/g, "/");
  return t === "agents:" || t === ".agents" || t === "~/.agents/skills" || t === "home:.agents";
}

/** 用户本机 `npx skills` / Codex 约定的个人技能目录。测试可经 AGENTS_SKILLS_DIR 改写。 */
export function homeAgentsSkillsDir(): string {
  const override = process.env.AGENTS_SKILLS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".agents", "skills");
}

function isZipPath(p: string): boolean {
  return /\.zip$/i.test(p.split(/[?#]/)[0] ?? p);
}

/** 来源识别：git: / GitHub / zip / Markdown 直链 / 本机路径 / ~/.agents / 内置目录。 */
async function resolveUnits(raw: string): Promise<{ kind: SkillSourceKind; normalized: string; revision: string; units: SkillUnit[]; cleanup?: () => void }> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("请填写技能来源");

  if (isHomeAgentsAlias(trimmed)) {
    const dir = homeAgentsSkillsDir();
    if (!fs.existsSync(dir)) throw new Error(`未找到用户技能目录：${dir}`);
    return { kind: "local", normalized: dir, revision: hashDir(dir), units: unitsFromRoot(dir) };
  }

  if (trimmed.startsWith("zip:")) {
    throw new Error("压缩包导入无法在线同步，请重新选择技能包安装");
  }

  if (trimmed.startsWith("git:")) {
    const url = normalizeGitUrl(trimmed);
    if (parseGithubRepo(url)) {
      const loaded = await materializeGithub(url);
      return { kind: "git", normalized: trimmed, revision: loaded.revision, units: loaded.units, cleanup: loaded.cleanup };
    }
    const cloned = cloneToTemp(url);
    return { kind: "git", normalized: trimmed, revision: cloned.revision, units: cloned.units, cleanup: cloned.cleanup };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (isZipPath(trimmed)) {
      const buf = await fetchBinary(trimmed, "application/zip,application/octet-stream,*/*");
      const loaded = materializeZip(buf);
      return { kind: "zip", normalized: trimmed, revision: loaded.revision, units: loaded.units, cleanup: loaded.cleanup };
    }
    if (parseGithubRepo(trimmed) || /\.git$/i.test(trimmed)) {
      const loaded = parseGithubRepo(trimmed) ? await materializeGithub(trimmed) : cloneToTemp(trimmed);
      return { kind: "git", normalized: trimmed, revision: loaded.revision, units: loaded.units, cleanup: loaded.cleanup };
    }
    try {
      const text = await fetchMarkdown(trimmed);
      const parsed = parseSkillMd(text);
      return {
        kind: "url",
        normalized: trimmed,
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
      if (!/\.(md|markdown|txt)(\?|$)/i.test(trimmed)) {
        const cloned = cloneToTemp(trimmed);
        return { kind: "git", normalized: trimmed, revision: cloned.revision, units: cloned.units, cleanup: cloned.cleanup };
      }
      throw err;
    }
  }

  const localCandidate = path.resolve(expandHome(trimmed));
  if (fs.existsSync(localCandidate)) {
    if (isZipPath(localCandidate)) {
      const loaded = materializeZip(fs.readFileSync(localCandidate));
      return {
        kind: "zip",
        normalized: localCandidate,
        revision: loaded.revision,
        units: loaded.units,
        cleanup: loaded.cleanup,
      };
    }
    return { kind: "local", normalized: localCandidate, revision: hashDir(localCandidate), units: unitsFromRoot(localCandidate) };
  }

  const builtinId = trimmed.startsWith("builtin:") ? trimmed.slice("builtin:".length).trim() : trimmed;
  const catalogRoot = findCatalogRoot();
  if (builtinId && catalogRoot && fs.existsSync(path.join(catalogRoot, builtinId, "SKILL.md"))) {
    const dir = path.join(catalogRoot, builtinId);
    return { kind: "builtin", normalized: `builtin:${builtinId}`, revision: hashDir(dir), units: [unitFromDir(dir)] };
  }

  const ghShort = parseGithubRepo(trimmed);
  if (ghShort) {
    const loaded = await materializeGithub(`https://github.com/${ghShort.owner}/${ghShort.repo}`, ghShort.skill);
    return {
      kind: "git",
      normalized: `https://github.com/${ghShort.owner}/${ghShort.repo}`,
      revision: loaded.revision,
      units: loaded.units,
      cleanup: loaded.cleanup,
    };
  }

  throw new Error("无法识别的技能来源：请填写内置技能名、https:// 直链/仓库地址、技能包 zip、git: 仓库地址、本机路径或 agents:（用户 ~/.agents/skills）");
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
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
  if (kind === "zip") return "";
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
        if (g.kind === "zip") {
          out.push({ ...base, note: "技能包导入后无法在线检测更新" });
          return;
        }
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

export interface HomeAgentsSyncResult {
  source: string;
  added: string[];
  updated: string[];
  removed: string[];
  skipped: string[];
  missing: boolean;
}

/**
 * 把用户本机 ~/.agents/skills 扫进平台技能库。
 * 已从该目录安装的覆盖刷新；源里消失的移除；与其它来源或手工创建重名的跳过。
 */
export function syncHomeAgentsSkills(): HomeAgentsSyncResult {
  const source = homeAgentsSkillsDir();
  const empty: HomeAgentsSyncResult = { source, added: [], updated: [], removed: [], skipped: [], missing: false };
  if (!fs.existsSync(source)) return { ...empty, missing: true };

  let units: SkillUnit[];
  try {
    units = unitsFromRoot(source);
  } catch (err) {
    throw new Error(`读取 ${source} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (units.length > MAX_SKILLS_PER_SOURCE) {
    throw new Error(`~/.agents/skills 包含 ${units.length} 个技能，超过单次安装上限（${MAX_SKILLS_PER_SOURCE}）`);
  }
  const revision = hashDir(source);
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const unit of units) {
    const info = getSourceInfo(unit.name);
    if (skillExists(unit.name) && (!info || info.source !== source)) {
      skipped.push(unit.name);
      continue;
    }
    const status = commitUnit(unit, source, "local", revision, true);
    (status === "added" ? added : updated).push(unit.name);
  }
  const removed: string[] = [];
  for (const sibling of (stmt(SQL_SELECT_SIBLINGS).all(source) as Array<Parameters<typeof rowToInfo>[0]>).map(rowToInfo)) {
    if (!units.some((u) => u.name === sibling.name)) {
      deleteSkill(sibling.name);
      stmt(SQL_DELETE_SOURCE).run(sibling.name);
      removed.push(sibling.name);
    }
  }
  return { source, added, updated, removed, skipped, missing: false };
}

/** 批量同步全部有登记的来源（每个来源一次 syncSkill）；开头先同步用户 ~/.agents/skills。 */
export async function syncAllSkills(): Promise<{
  sources: string[];
  failed: Array<{ source: string; error: string }>;
  home: HomeAgentsSyncResult;
}> {
  const failed: Array<{ source: string; error: string }> = [];
  let home: HomeAgentsSyncResult;
  try {
    home = syncHomeAgentsSkills();
  } catch (err) {
    home = {
      source: homeAgentsSkillsDir(),
      added: [],
      updated: [],
      removed: [],
      skipped: [],
      missing: false,
    };
    failed.push({ source: home.source, error: err instanceof Error ? err.message : String(err) });
  }
  const rows = stmt("SELECT DISTINCT source FROM skill_sources ORDER BY source").all() as Array<{ source: string }>;
  const sources: string[] = [];
  for (const { source } of rows) {
    if (source === home.source) {
      sources.push(source);
      continue;
    }
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
  return { sources, failed, home };
}

/** 从已读入的 zip 字节安装技能包（上传入口）。 */
export async function installSkillFromZipBuffer(
  buf: Buffer,
  opts: { overwrite?: boolean; label?: string } = {}
): Promise<InstallOutcome> {
  const loaded = materializeZip(buf);
  const label = opts.label?.trim() || "upload.zip";
  try {
    if (loaded.units.length > MAX_SKILLS_PER_SOURCE) {
      throw new Error(`技能包包含 ${loaded.units.length} 个技能，超过单次安装上限（${MAX_SKILLS_PER_SOURCE}）`);
    }
    const added: string[] = [];
    const updated: string[] = [];
    const source = `zip:${path.basename(label)}`;
    for (const unit of loaded.units) {
      const status = commitUnit(unit, source, "zip", loaded.revision, opts.overwrite === true);
      (status === "added" ? added : updated).push(unit.name);
    }
    return { names: [...added, ...updated], added, updated, removed: [], kind: "zip", source, revision: loaded.revision };
  } finally {
    loaded.cleanup();
  }
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
