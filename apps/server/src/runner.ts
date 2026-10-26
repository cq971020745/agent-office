import {
  calculateContextTokens,
  createAgentSession,
  DefaultResourceLoader,
  getLastAssistantUsage,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type, type Model } from "@earendil-works/pi-ai";
import {
  resolveProviderApiFormat,
  type AccessMode,
  type ProviderApiFormat,
  type TaskContextUsage,
  type TaskTurnStep,
} from "@office/shared";
import fs from "node:fs";
import path from "node:path";
import { codeExecToolIfAvailable, hasCodeExec } from "./codeExec.js";
import { isPlatformWorkspace, paths } from "./config.js";
import { db, now, uuid } from "./db.js";
import { createHostTerminalTool } from "./host-terminal.js";
import { readAgentsMd } from "./instructions.js";
import { parseModelOverrides, resolveModelCaps } from "./model-caps.js";
import { isSafePlanCommand, PLAN_MODE_INSTRUCTION } from "./plan-mode.js";
import { buildSkillsPrompt, expandSkillSlash } from "./skills.js";
import { publishContext, publishPi, publishStatus, publishUser } from "./sse.js";
import { cancelToolApproval, hasSessionGrant, requestToolApproval } from "./tool-approval.js";
import { parseAccessMode, parseToolPolicy, PLAN_BLOCKED_TOOLS, policyFor, toolNeedsApproval } from "./tool-policy.js";
import { platformPlugins } from "./plugins/index.js";
import { workspaceCoreTools } from "./tools.js";
import {
  createdAtAfter,
  mergePartial,
  partialTranscript,
  transcriptsFromSessionEntries,
  withInterruptNote,
  type SessionMessageLike,
} from "./turn-transcript.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ProviderRow {
  provider_id: string;
  name: string;
  base_url: string;
  api_key: string;
  model_overrides: string | null;
  api_format?: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  provider_id: string;
  model_id: string;
}

const OFFICE_PREAMBLE = `You are a task-executing agent in an office automation platform. You receive a task from a user and work on it autonomously until it is done.

Environment:
- Each task gets an isolated workspace directory (currently empty). Treat it as your office desk.
- All output files (reports, drafts, code, data) MUST be written there with the workspace_write or workspace_edit tool. Deliverables are collected from that directory.
- Use workspace_list / workspace_read to inspect files in the workspace, transcribe_audio to transcribe any audio files (.wav/.mp3/.m4a/.webm/.ogg) into text, web_search for public-web research, and fetch_content or fetch_url to read a known URL.
- You have no shell access on purpose: produce files, not terminal effects.
- When the task is complete, end with a short final message summarizing what you produced (mention file names).`;

const USER_DIR_PREAMBLE = `You are a task-executing agent in an office automation platform. You receive a task from a user and work on it autonomously until it is done.

Environment:
- You are working inside a directory CHOSEN BY THE USER (your current workspace). It may already contain files; use workspace_list / workspace_read to inspect them before overwriting anything.
- All output files MUST be written into that directory with the workspace_write or workspace_edit tool. Deliverables are collected from files created or modified during this task.
- transcribe_audio is available to transcribe audio files (.wav/.mp3/.m4a/.webm/.ogg). Use web_search for public-web research, and fetch_content or fetch_url to read a known URL.
- You have no shell access on purpose: produce files, not terminal effects.
- When the task is complete, end with a short final message summarizing what you produced (mention file names).`;

const NO_SHELL_LINE = "- You have no shell access on purpose: produce files, not terminal effects.";

const TERMINAL_NOTE =
  "- The terminal tool runs host commands in this task workspace (PowerShell on Windows, bash on Linux/macOS). It uses the current server process privileges and does not elevate. Each call needs approval unless the user has allowed that tool for this task session. Use it to run workspace scripts such as .ps1, .py, .js, .bat, and .cmd.";

const WRITE_SKILL_NOTE =
  "- To publish a platform skill into the shared skill library, call write_skill after agreeing name, description and body with the user. Do not only write SKILL.md into the task workspace. write_skill needs approval.";

const DOC_NOTE =
  "- Office, PDF, images, and legacy Word files are binary. Do not read them with workspace_read. Call doc_to_md with outputDir under the hidden .parsed/ directory, then workspace_read the Saved-To markdown. If that markdown is empty or the file is a scanned PDF / screenshot / photo, call ocr_to_md with the same path and outputDir. Default OCR is open-source Tesseract.js (OCR_MODEL language packs). A bound vision OCR model overrides it. Image files (png/jpg/tif/bmp/webp) skip doc_to_md and go straight to ocr_to_md. Do not install system Tesseract. Do not upload a local attachment to WPS cloud just to extract its text. Never rename, move, or overwrite user-uploaded source files; keep their original filenames. Conversion outputs must stay under .parsed/ only.";

const WEB_NOTE =
  "- web_search searches the public internet. fetch_content reads a known URL (pages, GitHub, PDFs, YouTube). fetch_url is a simple HTML fallback if fetch_content is unavailable. get_search_content pages through stored search results. source_check gathers cited sources for a claim.";

const CODE_EXEC_NOTE =
  "- The run_code tool executes a JavaScript/Python script in a network-isolated container with this workspace mounted read-only at /workspace. Use it for untrusted computation. It does not replace terminal, and it cannot reach office APIs.";

