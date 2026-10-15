import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { codeExecToolIfAvailable, hasCodeExec } from "./codeExec.js";
import { paths } from "./config.js";
import { db, now, uuid } from "./db.js";
import { readAgentsMd } from "./instructions.js";
import { getMcpTools } from "./mcp.js";
import { parseModelOverrides, resolveModelCaps } from "./model-caps.js";
import { skillScriptTool } from "./skill-scripts.js";
import { buildSkillsPrompt, expandSkillSlash, readSkillTool } from "./skills.js";
import { publishPi, publishStatus, publishUser } from "./sse.js";
import { cancelToolApproval, requestToolApproval } from "./tool-approval.js";
import { parseToolPolicy, policyFor } from "./tool-policy.js";
import { workspaceTools } from "./tools.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ProviderRow {
  provider_id: string;
  name: string;
  base_url: string;
  api_key: string;
  model_overrides: string | null;
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
- All output files (reports, drafts, code, data) MUST be written there with the workspace_write tool. Deliverables are collected from that directory.
- Use workspace_list / workspace_read to inspect files in the workspace, and fetch_url to read web pages when needed.
- You have no shell access on purpose: produce files, not terminal effects.
- When the task is complete, end with a short final message summarizing what you produced (mention file names).`;

const USER_DIR_PREAMBLE = `You are a task-executing agent in an office automation platform. You receive a task from a user and work on it autonomously until it is done.

Environment:
- You are working inside a directory CHOSEN BY THE USER (your current workspace). It may already contain files; use workspace_list / workspace_read to inspect them before overwriting anything.
- All output files MUST be written into that directory with the workspace_write tool. Deliverables are collected from files created or modified during this task.
- fetch_url is available to read web pages when needed.
- You have no shell access on purpose: produce files, not terminal effects.
- When the task is complete, end with a short final message summarizing what you produced (mention file names).`;

const CODE_EXEC_NOTE =
  "- You have no shell access, but the run_code tool executes a JavaScript/Python script in a network-isolated container with this workspace mounted read-only at /workspace. Use it for computation, data processing, or verifying generated code, then write results with workspace_write.";

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
  if (!codeExec) return base;
  return base.replace("- You have no shell access on purpose: produce files, not terminal effects.", CODE_EXEC_NOTE);
}

/** 用 model_providers 行在内存中注册一个 OpenAI 兼容供应商，并构造对应 Model。 */
async function buildRuntimeAndModel(
  provider: ProviderRow,
  modelId: string
): Promise<{ runtime: ModelRuntime; model: Model<"openai-completions"> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const providerId = `office-${provider.provider_id}`;
  // 能力元数据可按模型覆盖（contextWindow/maxTokens/reasoning），未配置时用兜底默认
  const caps = resolveModelCaps(modelId, parseModelOverrides(provider.model_overrides));
  runtime.registerProvider(providerId, {
    name: provider.name,
    baseUrl: provider.base_url,
    apiKey: provider.api_key,
    api: "openai-completions",
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
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
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

/** 用户自选目录的任务：只把任务开始之后产生/修改的文件记为成果物（2 秒时钟容差）。 */
function deliverableSinceMs(taskId: string): number | undefined {
  const t = db.prepare("SELECT started_at, created_at, custom_workspace FROM tasks WHERE id = ?").get(taskId) as
    | { started_at: string | null; created_at: string; custom_workspace: number }
    | undefined;
  if (!t?.custom_workspace) return undefined;
  const base = t.started_at ?? t.created_at;
  const ms = Date.parse(base);
  return Number.isFinite(ms) ? ms - 2_000 : undefined;
}

interface TaskJoinRow {
  id: string;
  prompt: string;
  /** 附件清单与 @ 引用等机器上下文：只随首轮发给模型，展示文本保持用户原文 */
  context_note: string;
  workspace_path: string;
  custom_workspace: number;
  session_id: string | null;
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
}

// 任务级模型优先（专家与模型解耦），否则回退专家默认绑定
const SELECT_RUN_ROW = `
  SELECT t.id, t.prompt, t.context_note, t.workspace_path, t.custom_workspace, t.session_id,
         a.name AS agent_name, a.system_prompt, a.high_risk, a.tool_policy,
         COALESCE(t.model_id, a.model_id) AS model_id,
         COALESCE(t.provider_id, a.provider_id) AS provider_id,
         p.name AS provider_name, p.base_url, p.api_key, p.model_overrides
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
const busy = new Set<string>();
const cancelRequested = new Set<string>();
const lastActivity = new Map<string, number>();

