import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { currentUser, requireAdmin } from "../auth.js";
import { config, paths } from "../config.js";
import { db } from "../db.js";
import { syncDirIfChanged } from "../packages.js";
import { resolveInsideWorkspace } from "../workspace-tree.js";
import { isZip, unzipTo } from "../zip-pack.js";
import {
  MANIFEST_NAME,
  SKIN_ID_RE,
  SkinConflictError,
  installFromDir,
  locatePackRoot,
  packDir,
  packZipBuffer,
  readBuiltinIds,
  readManifest,
  sendZip,
  writeBuiltinIds,
  type SkinManifest,
} from "../skins-core.js";

/**
 * 桌面皮肤包：{DATA_DIR}/skins/<id>/ 下一个 skin.json + skin.css（+ assets/）。
 * 目录即真相，无数据库表。内置包随应用分发（仓库 skin-packs/ → 打包资源 →
 * SKIN_PACKS_DIR），启动时差异同步进来并登记在 builtins.json，删除/覆盖受保护。
 * 皮肤只含 CSS 与资源，不含可执行代码——取舍见 docs/adr/0011-skin-packs-css-only.md。
 * 全员开放的市场入口见 plugins/skin-market.ts（平台插件，可启停）。
 */

const MIME_BY_EXT: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** 把 SKIN_PACKS_DIR 下的内置皮肤差异同步进数据目录。包源缺失（纯服务端部署）时静默跳过。 */
export function syncBuiltinSkinPacks(): void {
  const sourceRoot = process.env.SKIN_PACKS_DIR;
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const synced = readBuiltinIds();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceRoot, entry.name);
    if (!fs.existsSync(path.join(source, MANIFEST_NAME))) continue;
    try {
      // 源目录名与清单 id 不一致的包不下发：落盘后 id 对不上会误导用户
      if (readManifest(source).id !== entry.name) {
        console.warn(`[skins] 内置皮肤目录名与 id 不一致，跳过：${entry.name}`);
        continue;
      }
      syncDirIfChanged(source, packDir(entry.name), MANIFEST_NAME);
      synced.add(entry.name);
    } catch (err) {
      console.warn(`[skins] 内置皮肤同步失败：${entry.name}`, err);
    }
  }
  // 内置源里已消失的包不再标记内置（数据目录的副本保留，可正常删除）
  for (const id of synced) {
    if (!fs.existsSync(path.join(sourceRoot, id, MANIFEST_NAME))) synced.delete(id);
  }
  writeBuiltinIds(synced);
}

