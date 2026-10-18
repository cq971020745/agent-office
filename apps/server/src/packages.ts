import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { paths } from "./config.js";

/**
 * pi 插件包安装：把仓库内的 pi-packages/* 同步进平台数据目录
 * `{agentDir}/packages/<dirName>/`，并把声明写入 `{agentDir}/settings.json` 的
 * `packages` 数组——等价于 `pi install ./local-package` 产生的全局声明。
 *
 * 声明用相对路径（pi 相对 settings.json 所在目录解析，见 pi docs/packages.md），
 * 数据目录整体迁移时依然有效；同步是内容差异驱动的，重复调用幂等。
 */

/** 随平台分发的内置插件包：id 用于日志，dirName 同时是仓库目录名与安装目录名。 */
const BUILTIN_PACKAGES: ReadonlyArray<{ id: string; dirName: string }> = [
  { id: "office-suite", dirName: "office-suite" },
  { id: "document-ocr", dirName: "document-ocr" },
];

/**
 * 外部 Pi 包。版本钉死，兼容当前 Node 22。
 * 对外客户端只认这里声明的包（写入平台 agentDir），不认操作者本机 ~/.pi。
 * pi-quiver 只启用 doc_to_md，避免把它的 fetch、Slack、会话装饰一并加载。
 * pi-web-access 提供 web_search / fetch_content / get_search_content / source_check。
 * pi-smart-context：智能压缩工具 + 阈值提醒（deferred compact_context，需 +tool_search）。
 * 终端 TUI 专用包（statusbar / sidebar / pi-git-ui）不进此列表——桌面已有等价 UI。
 */
const EXTERNAL_PACKAGES: readonly PiPackageDeclaration[] = [
  {
    source: "npm:pi-quiver@6.13.2",
    extensions: ["extensions/doc_to_md.ts"],
    skills: [],
    prompts: [],
    themes: [],
  },
  { source: "npm:pi-web-access@0.42.0" },
  { source: "npm:@zhushanwen/pi-smart-context@0.3.9" },
];

export interface PiPackageDeclaration {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

/** 定位仓库内的包模板目录；优先环境变量，其次按 cwd 与模块位置探测。 */
export function findPackageSourceDir(dirName: string, cwd: string = process.cwd()): string | undefined {
  const candidates: Array<string | undefined> = [
    process.env.PI_PACKAGES_DIR ? path.join(process.env.PI_PACKAGES_DIR, dirName) : undefined,
    path.resolve(cwd, "pi-packages", dirName),
    path.resolve(cwd, "..", "..", "pi-packages", dirName),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "pi-packages", dirName),
  ];
  return candidates
    .filter((p): p is string => !!p)
    .find((p) => fs.existsSync(path.join(p, "package.json")));
}

/** 递归列出目录内全部文件，键为 / 分隔的相对路径（跨平台一致的 diff 依据）。 */
function listFiles(root: string, prefix = ""): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of listFiles(abs, rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(rel, fs.readFileSync(abs));
    }
  }
  return out;
}

/** 目标目录与源内容完全一致时返回 true（缺文件、多文件或内容不同都算不同步）。 */
export function isPackageSynced(source: string, dest: string): boolean {
  if (!fs.existsSync(path.join(dest, "package.json"))) return false;
  const src = listFiles(source);
  const dst = listFiles(dest);
  if (src.size !== dst.size) return false;
  for (const [rel, content] of src) {
    const existing = dst.get(rel);
    if (!existing || !existing.equals(content)) return false;
  }
  return true;
}

function declarationRecord(spec: string | PiPackageDeclaration): Record<string, unknown> {
  if (typeof spec === "string") return { source: spec };
  const record: Record<string, unknown> = { source: spec.source };
  if (spec.extensions) record.extensions = spec.extensions;
  if (spec.skills) record.skills = spec.skills;
  if (spec.prompts) record.prompts = spec.prompts;
  if (spec.themes) record.themes = spec.themes;
  return record;
}

