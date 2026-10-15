// 后端 API 访问封装：token 存 localStorage，事件流走 EventSource(?token=)。
import type {
  AgentConfig,
  AgentPackInfo,
  AgentPackInstallResult,
  AgentTaskWithDeliverables,
  AuthResponse,
  Deliverable,
  GeneratedAgent,
  GenerateAgentRequest,
  McpServerConfig,
  ModelOption,
  ModelOverride,
  PagedTasks,
  CreateScheduledTaskRequest,
  ScheduledTask,
  UpdateScheduledTaskRequest,
  SlashSkill,
  SkillDetail,
  SkillInfo,
  SkillInstallResult,
  SkillsCatalog,
  SkillUpdateInfo,
  SkillUsageInfo,
  Task,
  TaskEventEnvelope,
  TaskMessage,
  ToolApprovalDecision,
  ToolPolicy,
  WpsContacts,
  WpsMention,
  WpsMentionSearch,
  WpsProfile,
} from "@office/shared";
import { toast } from "./composables/toast";

export const API_BASE = "http://127.0.0.1:8787";

const TOKEN_KEY = "agent-office-token";
const USERNAME_KEY = "agent-office-username";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getUsername(): string {
  return localStorage.getItem(USERNAME_KEY) ?? "";
}

export function setUsername(username: string): void {
  if (username) localStorage.setItem(USERNAME_KEY, username);
  else localStorage.removeItem(USERNAME_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${getToken()}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (typeof init.body === "string") {
    // 只在确有请求体时声明 JSON：Fastify 拒绝「Content-Type: json 但 body 为空」的请求（DELETE 等无体调用）
    headers["content-type"] = "application/json";
  }
  // FormData 由浏览器自动生成带 boundary 的 content-type，不能手工指定
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    // 会话过期：清空本地凭证并回登录页（登录/注册接口本身的 401 不走这里）
    if (res.status === 401 && getToken() && !path.startsWith("/auth/")) {
      setToken("");
      setUsername("");
      toast("error", "登录已过期，请重新登录");
      if (!location.hash.startsWith("#/login")) location.hash = "#/login";
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

export function login(username: string, password: string) {
  return request<AuthResponse>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export function register(username: string, password: string) {
  return request<AuthResponse>("/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
}

/** 登录页忘记密码：仅本机可按用户名设置新密码，成功后直接登录。 */
export function resetPassword(username: string, newPassword: string) {
  return request<AuthResponse>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ username, newPassword }),
  });
}

/** 修改当前登录用户的密码（无需旧密码，凭当前登录态即可改）。 */
export function changePassword(newPassword: string) {
  return request<{ ok: true }>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ newPassword }),
  });
}

export function listAgents() {
  return request<AgentConfig[]>("/agents");
}

/** 专家详情：完整配置（含系统提示词） */
export function getAgent(id: string) {
  return request<AgentConfig>(`/agents/${id}`);
}

/** 专家详情：该专家的历史任务（含产出文件），口径与 GET /tasks 一致 */
export function listAgentTasks(id: string) {
  return request<AgentTaskWithDeliverables[]>(`/agents/${id}/tasks`);
}

export function listTasks() {
  return request<Task[]>("/tasks");
}

/** 服务端分页 + 状态/关键词筛选 */
export function listTasksPaged(params: { limit?: number; offset?: number; status?: string; q?: string }) {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.q) qs.set("q", params.q);
  const query = qs.toString();
  return request<PagedTasks>(`/tasks${query ? `?${query}` : ""}`);
}

export function getTask(id: string) {
  return request<Task>(`/tasks/${id}`);
}

export function createTask(
  agentId: string | undefined,
  prompt: string,
  title?: string,
  model?: { providerId: string; modelId: string },
  workspaceDir?: string,
  mentions?: WpsMention[]
) {
  return request<{ id: string }>("/tasks", {
    method: "POST",
    body: JSON.stringify({
      agentId: agentId || undefined, // 专家非必选：不选时由服务端落到默认「通用助手」
      prompt,
      title,
      ...model,
      workspaceDir: workspaceDir || undefined,
      mentions: mentions?.length ? mentions : undefined,
    }),
  });
}

