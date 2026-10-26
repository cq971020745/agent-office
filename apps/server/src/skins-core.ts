import fs from "node:fs";
import path from "node:path";
import { copyDirSync } from "./packages.js";
import { paths } from "./config.js";
import { zipFiles } from "./zip-pack.js";

/**
 * 皮肤包核心（routes/skins.ts 与 plugins/skin-market.ts 共用）：
 * 清单解析、目录即真相的安装、zip 打包。皮肤只含 CSS 与资源，取舍见
 * docs/adr/0011-skin-packs-css-only.md。
 */

export interface SkinManifest {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  /** 声明适配的外观档位；缺省视为三档通用。 */
  modes?: string[];
}

export const SKIN_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const MANIFEST_NAME = "skin.json";
export const BUILTINS_FILE = "builtins.json";
const VALID_MODES = new Set(["light", "dark", "glass"]);

export function packDir(id: string): string {
  return path.join(paths.skins, id);
}

export function readBuiltinIds(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(paths.skins, BUILTINS_FILE), "utf8")) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeBuiltinIds(ids: Iterable<string>): void {
  fs.writeFileSync(path.join(paths.skins, BUILTINS_FILE), `${JSON.stringify([...ids], null, 2)}\n`, "utf8");
}

/** 解析并校验皮肤包清单字段；id 非法或缺 name 时抛错。不校验 id 与目录名的关系。 */
export function readManifest(dir: string): SkinManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8")) as Partial<SkinManifest>;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!SKIN_ID_RE.test(id)) throw new Error(`skin.json 的 id 非法（需匹配 ${SKIN_ID_RE.source}）：${id || "(缺失)"}`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("skin.json 缺少 name");
  const modes = Array.isArray(raw.modes)
    ? raw.modes.filter((m): m is string => typeof m === "string" && VALID_MODES.has(m))
    : undefined;
  return {
    id,
    name: raw.name.trim(),
    version: typeof raw.version === "string" ? raw.version : undefined,
    author: typeof raw.author === "string" ? raw.author : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    modes: modes && modes.length ? modes : undefined,
  };
}

/** zip 解压后定位皮肤包根：skin.json 在根部，或唯一一级子目录里。 */
export function locatePackRoot(unpacked: string): string {
  if (fs.existsSync(path.join(unpacked, MANIFEST_NAME))) return unpacked;
  const children = fs.readdirSync(unpacked, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (children.length === 1 && fs.existsSync(path.join(unpacked, children[0]!.name, MANIFEST_NAME))) {
    return path.join(unpacked, children[0]!.name);
  }
  throw new Error("皮肤包缺少 skin.json（放在 zip 根或唯一一级目录内）");
}

/** 内置包冲突专用错误（路由层转 409）。 */
export class SkinConflictError extends Error {}

/** 校验并把一个皮肤包目录安装进皮肤目录（zip 上传 / 任务工作区 / 市场下载共用）。 */
export function installFromDir(packRoot: string): SkinManifest {
  const manifest = readManifest(packRoot);
  if (readBuiltinIds().has(manifest.id)) throw new SkinConflictError(`「${manifest.id}」是内置皮肤，不能被覆盖安装`);
  const dest = packDir(manifest.id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyDirSync(packRoot, dest);
  return manifest;
}

/** 把皮肤包打成 zip（导出分享 / 上传市场共用）。 */
export function packZipBuffer(id: string): Buffer | undefined {
  const dir = packDir(id);
  if (!fs.existsSync(path.join(dir, MANIFEST_NAME))) return undefined;
  const files: Array<{ name: string; data: Buffer }> = [];
  const walk = (relDir: string): void => {
    const absDir = relDir ? path.join(dir, relDir) : dir;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push({ name: rel, data: fs.readFileSync(path.join(absDir, entry.name)) });
    }
  };
  walk("");
  return zipFiles(files);
}

export function sendZip(reply: import("fastify").FastifyReply, id: string, zip: Buffer): unknown {
  reply.header("content-type", "application/zip");
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${id}.zip`)}`);
  return reply.send(zip);
}

/** 扫描皮肤目录，返回有效清单（坏包跳过）。 */
export function listSkinManifests(): Array<SkinManifest & { builtin: boolean }> {
  const out: Array<SkinManifest & { builtin: boolean }> = [];
  const builtins = readBuiltinIds();
  if (fs.existsSync(paths.skins)) {
    for (const entry of fs.readdirSync(paths.skins, { withFileTypes: true })) {
      if (!entry.isDirectory() || !fs.existsSync(path.join(paths.skins, entry.name, MANIFEST_NAME))) continue;
      try {
        const manifest = readManifest(packDir(entry.name));
        if (manifest.id !== entry.name) continue;
        out.push({ ...manifest, builtin: builtins.has(entry.name) });
      } catch {
        // 坏包不进列表，由 /skins 的 broken 单独诊断
      }
    }
  }
  return out;
}
