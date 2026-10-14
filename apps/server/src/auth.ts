import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, now, uuid } from "./db.js";
import type { Role } from "@office/shared";

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
