import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser, getKbAccessToken } from "./auth.js";
import { KbAuthError, kbBaseUrl, loadKbSession } from "./kb-auth.js";

const tickets = new Map<string, { userId: string; exp: number }>();
const sessions = new Map<string, { userId: string; exp: number }>();
const TICKET_MS = 2 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;

function prune(map: Map<string, { exp: number }>): void {
  const nowMs = Date.now();
  for (const [key, value] of map) {
    if (value.exp <= nowMs) map.delete(key);
  }
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function rewriteLocation(location: string): string {
  try {
    const base = new URL(kbBaseUrl());
    if (location.startsWith(base.origin)) return location.slice(base.origin.length) || "/";
  } catch {
    // 知识库地址配置非法时原样返回
  }
  return location;
}

/** 打开工作台或续期前确认知识库访问凭证仍有效；401 让客户端回本应用登录页。 */
async function ensureKbAccessToken(
  userId: string
): Promise<{ token: string } | { error: string; status: number }> {
  const token = getKbAccessToken(userId);
  if (!token) return { error: "登录已过期，请重新登录", status: 401 };
  try {
    await loadKbSession(token);
    return { token };
  } catch (err) {
    if (err instanceof KbAuthError) return { error: "登录已过期，请重新登录", status: 401 };
    return { error: err instanceof Error ? err.message : "企业知识库暂时无法验证登录", status: 502 };
  }
}

export async function registerKbEmbedRoutes(app: FastifyInstance): Promise<void> {
  app.get("/kb-embed/session", { onRequest: [app.authenticate] }, async (req, reply) => {
    const result = await ensureKbAccessToken(currentUser(req).id);
    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    return { ok: true };
  });

  app.get("/kb-embed/ticket", { onRequest: [app.authenticate] }, async (req, reply) => {
    const result = await ensureKbAccessToken(currentUser(req).id);
    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    prune(tickets);
    const ticket = crypto.randomBytes(24).toString("hex");
    tickets.set(ticket, { userId: currentUser(req).id, exp: Date.now() + TICKET_MS });
    return { ticket };
  });

  app.get("/kb-embed/open", async (req, reply) => {
    prune(tickets);
    prune(sessions);
    const ticket = String((req.query as { ticket?: string }).ticket ?? "");
    const hit = tickets.get(ticket);
    if (!hit || hit.exp <= Date.now()) {
      return reply.code(401).send({ error: "工作台入口已失效，请重新打开" });
    }
    tickets.delete(ticket);
    const sid = crypto.randomBytes(24).toString("hex");
    sessions.set(sid, { userId: hit.userId, exp: Date.now() + SESSION_MS });
    reply.header(
      "set-cookie",
      `kb_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`
    );
    // 开发时页面在 localhost:38618，窗口在 127.0.0.1:38617，跨站窗口存不住 Cookie。
    // 把会话编号放进首个页面地址，由代理写入知识库自己的登录态。
    return reply.redirect(`/new-general-rag-kb/knowledge?kb_sid=${sid}`);
  });

  await app.register(
    async (child) => {
      // 知识库登录体是 AES 密文，Content-Type 却是 application/json。
      // 父级宽松 JSON 解析器会把密文判成坏 JSON（400），或把 JSON 解析成对象后被代理丢掉（上游 500）。
      child.removeContentTypeParser("application/json");
      child.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
        done(null, body);
      });
      child.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
        done(null, body);
      });
      child.route({
        method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        url: "/*",
        handler: proxyKb,
      });
    },
    { prefix: "/new-general-rag-kb" }
  );
}

function kbSidFrom(req: FastifyRequest): string {
  const fromQuery = (req.query as { kb_sid?: string } | undefined)?.kb_sid;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  return readCookie(req.headers.cookie, "kb_sid");
}

function upstreamUrlFor(reqUrl: string): string {
  const base = new URL(kbBaseUrl());
  const local = new URL(reqUrl, "http://127.0.0.1");
  local.searchParams.delete("kb_sid");
  return `${base.origin}${local.pathname}${local.search}`;
}

function proxyBody(req: FastifyRequest): Uint8Array | undefined {
  if (["GET", "HEAD"].includes(req.method)) return undefined;
  const body = req.body;
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) {
    return body.length ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined;
  }
  if (body instanceof Uint8Array) return body.byteLength ? body : undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body), "utf8");
}

const SKIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  // 由 Node fetch 自己协商压缩，避免上游用浏览器声明的 zstd 等而响应被剥掉 Content-Encoding
  "accept-encoding",
]);

async function proxyKb(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const upstreamUrl = upstreamUrlFor(req.url);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (SKIP_REQ_HEADERS.has(lower)) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const raw = proxyBody(req);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      // Node fetch 的 BodyInit 与 TS lib 的 Uint8Array 泛型偶发不兼容，拷成独立 ArrayBuffer 视图
      body: raw ? new Uint8Array(raw) : undefined,
      redirect: "manual",
    });
  } catch (err) {
    await reply.code(502).send({ error: err instanceof Error ? err.message : "知识库工作台暂时无法打开" });
    return;
  }

  reply.code(upstream.status);
  const skip = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "set-cookie",
    "x-frame-options",
    "content-security-policy",
  ]);
  upstream.headers.forEach((value, key) => {
    if (skip.has(key.toLowerCase())) return;
    if (key.toLowerCase() === "location") {
      reply.header(key, rewriteLocation(value));
      return;
    }
    reply.header(key, value);
  });
  const setCookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  if (setCookies.length) {
    reply.header(
      "set-cookie",
      setCookies.map((cookie) => cookie.replace(/;\s*domain=[^;]*/i, ""))
    );
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const type = upstream.headers.get("content-type") ?? "";
  if (type.includes("text/html")) {
    const sid = kbSidFrom(req);
    const session = sessions.get(sid);
    const token = session && session.exp > Date.now() ? getKbAccessToken(session.userId) : "";
    if (session && session.exp > Date.now()) {
      // 凭证失效时清掉窗口里的旧 Admin-Token，避免知识库拿过期令牌去 getInfo，弹出「系统未知错误」再落到它自己的登录页。
      const script = token
        ? `<script>try{localStorage.setItem("Admin-Token",${JSON.stringify(token)});var u=new URL(location.href);if(u.searchParams.has("kb_sid")){u.searchParams.delete("kb_sid");history.replaceState(null,"",u.pathname+u.search+u.hash)}}catch(e){}</script>`
        : `<script>try{localStorage.removeItem("Admin-Token");var u=new URL(location.href);if(u.searchParams.has("kb_sid")){u.searchParams.delete("kb_sid");history.replaceState(null,"",u.pathname+u.search+u.hash)}}catch(e){}</script>`;
      const html = buf.toString("utf8").replace("</head>", `${script}</head>`);
      await reply.send(html);
      return;
    }
  }
  await reply.send(buf);
}
