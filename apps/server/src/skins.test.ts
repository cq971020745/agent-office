// skins.test.ts：皮肤包路由。导入前隔离 DATA_DIR（模块链上有 config.js/db.js）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-skins-test-"));

const Fastify = (await import("fastify")).default;
const jwt = (await import("@fastify/jwt")).default;
const { registerSkinRoutes, syncBuiltinSkinPacks } = await import("./routes/skins.js");
const { paths } = await import("./config.js");
const { zipFiles } = await import("./zip-pack.js");

const SKIN_CSS = ":root { --accent: #b45309; }\n:root[data-theme=\"dark\"] { --bg: #1c1917; }\n";

function writePack(root: string, id: string, css = SKIN_CSS, manifest: Record<string, unknown> = {}): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skin.json"),
    JSON.stringify({ id, name: `皮肤 ${id}`, version: "1.0.0", ...manifest })
  );
  fs.writeFileSync(path.join(dir, "skin.css"), css);
  return dir;
}

/** 用 zip-pack 自带的打包器造上传 payload；打包器本身就拒绝 .. 路径，zip-slip 由它兜底。 */
function zipBuffer(files: Array<{ name: string; data: string }>): Buffer {
  return zipFiles(files.map((f) => ({ name: f.name, data: Buffer.from(f.data) })));
}

function multipartBody(buf: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "testskinboundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.zip"\r\nContent-Type: application/zip\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, buf, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "test-secret" });
  await app.register((await import("@fastify/multipart")).default, {
    limits: { fileSize: 20 * 1024 * 1024 },
  });
  app.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  registerSkinRoutes(app);
  const token = app.jwt.sign({ sub: "u1", role: "user" });
  return { app, token };
}

describe("syncBuiltinSkinPacks", () => {
  it("把内置包同步进数据目录并登记 builtins.json，内容差异才重拷", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-src-"));
    writePack(sourceRoot, "paper-warm");
    process.env.SKIN_PACKS_DIR = sourceRoot;
    try {
      syncBuiltinSkinPacks();
      const dest = path.join(paths.skins, "paper-warm", "skin.css");
      assert.ok(fs.existsSync(dest), "内置包应同步到数据目录");
      const builtins = JSON.parse(fs.readFileSync(path.join(paths.skins, "builtins.json"), "utf8")) as string[];
      assert.ok(builtins.includes("paper-warm"));

      // 用户改动数据目录里的副本后，下次同步以内置源为准恢复
      fs.writeFileSync(dest, "/* tampered */");
      syncBuiltinSkinPacks();
      assert.equal(fs.readFileSync(dest, "utf8"), SKIN_CSS);

      // 源里移除该包：不再标记内置，但数据目录副本保留
      fs.rmSync(path.join(sourceRoot, "paper-warm"), { recursive: true, force: true });
      syncBuiltinSkinPacks();
      const after = JSON.parse(fs.readFileSync(path.join(paths.skins, "builtins.json"), "utf8")) as string[];
      assert.ok(!after.includes("paper-warm"));
      assert.ok(fs.existsSync(dest));
    } finally {
      delete process.env.SKIN_PACKS_DIR;
    }
  });
});

describe("GET /skins", () => {
  it("列出有效皮肤并标记内置，坏清单进 broken", async () => {
    writePack(paths.skins, "good-one", SKIN_CSS, { modes: ["light", "dark"] });
    fs.mkdirSync(path.join(paths.skins, "bad-pack"), { recursive: true });
    fs.writeFileSync(path.join(paths.skins, "bad-pack", "skin.json"), JSON.stringify({ id: "mismatch-name" }));
    const { app, token } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/skins", headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        skinDir: string;
        skins: Array<{ id: string; builtin: boolean; modes?: string[] }>;
        broken: Array<{ dir: string }>;
      };
      assert.equal(body.skinDir, paths.skins);
      const good = body.skins.find((s) => s.id === "good-one");
      assert.ok(good);
      assert.deepEqual(good.modes, ["light", "dark"]);
      assert.equal(good.builtin, false);
      assert.ok(body.broken.some((b) => b.dir === "bad-pack"));
    } finally {
      await app.close();
    }
  });

  it("未带 token 时 401", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/skins" });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

describe("GET /skins/:id/file", () => {
  it("按 MIME 下发 css，支持 ?token= 访问", async () => {
    const { app, token } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/skins/good-one/file?path=skin.css&token=" + encodeURIComponent(token),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "text/css; charset=utf-8");
      assert.equal(res.body, SKIN_CSS);
    } finally {
      await app.close();
    }
  });

  it("拒绝路径穿越与目录外文件", async () => {
    const { app, token } = await buildApp();
    try {
      const outside = path.join(paths.skins, "..", "escape.css");
      fs.writeFileSync(outside, "hax");
      for (const rel of ["../escape.css", "a/../../escape.css", "..\\escape.css", "", "sub/", "no-such.css"]) {
        const res = await app.inject({
          method: "GET",
          url: `/skins/good-one/file?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(token)}`,
        });
        assert.notEqual(res.statusCode, 200, `path=${rel} 不应放行`);
      }
    } finally {
      await app.close();
    }
  });
});

