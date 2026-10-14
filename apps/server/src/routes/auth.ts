import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  countUsers,
  createUser,
  currentUser,
  getUserByUsername,
  updatePassword,
  verifyPassword,
} from "../auth.js";

// 登录限流：同一 用户名+IP 在窗口内连续失败达上限后锁定一个窗口时长（进程内实现，重启即清零）
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 10 * 60_000;

interface LoginFailEntry {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const loginFails = new Map<string, LoginFailEntry>();

function loginKey(username: string, ip: string): string {
  return `${username.toLowerCase()}|${ip}`;
}

/** 返回剩余锁定秒数；0 表示未锁定。窗口过期则顺手清掉旧记录。 */
function loginLockedFor(key: string): number {
  const entry = loginFails.get(key);
  if (!entry) return 0;
  const nowMs = Date.now();
  if (entry.lockedUntil > nowMs) return Math.ceil((entry.lockedUntil - nowMs) / 1000);
  if (nowMs - entry.windowStart > LOGIN_WINDOW_MS) loginFails.delete(key);
  return 0;
}

function recordLoginFail(key: string): void {
  const nowMs = Date.now();
  const entry = loginFails.get(key);
  if (!entry || nowMs - entry.windowStart > LOGIN_WINDOW_MS) {
    loginFails.set(key, { count: 1, windowStart: nowMs, lockedUntil: 0 });
  } else {
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_FAILS) entry.lockedUntil = nowMs + LOGIN_WINDOW_MS;
  }
  // 粗粒度防膨胀：只在超阈值时全量清理一次过期记录
  if (loginFails.size > 1000) {
    for (const [k, e] of loginFails) {
      if (e.lockedUntil < nowMs && nowMs - e.windowStart > LOGIN_WINDOW_MS) loginFails.delete(k);
    }
  }
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post("/auth/register", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: "username and password required" });
    if (getUserByUsername(username)) return reply.code(409).send({ error: "username taken" });
    if (countUsers() > 0) {
      return reply.code(403).send({ error: "registration is closed; ask an admin to create your account" });
    }
    const user = createUser(username, password, "admin");
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return reply.send({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post("/auth/login", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const key = loginKey(username ?? "", req.ip);
    const lockedFor = loginLockedFor(key);
    if (lockedFor > 0) {
      return reply
        .code(429)
        .send({ error: `登录失败次数过多，请 ${Math.ceil(lockedFor / 60)} 分钟后再试` });
    }
    const user = username ? getUserByUsername(username) : undefined;
    if (!user || !password || !verifyPassword(password, user.password_hash)) {
      recordLoginFail(key);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    loginFails.delete(key);
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return reply.send({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  // 修改当前登录用户的密码：不要求旧密码（能持有有效登录态即可改，忘记原密码是常态）；
  // JWT 无状态，改密后旧 token 仍有效至过期
  app.post("/auth/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { newPassword } = (req.body ?? {}) as { newPassword?: string };
    if (!newPassword) {
      return reply.code(400).send({ error: "new password is required" });
    }
    if (newPassword.length < 6) {
      return reply.code(400).send({ error: "new password too short (min 6)" });
    }
    const { id } = currentUser(req);
    updatePassword(id, newPassword);
    return reply.send({ ok: true });
  });
}
