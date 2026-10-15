// wps-routes.test.ts：验证 WPS 用户信息严格按当前平台账号隔离。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-wps-routes-test-"));

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { createUser } = await import("./auth.js");
const { db, migrate, now } = await import("./db.js");
const { registerWpsRoutes } = await import("./routes/wps.js");
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
registerWpsRoutes(app);
await app.ready();

const admin = createUser("admin", "admin-pass", "admin");
const member = createUser("member", "member-pass", "member");
const adminToken = app.jwt.sign({ sub: admin.id, role: admin.role });
const memberToken = app.jwt.sign({ sub: member.id, role: member.role });

const syncedAt = now();
db.prepare("INSERT INTO wps_profile (user_id, profile, synced_at) VALUES (?, ?, ?)").run(
  admin.id,
  JSON.stringify({ id: "wps-admin", name: "管理员 WPS", syncedAt }),
  syncedAt
);
db.prepare("INSERT INTO wps_profile (user_id, profile, synced_at) VALUES (?, ?, ?)").run(
  member.id,
  JSON.stringify({ id: "wps-member", name: "成员 WPS", syncedAt }),
  syncedAt
);

after(() => void app.close());

describe("WPS 用户信息隔离", () => {
  it("每个登录用户只能读取自己同步的 WPS 信息", async () => {
    const adminRes = await app.inject({
      method: "GET",
      url: "/wps/me",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const memberRes = await app.inject({
      method: "GET",
      url: "/wps/me",
      headers: { authorization: `Bearer ${memberToken}` },
    });

    assert.equal(adminRes.statusCode, 200);
    assert.equal(memberRes.statusCode, 200);
    assert.equal(adminRes.json().profile.id, "wps-admin");
    assert.equal(memberRes.json().profile.id, "wps-member");
  });

  it("未登录用户不能读取 WPS 信息", async () => {
    const res = await app.inject({ method: "GET", url: "/wps/me" });
    assert.equal(res.statusCode, 401);
  });
});
