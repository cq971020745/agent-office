// 前后端共享的领域类型与 DTO。定义以 CONTEXT.md 的术语为准。

export type Role = "admin" | "member";

/** pending=排队 running=执行中 awaiting_approval=高风险任务已出执行清单待确认 completed failed cancelled */
export type TaskStatus = "pending" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  /** 从供应商 /models 接口拉取并缓存的模型 ID 列表 */
  models: string[];
  modelsFetchedAt: string | null;
}

export interface CreateModelProviderRequest {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  /** 系统提示词（D8：仅向管理员返回，普通成员访问 GET /agents/:id 时省略） */
  systemPrompt?: string;
  /** 默认供应商与模型；为空表示专家不绑定模型，派发任务时再选择 */
  providerId: string;
  providerName: string;
  modelId: string;
  /** 专家常驻文件夹（任务默认工作目录，可从客户端直接打开） */
  folderPath: string;
  tags: string[];
  /** 高风险专家：派发任务后 Agent 先输出执行清单，用户逐项确认后才继续执行 */
  highRisk: boolean;
  /** 绑定的技能名；null = 未显式绑定（自动使用全部平台技能） */
  skills: string[] | null;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  systemPrompt: string;
  providerId?: string;
  modelId?: string;
  tags?: string[];
  highRisk?: boolean;
  /** 绑定的技能名列表；缺省 = 使用全部平台技能（兼容 v1） */
  skills?: string[];
}

export interface UpdateAgentRequest {
  name: string;
  description?: string;
  systemPrompt: string;
  providerId?: string;
  modelId?: string;
  tags?: string[];
  highRisk?: boolean;
  /** 绑定的技能名列表；缺省 = 使用全部平台技能（兼容 v1） */
  skills?: string[];
}

/** AI 一句话生成专家配置（WorkBuddy expert-manager 式） */
export interface GenerateAgentRequest {
  prompt: string;
  /** 指定生成用的模型（需成对）；缺省时服务端自动挑选可用供应商 */
  providerId?: string;
  modelId?: string;
}

export interface GeneratedAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tags: string[];
  /** llm = 真实模型生成；fallback = 内置模板兜底 */
  source: "llm" | "fallback";
  /** source 为 fallback 时的原因说明 */
  note?: string;
}

export interface Task {
  id: string;
  userId: string;
  agentId: string;
  agentName: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 本任务实际使用的模型（派发时选择或专家默认） */
  providerName: string;
  modelId: string;
  /** 任务工作目录（用户自选目录 / 专家常驻文件夹 / 平台隔离工作区） */
  workspacePath: string;
  customWorkspace: boolean;
}

export interface CreateTaskRequest {
  agentId: string;
  prompt: string;
  title?: string;
  /** 显式指定模型（专家与模型解耦）；缺省时用专家默认模型 */
  providerId?: string;
  modelId?: string;
  /** 用户自选的工作目录（绝对路径）；缺省时用专家常驻文件夹 */
  workspaceDir?: string;
  /** 输入框 @ 选中的 WPS 对象（联系人/群聊/云文档等），随任务注入提示词 */
  mentions?: WpsMention[];
}

/** @ 弹层数据源类别（对齐 WPS Comate：聊天/联系人/云文档/知识库） */
export type WpsMentionType = "chat" | "contact" | "doc" | "kb" | "meeting";

/** @ 弹层候选条目（服务端把各 WPS 脚本输出归一化成这个形状） */
export interface WpsMentionItem {
  type: WpsMentionType;
  /** WPS 侧对象 id（chat_id / user_id / file_id / space_id / 会议记录 id） */
  id: string;
  name: string;
  /** 补充说明（部门、群类型、文档大小等） */
  subtitle?: string;
}

/** 任务携带的 @ 引用：id + 名称即可，专家侧按需回查详情 */
export interface WpsMention {
  type: WpsMentionType;
  id: string;
  name: string;
}

/** @ 搜索结果（含账号配置状态，前端据此提示先同步） */
export interface WpsMentionSearch {
  configured: boolean;
  items: WpsMentionItem[];
}

/** WPS 365 当前账号（设置页同步按钮的结果缓存） */
export interface WpsProfile {
  id: string;
  name: string;
  defDeptId: string;
  deptName: string;
  deptPath: string;
  email: string;
  phone: string;
  avatar: string;
  syncedAt: string;
}

/** 全量通讯录条目（GET /wps/contacts，前端按 deptPath 分组做组织结构化展示） */
export interface WpsDirectoryEntry {
  id: string;
  name: string;
  deptId: string;
  deptName: string;
  /** 组织路径（不含集团根前缀），如「信投公司/紫金数云公司/紫金数云_技术部」 */
  deptPath: string;
  isLeader: boolean;
}

