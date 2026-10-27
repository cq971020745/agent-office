// skin-market.test.ts：皮肤市场平台插件（全员开放、无令牌、可启停）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-market-test-"));

const Fastify = (await import("fastify")).default;
const jwt = (await import("@fastify/jwt")).default;
const multipart = (await import("@fastify/multipart")).default;
const { skinMarketPlugin } = await import("./plugins/skin-market.js");
// 路由门查的是全局 registry（plugins/index.js 已注册本插件），测试只启停市场这一个
const { platformPlugins } = await import("./plugins/index.js");
const { migrate } = await import("./db.js");
const { paths } = await import("./config.js");
const { unzipTo, zipFiles } = await import("./zip-pack.js");

migrate();

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "market-secret" });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  app.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  skinMarketPlugin.registerRoutes(app);
  await platformPlugins.setEnabled("skin-market", true);
  return {
    app,
    memberToken: app.jwt.sign({ sub: "member-1", role: "member" }),
  };
}

function zipBody(zip: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "market-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.zip"\r\nContent-Type: application/zip\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, zip, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("skin-market 插件", () => {
  it("未登录 401；成员可见列表、可上传、可下载（无令牌无管理员门槛）", async () => {
    const { app, memberToken } = await buildApp();
    const auth = { authorization: `Bearer ${memberToken}` };
    try {
      const anon = await app.inject({ method: "GET", url: "/skins-market" });
      assert.equal(anon.statusCode, 401);

      const zip = zipFiles([
        { name: "skin.json", data: Buffer.from(JSON.stringify({ id: "shared-glow", name: "全员共享皮肤", author: "同事A" })) },
        { name: "skin.css", data: Buffer.from(":root { --accent: #7c3aed; }") },
      ]);
      const m = zipBody(zip);
      const upload = await app.inject({ method: "POST", url: "/skins-market", payload: m.payload, headers: { ...m.headers, ...auth } });
      assert.equal(upload.statusCode, 201, upload.body);
      assert.ok(fs.existsSync(path.join(paths.skins, "shared-glow", "skin.css")));

      const list = await app.inject({ method: "GET", url: "/skins-market", headers: auth });
      assert.equal(list.statusCode, 200);
      assert.ok((list.json().skins as Array<{ id: string }>).some((s) => s.id === "shared-glow"));

      const download = await app.inject({ method: "GET", url: "/skins-market/shared-glow/download", headers: auth });
      assert.equal(download.statusCode, 200);
      assert.equal(download.headers["content-type"], "application/zip");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-roundtrip-"));
      unzipTo(Buffer.from(download.rawPayload ?? download.body, "binary"), tmp);
      assert.equal(fs.readFileSync(path.join(tmp, "skin.css"), "utf8"), ":root { --accent: #7c3aed; }");
      fs.rmSync(tmp, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  });

  it("管理员停用插件后市场入口 503，重启恢复", async () => {
    const { app, memberToken } = await buildApp();
    const auth = { authorization: `Bearer ${memberToken}` };
    try {
      const before = await app.inject({ method: "GET", url: "/skins-market", headers: auth });
      assert.equal(before.statusCode, 200);

      assert.ok(await platformPlugins.setEnabled("skin-market", false));
      const disabled = await app.inject({ method: "GET", url: "/skins-market", headers: auth });
      assert.equal(disabled.statusCode, 503);

      assert.ok(await platformPlugins.setEnabled("skin-market", true));
      const enabled = await app.inject({ method: "GET", url: "/skins-market", headers: auth });
      assert.equal(enabled.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("GitHub 市场：代理拉注册表并一键安装（本地 raw 源模拟 GitHub）", async () => {
    // 用一个真实监听的迷你服务模拟 raw.githubusercontent.com（registry.json + zip）
    const zip = zipFiles([
      { name: "skin.json", data: Buffer.from(JSON.stringify({ id: "gh-neon", name: "霓虹之夜", author: "网友" })) },
      { name: "skin.css", data: Buffer.from(":root { --accent: #22d3ee; }") },
    ]);
    const raw = Fastify({ logger: false });
    let rawPort = 0;
    raw.get("/registry.json", async () => ({
      skins: [
        { id: "gh-neon", name: "霓虹之夜", author: "网友", version: "1.0.0", zip: `http://127.0.0.1:${rawPort}/gh-neon.zip` },
      ],
    }));
    raw.get("/gh-neon.zip", async (_req, reply) => {
      reply.header("content-type", "application/zip");
      return reply.send(zip);
    });
    await raw.listen({ port: 0, host: "127.0.0.1" });
    rawPort = (raw.server.address() as { port: number }).port;
    const registry = `http://127.0.0.1:${rawPort}/registry.json`;

    const { app, memberToken } = await buildApp();
    const auth = { authorization: `Bearer ${memberToken}` };
    try {
      const list = await app.inject({
        method: "GET",
        url: `/skins-market/github?registry=${encodeURIComponent(registry)}`,
        headers: auth,
      });
      assert.equal(list.statusCode, 200);
      assert.equal((list.json().skins as Array<{ id: string }>)[0]!.id, "gh-neon");

      const install = await app.inject({
        method: "GET",
        url: `/skins-market/github/install?registry=${encodeURIComponent(registry)}&id=gh-neon`,
        headers: auth,
      });
      assert.equal(install.statusCode, 201, install.body);
      assert.equal(
        fs.readFileSync(path.join(paths.skins, "gh-neon", "skin.css"), "utf8"),
        ":root { --accent: #22d3ee; }"
      );

      const missing = await app.inject({
        method: "GET",
        url: `/skins-market/github/install?registry=${encodeURIComponent(registry)}&id=no-such`,
        headers: auth,
      });
      assert.equal(missing.statusCode, 404);
    } finally {
      await app.close();
      await raw.close();
    }
  });

  it("npm 市场：搜索代理 + tarball 安装（本地 stub 镜像，系统 tar 打真 tgz）", async () => {
    // 造一个真实的 npm 包 tarball：package/skin.json + skin.css，tar -czf（与生产解包路径同一条）
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-npm-pkg-"));
    fs.mkdirSync(path.join(pkgDir, "package"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package", "skin.json"), JSON.stringify({ id: "npm-aurora", name: "极光", author: "npm 网友" }));
    fs.writeFileSync(path.join(pkgDir, "package", "skin.css"), ":root { --accent: #f472b6; }");
    const tgz = path.join(pkgDir, "muniu-skin-aurora-1.0.0.tgz");
    const { execFileSync } = await import("node:child_process");
    // 相对路径 + cwd：GNU tar 会把 C:\ 绝对路径当远程主机名
    execFileSync("tar", ["-czf", "muniu-skin-aurora-1.0.0.tgz", "package"], { cwd: pkgDir });

    // stub 镜像 registry：metadata + tarball + 搜索
    const npm = Fastify({ logger: false });
    let npmPort = 0;
    npm.get("/muniu-skin-aurora", async () => ({
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { dist: { tarball: `http://127.0.0.1:${npmPort}/muniu-skin-aurora/-/1.0.0.tgz` } } },
    }));
    npm.get("/muniu-skin-aurora/-/1.0.0.tgz", async (_req, reply) => {
      reply.header("content-type", "application/octet-stream");
      return reply.send(fs.readFileSync(tgz));
    });
    npm.get("/-/v1/search", async (req) => ({
      objects: [{ package: { name: "muniu-skin-aurora", version: "1.0.0", description: "极光皮肤", publisher: { username: "someone" } } }, ...(String((req.query as Record<string, string>).text ?? "").includes("empty") ? [] : [])],
    }));
    await npm.listen({ port: 0, host: "127.0.0.1" });
    npmPort = (npm.server.address() as { port: number }).port;
    process.env.SKIN_NPM_REGISTRY = `http://127.0.0.1:${npmPort}`;

    const { app, memberToken } = await buildApp();
    const auth = { authorization: `Bearer ${memberToken}` };
    try {
      const search = await app.inject({ method: "GET", url: "/skins-market/npm/search?q=muniu-skin", headers: auth });
      assert.equal(search.statusCode, 200);
      assert.equal((search.json().skins as Array<{ name: string }>)[0]!.name, "muniu-skin-aurora");

      const install = await app.inject({ method: "GET", url: "/skins-market/npm/install?pkg=muniu-skin-aurora", headers: auth });
      assert.equal(install.statusCode, 201, install.body);
      assert.equal(fs.readFileSync(path.join(paths.skins, "npm-aurora", "skin.css"), "utf8"), ":root { --accent: #f472b6; }");

      const pinned = await app.inject({ method: "GET", url: "/skins-market/npm/install?pkg=muniu-skin-aurora@1.0.0", headers: auth });
      assert.equal(pinned.statusCode, 201);

      const missing = await app.inject({ method: "GET", url: "/skins-market/npm/install?pkg=no-such-skin", headers: auth });
      assert.equal(missing.statusCode, 404);

      const badSpec = await app.inject({ method: "GET", url: "/skins-market/npm/install?pkg=not a pkg!", headers: auth });
      assert.equal(badSpec.statusCode, 400);
    } finally {
      delete process.env.SKIN_NPM_REGISTRY;
      await app.close();
      await npm.close();
      fs.rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  it("一键发布到 npm：PUT 协议落库 + 令牌校验 + 发布结果可再安装", async () => {
    // 本地先放一个待发布皮肤
    const local = path.join(paths.skins, "publish-demo");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "skin.json"), JSON.stringify({ id: "publish-demo", name: "待发布", version: "0.9.0" }));
    fs.writeFileSync(path.join(local, "skin.css"), ":root { --accent: #84cc16; }");

    // stub 发布 registry：记录 PUT，把 tarball 挂到安装元数据里形成回环
    const pub = Fastify({ logger: false });
    let pubPort = 0;
    let publishedTarball: Buffer | null = null;
    pub.put("/muniu-skin-publish-demo", async (req, reply) => {
      if (req.headers.authorization !== "Bearer good-token") return reply.code(401).send({ error: "unauthorized" });
      const body = req.body as {
        name: string;
        "dist-tags": Record<string, string>;
        versions: Record<string, { dist: { shasum: string } }>;
        _attachments: Record<string, { data: string }>;
      };
      const version = body["dist-tags"].latest!;
      publishedTarball = Buffer.from(Object.values(body._attachments)[0]!.data, "base64");
      return reply.code(201).send({ ok: true });
    });
    pub.get("/muniu-skin-publish-demo", async () => {
      if (!publishedTarball) return reply.code(404).send({});
      const version = "1.2.3";
      return {
        "dist-tags": { latest: version },
        versions: { [version]: { dist: { tarball: `http://127.0.0.1:${pubPort}/muniu-skin-publish-demo/-/${version}.tgz` } } },
      };
    });
    pub.get("/muniu-skin-publish-demo/-/1.2.3.tgz", async (_req, reply) => {
      if (!publishedTarball) return reply.code(404).send({});
      reply.header("content-type", "application/octet-stream");
      return reply.send(publishedTarball);
    });
    await pub.listen({ port: 0, host: "127.0.0.1" });
    pubPort = (pub.server.address() as { port: number }).port;
    process.env.SKIN_NPM_PUBLISH_REGISTRY = `http://127.0.0.1:${pubPort}`;
    process.env.SKIN_NPM_REGISTRY = `http://127.0.0.1:${pubPort}`;

    const { app, memberToken } = await buildApp();
    const auth = { authorization: `Bearer ${memberToken}`, "content-type": "application/json" };
    try {
      const noToken = await app.inject({ method: "POST", url: "/skins-market/npm/publish", payload: { id: "publish-demo" }, headers: auth });
      assert.equal(noToken.statusCode, 400);

      const badToken = await app.inject({
        method: "POST",
        url: "/skins-market/npm/publish",
        payload: { id: "publish-demo", token: "wrong" },
        headers: auth,
      });
      assert.equal(badToken.statusCode, 403);

      const ok = await app.inject({
        method: "POST",
        url: "/skins-market/npm/publish",
        payload: { id: "publish-demo", name: "muniu-skin-publish-demo", version: "1.2.3", token: "good-token" },
        headers: auth,
      });
      assert.equal(ok.statusCode, 201, ok.body);
      assert.ok(publishedTarball, "registry 应收到 tarball 附件");

      // 发布出去的包能被安装链路拉回来（删本地后经 npm install 恢复）
      fs.rmSync(local, { recursive: true, force: true });
      const reinstalled = await app.inject({
        method: "GET",
        url: "/skins-market/npm/install?pkg=muniu-skin-publish-demo",
        headers: { authorization: `Bearer ${memberToken}` },
      });
      assert.equal(reinstalled.statusCode, 201, reinstalled.body);
      assert.equal(fs.readFileSync(path.join(paths.skins, "publish-demo", "skin.css"), "utf8"), ":root { --accent: #84cc16; }");
    } finally {
      delete process.env.SKIN_NPM_PUBLISH_REGISTRY;
      delete process.env.SKIN_NPM_REGISTRY;
      await app.close();
      await pub.close();
    }
  });
});