/** 组装环境提示词：根据工作区类型、run_code 可用性与是否带附件动态生成。 */
export function buildPreamble(
  customWorkspace: boolean,
  codeExec: boolean,
  hasUploads = false,
  skillScripts = false
): string {
  let base = customWorkspace ? USER_DIR_PREAMBLE : OFFICE_PREAMBLE;
  // 平台隔离工作区的提示词默认声称「目录为空」，带附件派发时必须纠正，否则模型会忽略已有文件
  if (hasUploads && !customWorkspace) {
    base = base.replace(
      "Each task gets an isolated workspace directory (currently empty).",
      "Each task gets an isolated workspace directory (the user's uploaded attachments are already saved there)."
    );
  }
  if (skillScripts) {
    base = base.replace(
      "\n- When the task is complete",
      "\n- The run_skill_script tool executes Python scripts bundled inside installed platform skills (see <platform_skills>) on the host, with the skill's own environment (e.g. WPS 365 login credentials) already injected. This reaches office APIs (contacts, IM chats, cloud docs, calendar, mail) that run_code's network-isolated sandbox cannot. Read the skill's docs with read_skill first, then run its scripts through this tool.\n- When the task is complete"
    );
  }
  const capabilityNotes = [TERMINAL_NOTE, WRITE_SKILL_NOTE, DOC_NOTE, WEB_NOTE, codeExec ? CODE_EXEC_NOTE : ""].filter(Boolean).join("\n");
  return base.replace(NO_SHELL_LINE, capabilityNotes);
}

/** 用 model_providers 行在内存中注册供应商，并按该行的对话协议构造 Model。 */
async function buildRuntimeAndModel(
  provider: ProviderRow,
  modelId: string
): Promise<{ runtime: ModelRuntime; model: Model<ProviderApiFormat> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const providerId = `office-${provider.provider_id}`;
  const api = resolveProviderApiFormat(provider.api_format);
  // 能力元数据可按模型覆盖（contextWindow/maxTokens/reasoning），未配置时用兜底默认
  const caps = resolveModelCaps(modelId, parseModelOverrides(provider.model_overrides));
  runtime.registerProvider(providerId, {
    name: provider.name,
    baseUrl: provider.base_url,
    apiKey: provider.api_key,
    api,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: caps.reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: caps.contextWindow,
        maxTokens: caps.maxTokens,
      },
    ],
  });
  const model: Model<ProviderApiFormat> = {
    id: modelId,
    name: modelId,
    api,
    provider: providerId,
    baseUrl: provider.base_url,
    reasoning: caps.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps.contextWindow,
    maxTokens: caps.maxTokens,
  };
  return { runtime, model } as const;
}

function scanDeliverables(taskId: string, root: string, sinceMs?: number): void {
  // 任务附件是输入不是成果：登记在 task_uploads 里的相对路径不计入成果物
  const uploads = new Set(
    (db.prepare("SELECT rel_path FROM task_uploads WHERE task_id = ?").all(taskId) as { rel_path: string }[]).map(
      (r) => r.rel_path
    )
  );
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (uploads.has(relPath)) continue;
      // 用户自选目录里可能已有旧文件：只把任务开始后新建/修改的文件记为成果物
      if (sinceMs !== undefined && fs.statSync(abs).mtimeMs < sinceMs) continue;
      const known = db.prepare("SELECT id FROM deliverables WHERE task_id = ? AND rel_path = ?").get(taskId, relPath);
      if (known) continue;
      db.prepare(
        "INSERT INTO deliverables (id, task_id, filename, rel_path, size, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(uuid(), taskId, entry.name, relPath, fs.statSync(abs).size, now());
    }
  };
  walk(root, "");
}

function setTaskStatus(taskId: string, status: string, error?: string): void {
  db.prepare("UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(
    status,
    error ?? null,
    now(),
    taskId
  );
}

/** 非平台隔离工作区（用户自选目录 / 专家常驻目录）：只把任务开始之后产生/修改的文件记为成果物（2 秒时钟容差）。 */
function deliverableSinceMs(taskId: string): number | undefined {
  const t = db.prepare("SELECT started_at, created_at, workspace_path FROM tasks WHERE id = ?").get(taskId) as
    | { started_at: string | null; created_at: string; workspace_path: string }
    | undefined;
  if (!t || isPlatformWorkspace(t.workspace_path)) return undefined;
  const base = t.started_at ?? t.created_at;
  const ms = Date.parse(base);
  return Number.isFinite(ms) ? ms - 2_000 : undefined;
}

interface TaskJoinRow {
  id: string;
  user_id: string;
  agent_id: string;
  prompt: string;
  /** 附件清单与 @ 引用等机器上下文：只随首轮发给模型，展示文本保持用户原文 */
  context_note: string;
  workspace_path: string;
  custom_workspace: number;
  session_id: string | null;
  access_mode: string;
  agent_name: string;
  system_prompt: string;
  high_risk: number;
  tool_policy: string | null;
  model_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  base_url: string | null;
  api_key: string | null;
  model_overrides: string | null;
  api_format: string | null;
}

// 任务级模型优先（专家与模型解耦），否则回退专家默认绑定
const SELECT_RUN_ROW = `
  SELECT t.id, t.user_id, t.agent_id, t.prompt, t.context_note, t.workspace_path, t.custom_workspace, t.session_id,
         COALESCE(t.access_mode, 'autonomous') AS access_mode,
         a.name AS agent_name, a.system_prompt, a.high_risk, a.tool_policy,
         COALESCE(t.model_id, a.model_id) AS model_id,
         COALESCE(t.provider_id, a.provider_id) AS provider_id,
         p.name AS provider_name, p.base_url, p.api_key, p.model_overrides, p.api_format
  FROM tasks t
  JOIN agents a ON a.id = t.agent_id
  LEFT JOIN model_providers p ON p.id = COALESCE(t.provider_id, a.provider_id)
  WHERE t.id = ?`;

function getRunRow(taskId: string): TaskJoinRow | undefined {
  return db.prepare(SELECT_RUN_ROW).get(taskId) as TaskJoinRow | undefined;
}

// 会话级状态：AgentSession 跨轮次保留在内存里（多轮追问复用同一会话，上下文不丢）；
// 服务重启后通过 SessionManager.open 从 JSONL 恢复。
const sessions = new Map<string, AgentSession>();
/** 最近一次读到的上下文占用；会话被回收后仍可供详情页展示 */
const lastContextUsage = new Map<string, TaskContextUsage>();

const CONTEXT_PUBLISH_TYPES = new Set([
  "agent_end",
  "message_end",
  "turn_end",
  "auto_compaction_end",
  "session_compact",
]);