/** 把声明合并进 settings.json 的 packages 数组；同 source 会更新过滤字段，其余字段保留。 */
export function declarePiPackage(settingsPath: string, spec: string | PiPackageDeclaration): void {
  let settings: { packages?: Array<Record<string, unknown>>; [key: string]: unknown } = {};
  let rawExisting = "";
  if (fs.existsSync(settingsPath)) {
    try {
      rawExisting = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(rawExisting) as typeof settings;
    } catch {
      settings = {};
    }
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const next = declarationRecord(spec);
  const existing = packages.find((pkg) => pkg && pkg.source === next.source);
  if (existing) Object.assign(existing, next);
  else packages.push(next);
  settings.packages = packages;
  const nextContent = `${JSON.stringify(settings, null, 2)}\n`;
  if (rawExisting === nextContent) return;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try {
    fs.writeFileSync(settingsPath, nextContent, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EBUSY") throw err;
  }
}

function copyDirSync(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDirSync(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

export interface InstallResult {
  installed: Array<{ id: string; dest: string; alreadySynced: boolean }>;
  skipped: string[];
}

/**
 * 同步所有内置插件包到 agentDir 并写入声明。包模板缺失（例如数据目录被单独
 * 部署、仓库结构变化）时跳过该包并记录，不视为错误。
 */
export function installPiPackages(cwd: string = process.cwd()): InstallResult {
  const installed: InstallResult["installed"] = [];
  const skipped: string[] = [];
  for (const { id, dirName } of BUILTIN_PACKAGES) {
    const source = findPackageSourceDir(dirName, cwd);
    if (!source) {
      skipped.push(id);
      continue;
    }
    const dest = path.join(paths.agentDir, "packages", dirName);
    const alreadySynced = isPackageSynced(source, dest);
    if (!alreadySynced) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      copyDirSync(source, dest);
    }
    declarePiPackage(path.join(paths.agentDir, "settings.json"), `./packages/${dirName}`);
    installed.push({ id, dest, alreadySynced });
  }
  const settingsPath = path.join(paths.agentDir, "settings.json");
  for (const spec of EXTERNAL_PACKAGES) declarePiPackage(settingsPath, spec);
  ensureToolSearchDefault();
  ensureSmartContextConfig();
  return { installed, skipped };
}

function offlineMode(): boolean {
  const value = process.env.PI_OFFLINE?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export interface ExternalInstallResult {
  ready: string[];
  failed: Array<{ source: string; error: string }>;
}

/**
 * 平台默认让网页工具首轮即可用。不覆盖用户已有的 web-search.json。
 * eager：跳过 web_enable，避免部分模型从不主动开启检索工具。
 */
export function ensureWebSearchConfig(): void {
  const configPath = path.join(paths.agentDir, "web-search.json");
  if (fs.existsSync(configPath)) return;
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ toolActivation: "eager" }, null, 2)}\n`, "utf8");
}

/** smart-context 配置：不覆盖已有文件；空 compactModel 表示 same-model 压缩。 */
export function ensureSmartContextConfig(): void {
  const configDir = path.join(paths.agentDir, "config");
  const configPath = path.join(configDir, "smart-context-ext-config.json");
  if (fs.existsSync(configPath)) return;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        enabled: true,
        compactModel: { type: "ref", ref: "" },
        reminderThresholds: [100000, 150000, 180000],
        excludedModels: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

/**
 * 增量开启 tool_search，供 deferred 工具（如 smart-context 的 compact_context）被检索激活。
 * 不覆盖用户已显式配置的 defaultTools。
 */
export function ensureToolSearchDefault(): void {
  const settingsPath = path.join(paths.agentDir, "settings.json");
  let settings: { defaultTools?: unknown; [key: string]: unknown } = {};
  let rawExisting = "";
  if (fs.existsSync(settingsPath)) {
    try {
      rawExisting = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(rawExisting) as typeof settings;
    } catch {
      settings = {};
    }
  }
  const tools = Array.isArray(settings.defaultTools)
    ? settings.defaultTools.filter((t): t is string => typeof t === "string")
    : [];
  if (tools.some((t) => t === "tool_search" || t === "+tool_search")) return;
  tools.push("+tool_search");
  settings.defaultTools = tools;
  const nextContent = `${JSON.stringify(settings, null, 2)}\n`;
  if (rawExisting === nextContent) return;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try {
    fs.writeFileSync(settingsPath, nextContent, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EBUSY") throw err;
  }
}

/**
 * 把已声明、尚未落地的 npm Pi 包装进 agentDir。声明本身由 installPiPackages 写入。
 * 离线或单个包失败时只记日志，其余包仍安装；任务可运行，缺的是对应工具。
 */
export async function ensureExternalPiPackages(cwd: string = process.cwd()): Promise<ExternalInstallResult> {
  const ready: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  ensureWebSearchConfig();
  ensureSmartContextConfig();
  ensureToolSearchDefault();
  if (offlineMode()) return { ready, failed };
  const settings = SettingsManager.create(cwd, paths.agentDir);
  const manager = new DefaultPackageManager({ cwd, agentDir: paths.agentDir, settingsManager: settings });
  for (const spec of EXTERNAL_PACKAGES) {
    try {
      if (!manager.getInstalledPath(spec.source, "user")) {
        await manager.install(spec.source);
      }
      ready.push(spec.source);
    } catch (err) {
      failed.push({
        source: spec.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ready, failed };
}
