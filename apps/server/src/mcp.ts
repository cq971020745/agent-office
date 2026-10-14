import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { db } from "./db.js";

/**
 * 极简 MCP stdio 客户端：与配置的 MCP 服务器建立 JSON-RPC（按行分帧）连接，
 * 完成 initialize 握手后把 tools/list 的工具映射为 pi 自定义工具注入会话。
 * pi 本身不内置 MCP，这里在平台层补齐。
 */

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

export interface McpToolInfo {
  name: string;
  description: string;
  /** MCP inputSchema 原样透传（pi 工具入参校验依赖它） */
  inputSchema?: Record<string, unknown> | null;
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private exitHandlers: ((err: Error) => void)[] = [];

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly startupTimeoutSec = 10,
    private readonly toolTimeoutSec = 60
  ) {}

  private spawnProc(): ChildProcessWithoutNullStreams {
    const env = { ...process.env, ...this.env } as NodeJS.ProcessEnv;
    // Windows 下 npx/uvx 等是 .cmd，需要 shell；含空格的参数自行加引号
    const shell = process.platform === "win32";
    const safeArgs = shell ? this.args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : this.args;
    const proc = spawn(this.command, safeArgs, {
      shell,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) console.log(`[mcp] ${this.command} stderr: ${line.slice(0, 2000)}`);
    });
    proc.on("exit", (code, signal) => {
      console.log(`[mcp] ${this.command} exited: code=${code} signal=${signal}`);
      this.proc = null;
      const err = new Error("MCP 服务器进程已退出");
      for (const [id, p] of this.pending) {
        p.reject(err);
        this.pending.delete(id);
      }
      for (const h of this.exitHandlers) h(err);
      this.exitHandlers = [];
    });
    return proc;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number | string; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非JSON行忽略
      }
      if (typeof msg.id !== "number") continue; // 通知/请求忽略
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error?.message ?? "MCP 请求失败"));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown, timeoutSec = this.toolTimeoutSec): Promise<unknown> {
    const proc = this.proc ?? (this.proc = this.spawnProc());
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutSec}s）`));
      }, timeoutSec * 1000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        proc.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const proc = this.proc ?? (this.proc = this.spawnProc());
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // 通知失败不致命
    }
  }

  /** 握手 + 返回工具列表（含 inputSchema 透传）。serverName 仅用于显示。 */
  async listTools(): Promise<McpToolInfo[]> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-office", version: "1.0.0" },
      },
      this.startupTimeoutSec
    );
    this.notify("notifications/initialized", {});
    const res = (await this.request("tools/list", {})) as {
      tools?: { name?: string; description?: string; inputSchema?: unknown }[];
    };
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools
      .filter((t) => typeof t?.name === "string" && t.name)
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
            ? (t.inputSchema as Record<string, unknown>)
            : null,
      }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  onExit(handler: (err: Error) => void): void {
    this.exitHandlers.push(handler);
  }

  close(): void {
    this.proc?.removeAllListeners("exit");
    try {
      this.proc?.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
  }
}

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: number;
  type?: string;
  url?: string;
  headers?: string;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  disabled_tools?: string;
}

/** stdio 与 streamable HTTP 客户端的公共接口。 */
interface McpClientLike {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): void;
}

/**
 * 头部值里的 ${ENV_NAME} 展开为环境变量（未设置则为空串）。
 * 对齐 Codex bearer_token_env_var：令牌不落库，库里只存环境变量引用。
 */
export function expandHeaderEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * 极简 MCP streamable HTTP 客户端（P2-1）：POST JSON-RPC 到远端 URL，
 * Accept 同时声明 JSON 与 SSE；响应可能是普通 JSON、SSE 事件流或 202（通知）。
 * 会话以 mcp-session-id 响应头维系，后续请求自动带上。
 */
export class McpHttpClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly startupTimeoutSec = 10,
    private readonly toolTimeoutSec = 60
  ) {}

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    for (const [k, v] of Object.entries(this.headers)) h[k] = expandHeaderEnv(v);
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async request(method: string, params: unknown, timeoutSec: number): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 300)}` : ""}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return this.readSseResponse(res, id, timeoutSec);
    const text = await res.text();
    if (!text.trim()) return null; // 通知类请求的 202/空体
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new Error("响应不是合法 JSON");
    }
    if (msg.error) throw new Error(msg.error.message ?? "MCP 请求失败");
    return msg.result;
  }

  /** 逐行解析 SSE 事件流，取回与请求 id 匹配的那条 JSON-RPC 响应。 */
  private async readSseResponse(res: { body: ReadableStream<Uint8Array> | null }, id: number, timeoutSec: number): Promise<unknown> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("SSE 响应流为空");
    const decoder = new TextDecoder();
    let buffer = "";
    let result: unknown;
    let found = false;
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
    }, timeoutSec * 1000);
    try {
      while (!found) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0 && !found) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let msg: JsonRpcResponse;
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }
          if (msg.id !== id) continue; // 别的请求的响应/服务器通知
          if (msg.error) throw new Error(msg.error.message ?? "MCP 请求失败");
          result = msg.result;
          found = true;
        }
      }
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
    if (!found) throw new Error("SSE 流在返回响应前结束");
    return result;
  }

  /** JSON-RPC 通知（无 id）：服务器返回 202/空体即视为成功，失败不致命。 */
  private async notify(method: string, params: unknown): Promise<void> {
    try {
      await fetch(this.url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(this.startupTimeoutSec * 1000),
      });
    } catch {
      // 通知失败不致命
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-office", version: "1.0.0" },
      },
      this.startupTimeoutSec
    );
    await this.notify("notifications/initialized", {});
    const res = (await this.request("tools/list", {}, this.toolTimeoutSec)) as {
      tools?: { name?: string; description?: string; inputSchema?: unknown }[];
    };
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools
      .filter((t) => typeof t?.name === "string" && t.name)
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
            ? (t.inputSchema as Record<string, unknown>)
            : null,
      }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, this.toolTimeoutSec);
  }

  close(): void {
    // 尽力通知服务端结束会话；失败不影响本地释放
    if (this.sessionId) {
      void fetch(this.url, {
        method: "DELETE",
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
    this.sessionId = null;
  }
}

function parseJsonArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, string> {
  try {
    const obj = JSON.parse(raw || "{}");
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

const clients = new Map<string, McpClientLike>();

function getClient(serverId: string, row: McpServerRow): McpClientLike {
  const existing = clients.get(serverId);
  if (existing) return existing;
  let client: McpClientLike;
  if (row.type === "http") {
    if (!row.url) throw new Error("HTTP 连接器缺少 url");
    client = new McpHttpClient(
      row.url,
      parseJsonObject(row.headers ?? "{}"),
      clampTimeout(row.startup_timeout_sec, 10),
      clampTimeout(row.tool_timeout_sec, 60)
    );
  } else {
    const stdio = new McpClient(
      row.command,
      parseJsonArray(row.args),
      parseJsonObject(row.env),
      clampTimeout(row.startup_timeout_sec, 10),
      clampTimeout(row.tool_timeout_sec, 60)
    );
    stdio.onExit(() => {
      // 进程意外退出后移除缓存，下次调用自动重启
      if (clients.get(serverId) === stdio) clients.delete(serverId);
    });
    client = stdio;
  }
  clients.set(serverId, client);
  return client;
}

/** 超时秒数合法性收敛：非正数/非有限值回退默认（启动 10s，工具调用 60s，对齐 Codex 约定）。 */
export function clampTimeout(value: number | undefined, dflt: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : dflt;
}

/** 配置变更（命令/参数/环境/超时/启停）后必须调用：丢弃旧进程与缓存，下次调用按新配置重连。 */
export function invalidateMcpClient(serverId: string): void {
  closeMcpClient(serverId);
}

export function closeMcpClient(serverId: string): void {
  clients.get(serverId)?.close();
  clients.delete(serverId);
}

/** 连接指定服务器并返回工具列表（不缓存结果，供「测试连接」用）。 */
export async function probeMcpTools(row: McpServerRow): Promise<McpToolInfo[]> {
  const client = getClient(row.id, row);
  try {
    return await client.listTools();
  } catch (err) {
    // 握手失败：丢弃旧进程，下次重连
    closeMcpClient(row.id);
    throw err;
  }
}

/**
 * 把所有启用的 MCP 服务器工具映射为 pi 自定义工具（跳过 disabled_tools 里点名的工具）。
 * 单个服务器失败只打日志，不影响其余工具与其他任务。
 */
export async function getMcpTools(): Promise<ToolDefinition[]> {
  const rows = db
    .prepare(
      "SELECT id, name, command, args, env, enabled, type, url, headers, startup_timeout_sec, tool_timeout_sec, disabled_tools FROM mcp_servers WHERE enabled = 1"
    )
    .all() as unknown as McpServerRow[];
  const tools: ToolDefinition[] = [];
  for (const row of rows) {
    try {
      const client = getClient(row.id, row);
      const disabled = new Set(parseJsonArray(row.disabled_tools ?? "[]"));
      const list = (await client.listTools()).filter((t) => !disabled.has(t.name));
      for (const t of list) {
        tools.push(mcpToolToDefinition(row.name, t, () => client));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[mcp] 服务器 ${row.name} 不可用：${reason}`);
      closeMcpClient(row.id);
    }
  }
  return tools;
}

/** 把一个 MCP 工具包装成 pi ToolDefinition；getClientFn 用于进程被杀后自动重连。 */
function mcpToolToDefinition(
  serverName: string,
  tool: McpToolInfo,
  getClientFn: () => McpClientLike
): ToolDefinition {
  const toolSafe = (s: string): string => s.replace(/[^\w-]/g, "_");
  const fullName = `mcp_${toolSafe(serverName)}_${toolSafe(tool.name)}`.slice(0, 64);
  const rawSchema = tool.inputSchema;
  const parameters = Type.Unsafe(
    (rawSchema && typeof rawSchema === "object" ? rawSchema : { type: "object", properties: {} }) as never
  );
  return {
    name: fullName,
    label: tool.name,
    description: tool.description ? `[MCP·${serverName}] ${tool.description}` : `[MCP·${serverName}] ${tool.name}`,
    parameters,
    execute: async (_id, args) => {
      const res = (await getClientFn().callTool(tool.name, args)) as {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
      };
      const parts = Array.isArray(res?.content) ? res.content : [];
      const text = parts
        .map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      const output = text ? truncate(text) : "工具执行完成（无文本输出）";
      if (res?.isError) throw new Error(output);
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  };
}

function truncate(text: string): string {
  const MAX_LINES = 2000;
  const MAX_BYTES = 50 * 1024;
  const lines = text.split("\n");
  const kept = lines.slice(0, MAX_LINES).join("\n").slice(0, MAX_BYTES);
  if (kept.length === text.length) return kept;
  return `${kept}\n[truncated]`;
}

/** mcp_servers 行 → DTO（tools 字符串列解析为对象数组）。 */
export interface McpServerParsed {
  id: string;
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  tools: McpToolInfo[];
  toolsCheckedAt: string | null;
  disabledTools: string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  createdAt: string;
}

export function toMcpDto(row: {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: number;
  type?: string;
  url?: string;
  headers?: string;
  tools: string;
  tools_checked_at: string | null;
  disabled_tools?: string;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  created_at: string;
}): McpServerParsed {
  let tools: McpToolInfo[] = [];
  try {
    const arr = JSON.parse(row.tools || "[]");
    if (Array.isArray(arr)) {
      tools = arr.filter((t): t is McpToolInfo => !!t && typeof t === "object" && typeof (t as McpToolInfo).name === "string");
    }
  } catch {
    // keep empty
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type === "http" ? "http" : "stdio",
    command: row.command,
    args: parseJsonArray(row.args),
    env: parseJsonObject(row.env),
    url: row.url ?? "",
    headers: parseJsonObject(row.headers ?? "{}"),
    enabled: !!row.enabled,
    tools,
    toolsCheckedAt: row.tools_checked_at,
    disabledTools: parseJsonArray(row.disabled_tools ?? "[]"),
    startupTimeoutSec: clampTimeout(row.startup_timeout_sec, 10),
    toolTimeoutSec: clampTimeout(row.tool_timeout_sec, 60),
    createdAt: row.created_at,
  };
}