function toTaskContextUsage(raw: {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}): TaskContextUsage {
  return {
    tokens: raw.tokens,
    contextWindow: raw.contextWindow,
    percent: raw.percent == null ? null : Math.round(raw.percent * 10) / 10,
  };
}

function publishSessionContext(taskId: string, session: AgentSession): void {
  try {
    const raw = session.getContextUsage();
    if (!raw || !(raw.contextWindow > 0)) return;
    const usage = toTaskContextUsage(raw);
    lastContextUsage.set(taskId, usage);
    publishContext(taskId, usage);
  } catch {
    // 读上下文失败不打断任务
  }
}

function contextWindowForTask(taskId: string): number | null {
  const row = db
    .prepare(
      `SELECT t.model_id, p.model_overrides
       FROM tasks t
       LEFT JOIN model_providers p ON p.id = t.provider_id
       WHERE t.id = ?`
    )
    .get(taskId) as { model_id: string | null; model_overrides: string | null } | undefined;
  if (!row?.model_id) return null;
  return resolveModelCaps(row.model_id, parseModelOverrides(row.model_overrides)).contextWindow;
}

/** 冷启动：从会话 JSONL 读最近一次 assistant usage，估占用。 */
function contextUsageFromSessionFile(taskId: string, contextWindow: number): TaskContextUsage | null {
  const row = db
    .prepare("SELECT session_id AS sessionId, workspace_path AS workspacePath FROM tasks WHERE id = ?")
    .get(taskId) as { sessionId: string | null; workspacePath: string } | undefined;
  if (!row?.sessionId || !row.workspacePath) return null;
  try {
    const file = SessionManager.findById(row.workspacePath, row.sessionId, paths.sessions);
    if (!file) return null;
    const sm = SessionManager.open(file, paths.sessions, row.workspacePath);
    const usage = getLastAssistantUsage(sm.getBranch());
    if (!usage) return { tokens: null, contextWindow, percent: null };
    const tokens = calculateContextTokens(usage);
    if (!(tokens > 0)) return { tokens: null, contextWindow, percent: null };
    return toTaskContextUsage({
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    });
  } catch {
    return null;
  }
}

/** 详情页拉取当前上下文占用：优先热会话，其次缓存/会话文件，再退回模型窗口容量。 */
export function peekContextUsage(taskId: string): TaskContextUsage | null {
  const session = sessions.get(taskId);
  if (session) {
    try {
      const raw = session.getContextUsage();
      if (raw && raw.contextWindow > 0) {
        const usage = toTaskContextUsage(raw);
        lastContextUsage.set(taskId, usage);
        return usage;
      }
    } catch {
      // fall through
    }
  }
  const cached = lastContextUsage.get(taskId);
  if (cached && cached.tokens != null) return cached;

  const contextWindow = contextWindowForTask(taskId);
  if (!contextWindow || contextWindow <= 0) return cached ?? null;

  const fromFile = contextUsageFromSessionFile(taskId, contextWindow);
  if (fromFile) {
    lastContextUsage.set(taskId, fromFile);
    return fromFile;
  }
  return cached ?? { tokens: null, contextWindow, percent: null };
}
const busy = new Set<string>();
const cancelRequested = new Set<string>();
const lastActivity = new Map<string, number>();
const turnTraces = new Map<string, { thinking: string; steps: TaskTurnStep[] }>();

function summarizeToolDetail(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  if (typeof args.path === "string" && args.path) return args.path;
  if (typeof args.agent === "string" && args.agent) return args.agent;
  if (typeof args.skill === "string" && args.skill) {
    return typeof args.script === "string" ? `${args.skill}/${args.script}` : args.skill;
  }
  if (typeof args.name === "string" && args.name) return args.name;
  if (typeof args.command === "string" && args.command) return args.command.slice(0, 160);
  if (typeof args.url === "string" && args.url) return args.url;
  return undefined;
}

export interface UserMessageAttachment {
  filename: string;
  size: number;
  relPath?: string;
}

function insertUserMessage(
  taskId: string,
  content: string,
  attachments?: UserMessageAttachment[]
): void {
  const meta =
    attachments?.length
      ? JSON.stringify({
          attachments: attachments.map((a) => ({
            filename: a.filename,
            size: a.size,
            ...(a.relPath ? { relPath: a.relPath } : {}),
          })),
        })
      : "{}";
  db.prepare(
    "INSERT INTO task_messages (id, task_id, role, content, meta, created_at) VALUES (?, ?, 'user', ?, ?, ?)"
  ).run(uuid(), taskId, content, meta, now());
}

/** 读取任务当前已登记的上传附件（首轮落库展示用） */
function listTaskUploadAttachments(taskId: string): UserMessageAttachment[] {
  return (
    db
      .prepare("SELECT filename, size, rel_path AS relPath FROM task_uploads WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as { filename: string; size: number; relPath: string }[]
  ).map((r) => ({ filename: r.filename, size: r.size, relPath: r.relPath }));
}

function insertAssistantMessage(
  taskId: string,
  content: string,
  trace?: { thinking: string; steps: TaskTurnStep[] },
  createdAt?: string
): void {
  const meta: { thinking?: string; steps?: TaskTurnStep[] } = {};
  if (trace?.thinking.trim()) meta.thinking = trace.thinking.trim();
  if (trace?.steps.length) meta.steps = trace.steps;
  db.prepare(
    "INSERT INTO task_messages (id, task_id, role, content, meta, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)"
  ).run(uuid(), taskId, content, JSON.stringify(meta), createdAt ?? now());
}

/**
 * 轮次没正常结束时也把已写出的内容落成一条助手消息，挂在对应问句下面。
 * 否则打断、超时、失败都只留下用户消息，刷新后所有问句会堆在对话顶部。
 */
function persistInterrupted(taskId: string, session: AgentSession | null, baseline: number, note: string): void {
  try {
    const parsed = session
      ? partialTranscript(session.messages as unknown as SessionMessageLike[], baseline)
      : { text: "", thinking: "", steps: [] as TaskTurnStep[] };
    const merged = mergePartial(parsed, turnTraces.get(taskId));
    insertAssistantMessage(taskId, withInterruptNote(merged.text, note), merged);
  } catch (err) {
    console.error(`[runner] 中断回复落库失败（任务 ${taskId}）`, err);
  }
}

/** 取最后一条 assistant 消息的纯文本（最终答复落库用）。 */
function extractAssistantText(session: AgentSession): string {
  const last = [...session.messages].reverse().find((m) => m.role === "assistant") as
    | { content?: unknown }
    | undefined;
  const content = last?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string })?.type === "text")
      .map((b) => (b as { text?: string })?.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

const DelegateParams = Type.Object({
  agent: Type.String({
    description: "Target expert name or ID (e.g. '公文写作助手', '深度研究员', or exact agent name)",
  }),
  task: Type.String({
    description: "Clear sub-task instructions and expected output files for the delegated expert",
  }),
});

export interface DelegatedAgentLookupRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  provider_id: string | null;
  model_id: string | null;
  tool_policy: string | null;
}

