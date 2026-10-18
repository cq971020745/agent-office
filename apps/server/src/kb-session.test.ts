import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-kb-session-test-"));

const { db, migrate } = await import("./db.js");
migrate();
const { renewStoredKbSessions } = await import("./kb-session.js");

const seen: string[] = [];
const kbServer = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  const auth = String(req.headers.authorization ?? "");
  if (auth.includes("dead")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 401, msg: "认证失败" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      code: 200,
      data: { roles: ["superadmin"], user: { userId: 1, userName: "admin" } },
    })
  );
});

before(async () => {
  await new Promise<void>((resolve) => kbServer.listen(0, "127.0.0.1", resolve));
  const addr = kbServer.address();
  if (!addr || typeof addr === "string") throw new Error("kb mock did not bind");
  process.env.KB_BASE_URL = `http://127.0.0.1:${addr.port}/new-general-rag-kb`;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, kb_user_id, phone, nick_name, kb_access_token)
     VALUES ('alive', 'a', 'x', 'member', 't', '1', '', '', 'live-token'),
            ('dead', 'b', 'x', 'member', 't', '2', '', '', 'dead-token'),
            ('none', 'c', 'x', 'member', 't', '3', '', '', '')`
  ).run();
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    kbServer.close((err) => (err ? reject(err) : resolve()));
    kbServer.closeAllConnections?.();
  });
});

describe("知识库会话续期", () => {
  it("只对仍存有访问凭证的用户向知识库 getInfo", async () => {
    seen.length = 0;
    const result = await renewStoredKbSessions();
    assert.equal(result.ok, 1);
    assert.equal(result.expired, 1);
    assert.equal(result.failed, 0);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((line) => line.includes("/api/system/user/getInfo")));
  });
});
