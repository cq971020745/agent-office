// auth-routes.test.ts：企业知识库登录与 CORS 预检的应用级测试。
// index.ts 的 main() 导入即启动，无法直接复用，这里按其配置复刻最小 app；
// 导入前隔离 DATA_DIR（模块链上有 db.js）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-auth-routes-test-"));

const { default: Fastify } = await import("fastify");
const { default: cors } = await import("@fastify/cors");
const { default: jwt } = await import("@fastify/jwt");
const { db, migrate } = await import("./db.js");
const { setKbLoginForTests } = await import("./kb-auth.js");
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
        origin: "http://localhost:38618",
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

describe("企业知识库登录", () => {
  it("不再接受自助注册、改密和重置密码", async () => {
    for (const url of ["/auth/register", "/auth/reset-password"]) {
      const res = await app.inject({ method: "POST", url, payload: { username: "a", password: "123456" } });
      assert.equal(res.statusCode, 410);
    }
    const token = app.jwt.sign({ sub: "u1", role: "member" });
    const changed = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: "123456" },
    });
    assert.equal(changed.statusCode, 410);
    const anon = await app.inject({ method: "POST", url: "/auth/change-password", payload: { newPassword: "123456" } });
    assert.equal(anon.statusCode, 401);
  });

  it("超级管理员登录后领走尚未归属的供应商，成员登录不会领走", async () => {
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key, enabled, created_at) VALUES ('orphan-p', '旧供应商', 'http://example.test', 'sk-test', 1, '2026-01-01')"
    ).run();
    setKbLoginForTests(async (input) => {
      if (input.username === "member") {
        return {
          accessToken: "kb-member",
          userId: "kb-member",
          userName: "member",
          phone: "13800000001",
          nickName: "成员",
          roleKeys: ["test2"],
        };
      }
      return {
        accessToken: "kb-admin",
        userId: "kb-admin",
        userName: "super",
        phone: "13800000002",
        nickName: "超管",
        roleKeys: ["superadmin"],
      };
    });

    const memberRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "member", password: "secret", code: "1", uuid: "u" },
    });
    assert.equal(memberRes.statusCode, 200);
    assert.equal(memberRes.json().user.role, "member");
    const stillOrphan = db.prepare("SELECT user_id FROM model_providers WHERE id = 'orphan-p'").get() as { user_id: string | null };
    assert.equal(stillOrphan.user_id, null);
    const memberTextIn = db
      .prepare("SELECT name, ocr_model FROM model_providers WHERE user_id = ? AND ocr_model = 'textin'")
      .get(memberRes.json().user.id as string) as { name: string; ocr_model: string } | undefined;
    assert.equal(memberTextIn?.name, "TextIn OCR");
    assert.equal(memberTextIn?.ocr_model, "textin");

    const adminRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "super", password: "secret", code: "1", uuid: "u" },
    });
    assert.equal(adminRes.statusCode, 200);
    assert.equal(adminRes.json().user.role, "admin");
    const adminId = adminRes.json().user.id as string;
    const claimed = db.prepare("SELECT user_id FROM model_providers WHERE id = 'orphan-p'").get() as { user_id: string };
    assert.equal(claimed.user_id, adminId);
    setKbLoginForTests(null);
  });
});
