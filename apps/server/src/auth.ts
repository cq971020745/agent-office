import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@office/shared";
import { db, now, uuid } from "./db.js";
import type { KbSession } from "./kb-auth.js";
import { ensureTextInProvider } from "./textin-provider.js";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function createUser(username: string, password: string, role: Role) {
  const id = uuid();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, username, hashPassword(password), role, now());
  return { id, username, role };
}

export function getUserByUsername(username: string) {
  return db
    .prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?")
    .get(username) as { id: string; username: string; password_hash: string; role: Role } | undefined;
}

export function getUserById(id: string) {
  return db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(id) as
    | { id: string; username: string; role: Role }
    | undefined;
}

export function getPasswordHashById(id: string): string | undefined {
  return (db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as
    | { password_hash?: string }
    | undefined)?.password_hash;
}

export function updatePassword(id: string, password: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), id);
}

// @fastify/jwt 把 JWT 载荷放在 req.user 上；我们签发的是 { sub: userId, role }
type AuthedRequest = FastifyRequest & { user?: { sub?: string; role?: Role } };

export function currentUser(req: FastifyRequest): { id: string; role: Role } {
  const payload = (req as AuthedRequest).user;
  return { id: payload?.sub ?? "", role: payload?.role ?? "member" };
}

/** 按企业知识库用户编号建立或更新本应用登录身份。密码不在本地校验。 */
export function upsertKbUser(session: KbSession): { id: string; username: string; role: Role } {
  const role: Role = session.roleKeys.includes("superadmin") ? "admin" : "member";
  const existing = db.prepare("SELECT id FROM users WHERE kb_user_id = ?").get(session.userId) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare(
      "UPDATE users SET username = ?, role = ?, phone = ?, nick_name = ?, kb_access_token = ? WHERE id = ?"
    ).run(session.userName, role, session.phone, session.nickName, session.accessToken, existing.id);
    if (role === "admin") claimOrphanProviders(existing.id);
    ensureTextInProvider(existing.id);
    return { id: existing.id, username: session.userName, role };
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, kb_user_id, phone, nick_name, kb_access_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    session.userName,
    hashPassword(randomBytes(24).toString("hex")),
    role,
    now(),
    session.userId,
    session.phone,
    session.nickName,
    session.accessToken
  );
  if (role === "admin") {
    claimOrphanProviders(id);
    claimOrphanConnectors(id);
  }
  ensureTextInProvider(id);
  return { id, username: session.userName, role };
}

/** 切换前留下的全局供应商，整份交给当前这位超级管理员。 */
export function claimOrphanProviders(userId: string): void {
  db.prepare("UPDATE model_providers SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(userId);
}

/** 切换前留下的全局连接器，整份交给当前这位超级管理员。 */
export function claimOrphanConnectors(userId: string): void {
  db.prepare("UPDATE mcp_servers SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(userId);
}

export function getUserPhone(id: string): string {
  const row = db.prepare("SELECT phone FROM users WHERE id = ?").get(id) as { phone?: string | null } | undefined;
  return row?.phone ?? "";
}

export function getKbAccessToken(id: string): string {
  const row = db.prepare("SELECT kb_access_token FROM users WHERE id = ?").get(id) as
    | { kb_access_token?: string | null }
    | undefined;
  return row?.kb_access_token ?? "";
}

export function listKbAccessTokens(): { id: string; token: string }[] {
  return db
    .prepare("SELECT id, kb_access_token AS token FROM users WHERE kb_access_token != ''")
    .all() as { id: string; token: string }[];
}

export function saveKbMcpApiKey(id: string, key: string): void {
  db.prepare("UPDATE users SET kb_mcp_api_key = ? WHERE id = ?").run(key, id);
}

export function getKbMcpApiKey(id: string): string {
  const row = db.prepare("SELECT kb_mcp_api_key FROM users WHERE id = ?").get(id) as
    | { kb_mcp_api_key?: string | null }
    | undefined;
  const key = row?.kb_mcp_api_key ?? "";
  return key.startsWith("kb_") ? key : "";
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const user = (req as AuthedRequest).user;
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  if (user.role !== "admin") {
    reply.code(403).send({ error: "forbidden" });
    return;
  }
  done();
}
