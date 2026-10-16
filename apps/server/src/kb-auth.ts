import crypto from "node:crypto";

/** 企业知识库前端内置的登录加密公钥（RSA PKCS1），与页面登录同一套。 */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDvEDuRIOM3oZPWj9Ukoc5pQklR4PFH6/clnjeFqjDLIgDyQvjxhgqAZQA+E9eD6qu6FsXPmK8djcL+nh3cFHz4pX473jDvO3Sve+8yL3VRQ0n2pRgQ2a01MJsy+WwTZCBYWf0VnLRIvANUoWQgy9vz94q7Va44dg7A1/3ICf+xAwIDAQAB
-----END PUBLIC KEY-----`;

export const KB_CLIENT_ID = "e5cd7e4891bf95d1d19206ce24a7b32e";

export function kbBaseUrl(): string {
  return (process.env.KB_BASE_URL ?? "http://10.50.11.17/new-general-rag-kb").replace(/\/+$/, "");
}

export interface KbCaptcha {
  enabled: boolean;
  uuid: string;
  img: string;
}

export interface KbSession {
  accessToken: string;
  userId: string;
  userName: string;
  phone: string;
  nickName: string;
  /** 含 superadmin 时本应用记为管理员 */
  roleKeys: string[];
}

interface KbEnvelope {
  code?: number;
  msg?: string;
  data?: unknown;
}

function aesKey(): Buffer {
  // 与知识库前端一致：32 个十六进制字符，按 UTF-8 当作 AES-256 密钥
  return Buffer.from(crypto.randomBytes(32).toString("hex").slice(0, 32), "utf8");
}

function encryptBody(plain: string, key: Buffer): string {
  const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

function encryptKeyHeader(key: Buffer): string {
  return crypto
    .publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(key.toString("base64"), "utf8"))
    .toString("base64");
}

async function kbFetch(path: string, init: RequestInit = {}): Promise<KbEnvelope> {
  const res = await fetch(`${kbBaseUrl()}/api${path}`, init);
  const text = await res.text();
  let body: KbEnvelope;
  try {
    body = JSON.parse(text) as KbEnvelope;
  } catch {
    throw new Error(text.slice(0, 200) || `知识库返回了无法解析的响应（HTTP ${res.status}）`);
  }
  if (body.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || `知识库请求失败（${body.code}）`);
  }
  return body;
}

export async function fetchKbCaptcha(): Promise<KbCaptcha> {
  const body = await kbFetch("/auth/code", {
    headers: { clientid: KB_CLIENT_ID, isToken: "false" },
  });
  const data = (body.data ?? {}) as { captchaEnabled?: boolean; uuid?: string; img?: string };
  return {
    enabled: data.captchaEnabled !== false,
    uuid: data.uuid ?? "",
    img: data.img ?? "",
  };
}

export async function loginKb(input: {
  username: string;
  password: string;
  code?: string;
  uuid?: string;
}): Promise<KbSession> {
  const payload = JSON.stringify({
    username: input.username,
    password: input.password,
    code: input.code ?? "",
    uuid: input.uuid ?? "",
    clientId: KB_CLIENT_ID,
    grantType: "password",
  });
  const key = aesKey();
  const body = await kbFetch("/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=utf-8",
      clientid: KB_CLIENT_ID,
      isToken: "false",
      "encrypt-key": encryptKeyHeader(key),
    },
    body: encryptBody(payload, key),
  });
  const accessToken = (body.data as { access_token?: string } | undefined)?.access_token;
  if (!accessToken) throw new Error("知识库登录未返回访问凭证");
  return loadKbSession(accessToken);
}

type KbLoginFn = typeof loginKb;
type KbCaptchaFn = typeof fetchKbCaptcha;
let kbLoginImpl: KbLoginFn = loginKb;
let kbCaptchaImpl: KbCaptchaFn = fetchKbCaptcha;

/** 测试注入：传入 null 恢复真实知识库请求。 */
export function setKbLoginForTests(fn: KbLoginFn | null): void {
  kbLoginImpl = fn ?? loginKb;
}

export function setKbCaptchaForTests(fn: KbCaptchaFn | null): void {
  kbCaptchaImpl = fn ?? fetchKbCaptcha;
}

export function loginKbAccount(input: Parameters<typeof loginKb>[0]): Promise<KbSession> {
  return kbLoginImpl(input);
}

export function loadKbCaptcha(): Promise<KbCaptcha> {
  return kbCaptchaImpl();
}

export async function loadKbSession(accessToken: string): Promise<KbSession> {
  const body = await kbFetch("/system/user/getInfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      clientid: KB_CLIENT_ID,
    },
  });
  const data = (body.data ?? {}) as {
    roles?: string[];
    user?: { userId?: string | number; userName?: string; phoneNumber?: string; nickName?: string };
  };
  const user = data.user;
  if (!user?.userId || !user.userName) throw new Error("知识库未返回用户信息");
  return {
    accessToken,
    userId: String(user.userId),
    userName: user.userName,
    phone: user.phoneNumber ?? "",
    nickName: user.nickName ?? "",
    roleKeys: Array.isArray(data.roles) ? data.roles.map(String) : [],
  };
}
