// kb-embed.test.ts：工作台代理必须原样转发登录密文，过期知识库凭证不能再注入窗口。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-kb-embed-test-"));

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { db, migrate } = await import("./db.js");
const { registerLenientJsonParser } = await import("./json-body.js");
const { registerKbEmbedRoutes } = await import("./kb-embed.js");

migrate();

interface Captured {
  url: string;
  method: string;
  body: string;
  encryptKey: string;
}

const captured: Captured[] = [];
let kbTokenValid = true;

const kbServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    captured.push({
      url: req.url ?? "",
      method: req.method ?? "",
      body,
      encryptKey: String(req.headers["encrypt-key"] ?? ""),
    });
    const url = req.url ?? "";
    if (url.endsWith("/api/system/user/getInfo")) {
      if (!kbTokenValid) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 401, msg: "认证失败" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: { roles: ["superadmin"], user: { userId: 1, userName: "admin", phoneNumber: "", nickName: "管" } },
        })
      );
      return;
    }
    if (url.includes("/api/auth/login")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { access_token: "new-token" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head></head><body>kb</body></html>");
  });
});

const app = Fastify();
registerLenientJsonParser(app);
await app.register(jwt, { secret: "test-secret" });
app.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "unauthorized" });
  }
});

before(async () => {
  await new Promise<void>((resolve) => kbServer.listen(0, "127.0.0.1", resolve));
  const addr = kbServer.address();
  if (!addr || typeof addr === "string") throw new Error("kb mock did not bind");
  process.env.KB_BASE_URL = `http://127.0.0.1:${addr.port}/new-general-rag-kb`;
  await registerKbEmbedRoutes(app);
  await app.ready();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, kb_user_id, phone, nick_name, kb_access_token)
     VALUES ('u1', 'admin', 'x', 'admin', 't', '1', '', '', 'kb-token')`
  ).run();
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) => kbServer.close((err) => (err ? reject(err) : resolve())));
});

function authHeader(): string {
  return `Bearer ${app.jwt.sign({ sub: "u1", role: "admin" })}`;
}

describe("知识库工作台代理", () => {
  it("转发 AES 密文登录体，而不是被父级 JSON 解析器丢掉", async () => {
    captured.length = 0;
    const ciphertext = "not-json-aes-ciphertext==";
    const res = await app.inject({
      method: "POST",
      url: "/new-general-rag-kb/api/auth/login",
      headers: {
        "content-type": "application/json;charset=utf-8",
        "encrypt-key": "rsa-blob",
        isToken: "false",
        clientid: "e5cd7e4891bf95d1d19206ce24a7b32e",
      },
      payload: ciphertext,
    });
    assert.equal(res.statusCode, 200, res.body);
    const hit = captured.find((c) => c.url.includes("/api/auth/login"));
    assert.ok(hit, "上游应收到登录请求");
    assert.equal(hit.body, ciphertext);
    assert.equal(hit.encryptKey, "rsa-blob");
  });

  it("JSON 请求体原样到达上游", async () => {
    captured.length = 0;
    const payload = JSON.stringify({ username: "admin", code: "ab12" });
    const res = await app.inject({
      method: "POST",
      url: "/new-general-rag-kb/api/knowledge/query",
      headers: { "content-type": "application/json" },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    const hit = captured.find((c) => c.url.includes("/api/knowledge/query"));
    assert.ok(hit);
    assert.equal(hit.body, payload);
  });

  it("知识库凭证失效时 ticket 返回 401，不发工作台入口", async () => {
    kbTokenValid = false;
    const res = await app.inject({
      method: "GET",
      url: "/kb-embed/ticket",
      headers: { authorization: authHeader() },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, "登录已过期，请重新登录");
    kbTokenValid = true;
  });

  it("知识库凭证有效时 ticket 可开，HTML 写入 Admin-Token", async () => {
    kbTokenValid = true;
    const ticketRes = await app.inject({
      method: "GET",
      url: "/kb-embed/ticket",
      headers: { authorization: authHeader() },
    });
    assert.equal(ticketRes.statusCode, 200, ticketRes.body);
    const ticket = ticketRes.json().ticket as string;
    assert.ok(ticket);
    const openRes = await app.inject({
      method: "GET",
      url: `/kb-embed/open?ticket=${ticket}`,
    });
    assert.equal(openRes.statusCode, 302);
    const location = String(openRes.headers.location);
    const page = await app.inject({ method: "GET", url: location });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /localStorage\.setItem\("Admin-Token","kb-token"\)/);
  });

  it("session 续期在凭证失效时返回 401", async () => {
    kbTokenValid = false;
    const res = await app.inject({
      method: "GET",
      url: "/kb-embed/session",
      headers: { authorization: authHeader() },
    });
    assert.equal(res.statusCode, 401);
    kbTokenValid = true;
  });
});