/** 带附件派发任务：multipart 提交（字段在前、文件在后），附件会随任务落进工作区。 */
export function createTaskWithFiles(
  agentId: string | undefined,
  prompt: string,
  files: File[],
  opts: {
    title?: string;
    model?: { providerId: string; modelId: string };
    workspaceDir?: string;
    mentions?: WpsMention[];
  } = {}
) {
  const form = new FormData();
  // 顺序即到达顺序：先字段后文件，服务端才能在落附件前确定工作区
  if (agentId) form.set("agentId", agentId); // 专家非必选
  form.set("prompt", prompt);
  if (opts.title) form.set("title", opts.title);
  if (opts.model) {
    form.set("providerId", opts.model.providerId);
    form.set("modelId", opts.model.modelId);
  }
  if (opts.workspaceDir) form.set("workspaceDir", opts.workspaceDir);
  if (opts.mentions?.length) form.set("mentions", JSON.stringify(opts.mentions));
  for (const f of files) form.append("files", f, f.name);
  return request<{ id: string }>("/tasks", { method: "POST", body: form });
}

/** 派发时可选的模型：启用供应商下的「可用模型」。 */
export function listModelOptions() {
  return request<ModelOption[]>("/models");
}

// ---------- WPS 365 账号与 @ 引用（数据由 wps365-skill 脚本在服务端执行获得） ----------

/** 当前账号缓存（未同步过时 profile 为 null；configured 表示本机是否已具备 WPS 登录态） */
export function getWpsMe() {
  return request<{ configured: boolean; profile: WpsProfile | null }>("/wps/me");
}

/** 设置页「同步」按钮：服务端跑 user-current 脚本刷新当前账号缓存 */
export function syncWpsAccount() {
  return request<{ configured: boolean; profile: WpsProfile }>("/wps/sync", { method: "POST" });
}

/** @ 弹层搜索：服务端并行跑 im/contacts/drive 等脚本并归一化 */
export function searchMentions(q = "") {
  return request<WpsMentionSearch>(`/wps/mentions?q=${encodeURIComponent(q)}`);
}

/** 全量通讯录（组织结构化；服务端内存缓存，首次拉取约数秒） */
export function getWpsContacts() {
  return request<WpsContacts>("/wps/contacts");
}

// ---------- 云文档选择器（浏览最近 / 我的云文档 / 团队文档库 / 搜索） ----------

export interface WpsDriveEntry {
  id: string;
  name: string;
  folder: boolean;
  subtitle: string;
}

export function getWpsDriveRecent() {
  return request<{ entries: WpsDriveEntry[] }>("/wps/drive/recent");
}

export function getWpsDriveEntries(parent: string, drive?: string) {
  const p = encodeURIComponent(parent);
  return request<{ entries: WpsDriveEntry[] }>(`/wps/drive/entries?parent=${p}${drive ? `&drive=${encodeURIComponent(drive)}` : ""}`);
}

export function getWpsDriveDoclibs() {
  return request<{ entries: WpsDriveEntry[] }>("/wps/drive/doclibs");
}

export function getWpsDriveSearch(q: string) {
  return request<{ entries: WpsDriveEntry[] }>(`/wps/drive/search?q=${encodeURIComponent(q)}`);
}

export function cancelTask(id: string) {
  return request<{ ok: true }>(`/tasks/${id}/cancel`, { method: "POST" });
}