export function registerSkinRoutes(app: FastifyInstance): void {
  // 皮肤清单。broken 单列，坏包不进 skins 但可诊断。
  app.get("/skins", { onRequest: [app.authenticate] }, async () => {
    const skins: Array<SkinManifest & { builtin: boolean }> = [];
    const broken: Array<{ dir: string; error: string }> = [];
    const builtins = readBuiltinIds();
    if (fs.existsSync(paths.skins)) {
      for (const entry of fs.readdirSync(paths.skins, { withFileTypes: true })) {
        if (!entry.isDirectory() || !fs.existsSync(path.join(paths.skins, entry.name, MANIFEST_NAME))) continue;
        try {
          const manifest = readManifest(packDir(entry.name));
          // 目录名与清单 id 不一致的包视为坏包（数据目录里的目录名是 id 的唯一事实）
          if (manifest.id !== entry.name) throw new Error(`skin.json 的 id（${manifest.id}）必须与目录名（${entry.name}）一致`);
          skins.push({ ...manifest, builtin: builtins.has(entry.name) });
        } catch (err) {
          broken.push({ dir: entry.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    skins.sort((a, b) => (a.builtin === b.builtin ? a.id.localeCompare(b.id) : a.builtin ? -1 : 1));
    // 多用户服务端部署不暴露数据目录绝对路径（评审 P1；桌面端「打开皮肤目录」需要它）
    return { skinDir: config.multiUser ? null : paths.skins, skins, broken };
  });

  // 皮肤内文件（skin.css / assets/*）。支持 ?token=：CSS 里的 url() 请求不带 Authorization 头。
  app.get("/skins/:id/file", async (req, reply) => {
    const header = req.headers.authorization;
    const queryToken = (req.query as { token?: string }).token;
    if (!header && queryToken) req.headers.authorization = `Bearer ${queryToken}`;
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { id } = req.params as { id: string };
    if (!SKIN_ID_RE.test(id)) return reply.code(400).send({ error: "skin id 非法" });
    const root = packDir(id);
    const rel = ((req.query as { path?: string }).path ?? "").trim().replace(/\\/g, "/");
    if (!rel) return reply.code(400).send({ error: "缺少 path" });
    if (rel.includes("\0")) return reply.code(400).send({ error: "路径非法" });
    const parts = rel.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
      return reply.code(400).send({ error: "路径非法" });
    }
    const abs = path.resolve(root, ...parts);
    const relToRoot = path.relative(root, abs);
    if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      return reply.code(400).send({ error: "路径非法" });
    }
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: "文件不存在" });
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || stat.isSymbolicLink()) return reply.code(400).send({ error: "不是可下发的文件" });
    const ctype = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    // 皮肤文件全部是渲染层要加载的子资源（样式/图片/字体），一律 inline
    reply.header("content-type", ctype);
    reply.header("cache-control", "no-cache");
    return reply.send(fs.createReadStream(abs));
  });

  // 上传安装皮肤包 zip（skin.json 在根部或唯一一级目录内）。与内置包 id 冲突时拒绝。
  // 多用户服务端部署（SERVER_MULTI_USER=1）下皮肤是全局外观资源，写操作限管理员——
  // 否则任一成员可改所有人的 UI（评审 P1：CSS 可做界面遮挡）；全员开放入口走皮肤市场插件
  app.post("/skins", {
    onRequest: [app.authenticate],
    preHandler: config.multiUser ? requireAdmin : undefined,
  }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "缺少皮肤包文件" });
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);
    if (!isZip(buf)) return reply.code(400).send({ error: "请上传 zip 皮肤包（需包含 skin.json）" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-zip-"));
    try {
      unzipTo(buf, tmp);
      const manifest = installFromDir(locatePackRoot(tmp));
      return reply.code(201).send({ ...manifest, builtin: false });
    } catch (err) {
      if (err instanceof SkinConflictError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 删除用户皮肤包。内置包受保护；多用户部署限管理员（同上传）。
  app.delete("/skins/:id", {
    onRequest: [app.authenticate],
    preHandler: config.multiUser ? requireAdmin : undefined,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SKIN_ID_RE.test(id)) return reply.code(400).send({ error: "skin id 非法" });
    if (readBuiltinIds().has(id)) return reply.code(409).send({ error: "内置皮肤不能删除" });
    const dir = packDir(id);
    if (!fs.existsSync(path.join(dir, MANIFEST_NAME))) return reply.code(404).send({ error: "皮肤不存在" });
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  });

  // 从任务工作区安装皮肤包（AI 创造流程）：任务只能写自己的工作区（workspace boundary
  // 挡住了 DATA_DIR），把成品落进皮肤目录由这个受控接口完成。多用户部署限管理员（同上传）。
  app.post("/skins/install-from-workspace", {
    onRequest: [app.authenticate],
    preHandler: config.multiUser ? requireAdmin : undefined,
  }, async (req, reply) => {
    const body = req.body as { taskId?: string; path?: string };
    const taskId = String(body.taskId ?? "").trim();
    const rel = String(body.path ?? "skin-pack").trim().replace(/\\/g, "/");
    if (!taskId) return reply.code(400).send({ error: "taskId is required" });
    const task = db.prepare("SELECT id, user_id, workspace_path FROM tasks WHERE id = ?").get(taskId) as
      | { id: string; user_id: string; workspace_path: string }
      | undefined;
    if (!task) return reply.code(404).send({ error: "task not found" });
    const user = currentUser(req);
    if (user.role !== "admin" && task.user_id !== user.id) {
      return reply.code(403).send({ error: "无权访问该任务" });
    }
    const packRoot = resolveInsideWorkspace(task.workspace_path, rel);
    if (!packRoot || !fs.existsSync(path.join(packRoot, MANIFEST_NAME))) {
      return reply.code(404).send({ error: `任务工作区里没找到 ${rel}/${MANIFEST_NAME}。等创造任务完成后再试` });
    }
    try {
      const manifest = installFromDir(packRoot);
      return reply.code(201).send({ ...manifest, builtin: false });
    } catch (err) {
      if (err instanceof SkinConflictError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 导出皮肤包 zip：分享给其他用户/服务器，对方经「上传 zip」直接安装。
  app.get("/skins/:id/export", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SKIN_ID_RE.test(id)) return reply.code(400).send({ error: "skin id 非法" });
    const zip = packZipBuffer(id);
    if (!zip) return reply.code(404).send({ error: "皮肤不存在" });
    return sendZip(reply, id, zip) as void;
  });
}
