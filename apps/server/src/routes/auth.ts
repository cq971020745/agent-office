import type { FastifyInstance } from "fastify";
import { currentUser, saveKbMcpApiKey, upsertKbUser } from "../auth.js";
import { fetchKbMcpApiKey, loadKbCaptcha, loginKbAccount } from "../kb-auth.js";

const GONE = "密码由企业知识库管理，本应用不再注册或修改密码";

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
  if (loginFails.size > 1000) {
    for (const [k, e] of loginFails) {
      if (e.lockedUntil < nowMs && nowMs - e.windowStart > LOGIN_WINDOW_MS) loginFails.delete(k);
    }
  }
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/captcha", async (_req, reply) => {
    try {
      return await loadKbCaptcha();
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "无法获取验证码" });
    }
  });

  app.post("/auth/register", async (_req, reply) => {
    return reply.code(410).send({ error: GONE });
  });

  app.post("/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; code?: string; uuid?: string };
    const username = body.username?.trim() ?? "";
    const password = body.password ?? "";
    if (!username || !password) {
      return reply.code(400).send({ error: "username and password required" });
    }
    const key = loginKey(username, req.ip);
    const lockedFor = loginLockedFor(key);
    if (lockedFor > 0) {
      return reply
        .code(429)
        .send({ error: `登录失败次数过多，请 ${Math.ceil(lockedFor / 60)} 分钟后再试` });
    }
    try {
      const session = await loginKbAccount({
        username,
        password,
        code: body.code,
        uuid: body.uuid,
      });
      loginFails.delete(key);
      const user = upsertKbUser(session);
      try {
        const mcpKey = await fetchKbMcpApiKey(session.accessToken);
        if (mcpKey) saveKbMcpApiKey(user.id, mcpKey);
      } catch {
        console.warn("[auth] 未能读取当前用户的知识库 MCP API Key");
      }
      const token = app.jwt.sign({ sub: user.id, role: user.role });
      return reply.send({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      recordLoginFail(key);
      const message = err instanceof Error ? err.message : "登录失败";
      return reply.code(401).send({ error: message });
    }
  });

  app.post("/auth/reset-password", async (_req, reply) => {
    return reply.code(410).send({ error: GONE });
  });

  app.post("/auth/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
    currentUser(req);
    return reply.code(410).send({ error: GONE });
  });
}