/** 高风险审批：提交用户逐项勾选的执行清单（reject=true 表示拒绝并取消任务）。 */
export function approveTask(id: string, approvedItems: string[], reject = false) {
  return request<{ ok: true; rejected?: boolean }>(`/tasks/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ approvedItems, reject }),
  });
}

/** ask 级工具调用审批：拒绝、仅本次允许，或允许该工具在本任务会话内继续调用。 */
export function approveToolCall(id: string, decision: ToolApprovalDecision) {
  return request<{ ok: true }>(`/tasks/${id}/tool-approval`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

export function listSessionGrants(id: string) {
  return request<{ tools: string[] }>(`/tasks/${id}/session-grants`);
}

export function revokeSessionGrant(id: string, tool: string) {
  return request<{ ok: true }>(`/tasks/${id}/session-grants/${encodeURIComponent(tool)}`, { method: "DELETE" });
}

/** 修改任务标题（重命名） */
export function renameTask(id: string, title: string) {
  return request<{ ok: true; title: string }>(`/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** 删除任务（进行中/排队中的任务服务端会拒绝，需先取消）。 */
export function deleteTask(id: string) {
  return request<{ ok: true }>(`/tasks/${id}`, { method: "DELETE" });
}

export function getTaskMessages(taskId: string) {
  return request<TaskMessage[]>(`/tasks/${taskId}/messages`);
}

export function sendTaskMessage(taskId: string, prompt: string, mentions?: WpsMention[], interrupt = false) {
  return request<{ ok: true }>(`/tasks/${taskId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      mentions: mentions?.length ? mentions : undefined,
      interrupt: interrupt || undefined,
    }),
  });
}

/** 带附件的追问：multipart 提交（prompt 字段在前、文件在后），附件会落进任务工作区。 */
export function sendTaskMessageWithFiles(
  taskId: string,
  prompt: string,
  files: File[],
  mentions?: WpsMention[],
  interrupt = false
) {
  const form = new FormData();
  form.set("prompt", prompt);
  if (mentions?.length) form.set("mentions", JSON.stringify(mentions));
  if (interrupt) form.set("interrupt", "true");
  for (const f of files) form.append("files", f, f.name);
  return request<{ ok: true }>(`/tasks/${taskId}/messages`, { method: "POST", body: form });
}

export function listDeliverables(taskId: string) {
  return request<Deliverable[]>(`/tasks/${taskId}/deliverables`);
}

/** 斜杠技能候选（GET /skills，全体登录用户可见的 user-invocable 技能元数据，输入框 / 弹层数据源） */
export function listSlashSkills() {
  return request<SlashSkill[]>("/skills");
}

export interface VoiceStatus {
  available: boolean;
  hasExplicit: boolean;
  candidates: Array<{ providerId: string; providerName: string; model: string; explicit: boolean }>;
  localFallback?: {
    model: string;
    cached: boolean;
    loading: boolean;
    ready: boolean;
    cacheDir: string;
  };
}

/** 查询语音转写候选配置状态 */
export function getVoiceStatus() {
  return request<VoiceStatus>("/voice/status");
}

/** 预热/下载本地开源 Whisper ONNX 语音识别模型 */
export function warmupLocalVoice() {
  return request<{ ok: true; localFallback: NonNullable<VoiceStatus["localFallback"]> }>("/voice/local-warmup", {
    method: "POST",
  });
}

/** 语音转文字：multipart 提交录音或音频文件，服务端按优先级尝试 OpenAI 兼容转写端点 */
export function transcribeVoice(audio: Blob, filename: string) {
  const form = new FormData();
  form.append("audio", audio, filename);
  return request<{ text: string; provider: string; model: string }>("/voice/transcribe", {
    method: "POST",
    body: form,
  });
}

// ---------- 管理端 ----------

export type Role2 = "admin" | "member";

/** 从 JWT 载荷解析当前用户角色（无需请求）。 */
export function getRole(): "admin" | "member" | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(token.split(".")[1] ?? "")) as { role?: "admin" | "member" };
    return payload.role ?? null;
  } catch {
    return null;
  }
}

function decodeBase64Url(segment: string): string {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  // JWT 载荷是 UTF-8，需要显式解码
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface AdminProvider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  models: string[];
  /** 已启用的可用模型（专家创建时只能从这里选）。 */
  enabledModels: string[];
  modelsFetchedAt: string | null;
  /** 按模型 ID 的能力覆盖（contextWindow/maxTokens/reasoning），空 = 全部用平台默认 */
  modelOverrides: Record<string, ModelOverride>;
  /** 显式指定的语音转写（ASR）模型 ID（空表示自动探测） */
  asrModel: string;
}

/** 供应商模型两层列表的快照：models 为候选池，enabledModels 为可用集合。 */
export interface ProviderModelsState {
  models: string[];
  enabledModels: string[];
}

export function listAdminProviders() {
  return request<AdminProvider[]>("/admin/providers");
}

export function createAdminProvider(name: string, baseUrl: string, apiKey: string) {
  return request<{ id: string }>("/admin/providers", { method: "POST", body: JSON.stringify({ name, baseUrl, apiKey }) });
}

export function setProviderEnabled(id: string, enabled: boolean) {
  return request<{ ok: true }>(`/admin/providers/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
}

/** 编辑供应商基础信息；apiKey 传空字符串表示不修改。 */
export function updateAdminProvider(
  id: string,
  body: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    modelOverrides?: Record<string, ModelOverride>;
    asrModel?: string;
  }
) {
  return request<{ ok: true }>(`/admin/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

/** 删除供应商（仍有专家引用时服务端会拒绝）。 */
export function deleteAdminProvider(id: string) {
  return request<{ ok: true }>(`/admin/providers/${id}`, { method: "DELETE" });
}

/** 手动向供应商添加一个模型 ID（同时进入候选与可用列表）。 */
export function addProviderModel(id: string, model: string) {
  return request<ProviderModelsState>(`/admin/providers/${id}/models`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

/** 从供应商彻底移除一个模型 ID（候选与可用列表都移除）。 */
export function removeProviderModel(id: string, model: string) {
  return request<ProviderModelsState>(`/admin/providers/${id}/models?model=${encodeURIComponent(model)}`, {
    method: "DELETE",
  });
}

/** 启用一个候选模型，使其成为可用模型。 */
export function enableProviderModel(id: string, model: string) {
  return request<ProviderModelsState>(`/admin/providers/${id}/models/enable`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

/** 停用一个可用模型（保留在候选列表里）。 */
export function disableProviderModel(id: string, model: string) {
  return request<ProviderModelsState>(`/admin/providers/${id}/models/disable`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

/** 从供应商拉取模型列表（服务端缓存；从未整理过时默认全部可用）。 */
export function fetchProviderModels(id: string) {
  return request<ProviderModelsState & { fetchedAt: string }>(`/admin/providers/${id}/models`, { method: "GET" });
}

export interface AdminAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  providerId: string;
  modelId: string;
  providerName: string;
  tags: string[];
  highRisk: boolean;
  /** null = 未显式绑定（使用全部平台技能）；数组 = 显式绑定的技能名 */
  skills: string[] | null;
  /** 工具策略（P2-2）：键为工具名或 mcp:连接器:* 通配；缺省动作 = 放行 */
  toolPolicy: ToolPolicy;
}

export function listAdminAgents() {
  return request<AdminAgent[]>("/admin/agents");
}

export function createAdminAgent(body: {
  name: string;
  description?: string;
  systemPrompt: string;
  /** 默认模型（可选）：专家与模型解耦，缺省时派发任务再选 */
  providerId?: string;
  modelId?: string;
  tags?: string[];
  /** 高风险专家：任务先出执行清单，逐项确认后才执行 */
  highRisk?: boolean;
  /** 显式绑定的技能名；不传 = 使用全部平台技能 */
  skills?: string[];
  /** 工具策略（P2-2）：ask = 每次调用需人工确认，deny = 对该专家隐藏 */
  toolPolicy?: ToolPolicy;
}) {
  return request<{ id: string }>("/admin/agents", { method: "POST", body: JSON.stringify(body) });
}

export function updateAdminAgent(
  id: string,
  body: {
    name: string;
    description?: string;
    systemPrompt: string;
    providerId?: string;
    modelId?: string;
    tags?: string[];
    highRisk?: boolean;
    /** 传入即覆写绑定（空数组 = 不绑任何技能）；不传 = 保持原绑定 */
    skills?: string[];
    /** 传入即覆写工具策略（空对象 = 全部放行）；不传 = 保持原策略 */
    toolPolicy?: ToolPolicy;
  }
) {
  return request<{ ok: true }>(`/admin/agents/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export function deleteAdminAgent(id: string) {
  return request<{ ok: true }>(`/admin/agents/${id}`, { method: "DELETE" });
}

/** AI 一句话生成专家配置（服务端自动挑可用模型，失败时模板兜底） */
export function generateAdminAgent(body: GenerateAgentRequest) {
  return request<GeneratedAgent>("/admin/agents/generate", { method: "POST", body: JSON.stringify(body) });
}

// ---------- 技能 / 连接器（管理员） ----------

/** 技能列表条目（含 P2-4 激活计数：read_skill / 斜杠调用的使用统计） */
export type AdminSkillInfo = SkillInfo & SkillUsageInfo;

export function listSkills() {
  return request<AdminSkillInfo[]>("/admin/skills");
}

export function getSkill(name: string) {
  return request<SkillDetail>(`/admin/skills/${encodeURIComponent(name)}`);
}

export function createSkill(body: {
  name: string;
  description?: string;
  content: string;
  /** 斜杠调用的参数提示；填写后可用 /技能名 参数 直接调用 */
  argumentHint?: string;
  alias?: string;
}) {
  return request<{ ok: true }>("/admin/skills", { method: "POST", body: JSON.stringify(body) });
}

export function updateSkill(
  name: string,
  body: { description?: string; content: string; argumentHint?: string; alias?: string }
) {
  return request<{ ok: true }>(`/admin/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteSkill(name: string) {
  return request<{ ok: true }>(`/admin/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ---------- 技能安装 / 同步（管理员） ----------

export function getSkillsCatalog() {
  return request<SkillsCatalog>("/admin/skills/catalog");
}

export function installSkill(source: string, overwrite: boolean) {
  return request<SkillInstallResult>("/admin/skills/install", {
    method: "POST",
    body: JSON.stringify({ source, overwrite }),
  });
}

export function syncSkill(name: string) {
  return request<SkillInstallResult>(`/admin/skills/${encodeURIComponent(name)}/sync`, { method: "POST" });
}

/** 检测所有登记技能源的更新（P2-4 漂移检测；git/直链需网络，失败以 note 说明）。 */
export function getSkillUpdates() {
  return request<SkillUpdateInfo[]>("/admin/skills/updates");
}

/** 一键同步全部技能源：每个来源同步一次，失败的来源在 failed 里说明。 */
export function syncAllSkills() {
  return request<{ sources: string[]; failed: Array<{ source: string; error: string }> }>("/admin/skills/sync-all", {
    method: "POST",
  });
}

// ---------- 平台指令（AGENTS.md，P2-3：平台级全局指令，注入所有专家） ----------

export function getPlatformInstructions() {
  return request<{ content: string }>("/admin/instructions");
}

/** 保存平台级全局指令（AGENTS.md）；传空字符串即清空。 */
export function savePlatformInstructions(content: string) {
  return request<{ ok: true }>("/admin/instructions", { method: "PUT", body: JSON.stringify({ content }) });
}

// ---------- 专家包：市场 / 安装 / 导入 / 导出（管理员） ----------

export function listAgentPacks() {
  return request<AgentPackInfo[]>("/admin/agents/catalog");
}

export function installAgentPack(packId: string, providerId?: string, modelId?: string) {
  return request<AgentPackInstallResult>("/admin/agents/install", {
    method: "POST",
    body: JSON.stringify({ packId, providerId: providerId || undefined, modelId: modelId || undefined }),
  });
}

export function importAgentPack(file: File, providerId?: string, modelId?: string) {
  const fd = new FormData();
  fd.append("file", file);
  if (providerId) fd.append("providerId", providerId);
  if (modelId) fd.append("modelId", modelId);
  return request<AgentPackInstallResult>("/admin/agents/import", { method: "POST", body: fd });
}

/** 导出专家包并触发浏览器下载（skills 传 ["all"] 打包全部平台技能）。 */
export async function exportAgentPack(id: string, skills: string[], filename: string): Promise<void> {
  const qs = skills.length ? `?skills=${encodeURIComponent(skills.join(","))}` : "";
  const res = await fetch(`${API_BASE}/admin/agents/${encodeURIComponent(id)}/export${qs}`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "导出失败");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function listMcpServers() {
  return request<McpServerConfig[]>("/admin/mcp");
}

export function createMcpServer(body: {
  name: string;
  /** stdio = 本地进程；http = 远程 streamable HTTP 服务器（P2-1） */
  type?: "stdio" | "http";
  /** http 类型必填：https:// 的 streamable HTTP 端点 */
  url?: string;
  /** http 请求头；值支持 ${ENV_NAME} 引用服务器环境变量（如 Bearer 令牌） */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabledTools?: string[];
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}) {
  return request<{ id: string }>("/admin/mcp", { method: "POST", body: JSON.stringify(body) });
}

export function updateMcpServer(
  id: string,
  body: {
    name?: string;
    url?: string;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    disabledTools?: string[];
    startupTimeoutSec?: number;
    toolTimeoutSec?: number;
  }
) {
  return request<{ ok: true }>(`/admin/mcp/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteMcpServer(id: string) {
  return request<{ ok: true }>(`/admin/mcp/${id}`, { method: "DELETE" });
}

/** 测试连接：握手并缓存工具列表（全量，注入时才按 disabledTools 过滤）；失败抛 ApiError（502）。 */
export function testMcpServer(id: string) {
  return request<{ ok: true; tools: { name: string; description: string; inputSchema?: Record<string, unknown> | null }[] }>(
    `/admin/mcp/${id}/test`,
    { method: "POST" }
  );
}

/** 导入 .mcp.json（Claude/Codex 互操作格式，仅 stdio）：按名称 upsert。 */
export function importMcpConfig(content: string) {
  return request<{ imported: string[]; skipped: Array<{ name: string; reason: string }> }>("/admin/mcp/import", {
    method: "POST",
    body: content,
  });
}

/** 导出启用的连接器为 .mcp.json 并触发浏览器下载。 */
export async function exportMcpConfig(): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/mcp/export`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "导出失败");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mcp.json";
  a.click();
  URL.revokeObjectURL(url);
}

export interface AdminUser {
  id: string;
  username: string;
  role: "admin" | "member";
  createdAt: string;
}

export function listAdminUsers() {
  return request<AdminUser[]>("/admin/users");
}

/** 管理员重置成员密码：不需要旧密码。 */
export function resetUserPassword(userId: string, password: string) {
  return request<{ ok: true }>(`/admin/users/${userId}/password`, {
    method: "PATCH",
    body: JSON.stringify({ password }),
  });
}

// ---------- 定时与自动化巡检任务 ----------

export function listSchedules() {
  return request<ScheduledTask[]>("/schedules");
}

export function createSchedule(body: CreateScheduledTaskRequest) {
  return request<ScheduledTask>("/schedules", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateSchedule(id: string, body: UpdateScheduledTaskRequest) {
  return request<ScheduledTask>(`/schedules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteSchedule(id: string) {
  return request<{ ok: true }>(`/schedules/${id}`, {
    method: "DELETE",
  });
}

export function runScheduleNow(id: string) {
  return request<{ ok: true; taskId: string }>(`/schedules/${id}/run`, {
    method: "POST",
  });
}

/** SSE 订阅；返回关闭函数。 */
export function openTaskEvents(taskId: string, onEnvelope: (env: TaskEventEnvelope) => void): () => void {
  const source = new EventSource(`${API_BASE}/tasks/${taskId}/events?token=${encodeURIComponent(getToken())}`);
  source.onmessage = (msg) => {
    try {
      onEnvelope(JSON.parse(msg.data) as TaskEventEnvelope);
    } catch {
      // 忽略无法解析的帧
    }
  };
  return () => source.close();
}

/** 携带 token 下载成果物并触发浏览器保存。 */
export async function downloadDeliverable(taskId: string, file: Deliverable): Promise<void> {
  const res = await fetch(`${API_BASE}/tasks/${taskId}/deliverables/${file.id}/download`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new ApiError(res.status, "download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}