describe("POST /skins", () => {
  it("安装 zip 皮肤包（根部清单），同 id 覆盖", async () => {
    const { app, token } = await buildApp();
    try {
      const zip = zipBuffer([
        { name: "skin.json", data: JSON.stringify({ id: "uploaded", name: "上传皮肤" }) },
        { name: "skin.css", data: SKIN_CSS },
        { name: "assets/wall.png", data: "png" },
      ]);
      const { payload, headers } = multipartBody(zip);
      const res = await app.inject({
        method: "POST",
        url: "/skins",
        payload,
        headers: { ...headers, authorization: `Bearer ${token}` },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(fs.readFileSync(path.join(paths.skins, "uploaded", "skin.css"), "utf8"), SKIN_CSS);

      // 同 id 再传：覆盖（版本变化）
      const zip2 = zipBuffer([
        { name: "skin.json", data: JSON.stringify({ id: "uploaded", name: "上传皮肤", version: "2.0.0" }) },
        { name: "skin.css", data: "/* v2 */" },
      ]);
      const res2 = await app.inject({
        method: "POST",
        url: "/skins",
        payload: multipartBody(zip2).payload,
        headers: { ...multipartBody(zip2).headers, authorization: `Bearer ${token}` },
      });
      assert.equal(res2.statusCode, 201);
      assert.equal(fs.readFileSync(path.join(paths.skins, "uploaded", "skin.css"), "utf8"), "/* v2 */");
    } finally {
      await app.close();
    }
  });

  it("兼容唯一一级目录包裹的 zip，缺清单报错", async () => {
    const { app, token } = await buildApp();
    try {
      const wrapped = zipBuffer([
        { name: "wrapped/skin.json", data: JSON.stringify({ id: "wrapped", name: "包裹皮肤" }) },
        { name: "wrapped/skin.css", data: SKIN_CSS },
      ]);
      const w = multipartBody(wrapped);
      const ok = await app.inject({
        method: "POST",
        url: "/skins",
        payload: w.payload,
        headers: { ...w.headers, authorization: `Bearer ${token}` },
      });
      assert.equal(ok.statusCode, 201);

      const broken = zipBuffer([{ name: "readme.txt", data: "no manifest" }]);
      const b = multipartBody(broken);
      const bad = await app.inject({
        method: "POST",
        url: "/skins",
        payload: b.payload,
        headers: { ...b.headers, authorization: `Bearer ${token}` },
      });
      assert.equal(bad.statusCode, 400);
      assert.match(bad.json().error, /skin\.json/);
    } finally {
      await app.close();
    }
  });

  it("内置包 id 冲突返回 409，且原包未被破坏", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-src2-"));
    writePack(sourceRoot, "builtin-skin");
    process.env.SKIN_PACKS_DIR = sourceRoot;
    syncBuiltinSkinPacks();
    delete process.env.SKIN_PACKS_DIR;

    const { app, token } = await buildApp();
    try {
      const zip = zipBuffer([
        { name: "skin.json", data: JSON.stringify({ id: "builtin-skin", name: "冒名内置" }) },
        { name: "skin.css", data: "/* hijack */" },
      ]);
      const m = multipartBody(zip);
      const res = await app.inject({
        method: "POST",
        url: "/skins",
        payload: m.payload,
        headers: { ...m.headers, authorization: `Bearer ${token}` },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(fs.readFileSync(path.join(paths.skins, "builtin-skin", "skin.css"), "utf8"), SKIN_CSS);
    } finally {
      await app.close();
    }
  });
});

describe("DELETE /skins/:id", () => {
  it("删除用户包，内置包 409，未知 404", async () => {
    const { app, token } = await buildApp();
    const auth = { authorization: `Bearer ${token}` };
    try {
      const gone = await app.inject({ method: "DELETE", url: "/skins/uploaded", headers: auth });
      assert.equal(gone.statusCode, 200);
      assert.ok(!fs.existsSync(path.join(paths.skins, "uploaded")));

      const builtin = await app.inject({ method: "DELETE", url: "/skins/builtin-skin", headers: auth });
      assert.equal(builtin.statusCode, 409);
      assert.ok(fs.existsSync(path.join(paths.skins, "builtin-skin")));

      const missing = await app.inject({ method: "DELETE", url: "/skins/never-existed", headers: auth });
      assert.equal(missing.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
