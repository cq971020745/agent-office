import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isZip, unzipTo } from "../zip-pack.js";
import {
  MANIFEST_NAME,
  SKIN_ID_RE,
  SkinConflictError,
  installFromDir,
  listSkinManifests,
  locatePackRoot,
  packDir,
  packZipBuffer,
  readManifest,
  sendZip,
} from "../skins-core.js";
import type { PlatformPlugin } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * 皮肤市场（平台插件）：对全体登录用户开放的皮肤浏览/上传/下载，无需令牌或管理员。
 * 管理员可在「平台插件」页停用——停用后市场上传入口 503（皮肤本体与切换不受影响）。
 * 皮肤目录仍是 {DATA_DIR}/skins 单一事实，市场只是开放通道（取舍见 docs/adr/0011）。
 */

async function requireMarketPlugin(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  // 延迟动态导入：plugins/index.js 顶部 import 本插件，静态反向导入会触发 TDZ 循环
  const { platformPlugins } = await import("./index.js");
  // 必须返回 reply：只 send 不 return 时 handler 仍会执行，造成重复响应
  if (!platformPlugins.isPluginActive("skin-market")) {
    return reply.code(503).send({ error: "皮肤市场插件已停用" });
  }
}

export const skinMarketPlugin: PlatformPlugin = {
  manifest: {
    id: "skin-market",
    version: "0.1.0",
    name: "皮肤市场",
    description: "全体用户可浏览、上传、下载皮肤包；停用后市场上传入口关闭",
  },
  registerRoutes(app: FastifyInstance): void {
    // 市场列表 = 皮肤目录里的全部有效包（含内置），任何登录用户可见
    app.get("/skins-market", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async () => {
      return { skins: listSkinManifests() };
    });

    // 市场上传：任何登录用户，无令牌、无管理员门槛；同一 id 覆盖（内置保护仍在）
    app.post("/skins-market", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "缺少皮肤包文件" });
      const chunks: Buffer[] = [];
      for await (const chunk of file.file) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      if (!isZip(buf)) return reply.code(400).send({ error: "请上传 zip 皮肤包（需包含 skin.json）" });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-market-"));
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

    // 市场下载：zip 导出（配合「上传 zip」形成人人可传的分享环）
    app.get("/skins-market/:id/download", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!SKIN_ID_RE.test(id)) return reply.code(400).send({ error: "skin id 非法" });
      const zip = packZipBuffer(id);
      if (!zip) return reply.code(404).send({ error: "皮肤不存在" });
      return sendZip(reply, id, zip) as void;
    });

    // ---------- GitHub 市场：注册表托管在 GitHub 仓库（raw JSON），服务端代理拉取/安装
    //（浏览器直连 raw.githubusercontent.com 会撞 CSP/跨域，统一走本服务转发） ----------

    function httpUrl(raw: string | undefined): string | null {
      if (!raw) return null;
      try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
      } catch {
        return null;
      }
    }

    app.get("/skins-market/github", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const registry = httpUrl((req.query as { registry?: string }).registry);
      if (!registry) return reply.code(400).send({ error: "注册表地址必须是 http(s) URL" });
      try {
        const res = await fetch(registry, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return reply.code(502).send({ error: `注册表拉取失败：HTTP ${res.status}` });
        return (await res.json()) as unknown;
      } catch (err) {
        return reply.code(502).send({ error: `注册表拉取失败：${err instanceof Error ? err.message : String(err)}` });
      }
    });

    app.get("/skins-market/github/install", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const q = req.query as { registry?: string; id?: string };
      const registry = httpUrl(q.registry);
      const id = String(q.id ?? "");
      if (!registry) return reply.code(400).send({ error: "注册表地址必须是 http(s) URL" });
      if (!SKIN_ID_RE.test(id)) return reply.code(400).send({ error: "skin id 非法" });
      try {
        const res = await fetch(registry, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return reply.code(502).send({ error: `注册表拉取失败：HTTP ${res.status}` });
        // 注册表兼容两种格式：[...] 数组或 { skins: [...] }
        const body = (await res.json()) as unknown;
        const entries = Array.isArray(body) ? body : (body as { skins?: unknown }).skins;
        if (!Array.isArray(entries)) return reply.code(502).send({ error: "注册表格式不对（需数组或 { skins: [...] }）" });
        const entry = entries.find((e) => (e as { id?: string }).id === id) as { zip?: string } | undefined;
        const zipUrl = httpUrl(entry?.zip);
        if (!entry || !zipUrl) return reply.code(404).send({ error: `注册表里没有 ${id} 或缺少 zip 地址` });
        const zipRes = await fetch(zipUrl, { signal: AbortSignal.timeout(60_000) });
        if (!zipRes.ok) return reply.code(502).send({ error: `皮肤包下载失败：HTTP ${zipRes.status}` });
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-gh-"));
        try {
          unzipTo(Buffer.from(await zipRes.arrayBuffer()), tmp);
          const manifest = installFromDir(locatePackRoot(tmp));
          return reply.code(201).send({ ...manifest, builtin: false });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      } catch (err) {
        if (err instanceof SkinConflictError) return reply.code(409).send({ error: err.message });
        return reply.code(502).send({ error: `从 GitHub 市场安装失败：${err instanceof Error ? err.message : String(err)}` });
      }
    });

    // ---------- npm 市场：皮肤发布为 npm 包（约定名 muniu-skin-*），走镜像 registry ----------

    const npmRegistry = (): string =>
      (process.env.SKIN_NPM_REGISTRY ?? "https://registry.npmmirror.com").replace(/\/+$/, "");

    /** 解析 name / name@version / @scope/name / @scope/name@version */
    function parsePkgSpec(spec: string): { name: string; version?: string } | null {
      const m = /^(@[^@/]+\/[^@/]+|[^@/\s]+)(?:@([\w.\-+]+))?$/.exec(spec.trim());
      if (!m) return null;
      return { name: m[1]!, version: m[2] };
    }

    /** npm tarball 是 tar.gz：用系统 tar 解包（Windows 10+/Linux/macOS 自带），零新依赖。
     * 参数一律相对路径 + cwd——GNU tar 会把 C:\ 开头的绝对路径当远程主机名。 */
    async function extractTgz(buf: Buffer, dest: string): Promise<void> {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "pack.tgz"), buf);
      try {
        await execFileAsync("tar", ["-xzf", "pack.tgz", "-C", "."], { cwd: dest });
      } finally {
        fs.rmSync(path.join(dest, "pack.tgz"), { force: true });
      }
    }

    app.get("/skins-market/npm/search", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const q = String((req.query as { q?: string }).q ?? "").trim() || "muniu-skin";
      try {
        const res = await fetch(`${npmRegistry()}/-/v1/search?text=${encodeURIComponent(q)}&size=20`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return reply.code(502).send({ error: `npm 搜索失败：HTTP ${res.status}` });
        const body = (await res.json()) as {
          objects?: Array<{ package?: { name?: string; version?: string; description?: string; publisher?: { username?: string } } }>;
        };
        const skins = (body.objects ?? [])
          .map((o) => o.package)
          .filter((p): p is { name: string; version?: string; description?: string; publisher?: { username?: string } } =>
            typeof p?.name === "string"
          )
          .map((p) => ({ name: p.name, version: p.version ?? "", description: p.description ?? "", author: p.publisher?.username ?? "" }));
        return { skins };
      } catch (err) {
        return reply.code(502).send({ error: `npm 搜索失败：${err instanceof Error ? err.message : String(err)}` });
      }
    });

    app.get("/skins-market/npm/install", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const spec = String((req.query as { pkg?: string }).pkg ?? "").trim();
      const parsed = parsePkgSpec(spec);
      if (!parsed) return reply.code(400).send({ error: "包名格式不对（name 或 name@version，支持 @scope/name）" });
      try {
        // 元数据获取 + 占位版本处理：npm 新发布流程会产生 0.0.0-stage 暂存占位版本，
        // 镜像同步滞后时 latest 可能仍指向它（装出来没有 skin.json）。
        // 策略：未钉版本时跳过 -stage 选最新稳定版；当前 registry 没有 → 回退官方源再试。
        const isStage = (v: string) => /-stage$/.test(v);
        const semverCmp = (a: string, b: string) => {
          const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
          const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
          for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
          return 0;
        };
        const fetchMeta = async (base: string) => {
          const res = await fetch(`${base}/${parsed.name.replace("/", "%2F")}`, { signal: AbortSignal.timeout(15_000) });
          if (res.status === 404) throw Object.assign(new Error("not-found"), { status: 404 });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as { "dist-tags"?: Record<string, string>; versions?: Record<string, { dist?: { tarball?: string } }> };
        };
        let meta = await fetchMeta(npmRegistry());
        let version = parsed.version ?? meta["dist-tags"]?.latest;
        let tarball = version ? meta.versions?.[version]?.dist?.tarball : undefined;
        if (!tarball || (!parsed.version && isStage(version ?? ""))) {
          const stable = Object.keys(meta.versions ?? {}).filter((v) => !isStage(v)).sort(semverCmp).pop();
          if (stable && meta.versions?.[stable]?.dist?.tarball) {
            version = stable;
            tarball = meta.versions[stable]!.dist!.tarball;
          } else if (npmRegistry() !== "https://registry.npmjs.org") {
            // 镜像还没有该版本：回退官方源
            const official = await fetchMeta("https://registry.npmjs.org");
            version = parsed.version ?? official["dist-tags"]?.latest ?? version;
            tarball = version ? official.versions?.[version]?.dist?.tarball : undefined;
          }
        }
        if (!version || !tarball) return reply.code(404).send({ error: `${parsed.name} 没有可安装的版本` });
        const zipRes = await fetch(tarball, { signal: AbortSignal.timeout(60_000) });
        if (!zipRes.ok) return reply.code(502).send({ error: `tarball 下载失败：HTTP ${zipRes.status}` });
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-npm-"));
        try {
          // tarball 解出 package/ 目录，皮肤文件约定在包根部 → locatePackRoot 能定位
          await extractTgz(Buffer.from(await zipRes.arrayBuffer()), tmp);
          const manifest = installFromDir(locatePackRoot(tmp));
          return reply.code(201).send({ ...manifest, builtin: false });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      } catch (err) {
        if (err instanceof SkinConflictError) return reply.code(409).send({ error: err.message });
        if ((err as { status?: number }).status === 404) return reply.code(404).send({ error: `npm 上没有 ${parsed.name}` });
        return reply.code(502).send({ error: `npm 安装失败：${err instanceof Error ? err.message : String(err)}` });
      }
    });

    // 一键发布：把本地皮肤打包成 npm 包发布。走 npm publish 协议直写 registry
    // （npmmirror 是只读镜像，发布默认上 registry.npmjs.org，SKIN_NPM_PUBLISH_REGISTRY 可指私服）。
    // 令牌由用户在 npmjs.com 生成、仅本次请求使用，服务端不留存。
    app.post("/skins-market/npm/publish", { onRequest: [app.authenticate], preHandler: requireMarketPlugin }, async (req, reply) => {
      const body = req.body as { id?: string; name?: string; version?: string; token?: string };
      const id = String(body.id ?? "").trim();
      if (!SKIN_ID_RE.test(id)) return reply.code(400).send({ error: "skin id 非法" });
      const manifest = fs.existsSync(path.join(packDir(id), MANIFEST_NAME))
        ? readManifest(packDir(id))
        : undefined;
      if (!manifest) return reply.code(404).send({ error: "本地没有这个皮肤" });
      const name = String(body.name ?? "").trim() || `muniu-skin-${manifest.id}`;
      if (!/^(@[\w.-]+\/)?[\w.-]{1,214}$/.test(name)) {
        return reply.code(400).send({ error: "包名格式不对（name 或 @scope/name）" });
      }
      const version = String(body.version ?? "").trim() || manifest.version || "1.0.0";
      if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
        return reply.code(400).send({ error: "版本号需是 x.y.z 形式" });
      }
      const token = String(body.token ?? "").trim();
      if (!token) return reply.code(400).send({ error: "缺少 npm 访问令牌（npmjs.com → Access Tokens 生成）" });

      // 组 npm 包：package/ 下 package.json + 皮肤文件，tar -czf（相对路径 + cwd，GNU tar 兼容）
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-publish-"));
      try {
        const pkgRoot = path.join(staging, "package");
        fs.mkdirSync(pkgRoot, { recursive: true });
        const files: Array<{ name: string; data: Buffer }> = [];
        const walk = (rel: string): void => {
          const absDir = rel ? path.join(packDir(id), rel) : packDir(id);
          for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(r);
            else if (entry.isFile()) files.push({ name: r, data: fs.readFileSync(path.join(absDir, entry.name)) });
          }
        };
        walk("");
        for (const f of files) {
          const target = path.join(pkgRoot, f.name.replace(/\//g, path.sep));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, f.data);
        }
        fs.writeFileSync(
          path.join(pkgRoot, "package.json"),
          JSON.stringify(
            {
              name,
              version,
              description: manifest.description ?? "",
              keywords: ["muniu-skin", "muniu", "skin"],
              files: files.map((f) => f.name).concat(["package.json"]),
            },
            null,
            2
          )
        );
        const tgzName = `${name.replace("/", "-")}-${version}.tgz`;
        await execFileAsync("tar", ["-czf", tgzName, "package"], { cwd: staging });
        const tarball = fs.readFileSync(path.join(staging, tgzName));
        const shasum = createHash("sha1").update(tarball).digest("hex");

        const registry = (process.env.SKIN_NPM_PUBLISH_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
        const tarballUrl = `${registry}/${name}/-/${tgzName}`;
        const payload = {
          _id: name,
          name,
          description: manifest.description ?? "",
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              name,
              version,
              description: manifest.description ?? "",
              _nodeVersion: process.versions.node,
              dist: { tarball: tarballUrl, shasum },
            },
          },
          _attachments: {
            [tgzName]: { "content-type": "application/octet-stream", data: tarball.toString("base64"), length: tarball.length },
          },
        };
        const res = await fetch(`${registry}/${name.replace("/", "%2F")}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) return reply.code(201).send({ ok: true, name, version, tarball: tarballUrl });
        const detail = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        const why = detail.error ?? detail.reason ?? res.statusText;
        if (res.status === 409 || /conflict|already exists/i.test(String(why))) {
          return reply.code(409).send({ error: `${name}@${version} 已存在——换一个版本号再发` });
        }
        if (res.status === 401 || res.status === 403) {
          return reply.code(401).send({ error: "令牌无效或无权发布该包名（检查 npm 访问令牌 / scope 归属）" });
        }
        return reply.code(502).send({ error: `registry 返回 ${res.status}：${why}` });
      } catch (err) {
        return reply.code(500).send({ error: `发布失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    });
  },
};