/** 按名称或 ID 匹配可委派的目标专家（精确匹配 > 包含匹配，排除当前专家自身） */
export function resolveDelegatedAgent(
  query: string,
  candidates: DelegatedAgentLookupRow[],
  excludeAgentName?: string
): DelegatedAgentLookupRow | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const pool = excludeAgentName
    ? candidates.filter((c) => c.name.toLowerCase() !== excludeAgentName.trim().toLowerCase())
    : candidates;
  return (
    pool.find((c) => c.id.toLowerCase() === q || c.name.toLowerCase() === q) ??
    pool.find((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()))
  );
}

/**
 * 构建多专家协作委派工具（delegate_to_agent）：
 * 允许主控专家将专项子任务委派给平台内其它专家，共享当前任务工作区并返回子专家总结。
 */
function buildDelegateTool(parentRow: TaskJoinRow): ToolDefinition<typeof DelegateParams> {
  return {
    name: "delegate_to_agent",
    label: "委派其他专家",
    description:
      "Delegate a specialized sub-task to another expert (Agent) in the platform. The sub-agent shares the current task workspace (can read/write files) and returns its final summary.",
    parameters: DelegateParams,
    execute: async (_id, params) => {
      const candidates = db
        .prepare(
          "SELECT id, name, description, system_prompt, provider_id, model_id, tool_policy FROM agents WHERE deleted = 0 ORDER BY created_at"
        )
        .all() as unknown as DelegatedAgentLookupRow[];
      const target = resolveDelegatedAgent(params.agent, candidates, parentRow.agent_name);
      if (!target) {
        const available = candidates
          .filter((c) => c.name !== parentRow.agent_name)
          .map((c) => c.name)
          .join("、");
        throw new Error(`未找到匹配的专家「${params.agent}」。当前可委派专家：${available || "无"}`);
      }

      const providerId = target.provider_id || parentRow.provider_id;
      const modelId = target.model_id || parentRow.model_id;
      if (!providerId || !modelId) {
        throw new Error(`目标专家「${target.name}」未绑定可用模型`);
      }
      const prov = db
        .prepare("SELECT id AS provider_id, name, base_url, api_key, model_overrides, api_format FROM model_providers WHERE id = ?")
        .get(providerId) as ProviderRow | undefined;
      if (!prov || !prov.base_url) {
        throw new Error(`目标专家「${target.name}」的模型供应商不可用`);
      }

      const { runtime, model } = await buildRuntimeAndModel(prov, modelId);
      const codeExecAvailable = await hasCodeExec();
      const skillsPrompt = platformPlugins.isPluginActive("skills") ? buildSkillsPrompt(target.id) : "";
      const basePreamble = buildPreamble(
    !isPlatformWorkspace(parentRow.workspace_path),
    codeExecAvailable,
    true,
    !!skillsPrompt
  );
      const platformInstructions = readAgentsMd().trim();

      const loader = new DefaultResourceLoader({
        cwd: parentRow.workspace_path,
        agentDir: paths.agentDir,
        systemPromptOverride: () =>
          `${basePreamble}${
            platformInstructions ? `\n\n<platform_instructions>\n${platformInstructions}\n</platform_instructions>` : ""
          }\n\nYou are "${target.name}" (acting as a specialist sub-agent delegated by "${parentRow.agent_name}"). Your persona and instructions:\n\n${target.system_prompt}${
            skillsPrompt ? `\n\n<platform_skills>\n${skillsPrompt}\n</platform_skills>` : ""
          }`,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const subSessionManager = SessionManager.create(parentRow.workspace_path, paths.sessions);
      const pluginTools = await platformPlugins.createTools({
        userId: parentRow.user_id, taskId: parentRow.id, agentId: target.id, workspacePath: parentRow.workspace_path,
      });
      const codeTools = codeExecAvailable ? await codeExecToolIfAvailable(parentRow.workspace_path) : [];
      // 子专家不注入 delegate_to_agent，防止递归死循环。会话授权跟父任务走。
      const subAllTools: ToolDefinition[] = [
        ...workspaceCoreTools(parentRow.workspace_path, parentRow.user_id),
        createHostTerminalTool(parentRow.workspace_path),
        ...pluginTools,
        ...codeTools,
      ];
      const subCustomTools = prepareCustomTools(parentRow.id, subAllTools, target.tool_policy);

      const created = await createAgentSession({
        cwd: parentRow.workspace_path,
        sessionManager: subSessionManager,
        modelRuntime: runtime,
        model,
        noTools: "builtin",
        customTools: subCustomTools,
        resourceLoader: loader,
      });

      const subSession = created.session;
      const keepAlive = setInterval(() => lastActivity.set(parentRow.id, Date.now()), 15_000);
      keepAlive.unref();
      try {
        await subSession.prompt(params.task);
        const reply = extractAssistantText(subSession).trim() || "（子专家已完成操作，详见工作区文件）";
        return {
          content: [{ type: "text", text: `[来自专家「${target.name}」的协作结果]\n\n${reply}` }],
          details: undefined,
        };
      } finally {
        clearInterval(keepAlive);
      }
    },
  };
}
async function ensureSession(row: TaskJoinRow): Promise<AgentSession> {
  if (!row.provider_id || !row.model_id || !row.base_url) {
    throw new Error("模型不可用：供应商已删除或专家未绑定模型，请重新选择模型");
  }
  const existing = sessions.get(row.id);
  if (existing) return existing;

  const { runtime, model } = await buildRuntimeAndModel(
    {
      provider_id: row.provider_id,
      name: row.provider_name ?? "",
      base_url: row.base_url,
      api_key: row.api_key ?? "",
      model_overrides: row.model_overrides,
      api_format: row.api_format,
    },
    row.model_id
  );
  const codeExecAvailable = await hasCodeExec();
  // 工作区提示词需反映附件已就位（会话可能由后续轮次/服务重启后建立，直接查登记表）
  const uploadCount = (
    db.prepare("SELECT COUNT(*) AS n FROM task_uploads WHERE task_id = ?").get(row.id) as { n: number }
  ).n;
  // 渐进披露：系统提示词只带技能清单（专家显式绑定时仅注入绑定的技能），正文按需 read_skill
  const skillsPrompt = platformPlugins.isPluginActive("skills") ? buildSkillsPrompt(row.agent_id) : "";
  const basePreamble = buildPreamble(
    !isPlatformWorkspace(row.workspace_path),
    codeExecAvailable,
    uploadCount > 0,
    !!skillsPrompt
  );
  // 平台级全局指令（AGENTS.md）：叠加在环境提示词之上、专家人设之下，所有专家共享
  const platformInstructions = readAgentsMd().trim();
  const loader = new DefaultResourceLoader({
    cwd: row.workspace_path,
    agentDir: paths.agentDir,
    systemPromptOverride: () =>
      `${basePreamble}${
        platformInstructions ? `\n\n<platform_instructions>\n${platformInstructions}\n</platform_instructions>` : ""
      }\n\nYou are "${row.agent_name}". Your persona and instructions:\n\n${row.system_prompt}${
        skillsPrompt ? `\n\n<platform_skills>\n${skillsPrompt}\n</platform_skills>` : ""
      }`,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // 插件包扩展与技能、提示词模板由 DefaultResourceLoader 按 agentDir settings.json 加载
  const loadedExtensions = loader.getExtensions();
  if (loadedExtensions.errors.length) {
    for (const err of loadedExtensions.errors) {
      console.warn(`[runner] pi 扩展加载失败 ${err.path}: ${err.error}`);
    }
  }
  if (loadedExtensions.extensions.length) {
    console.log(`[runner] 任务 ${row.id} 已加载 ${loadedExtensions.extensions.length} 个 pi 扩展`);
  }

  let sessionManager = SessionManager.create(row.workspace_path, paths.sessions);
  if (row.session_id) {
    const file = SessionManager.findById(row.workspace_path, row.session_id, paths.sessions);
    if (file) sessionManager = SessionManager.open(file, paths.sessions, row.workspace_path);
  }

  // 会话建立时连接启用的 MCP 服务器，把其工具注入本会话（服务器不可用只记日志）
  const pluginTools = await platformPlugins.createTools({
    userId: row.user_id, taskId: row.id, agentId: row.agent_id, workspacePath: row.workspace_path,
  });
  if (pluginTools.length) console.log(`[runner] 任务 ${row.id} 注入 ${pluginTools.length} 个插件工具`);

  // Docker 守护进程可用时注入容器隔离的代码执行工具；不可用时静默降级
  const codeTools = codeExecAvailable ? await codeExecToolIfAvailable(row.workspace_path) : [];
  if (codeTools.length) console.log(`[runner] 任务 ${row.id} 注入 run_code（Docker 隔离代码执行）`);

  const delegateTool = buildDelegateTool(row);
  await platformPlugins.onTaskStarted({
    userId: row.user_id,
    taskId: row.id,
    agentId: row.agent_id,
    workspacePath: row.workspace_path,
  });

  // 专家级工具策略：deny 直接不注入；ask 与默认询问的 terminal 包一层审批。
  // 会话授权在每次执行时现查，本会话允许和撤销都不用重建会话。
  const allTools: ToolDefinition[] = [
    ...workspaceCoreTools(row.workspace_path, row.user_id),
    createHostTerminalTool(row.workspace_path),
    delegateTool,
    ...pluginTools,
    ...codeTools,
  ];
  const customTools = prepareCustomTools(row.id, allTools, row.tool_policy);

  const created = await createAgentSession({
    cwd: row.workspace_path,
    sessionManager,
    modelRuntime: runtime,
    model,
    noTools: "builtin",
    customTools,
    resourceLoader: loader,
  });
  const session = created.session;
  sessions.set(row.id, session);
  if (!row.session_id) {
    db.prepare("UPDATE tasks SET session_id = ? WHERE id = ?").run(session.sessionId, row.id);
  }

  session.subscribe((event) => {
    lastActivity.set(row.id, Date.now());
    const ev = event as {
      type: string;
      assistantMessageEvent?: { type?: string; delta?: string };
      toolName?: string;
      args?: Record<string, unknown>;
      isError?: boolean;
    };
    const trace = turnTraces.get(row.id);
    if (trace) {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "thinking_delta" && ev.assistantMessageEvent.delta) {
        trace.thinking += ev.assistantMessageEvent.delta;
        if (trace.thinking.length > 4000) trace.thinking = "…" + trace.thinking.slice(-3800);
      } else if (ev.type === "tool_execution_start" && ev.toolName && trace.steps.length < 50) {
        trace.steps.push({
          tool: ev.toolName,
          detail: summarizeToolDetail(ev.toolName, ev.args),
          status: "done",
        });
      } else if (ev.type === "tool_execution_end" && ev.isError && trace.steps.length > 0) {
        trace.steps[trace.steps.length - 1]!.status = "error";
      }
    }
    try {
      publishPi(row.id, event as { type: string } & Record<string, unknown>);
    } catch {
      // 单条事件序列化失败不应中断任务
    }
    // 轮次节点刷新上下文占用，避免 text_delta 刷屏
    if (CONTEXT_PUBLISH_TYPES.has(ev.type)) {
      publishSessionContext(row.id, session);
    }
  });
  return session;
}

function beginTurn(taskId: string): void {
  busy.add(taskId);
  turnTraces.set(taskId, { thinking: "", steps: [] });
  lastActivity.set(taskId, Date.now());
  db.prepare("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL WHERE id = ?").run(
    now(),
    taskId
  );
  publishStatus(taskId, "running");
}

/** 现查任务 access_mode；非法或缺失时回退 autonomous。 */
function getTaskAccessMode(taskId: string): AccessMode {
  const row = db.prepare("SELECT access_mode FROM tasks WHERE id = ?").get(taskId) as
    | { access_mode: string }
    | undefined;
  return parseAccessMode(row?.access_mode) ?? "autonomous";
}

/**
 * deny 滤掉；其余一律套上权限闸门（执行时现查 access_mode / 会话授权）。
 * 这样中途改档位（计划→自主、切到完全访问）无需重建会话。
 */
function prepareCustomTools(taskId: string, tools: ToolDefinition[], policyRaw: string | null): ToolDefinition[] {
  const policy = parseToolPolicy(policyRaw);
  return tools
    .filter((tool) => policyFor(policy, tool.name) !== "deny")
    .map((tool) => gateTool(taskId, tool, policy));
}

/**
 * 会话权限闸门：计划模式硬拦写工具；terminal 在计划模式走只读白名单；
 * 其余按 access_mode + 专家 ask + DEFAULT_ASK 决定是否弹审批。
 */
function gateTool(
  taskId: string,
  tool: ToolDefinition,
  policy: ReturnType<typeof parseToolPolicy>
): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const mode = getTaskAccessMode(taskId);

      if (mode === "plan") {
        if (PLAN_BLOCKED_TOOLS.has(tool.name)) {
          throw new Error(
            `计划模式：禁止调用 ${tool.name}。请先输出执行清单，用户确认后再切换权限执行。`
          );
        }
        if (tool.name === "terminal") {
          const command =
            params && typeof params === "object" && "command" in params
              ? String((params as { command?: unknown }).command ?? "")
              : "";
          if (!isSafePlanCommand(command)) {
            throw new Error(
              `计划模式：命令不在只读白名单内，已被拦截。请改用只读命令，或确认计划后切换权限再执行。\n命令：${command}`
            );
          }
        }
      }

      if (mode === "full" || !toolNeedsApproval(policy, tool.name, hasSessionGrant(taskId, tool.name), mode)) {
        return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      const keepAlive = setInterval(() => lastActivity.set(taskId, Date.now()), 30_000);
      keepAlive.unref();
      try {
        const approved = await requestToolApproval(taskId, tool.name, params, signal);
        if (!approved) throw new Error(`用户拒绝了对工具 ${tool.name} 的本次调用`);
        return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      } finally {
        clearInterval(keepAlive);
      }
    },
  };
}

function endTurn(taskId: string): void {
  busy.delete(taskId);
  cancelRequested.delete(taskId);
  turnTraces.delete(taskId);
  // lastActivity 保留：会话回收 sweeper 依据「最后一次事件时间」判闲置
}

const IDLE_SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 定期回收长时间闲置的内存会话（每任务一个 AgentSession 常驻内存，长期运行会无界增长）。
 * 磁盘 JSONL 仍保留，用户追问时 ensureSession 会自动从会话文件恢复，上下文不丢。
 */
export function startSessionSweeper(): void {
  const timer = setInterval(() => {
    const nowMs = Date.now();
    for (const taskId of sessions.keys()) {
      if (busy.has(taskId)) continue;
      const idleMs = nowMs - (lastActivity.get(taskId) ?? 0);
      if (idleMs > IDLE_SESSION_TTL_MS) {
        // 直接丢弃内存引用即可：pi 会话已持久化为 JSONL，无需显式关闭
        sessions.delete(taskId);
        lastActivity.delete(taskId);
        console.log(`[runner] 已回收闲置会话（任务 ${taskId}，闲置 ${Math.floor(idleMs / 60_000)} 分钟）`);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  timer.unref();
}

/** 任务删除时释放内存会话与关联状态；仍在执行则先请求中止（调用方应先拒绝删除运行中的任务）。 */
export function dropTask(taskId: string): void {
  const session = sessions.get(taskId);
  if (session && busy.has(taskId)) void session.abort();
  sessions.delete(taskId);
  lastContextUsage.delete(taskId);
  cancelRequested.delete(taskId);
  lastActivity.delete(taskId);
  cancelToolApproval(taskId);
}

/** 切换模型后丢弃内存会话，下一轮按新模型重建；不中止当前轮（本轮仍用旧会话对象跑完）。 */
export function invalidateSession(taskId: string): void {
  sessions.delete(taskId);
}

/** 看门狗包裹的单轮执行：模型 180 秒无任何事件则中止，避免任务永远卡在 running。 */
async function runTurn(row: TaskJoinRow, session: AgentSession, prompt: string, opts: { planPhase?: boolean } = {}): Promise<void> {
  const IDLE_TIMEOUT_MS = 180_000;
  let timedOut = false;
  lastActivity.set(row.id, Date.now());
  const watchdog = setInterval(() => {
    if (Date.now() - (lastActivity.get(row.id) ?? 0) > IDLE_TIMEOUT_MS) {
      timedOut = true;
      void session.abort();
    }
  }, 15_000);
  watchdog.unref();

  const baseline = session.messages.length;
  try {
    const pluginContext = { userId: row.user_id, taskId: row.id, agentId: row.agent_id, prompt };
    const pluginBlocks = await platformPlugins.beforeTurn(pluginContext);
    let promptText = pluginBlocks.length ? `${prompt}\n\n${pluginBlocks.join("\n\n")}` : prompt;
    // 模型单轮输出撞到长度上限（stopReason:"length"）时自动续跑，最多 3 轮；
    // 截断不是成功也不是模型错误，直接判完成会得到"任务完成但什么都没做"的假象
    for (let round = 1; ; round++) {
      // 会话建立窗口期（ensureSession 尚未返回）收到的取消/打断请求：prompt 前直接落定，不再发起新一轮
      if (cancelRequested.has(row.id)) {
        persistInterrupted(row.id, session, baseline, "本轮已打断。");
        setTaskStatus(row.id, "cancelled");
        publishStatus(row.id, "cancelled");
        return;
      }
      await session.prompt(promptText);

      // prompt() 正常返回不代表成功：模型错误以 stopReason:"error" 落在最后一条 assistant 消息里
      const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant") as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      const stop = lastAssistant?.stopReason;

      if (stop === "error") {
        const message = lastAssistant?.errorMessage ?? "model run failed";
        persistInterrupted(row.id, session, baseline, `本轮未完成：${message}`);
        setTaskStatus(row.id, "failed", message);
        publishStatus(row.id, "failed", message);
        return;
      }
      if (stop === "aborted" || cancelRequested.has(row.id) || timedOut) {
        const message = timedOut ? "模型 180 秒无响应，已自动中止" : undefined;
        persistInterrupted(row.id, session, baseline, message ?? "本轮已打断。");
        setTaskStatus(row.id, timedOut ? "failed" : "cancelled", message);
        publishStatus(row.id, timedOut ? "failed" : "cancelled", message);
        return;
      }
      if (stop === "length") {
        if (round >= 3) {
          const message = "模型输出连续 3 轮被长度上限截断，任务中止；请拆小任务或换长输出模型后重试";
          persistInterrupted(row.id, session, baseline, message);
          setTaskStatus(row.id, "failed", message);
          publishStatus(row.id, "failed", message);
          return;
        }
        const notice = `[系统] 第 ${round} 轮输出因模型长度上限被截断，已自动续跑`;
        insertUserMessage(row.id, notice);
        publishUser(row.id, notice);
        promptText = "你上一轮的回复因输出长度上限被截断。请从中断处继续完成任务：直接用工具写入文件或输出剩余内容，不要重复已完成的部分。";
        continue;
      }
      break;
    }

    const text = extractAssistantText(session);
    const trace = turnTraces.get(row.id);
    if (text || trace?.thinking || trace?.steps.length) {
      insertAssistantMessage(row.id, text || "（已完成工具调用）", trace);
    }
    scanDeliverables(row.id, row.workspace_path, deliverableSinceMs(row.id));

    // 高风险规划轮：任务停在 awaiting_approval，等用户在界面上逐项确认（POST /tasks/:id/approve）后才继续
    if (opts.planPhase) {
      setTaskStatus(row.id, "awaiting_approval");
      publishStatus(row.id, "awaiting_approval");
      return;
    }

    await platformPlugins.afterTurn({ ...pluginContext, assistantText: text, status: "completed" });
    setTaskStatus(row.id, "completed");
    publishStatus(row.id, "completed");
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const cancelled = !timedOut && cancelRequested.has(row.id);
    const message = timedOut ? "模型 180 秒无响应，已自动中止" : cancelled ? undefined : rawMessage;
    persistInterrupted(row.id, session, baseline, message ?? "本轮已打断。");
    setTaskStatus(row.id, cancelled ? "cancelled" : "failed", message);
    publishStatus(row.id, cancelled ? "cancelled" : "failed", message);
  } finally {
    clearInterval(watchdog);
    publishSessionContext(row.id, session);
  }
}

/** 会话建立失败（供应商配置错误等）时的兜底落库。 */
function failTurn(taskId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  persistInterrupted(taskId, null, 0, `本轮未完成：${message}`);
  setTaskStatus(taskId, "failed", message);
  publishStatus(taskId, "failed", message);
}

/**
 * 执行一个任务的第一轮：每任务一个 pi 会话 + 独立工作区。
 * 内部自捕获错误，永远不向外抛（由 POST /tasks 里 fire-and-forget 调用）。
 */
export async function startTask(taskId: string): Promise<void> {
  const row = getRunRow(taskId);
  if (!row) return;
  const uploads = listTaskUploadAttachments(taskId);
  insertUserMessage(taskId, row.prompt, uploads);
  publishUser(taskId, row.prompt);
  // 斜杠调用（如 /周报生成 主题）：落库与展示保留原文，发给模型的是技能正文展开；
  // context_note（附件清单/@ 引用）只随首轮发给模型，展示文本保持用户原文
  const context = row.context_note ? `\n\n${row.context_note}` : "";
  const userPrompt = (platformPlugins.isPluginActive("skills") ? expandSkillSlash(row.prompt, row.agent_id) : row.prompt) + context;
  const planPhase = (parseAccessMode(row.access_mode) ?? "autonomous") === "plan";
  const firstPrompt = planPhase
    ? `${PLAN_MODE_INSTRUCTION}

用户任务：${userPrompt}`
    : userPrompt;
  beginTurn(taskId);
  try {
    const session = await ensureSession(row);
    await runTurn(row, session, firstPrompt, { planPhase });
  } catch (err) {
    failTurn(taskId, err);
  } finally {
    endTurn(taskId);
  }
}

/**
 * 在既有任务上继续一轮对话（多轮追问）。
 * 同步完成校验并启动异步轮次；返回值供路由映射 HTTP 状态。
 * contextNote（附件清单等机器上下文）只随本轮发给模型，展示文本保持用户原文。
 */
export function sendMessage(
  taskId: string,
  prompt: string,
  contextNote = "",
  attachments?: UserMessageAttachment[]
): "ok" | "busy" | "not-found" {
  const row = getRunRow(taskId);
  if (!row) return "not-found";
  const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  if (!current) return "not-found";
  if (busy.has(taskId) || current.status === "pending" || current.status === "running") return "busy";

  insertUserMessage(taskId, prompt, attachments);
  publishUser(taskId, prompt);
  beginTurn(taskId);
  const context = contextNote ? `\n\n${contextNote}` : "";
  void (async () => {
    try {
      const session = await ensureSession(row);
      await runTurn(row, session, (platformPlugins.isPluginActive("skills") ? expandSkillSlash(prompt, row.agent_id) : prompt) + context);
    } catch (err) {
      failTurn(taskId, err);
    } finally {
      endTurn(taskId);
    }
  })();
  return "ok";
}

/**
 * 高风险审批通过：把用户逐项勾选的清单作为新一轮指令下发，任务继续执行。
 * 会话可能已被回收（闲置 sweeper / 服务重启），ensureSession 会从 JSONL 恢复，上下文不丢。
 */
export function approveTask(taskId: string, approvedItems: string[]): "ok" | "busy" | "not-found" {
  const row = getRunRow(taskId);
  if (!row) return "not-found";
  const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  if (!current) return "not-found";
  if (busy.has(taskId) || current.status === "pending" || current.status === "running") return "busy";
  if (current.status !== "awaiting_approval") return "not-found";

  // 确认计划后升为自主模式，写工具闸门按新档位生效（无需重建会话）
  const mode = parseAccessMode(row.access_mode) ?? "plan";
  if (mode === "plan") {
    db.prepare("UPDATE tasks SET access_mode = 'autonomous' WHERE id = ?").run(taskId);
  }

  const list = approvedItems.map((item) => `- [x] ${item}`).join("\n");
  const prompt = `[计划确认] 用户已在界面上逐项确认执行清单，批准以下项目：
${list}

请只执行以上已批准的项目，未列出的项目一律不要执行；执行完成后输出结果摘要。`;
  insertUserMessage(taskId, prompt);
  publishUser(taskId, prompt);
  beginTurn(taskId);
  void (async () => {
    try {
      const session = await ensureSession(row);
      await runTurn(row, session, prompt);
    } catch (err) {
      failTurn(taskId, err);
    } finally {
      endTurn(taskId);
    }
  })();
  return "ok";
}

/** 取消正在执行的当前轮次。返回 false 表示没有正在执行的轮次。 */
export function cancelTask(taskId: string): boolean {
  if (!busy.has(taskId)) return false;
  // busy 但会话尚未建立（ensureSession 窗口）也要登记取消意图：runTurn 轮首检查后直接落定
  cancelRequested.add(taskId);
  const session = sessions.get(taskId);
  if (session) void session.abort();
  return true;
}

/** 等待任务退出忙碌（打断后接力发新消息用）；超时返回 false。 */
export function waitTaskIdle(taskId: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!busy.has(taskId)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 120);
    timer.unref();
  });
}

const RESTART_INTERRUPT_ERROR = "服务重启导致任务中断，请重新派发";

function sessionFileFor(sessionId: string): string | undefined {
  if (!sessionId || sessionId.includes("..") || sessionId.includes("/") || sessionId.includes("\\")) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(paths.sessions);
  } catch {
    return undefined;
  }
  const name = names.find((item) => item.endsWith(`_${sessionId}.jsonl`));
  return name ? path.join(paths.sessions, name) : undefined;
}

/** 进程被杀掉时，内存里的半成品回复来不及落库。从会话 JSONL 按轮次回补，时间插在对应问句后面。 */
function backfillRestartReplies(): void {
  const rows = db
    .prepare(
      `SELECT t.id, t.session_id AS sessionId
       FROM tasks t
       WHERE t.session_id IS NOT NULL
         AND t.status = 'failed'
         AND t.error = ?
         AND (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id AND m.role = 'assistant')
           < (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id AND m.role = 'user')`
    )
    .all(RESTART_INTERRUPT_ERROR) as Array<{ id: string; sessionId: string }>;
  for (const row of rows) {
    try {
      const file = sessionFileFor(row.sessionId);
      if (!file) continue;
      const entries = fs
        .readFileSync(file, "utf8")
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      const turns = transcriptsFromSessionEntries(entries);
      const saved = db
        .prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND role = 'assistant'")
        .get(row.id) as { n: number };
      const missing = turns.slice(saved.n);
      if (!missing.length) continue;
      const users = db
        .prepare(
          "SELECT created_at FROM task_messages WHERE task_id = ? AND role = 'user' ORDER BY created_at, rowid"
        )
        .all(row.id) as Array<{ created_at: string }>;
      missing.forEach((turn, index) => {
        const at = saved.n + index;
        const prev = users[at]?.created_at ?? users[users.length - 1]?.created_at ?? now();
        const next = users[at + 1]?.created_at;
        const note = "本轮在完成前中断。";
        insertAssistantMessage(
          row.id,
          withInterruptNote(turn.text, note),
          turn,
          createdAtAfter(prev, next)
        );
      });
      console.log(`[runner] 已回补任务 ${row.id} 的 ${missing.length} 条中断回复`);
    } catch (err) {
      console.error(`[runner] 回补任务 ${row.id} 的中断回复失败`, err);
    }
  }
}

/** 服务启动时调用：上一进程遗留的 pending/running 任务已无活动会话，标记为失败；并为没有消息记录的旧任务补一条用户消息。 */
export function sweepOrphanTasks(): void {
  // awaiting_approval 不在此列：任务停在清单确认页，重启后仍可批准继续（会话从 JSONL 恢复）
  const result = db
    .prepare("UPDATE tasks SET status = 'failed', error = ? WHERE status IN ('pending', 'running')")
    .run(RESTART_INTERRUPT_ERROR);
  if (result.changes > 0) console.log(`[runner] 已将 ${result.changes} 个中断任务标记为 failed`);
  backfillRestartReplies();

  // 旧任务（多轮功能上线前创建）没有消息记录，补上首条用户消息，保证聊天视图完整
  db.prepare(
    `INSERT INTO task_messages (id, task_id, role, content, created_at)
     SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), t.id, 'user', t.prompt, t.created_at FROM tasks t
     WHERE NOT EXISTS (SELECT 1 FROM task_messages m WHERE m.task_id = t.id)`
  ).run();
}
