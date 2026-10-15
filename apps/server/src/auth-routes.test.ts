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

describe("用户自助注册与修改密码", () => {
  let token = "";

  it("首个注册用户成为管理员", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: " admin ", password: "old-pass-1" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    token = body.token;
    assert.ok(token);
    assert.equal(body.user.username, "admin");
    assert.equal(body.user.role, "admin");
  });

  it("后续用户可自行注册且默认为普通成员", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: "member", password: "member-pass-1" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.token);
    assert.equal(body.user.username, "member");
    assert.equal(body.user.role, "member");
  });

  it("自助注册的成员可直接登录", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "member", password: "member-pass-1" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.role, "member");
  });

  it("重复用户名返回 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: "member", password: "another-pass" },
    });
    assert.equal(res.statusCode, 409);
  });

  it("注册密码少于 6 位返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: "short-password", password: "12345" },
    });
    assert.equal(res.statusCode, 400);
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

  it("本机可按用户名重置忘记的密码并登录", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { username: " admin ", newPassword: "reset-pass-1" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.user.username, "admin");
    assert.equal(body.user.role, "admin");
    assert.ok(body.token);
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "reset-pass-1" },
    });
    assert.equal(loginRes.statusCode, 200);
    const oldRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "new-pass-9" },
    });
    assert.equal(oldRes.statusCode, 401);
  });

  it("重置不存在的用户返回 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { username: "nobody", newPassword: "reset-pass-1" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("重置密码少于 6 位返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { username: "admin", newPassword: "12345" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("其他电脑不能重置密码", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      remoteAddress: "203.0.113.10",
      payload: { username: "admin", newPassword: "stolen-pass-1" },
    });
    assert.equal(res.statusCode, 403);
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "reset-pass-1" },
    });
    assert.equal(loginRes.statusCode, 200);
  });
});