export interface WpsContacts {
  configured: boolean;
  total: number;
  entries: WpsDirectoryEntry[];
  fetchedAt: string;
}

/** 任务列表分页响应（GET /tasks 带 limit/offset/status/q 时返回） */
export interface TaskPageCounts {
  all: number;
  /** 进行中（含排队 pending） */
  running: number;
  /** 待人工确认（高风险计划待确认） */
  awaiting_approval?: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface PagedTasks {
  items: Task[];
  /** 当前筛选（status + 关键词）下的总数 */
  total: number;
  counts: TaskPageCounts;
}

/** 专家详情页的任务条目：任务本体 + 该任务产出的文件 */
export interface AgentTaskWithDeliverables extends Task {
  deliverables: Deliverable[];
}

/** 派发时可选的模型：启用供应商下的「可用模型」 */
export interface ModelOption {
  providerId: string;
  providerName: string;
  models: string[];
}

/** 语音识别（ASR）模型名称识别规则（前后端共用） */
export const ASR_MODEL_RE = /whisper|asr|voice|audio|paraformer|sensevoice|funasr|speech/i;

/** 非对话模型（向量/重排/语音等）识别规则：不该出现在「选模型」列表里 */
export const NON_CHAT_MODEL_RE = /bge|reranker|embed|whisper|asr|paraformer|sensevoice|funasr|tts|vl/i;

/** 该模型 ID 是否可作为对话模型供任务使用 */
export function isChatModel(modelId: string): boolean {
  return !NON_CHAT_MODEL_RE.test(modelId);
}

/** 该模型 ID 是否为语音识别（ASR）模型 */
export function isAsrModel(modelId: string): boolean {
  return ASR_MODEL_RE.test(modelId);
}

/** 平台技能（{agentDir}/skills/<name>/SKILL.md）。正文按需经 read_skill 工具加载（渐进披露）。 */
export interface SkillInfo {
  name: string;
  description: string;
  /** 用户可用 /名称 直接调用（frontmatter user-invocable 或 argument-hint 存在） */
  userInvocable: boolean;
  /** 斜杠调用的参数提示（frontmatter argument-hint） */
  argumentHint: string;
  updatedAt: string;
  size: number;
}

export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  userInvocable: boolean;
  argumentHint: string;
  /** Agent Skills 规范的扩展 frontmatter：metadata 映射（如 author/version） */
  metadata: Record<string, string>;
  /** 规范 allowed-tools：声明该技能需要的工具（平台当前仅透传展示） */
  allowedTools: string[];
}

export interface UpsertSkillRequest {
  name?: string;
  description?: string;
  content: string;
}

/** 技能安装来源登记（有登记的技能支持一键同步更新） */
export interface SkillSourceInfo {
  source: string;
  kind: "builtin" | "url" | "git" | "local";
  revision: string;
  syncedAt: string;
  /** 漂移检测结果（P2-4）：true = 源端比登记基线新；undefined = 未能判断 */
  hasUpdate?: boolean;
  /** 检测失败/未建立基线等说明 */
  note?: string;
}

/** 已安装技能的激活计数（P2-4，read_skill 与斜杠调用埋点） */
export interface SkillUsageInfo {
  /** 累计激活次数（read_skill 加载与 /斜杠 调用） */
  usageCount: number;
  /** 最近一次激活时间；从未使用为 null */
  lastUsedAt: string | null;
}

/** 技能市场条目（内置目录 + 是否已安装） */
export interface CatalogSkillInfo {
  id: string;
  description: string;
  installed: boolean;
}

export interface SkillsCatalog {
  catalog: CatalogSkillInfo[];
  sources: Record<string, SkillSourceInfo>;
}

export interface SkillInstallResult {
  names: string[];
  added: string[];
  updated: string[];
  removed: string[];
  kind: "builtin" | "url" | "git" | "local";
  source: string;
  revision: string;
}

/** 专家包（office-agent-package）：内置市场条目 */
export interface AgentPackInfo {
  id: string;
  name: string;
  description: string;
  tags: string[];
  skillCount: number;
}

export interface AgentPackInstallResult {
  id: string;
  skills: Array<{ requested: string; finalName: string }>;
  /** 安装时被跳过或自动修正的说明（如非法技能名被跳过） */
  warnings?: string[];
}

/** MCP 连接器（stdio 服务器）及其最近一次探测到的工具 */
export interface McpToolInfo {
  name: string;
  description: string;
  /** 工具入参的 JSON Schema（MCP inputSchema 原样透传） */
  inputSchema?: Record<string, unknown> | null;
}

