// skins-multiuser.test.ts：SERVER_MULTI_USER=1 下的皮肤收敛（评审 P1）。
// 独立文件 = 独立进程：config 在模块加载时读取环境变量，必须先设再动态导入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-skins-mu-test-"));
process.env.SERVER_MULTI_USER = "1";

const Fastify = (await import("fastify")).default;
const jwt = (await import("@fastify/jwt")).default;
const { registerSkinRoutes } = await import("./routes/skins.js");
const { paths } = await import("./config.js");
const { zipFiles } = await import("./zip-pack.js");

function multipartBody(buf: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "mu-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.zip"\r\nContent-Type: application/zip\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, buf, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "mu-secret" });
  await app.register((await import("@fastify/multipart")).default, { limits: { fileSize: 20 * 1024 * 1024 } });
  app.decorate("authenticate", async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  registerSkinRoutes(app);
  return {
    app,
    adminToken: app.jwt.sign({ sub: "a1", role: "admin" }),
    userToken: app.jwt.sign({ sub: "u1", role: "user" }),
  };
}

describe("SERVER_MULTI_USER=1 皮肤收敛", () => {
  it("GET /skins 不返回 skinDir 绝对路径", async () => {
    const { app, userToken } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/skins", headers: { authorization: `Bearer ${userToken}` } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().skinDir, null);
    } finally {
      await app.close();
    }
  });

  it("成员上传/删除皮肤 403，管理员可上传", async () => {
    const { app, adminToken, userToken } = await buildApp();
    const zip = zipFiles([
      { name: "skin.json", data: JSON.stringify({ id: "mu-pack", name: "多用户皮肤" }) },
      { name: "skin.css", data: ":root{}" },
    ]);
    try {
      const asUser = await app.inject({
        method: "POST",
        url: "/skins",
        payload: multipartBody(zip).payload,
        headers: { ...multipartBody(zip).headers, authorization: `Bearer ${userToken}` },
      });
      assert.equal(asUser.statusCode, 403);

      const asAdmin = await app.inject({
        method: "POST",
        url: "/skins",
        payload: multipartBody(zip).payload,
        headers: { ...multipartBody(zip).headers, authorization: `Bearer ${adminToken}` },
      });
      assert.equal(asAdmin.statusCode, 201, `管理员上传失败：${asAdmin.body}`);
      assert.ok(fs.existsSync(path.join(paths.skins, "mu-pack", "skin.css")));

      const delAsUser = await app.inject({ method: "DELETE", url: "/skins/mu-pack", headers: { authorization: `Bearer ${userToken}` } });
      assert.equal(delAsUser.statusCode, 403);

      const delAsAdmin = await app.inject({ method: "DELETE", url: "/skins/mu-pack", headers: { authorization: `Bearer ${adminToken}` } });
      assert.equal(delAsAdmin.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});
