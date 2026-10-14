import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
];

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

/** 把声明合并进 settings.json 的 packages 数组；文件缺失/损坏时重建，其余字段保留。 */
export function declarePiPackage(settingsPath: string, source: string): void {
  let settings: { packages?: Array<Record<string, unknown>>; [key: string]: unknown } = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof settings;
    } catch {
      settings = {};
    }
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (!packages.some((p) => p && p.source === source)) {
    packages.push({ source });
  }
  settings.packages = packages;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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
  return { installed, skipped };
}
