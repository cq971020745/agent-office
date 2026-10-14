// auth-routes.test.ts：change-password 与 CORS 预检的应用级测试。
// index.ts 的 main() 导入即启动，无法直接复用，这里按其配置复刻最小 app；
// 导入前隔离 DATA_DIR（模块链上有 db.js）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-auth-routes-test-"));

const { default: Fastify } = await import("fastify");
const { default: cors } = await import("@fastify/cors");
const { default: jwt } = await import("@fastify/jwt");
const { migrate } = await import("./db.js");
const { registerAuthRoutes } = await import("./routes/auth.js");
const { registerLenientJsonParser } = await import("./json-body.js");
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

migrate();

async function buildApp() {
  const app = Fastify();
  registerLenientJsonParser(app);
  await app.register(cors, {
    origin: true,
    // 与 index.ts 保持一致：@fastify/cors 默认 methods 只有 GET,HEAD,POST，
    // 一旦漏配，桌面端所有 DELETE/PUT/PATCH 请求都会因预检失败报 Failed to fetch
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(jwt, { secret: "test-secret" });
  app.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  registerAuthRoutes(app);
  app.delete("/echo-something", async () => ({ ok: true }));
  await app.ready();
  return app;
}

const app = await buildApp();
after(() => void app.close());

describe("CORS 预检（桌面端跨端口访问）", () => {
  it("DELETE 预检放行且 allow-methods 含 DELETE/PUT/PATCH", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/tasks/some-id",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "DELETE",
      },
    });
    assert.equal(res.statusCode, 204);
    const allow = res.headers["access-control-allow-methods"] ?? "";
    for (const m of ["DELETE", "PUT", "PATCH"]) {
      assert.ok(allow.includes(m), `allow-methods 应包含 ${m}，实际：${allow}`);
    }
  });
});

describe("无请求体的 DELETE（Content-Type: json 但 body 为空）", () => {
  it("宽松解析放行，路由正常执行而不是 400", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/echo-something",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  it("坏 JSON 仍然报 400", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/echo-something",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    assert.equal(res.statusCode, 400);
  });
});

describe("修改密码（不要求旧密码）", () => {
  let token = "";
  it("注册首个用户拿登录态", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: "admin", password: "old-pass-1" } });
    assert.equal(res.statusCode, 200);
    token = res.json().token;
    assert.ok(token);
  });

  it("不传旧密码也能改密", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: "new-pass-9" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  it("新密码可登录", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "new-pass-9" } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().token);
  });

  it("旧密码已失效（改密即时生效）", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "old-pass-1" } });
    assert.equal(res.statusCode, 401);
  });

  it("缺 newPassword 返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it("新密码过短返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: "123" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("未登录改密返回 401", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/change-password", payload: { newPassword: "whatever-1" } });
    assert.equal(res.statusCode, 401);
  });
});