function insertUserMessage(taskId: string, content: string): void {
  db.prepare("INSERT INTO task_messages (id, task_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").run(
    uuid(),
    taskId,
    content,
    now()
  );
}

function insertAssistantMessage(taskId: string, content: string): void {
  db.prepare("INSERT INTO task_messages (id, task_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)").run(
    uuid(),
    taskId,
    content,
    now()
  );
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

/**
 * 取回（或恢复）任务对应的 AgentSession。
 * 内存里有就直接复用；没有则按 session_id 从 JSONL 恢复（服务重启场景），彻底没有才新建。
 */
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
    },
    row.model_id
  );
  const codeExecAvailable = await hasCodeExec();
  // 工作区提示词需反映附件已就位（会话可能由后续轮次/服务重启后建立，直接查登记表）
  const uploadCount = (
    db.prepare("SELECT COUNT(*) AS n FROM task_uploads WHERE task_id = ?").get(row.id) as { n: number }
  ).n;
  // 渐进披露：系统提示词只带技能清单（专家显式绑定时仅注入绑定的技能），正文按需 read_skill
  const skillsPrompt = buildSkillsPrompt(row.id);
  const basePreamble = buildPreamble(!!row.custom_workspace, codeExecAvailable, uploadCount > 0, !!skillsPrompt);
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
  const mcpTools = await getMcpTools();
  if (mcpTools.length) console.log(`[runner] 任务 ${row.id} 注入 ${mcpTools.length} 个 MCP 工具`);

  // Docker 守护进程可用时注入容器隔离的代码执行工具；不可用时静默降级
  const codeTools = codeExecAvailable ? await codeExecToolIfAvailable(row.workspace_path) : [];
  if (codeTools.length) console.log(`[runner] 任务 ${row.id} 注入 run_code（Docker 隔离代码执行）`);

  const skillTools = skillsPrompt ? [readSkillTool(), skillScriptTool()] : [];

  // 专家级工具策略（P2-2）：deny 的工具注入前直接过滤；ask 的包一层审批等待
  const policy = parseToolPolicy(row.tool_policy);
  const allTools: ToolDefinition[] = [...workspaceTools(row.workspace_path), ...skillTools, ...mcpTools, ...codeTools];
  const customTools = allTools
    .filter((t) => policyFor(policy, t.name) !== "deny")
    .map((t) => (policyFor(policy, t.name) === "ask" ? gateTool(row.id, t) : t));

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
    try {
      publishPi(row.id, event as { type: string } & Record<string, unknown>);
    } catch {
      // 单条事件序列化失败不应中断任务
    }
  });
  return session;
}

function beginTurn(taskId: string): void {
  busy.add(taskId);
  lastActivity.set(taskId, Date.now());
  db.prepare("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL WHERE id = ?").run(
    now(),
    taskId
  );
  publishStatus(taskId, "running");
}

/** ask 级工具包装（P2-2）：执行前先等用户审批；等待期间刷新 lastActivity，避免 180 秒看门狗中止会话。 */
function gateTool(taskId: string, tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
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
  cancelRequested.delete(taskId);
  lastActivity.delete(taskId);
  cancelToolApproval(taskId);
}

