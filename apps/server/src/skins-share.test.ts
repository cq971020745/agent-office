// skins-share.test.ts：AI 创造安装（从任务工作区）与导出分享回环。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-skins-share-test-"));

const Fastify = (await import("fastify")).default;
const jwt = (await import("@fastify/jwt")).default;
const { registerSkinRoutes } = await import("./routes/skins.js");
const { paths } = await import("./config.js");
const { db, now } = await import("./db.js");
const { unzipTo } = await import("./zip-pack.js");
const { migrate, ensureDefaultAgent } = await import("./db.js");
migrate();
ensureDefaultAgent();
const agentId = (db.prepare("SELECT id FROM agents ORDER BY created_at LIMIT 1").get() as { id: string }).id;
// tasks.user_id 外键指向 users：补种子用户（password_hash 非空即可，不走真实登录）
for (const u of ["owner-1", "stranger-1", "admin-1"]) {
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'test-hash', 'member', ?)").run(u, u, now());
}

const SKIN_CSS = ':root { --accent: #0ea5e9; }\n:root[data-theme="dark"] { --bg: #0b1220; }\n';

function writeTaskWorkspace(root: string, packId: string): string {
  const pack = path.join(root, "skin-pack");
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, "skin.json"), JSON.stringify({ id: packId, name: `任务皮肤 ${packId}`, version: "0.1.0" }));
  fs.writeFileSync(path.join(pack, "skin.css"), SKIN_CSS);
  fs.mkdirSync(path.join(pack, "assets"), { recursive: true });
  fs.writeFileSync(path.join(pack, "assets", "tex.svg"), "<svg/>");
  return root;
}

function insertTask(id: string, userId: string, workspacePath: string): void {
  db.prepare(
    "INSERT INTO tasks (id, user_id, agent_id, title, prompt, status, workspace_path, custom_workspace, created_at) VALUES (?, ?, ?, 't', 'p', 'completed', ?, 1, ?)"
  ).run(id, userId, agentId, workspacePath, now());
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "share-secret" });
  app.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  registerSkinRoutes(app);
  return {
    app,
    adminToken: app.jwt.sign({ sub: "admin-1", role: "admin" }),
    ownerToken: app.jwt.sign({ sub: "owner-1", role: "user" }),
    strangerToken: app.jwt.sign({ sub: "stranger-1", role: "user" }),
  };
}

describe("POST /skins/install-from-workspace", () => {
  it("任务所有者可安装工作区皮肤包，落地到皮肤目录", async () => {
    const ws = writeTaskWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-ws-")), "task-made");
    insertTask("task-share-1", "owner-1", ws);
    const { app, ownerToken } = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/skins/install-from-workspace",
        payload: { taskId: "task-share-1", path: "skin-pack" },
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(fs.readFileSync(path.join(paths.skins, "task-made", "skin.css"), "utf8"), SKIN_CSS);
      assert.ok(fs.existsSync(path.join(paths.skins, "task-made", "assets", "tex.svg")));
    } finally {
      await app.close();
    }
  });

  it("非所有者的普通成员 403，管理员可代装", async () => {
    const ws = writeTaskWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-ws2-")), "task-made-2");
    insertTask("task-share-2", "owner-1", ws);
    const { app, strangerToken, adminToken } = await buildApp();
    try {
      const forbidden = await app.inject({
        method: "POST",
        url: "/skins/install-from-workspace",
        payload: { taskId: "task-share-2" },
        headers: { authorization: `Bearer ${strangerToken}`, "content-type": "application/json" },
      });
      assert.equal(forbidden.statusCode, 403);

      const asAdmin = await app.inject({
        method: "POST",
        url: "/skins/install-from-workspace",
        payload: { taskId: "task-share-2" },
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      });
      assert.equal(asAdmin.statusCode, 201);
    } finally {
      await app.close();
    }
  });

  it("工作区没有皮肤包时 404", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-empty-"));
    insertTask("task-share-3", "owner-1", ws);
    const { app, ownerToken } = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/skins/install-from-workspace",
        payload: { taskId: "task-share-3" },
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe("GET /skins/:id/export", () => {
  it("导出 zip 可被解压回完整皮肤包（分享→上传回环）", async () => {
    const { app, ownerToken } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/skins/task-made/export",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "application/zip");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skin-roundtrip-"));
      unzipTo(res.rawPayload ? Buffer.from(res.rawPayload, "binary") : Buffer.from(res.body, "binary"), tmp);
      assert.equal(fs.readFileSync(path.join(tmp, "skin.css"), "utf8"), SKIN_CSS);
      assert.equal(fs.readFileSync(path.join(tmp, "assets", "tex.svg"), "utf8"), "<svg/>");
      fs.rmSync(tmp, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  });

  it("未知皮肤 404", async () => {
    const { app, ownerToken } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/skins/never-existed/export",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