export interface McpServerConfig {
  id: string;
  name: string;
  /** 连接方式：stdio 本地子进程（v1 语义）或 http 远程 streamable HTTP（P2-1） */
  type: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 远程连接器的端点（type=http 时有效） */
  url: string;
  /** 远程连接器的附加请求头；值支持 ${ENV_NAME} 引用（令牌不落库，发送时展开） */
  headers: Record<string, string>;
  enabled: boolean;
  tools: McpToolInfo[];
  toolsCheckedAt: string | null;
  /** 被禁用的工具名（这些工具不注入任务会话） */
  disabledTools: string[];
  /** 进程启动+握手超时（秒），对标 MCP 生态 startup_timeout_sec */
  startupTimeoutSec: number;
  /** 单次工具调用超时（秒） */
  toolTimeoutSec: number;
  createdAt: string;
}

export interface UpsertMcpRequest {
  name?: string;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  disabledTools?: string[];
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

/** .mcp.json 互操作格式（mcpServers map；支持 stdio 与远程 HTTP 服务器） */
export interface McpConfigFile {
  mcpServers: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  >;
}

/** 模型能力覆盖（P2-5）：按模型 ID 覆盖平台兜底默认（128k 上下文 / 32k 输出 / 不支持推理） */
export interface ModelOverride {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** 专家级工具策略（P2-2）：工具名 → ask/deny；未提及 = 放行。支持 mcp:<连接器>:* 与 mcp:* 通配 */
export type ToolPolicy = Record<string, "ask" | "deny">;

/** 工具审批决定。allow_once 只放行当前这一次；allow_session 在本任务内记住该工具。 */
export type ToolApprovalDecision = "allow_once" | "allow_session" | "deny";

/** 技能来源的漂移检测信息（P2-4） */
export interface SkillUpdateInfo {
  source: string;
  kind: string;
  skills: string[];
  hasUpdate: boolean;
  latest: string;
  note: string;
}

export interface Deliverable {
  id: string;
  taskId: string;
  filename: string;
  relPath: string;
  size: number;
  createdAt: string;
}

/** Agent 单轮执行中的一条工具调用步骤摘要（随 assistant 消息持久化，供历史回看） */
export interface TaskTurnStep {
  tool: string;
  detail?: string;
  status?: "done" | "error";
}

/** 任务会话中的一条消息（用户派发/追问、agent 的最终回复及本轮思考/工具轨迹）。 */
export interface TaskMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** 本轮模型的思考摘要（若有） */
  thinking?: string;
  /** 本轮模型执行的工具调用步骤（若有） */
  steps?: TaskTurnStep[];
}

export interface SendTaskMessageRequest {
  prompt: string;
  /** 任务执行中发送 = 打断当前轮次，本轮中止后以该消息开新一轮 */
  interrupt?: boolean;
}

/** 斜杠技能候选（GET /skills，仅 user-invocable，供输入框 / 弹层使用） */
export interface SlashSkill {
  name: string;
  description: string;
  /** 斜杠调用的参数提示（空 = 无参数） */
  argumentHint: string;
}

/**
 * 定时与自动化巡检任务（ScheduledTask）：
 * scheduleExpr 格式：
 * - `daily:HH:mm`（每日固定时刻，如 `daily:09:00`）
 * - `weekly:d:HH:mm`（每周固定星期与时刻，d=1..7 代表周一..周日，如 `weekly:1:09:00`）
 * - `interval:N`（每隔 N 分钟，N >= 5，如 `interval:60`）
 */
export interface ScheduledTask {
  id: string;
  userId: string;
  agentId: string;
  agentName: string;
  providerId: string;
  modelId: string;
  title: string;
  prompt: string;
  scheduleExpr: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastTaskId: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface CreateScheduledTaskRequest {
  title?: string;
  prompt: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  scheduleExpr: string;
  enabled?: boolean;
}

export interface UpdateScheduledTaskRequest {
  title?: string;
  prompt?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  scheduleExpr?: string;
  enabled?: boolean;
}

/** SSE 事件封套：pi 原始事件原样透传（type + 载荷），任务生命周期事件由平台注入。 */
export type TaskEventEnvelope =
  | { seq: number; kind: "pi"; event: { type: string; [key: string]: unknown } }
  | { seq: number; kind: "task"; status: TaskStatus; error?: string }
  | { seq: number; kind: "user"; text: string }
  | { seq: number; kind: "deliverables"; deliverables: Deliverable[] };