/** 高风险专家首轮只出执行清单、不动手：把这条指令包在用户任务前面。 */
const HIGH_RISK_PLAN_INSTRUCTION = `[高风险审批流程 - 本轮为规划阶段] 这是一个高风险专家的任务。本轮你绝对不能执行任何写操作：不要运行命令、不要创建/修改/删除任何文件、不要调用任何会改变系统或工作区状态的工具（只读查看类工具允许）。

你的唯一任务：基于下面的用户任务，输出一份执行清单供用户逐项确认，格式必须是 Markdown 复选框列表，每项一行：

- [ ] <将要执行的具体动作，写明将运行哪些命令、创建/修改/删除哪些文件、影响范围与风险>

要求：清单按执行顺序排列、每项具体可核查（不写"处理相关文件"这类模糊描述）、清单前用一句话概括整体方案、清单后加一行"请确认后执行"。除该清单外不要输出其他内容，也不要开始执行。`;

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

  try {
    let promptText = prompt;
    // 模型单轮输出撞到长度上限（stopReason:"length"）时自动续跑，最多 3 轮；
    // 截断不是成功也不是模型错误，直接判完成会得到"任务完成但什么都没做"的假象
    for (let round = 1; ; round++) {
      // 会话建立窗口期（ensureSession 尚未返回）收到的取消/打断请求：prompt 前直接落定，不再发起新一轮
      if (cancelRequested.has(row.id)) {
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
        setTaskStatus(row.id, "failed", message);
        publishStatus(row.id, "failed", message);
        return;
      }
      if (stop === "aborted" || cancelRequested.has(row.id) || timedOut) {
        const message = timedOut ? "模型 180 秒无响应，已自动中止" : undefined;
        setTaskStatus(row.id, timedOut ? "failed" : "cancelled", message);
        publishStatus(row.id, timedOut ? "failed" : "cancelled", message);
        return;
      }
      if (stop === "length") {
        if (round >= 3) {
          const message = "模型输出连续 3 轮被长度上限截断，任务中止；请拆小任务或换长输出模型后重试";
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
    if (text) insertAssistantMessage(row.id, text);
    scanDeliverables(row.id, row.workspace_path, deliverableSinceMs(row.id));

    // 高风险规划轮：任务停在 awaiting_approval，等用户在界面上逐项确认（POST /tasks/:id/approve）后才继续
    if (opts.planPhase) {
      setTaskStatus(row.id, "awaiting_approval");
      publishStatus(row.id, "awaiting_approval");
      return;
    }

    setTaskStatus(row.id, "completed");
    publishStatus(row.id, "completed");
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const cancelled = !timedOut && cancelRequested.has(row.id);
    const message = timedOut ? "模型 180 秒无响应，已自动中止" : cancelled ? undefined : rawMessage;
    setTaskStatus(row.id, cancelled ? "cancelled" : "failed", message);
    publishStatus(row.id, cancelled ? "cancelled" : "failed", message);
  } finally {
    clearInterval(watchdog);
  }
}

/** 会话建立失败（供应商配置错误等）时的兜底落库。 */
function failTurn(taskId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
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
  insertUserMessage(taskId, row.prompt);
  publishUser(taskId, row.prompt);
  // 斜杠调用（如 /周报生成 主题）：落库与展示保留原文，发给模型的是技能正文展开；
  // context_note（附件清单/@ 引用）只随首轮发给模型，展示文本保持用户原文
  const context = row.context_note ? `\n\n${row.context_note}` : "";
  const userPrompt = expandSkillSlash(row.prompt) + context;
  const planPhase = !!row.high_risk;
  const firstPrompt = planPhase ? `${HIGH_RISK_PLAN_INSTRUCTION}

用户任务：${userPrompt}` : userPrompt;
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
export function sendMessage(taskId: string, prompt: string, contextNote = ""): "ok" | "busy" | "not-found" {
  const row = getRunRow(taskId);
  if (!row) return "not-found";
  const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  if (!current) return "not-found";
  if (busy.has(taskId) || current.status === "pending" || current.status === "running") return "busy";

  insertUserMessage(taskId, prompt);
  publishUser(taskId, prompt);
  beginTurn(taskId);
  const context = contextNote ? `\n\n${contextNote}` : "";
  void (async () => {
    try {
      const session = await ensureSession(row);
      await runTurn(row, session, expandSkillSlash(prompt) + context);
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

  const list = approvedItems.map((item) => `- [x] ${item}`).join("\n");
  const prompt = `[高风险审批] 用户已在界面上逐项确认执行清单，批准以下项目：
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

/** 服务启动时调用：上一进程遗留的 pending/running 任务已无活动会话，标记为失败；并为没有消息记录的旧任务补一条用户消息。 */
export function sweepOrphanTasks(): void {
  // awaiting_approval 不在此列：任务停在清单确认页，重启后仍可批准继续（会话从 JSONL 恢复）
  const result = db
    .prepare("UPDATE tasks SET status = 'failed', error = ? WHERE status IN ('pending', 'running')")
    .run("服务重启导致任务中断，请重新派发");
  if (result.changes > 0) console.log(`[runner] 已将 ${result.changes} 个中断任务标记为 failed`);

  // 旧任务（多轮功能上线前创建）没有消息记录，补上首条用户消息，保证聊天视图完整
  db.prepare(
    `INSERT INTO task_messages (id, task_id, role, content, created_at)
     SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), t.id, 'user', t.prompt, t.created_at FROM tasks t
     WHERE NOT EXISTS (SELECT 1 FROM task_messages m WHERE m.task_id = t.id)`
  ).run();
}
