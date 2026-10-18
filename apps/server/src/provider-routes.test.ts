// provider-routes.test.ts：当前用户列出自己的供应商时回填密钥，供编辑弹窗显示。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-provider-routes-test-"));

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { createUser } = await import("./auth.js");
const { db, migrate, now } = await import("./db.js");
const { registerAdminRoutes } = await import("./routes/admin.js");
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

migrate();

const app = Fastify();
await app.register(jwt, { secret: "test-secret" });
app.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "unauthorized" });
  }
});
registerAdminRoutes(app);
await app.ready();

const owner = createUser("owner", "owner-pass", "member");
const other = createUser("other", "other-pass", "member");
const ownerToken = app.jwt.sign({ sub: owner.id, role: owner.role });

db.prepare(
  "INSERT INTO model_providers (id, name, base_url, api_key, enabled, user_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
).run("p-owner", "集群模型", "http://10.50.11.18:8888/v1", "sk-owner-secret", owner.id, now());
db.prepare(
  "INSERT INTO model_providers (id, name, base_url, api_key, enabled, user_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
).run("p-other", "别人的供应商", "http://example.test/v1", "sk-other-secret", other.id, now());

after(() => void app.close());

describe("GET /admin/providers 密钥回填", () => {
  it("只返回当前用户自己的供应商，并带上明文密钥供编辑回填", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.statusCode, 200);
    const list = res.json() as Array<{ id: string; apiKey: string; hasKey: boolean }>;
    assert.equal(
      list.some((p) => p.id === "p-other"),
      false,
      "不能把别人的供应商（含密钥）返回给当前用户",
    );
    const mine = list.find((p) => p.id === "p-owner");
    assert.ok(mine);
    assert.equal(mine.apiKey, "sk-owner-secret");
    assert.equal(mine.hasKey, true);
  });

  it("未配置密钥时 apiKey 为空字符串、hasKey 为 false", async () => {
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key, enabled, user_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run("p-empty", "无密钥", "http://empty.test/v1", "", owner.id, now());
    const res = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.statusCode, 200);
    const list = res.json() as Array<{ id: string; apiKey: string; hasKey: boolean }>;
    const empty = list.find((p) => p.id === "p-empty");
    assert.ok(empty);
    assert.equal(empty.apiKey, "");
    assert.equal(empty.hasKey, false);
  });
});

describe("供应商对话协议 apiFormat", () => {
  it("未指定时列表返回默认 Chat Completions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.statusCode, 200);
    const list = res.json() as Array<{ id: string; apiFormat: string }>;
    const mine = list.find((p) => p.id === "p-owner");
    assert.ok(mine);
    assert.equal(mine.apiFormat, "openai-completions");
  });

  it("创建时可指定 Anthropic Messages，并可改成 Responses", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "集团模型",
        baseUrl: "http://10.50.11.18:8080/v1",
        apiKey: "sk-group",
        apiFormat: "anthropic-messages",
      },
    });
    assert.equal(created.statusCode, 201);
    const { id } = created.json() as { id: string };

    const listed = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const row = (listed.json() as Array<{ id: string; apiFormat: string }>).find((p) => p.id === id);
    assert.ok(row);
    assert.equal(row.apiFormat, "anthropic-messages");

    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/providers/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { apiFormat: "openai-responses" },
    });
    assert.equal(patched.statusCode, 200);

    const after = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const updated = (after.json() as Array<{ id: string; apiFormat: string }>).find((p) => p.id === id);
    assert.ok(updated);
    assert.equal(updated.apiFormat, "openai-responses");
  });

  it("非法 apiFormat 被拒绝", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "坏格式",
        baseUrl: "http://example.test/v1",
        apiKey: "sk",
        apiFormat: "gemini",
      },
    });
    assert.equal(created.statusCode, 400);

    const patched = await app.inject({
      method: "PATCH",
      url: "/admin/providers/p-owner",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { apiFormat: "not-a-format" },
    });
    assert.equal(patched.statusCode, 400);
  });
});
