import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isChatModel, type AgentConfig, type AgentTaskWithDeliverables, type Task, type TaskStatus } from "@office/shared";
import { currentUser } from "../auth.js";
import { paths } from "../config.js";
import { db, now, uuid } from "../db.js";
import { attachSse, clearTask, publishStatus } from "../sse.js";
import { approveTask, cancelTask, dropTask, sendMessage, startTask } from "../runner.js";
import { resolveToolApproval } from "../tool-approval.js";
import { getAgentSkillBinding } from "../skills.js";
import { moveFile, stageMultipartFiles, uniqueTargetPath, withAttachmentNote, type StagedUpload } from "../uploads.js";

/** 审批流在任务时间线里留痕（拒绝/取消），复用 runner 的消息表结构。 */
function insertMessage(taskId: string, role: "user", content: string): void {
  db.prepare("INSERT INTO task_messages (id, task_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
    uuid(),
    taskId,
    role,
    content,
    now()
  );
}

interface TaskRow {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  workspace_path: string;
  custom_workspace: number;
  agent_name: string;
  model_id: string | null;
  provider_name: string | null;
}

function toTaskDto(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    providerName: row.provider_name ?? "",
    modelId: row.model_id ?? "",
    workspacePath: row.workspace_path,
    customWorkspace: !!row.custom_workspace,
  };
}

const SELECT_TASK = `
  SELECT t.id, t.user_id, t.agent_id, t.title, t.prompt, t.status, t.error,
         t.created_at, t.started_at, t.finished_at, t.workspace_path, t.custom_workspace,
         a.name AS agent_name,
         COALESCE(t.model_id, a.model_id) AS model_id,
         p.name AS provider_name
  FROM tasks t
  JOIN agents a ON a.id = t.agent_id
  LEFT JOIN model_providers p ON p.id = COALESCE(t.provider_id, a.provider_id)
`;

function parseStringArray(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function getTaskRow(id: string): TaskRow | undefined {
  return db.prepare(`${SELECT_TASK} WHERE t.id = ?`).get(id) as TaskRow | undefined;
}

function canAccess(req: FastifyRequest, row: TaskRow): boolean {
  const user = currentUser(req);
  return user.role === "admin" || row.user_id === user.id;
}

// ---------- 附件上传（净化/去重/暂存在 uploads.ts，这里只管落库与落盘） ----------

/** 把暂存附件移入任务工作区并登记 task_uploads；返回落盘的相对路径（供失败回滚）。 */
function persistUploads(taskId: string, workspace: string, staged: StagedUpload[]): string[] {
  const uploadStmt = db.prepare(
    "INSERT INTO task_uploads (task_id, rel_path, filename, size, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const relPaths: string[] = [];
  for (const s of staged) {
    const target = uniqueTargetPath(workspace, s.filename);
    moveFile(s.tmpPath, target);
    const relPath = path.relative(workspace, target).split(path.sep).join("/");
    uploadStmt.run(taskId, relPath, s.filename, s.size, now());
    relPaths.push(relPath);
  }
  return relPaths;
}

/** 追问并发竞态下 sendMessage 返回 busy 时，把刚登记的附件撤掉（文件与记录都删）。 */
function rollbackUploads(taskId: string, workspace: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    db.prepare("DELETE FROM task_uploads WHERE task_id = ? AND rel_path = ?").run(taskId, rel);
    const abs = path.resolve(workspace, ...rel.split("/"));
    if (abs.startsWith(path.resolve(workspace) + path.sep)) fs.rmSync(abs, { force: true });
  }
}

// ---------- 任务列表分页 ----------

/** 状态筛选桶：进行中含排队（pending），与客户端口径一致 */
const STATUS_FILTERS: Record<string, string[]> = {
  running: ["pending", "running"],
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface TaskListParams {
  status?: string;
  q?: string;
}

/** 解析 limit/offset/status/q；limit 夹在 1..200（默认 50），offset ≥ 0 */
export function parseListParams(raw: { limit?: string; offset?: string; status?: string; q?: string }): {
  limit: number;
  offset: number;
  status?: string;
  q?: string;
} {
  const toInt = (v: string | undefined, fallback: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const status = raw.status && STATUS_FILTERS[raw.status] ? raw.status : undefined;
  const q = raw.q?.trim() || undefined;
  return {
    limit: Math.min(Math.max(toInt(raw.limit, 50), 1), 200),
    offset: Math.max(toInt(raw.offset, 0), 0),
    status,
    q,
  };
}

/** 构建 GET /tasks 的 WHERE（含用户可见范围 + status 桶 + 关键词），LIMIT/OFFSET 由调用方拼接 */
export function buildTaskListWhere(
  userId: string,
  isAdmin: boolean,
  filter: TaskListParams
): { whereSql: string; args: unknown[] } {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (!isAdmin) {
    conds.push("t.user_id = ?");
    args.push(userId);
  }
  if (filter.status) {
    const statuses = STATUS_FILTERS[filter.status];
    if (!statuses) throw new Error(`bad status: ${filter.status}`);
    conds.push(`t.status IN (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  if (filter.q) {
    const like = `%${escapeLike(filter.q)}%`;
    conds.push("(t.title LIKE ? ESCAPE '\\' OR t.prompt LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  return { whereSql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", args };
}

export function registerTaskRoutes(app: FastifyInstance): void {
  // 成员可见的专家列表（软删除的专家不可见；默认模型可能为空，派发时再选）
  app.get("/agents", { onRequest: [app.authenticate] }, async () => {
    const rows = db
      .prepare(
        "SELECT a.id, a.name, a.description, a.provider_id AS providerId, a.model_id AS modelId, a.tags, a.folder, a.high_risk, p.name AS providerName FROM agents a LEFT JOIN model_providers p ON p.id = a.provider_id WHERE a.deleted = 0 ORDER BY a.created_at"
      )
      .all() as { id: string; name: string; description: string; providerId: string | null; modelId: string | null; tags: string; folder: string; high_risk: number; providerName: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      providerId: r.providerId ?? "",
      providerName: r.providerName ?? "",
      modelId: r.modelId ?? "",
      folderPath: r.folder ?? "",
      tags: parseStringArray(r.tags),
      highRisk: !!r.high_risk,
      skills: getAgentSkillBinding(r.id) ?? null,
    }));
  });

  // 派发时可选的模型：所有启用供应商下的「可用模型」；向量/重排等非对话模型不进选择列表
  app.get("/models", { onRequest: [app.authenticate] }, async () => {
    const rows = db
      .prepare("SELECT id, name, enabled_models FROM model_providers WHERE enabled = 1 ORDER BY created_at")
      .all() as { id: string; name: string; enabled_models: string }[];
    return rows.map((r) => ({
      providerId: r.id,
      providerName: r.name,
      models: parseStringArray(r.enabled_models).filter(isChatModel),
    }));
  });

  // 专家详情：完整配置（含系统提示词），登录用户可见
  app.get("/agents/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db
      .prepare(
        `SELECT a.id, a.name, a.description, a.system_prompt AS systemPrompt, a.provider_id AS providerId,
                a.model_id AS modelId, a.tags, a.folder, a.high_risk, p.name AS provider_name
         FROM agents a LEFT JOIN model_providers p ON p.id = a.provider_id
         WHERE a.id = ? AND a.deleted = 0`
      )
      .get(id) as
      | {
          id: string;
          name: string;
          description: string;
          systemPrompt: string;
          providerId: string | null;
          modelId: string | null;
          tags: string;
          folder: string;
          high_risk: number;
          provider_name: string | null;
        }
      | undefined;
    if (!r) return reply.code(404).send({ error: "agent not found" });
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      systemPrompt: r.systemPrompt,
      providerId: r.providerId ?? "",
      providerName: r.provider_name ?? "",
      modelId: r.modelId ?? "",
      folderPath: r.folder ?? "",
      tags: parseStringArray(r.tags),
      highRisk: !!r.high_risk,
      skills: getAgentSkillBinding(r.id) ?? null,
    } satisfies AgentConfig;
  });

  // 专家详情：该专家的历史任务（含产出文件）。口径与 GET /tasks 一致——管理员看全部，成员只看自己的
  app.get("/agents/:id/tasks", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = db.prepare("SELECT id FROM agents WHERE id = ? AND deleted = 0").get(id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const user = currentUser(req);
    const rows =
      user.role === "admin"
        ? (db.prepare(`${SELECT_TASK} WHERE t.agent_id = ? ORDER BY t.created_at DESC`).all(id) as unknown as TaskRow[])
        : (db.prepare(`${SELECT_TASK} WHERE t.agent_id = ? AND t.user_id = ? ORDER BY t.created_at DESC`).all(id, user.id) as unknown as TaskRow[]);
    const deliverablesStmt = db.prepare(
      "SELECT id, task_id, filename, rel_path, size, created_at FROM deliverables WHERE task_id = ? ORDER BY rel_path"
    );
    return rows.map((row) => {
      const files = deliverablesStmt.all(row.id) as unknown as {
        id: string;
        task_id: string;
        filename: string;
        rel_path: string;
        size: number;
        created_at: string;
      }[];
      return {
        ...toTaskDto(row),
        deliverables: files.map((f) => ({
          id: f.id,
          taskId: f.task_id,
          filename: f.filename,
          relPath: f.rel_path,
          size: f.size,
          createdAt: f.created_at,
        })),
      } satisfies AgentTaskWithDeliverables;
    });
  });

  app.post("/tasks", { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = currentUser(req);
    const isMultipart = (req.headers["content-type"] ?? "").startsWith("multipart/");
    let body: {
      agentId?: string;
      prompt?: string;
      title?: string;
      providerId?: string;
      modelId?: string;
      workspaceDir?: string;
    } = {};
    // multipart 附件先落到暂存目录：工作区取决于字段值，而字段可能在文件分片之后才到达
    const stageDir = isMultipart ? path.join(paths.workspaces, `_stage-${uuid()}`) : "";
    let staged: StagedUpload[] = [];
    try {
      if (isMultipart) {
        const parsed = await stageMultipartFiles(req, stageDir, [
          "agentId",
          "prompt",
          "title",
          "providerId",
          "modelId",
          "workspaceDir",
        ]);
        body = parsed.fields as typeof body;
        staged = parsed.staged;
        if (staged.some((s) => s.truncated)) {
          return reply.code(413).send({ error: "单个附件不能超过 20MB" });
        }
      } else {
        body = req.body as typeof body;
      }
      if (!body.agentId || !body.prompt?.trim()) {
        return reply.code(400).send({ error: "agentId and prompt are required" });
      }
      const agent = db
        .prepare("SELECT id, provider_id, model_id, folder FROM agents WHERE id = ? AND deleted = 0")
        .get(body.agentId) as
        | { id: string; provider_id: string | null; model_id: string | null; folder: string }
        | undefined;
      if (!agent) return reply.code(400).send({ error: "unknown agent" });

      // 模型选择：请求显式指定优先（专家与模型解耦），否则回退专家默认
      let providerId = body.providerId?.trim() ?? "";
      let modelId = body.modelId?.trim() ?? "";
      if (providerId || modelId) {
        if (!providerId || !modelId) return reply.code(400).send({ error: "providerId 与 modelId 需同时提供" });
        const p = db.prepare("SELECT enabled, enabled_models FROM model_providers WHERE id = ?").get(providerId) as
          | { enabled: number; enabled_models: string }
          | undefined;
        if (!p || !p.enabled) return reply.code(400).send({ error: "模型供应商不可用" });
        if (!parseStringArray(p.enabled_models).includes(modelId)) {
          return reply.code(400).send({ error: "模型不在该供应商的可用列表中" });
        }
      } else {
        providerId = agent.provider_id ?? "";
        modelId = agent.model_id ?? "";
        if (providerId && modelId) {
          const p = db.prepare("SELECT enabled FROM model_providers WHERE id = ?").get(providerId);
          if (!p) return reply.code(400).send({ error: "专家默认模型所在的供应商已删除，请重新选择模型" });
          if (!(p as { enabled: number }).enabled) {
            return reply.code(400).send({ error: "专家默认模型所在的供应商已停用，请重新选择模型" });
          }
        }
      }
      if (!providerId || !modelId) return reply.code(400).send({ error: "请先选择模型" });

      const id = uuid();
      // 工作目录：用户显式选择的目录 > 专家常驻文件夹（WorkBuddy 式，产出沉淀在专家目录）> 平台隔离工作区
      let workspace: string;
      let customWorkspace = 0;
      if (body.workspaceDir?.trim()) {
        const dir = path.resolve(body.workspaceDir.trim());
        if (!path.isAbsolute(dir)) return reply.code(400).send({ error: "工作目录必须是绝对路径" });
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          return reply.code(400).send({ error: "工作目录不存在或不是目录" });
        }
        workspace = dir;
        customWorkspace = 1;
      } else if (agent.folder) {
        fs.mkdirSync(agent.folder, { recursive: true });
        workspace = agent.folder;
        customWorkspace = 1;
      } else {
        workspace = path.join(paths.workspaces, id);
        fs.mkdirSync(workspace, { recursive: true });
      }
      // 标题取自用户原文；入库的 prompt 合成附件清单，agent 首轮即知道有哪些文件可读
      const prompt = body.prompt.trim();
      const title = body.title?.trim() || prompt.slice(0, 40);
      const storedPrompt = staged.length ? withAttachmentNote(prompt, staged) : prompt;
      db.prepare(
        "INSERT INTO tasks (id, user_id, agent_id, title, prompt, status, provider_id, model_id, workspace_path, custom_workspace, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)"
      ).run(id, user.id, body.agentId, title, storedPrompt, providerId, modelId, workspace, customWorkspace, now());

      // 附件从暂存区移入工作区并登记（rel_path 相对工作区；登记供成果物扫描排除）
      if (staged.length) {
        persistUploads(id, workspace, staged);
      }

      // fire-and-forget：runner 内部自捕获错误并回写状态
      void startTask(id);
      return reply.code(201).send({ id });
    } finally {
      if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
    }
  });

  // 列表分页：带 limit/offset/status/q 时返回 { items, total, counts }；
  // 无任何参数时保持旧行为返回全量数组（兼容旧客户端）。
  app.get("/tasks", { onRequest: [app.authenticate] }, async (req) => {
    const user = currentUser(req);
    const raw = req.query as { limit?: string; offset?: string; status?: string; q?: string };
    if (!raw.limit && !raw.offset && !raw.status && !raw.q) {
      const rows =
        user.role === "admin"
          ? (db.prepare(`${SELECT_TASK} ORDER BY t.created_at DESC`).all() as unknown as TaskRow[])
          : (db.prepare(`${SELECT_TASK} WHERE t.user_id = ? ORDER BY t.created_at DESC`).all(user.id) as unknown as TaskRow[]);
      return rows.map(toTaskDto);
    }
    const parsed = parseListParams(raw);
    const isAdmin = user.role === "admin";
    const { whereSql, args } = buildTaskListWhere(user.id, isAdmin, { status: parsed.status, q: parsed.q });
    const rows = db
      .prepare(`${SELECT_TASK} ${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, parsed.limit, parsed.offset) as unknown as TaskRow[];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM tasks t ${whereSql}`).get(...args) as { n: number }).n;
    // 状态计数只按可见范围统计（不受 status/q 筛选影响），供前端筛选 Tab 展示
    const scope = buildTaskListWhere(user.id, isAdmin, {});
    const countRows = db
      .prepare(`SELECT t.status AS status, COUNT(*) AS n FROM tasks t ${scope.whereSql} GROUP BY t.status`)
      .all(...scope.args) as unknown as { status: TaskStatus; n: number }[];
    const counts: Record<string, number> = { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of countRows) {
      counts.all += r.n;
      if (r.status === "pending" || r.status === "running") counts.running += r.n;
      else if (r.status in counts) counts[r.status] += r.n;
    }
    return { items: rows.map(toTaskDto), total, counts };
  });

  app.get("/tasks/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    return toTaskDto(row);
  });

  // 高风险审批：用户逐项确认执行清单后放行；reject=true 则直接取消任务
  app.post("/tasks/:id/approve", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    if (row.status !== "awaiting_approval") {
      return reply.code(409).send({ error: `task is ${row.status}，不在等待审批状态` });
    }
    const body = req.body as { approvedItems?: string[]; reject?: boolean };
    if (body.reject) {
      db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ?, error = NULL WHERE id = ?").run(now(), id);
      insertMessage(id, "user", "[高风险审批] 用户拒绝了执行计划，任务已取消。");
      publishStatus(id, "cancelled");
      return reply.send({ ok: true, rejected: true });
    }
    const items = (body.approvedItems ?? []).map((i) => String(i).trim()).filter(Boolean);
    if (!items.length) return reply.code(400).send({ error: "approvedItems 不能为空（逐项确认后提交）" });
    const result = approveTask(id, items);
    if (result === "not-found") return reply.code(404).send({ error: "task not found" });
    if (result === "busy") return reply.code(409).send({ error: "agent 正在执行中，请稍后再试" });
    return reply.code(202).send({ ok: true });
  });

  // ask 级工具调用审批（P2-2）：approve/deny 一次调用；等待中的请求由 runner 落定
  app.post("/tasks/:id/tool-approval", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    const body = req.body as { approved?: boolean };
    const ok = resolveToolApproval(id, body.approved === true);
    if (!ok) return reply.code(409).send({ error: "该任务当前没有等待审批的工具调用" });
    return reply.send({ ok: true });
  });

  app.post("/tasks/:id/cancel", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    if (row.status === "awaiting_approval") {
      // 停在清单确认页：runner 不忙，直接取消即可
      db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ?, error = NULL WHERE id = ?").run(now(), id);
      insertMessage(id, "user", "[高风险审批] 用户取消了待确认的任务。");
      publishStatus(id, "cancelled");
      return reply.send({ ok: true });
    }
    if (row.status !== "running" && row.status !== "pending") {
      return reply.code(409).send({ error: `task is ${row.status}` });
    }
    const ok = cancelTask(id);
    if (!ok && (row.status === "running" || row.status === "pending")) {
      // 尚未被 runner 接管（排队中）：直接标记取消
      db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), id);
    }
    return reply.send({ ok: true });
  });

  // 删除任务：登记、消息、成果物索引一并清掉；平台隔离工作区与会话文件随任务删除，
  // 用户自选目录（含专家常驻文件夹）里的文件属于用户，不删除。
  app.delete("/tasks/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    if (row.status === "running" || row.status === "pending") {
      return reply.code(409).send({ error: "任务进行中，请先取消再删除" });
    }
    const detail = db
      .prepare("SELECT workspace_path, custom_workspace, session_id FROM tasks WHERE id = ?")
      .get(id) as { workspace_path: string; custom_workspace: number; session_id: string | null } | undefined;

    db.prepare("DELETE FROM deliverables WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_uploads WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);

    // 平台隔离工作区目录位于 data/workspaces 下时才删除（防误删路径之外的内容）
    if (detail && !detail.custom_workspace) {
      const root = path.resolve(paths.workspaces);
      const dir = path.resolve(detail.workspace_path);
      if (dir.startsWith(root + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // 会话 JSONL：只删本任务的会话文件（同目录可能还有其他任务的会话）
    if (detail?.session_id) {
      const file = SessionManager.findById(detail.workspace_path, detail.session_id, paths.sessions);
      if (file) fs.rmSync(file, { force: true });
    }

    dropTask(id);
    clearTask(id);
    return reply.send({ ok: true });
  });

  // 多轮对话：任务级消息（用户派发/追问 + agent 最终回复）
  app.get("/tasks/:id/messages", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    const rows = db
      .prepare("SELECT id, task_id, role, content, created_at FROM task_messages WHERE task_id = ? ORDER BY created_at, rowid")
      .all(id) as unknown as { id: string; task_id: string; role: string; content: string; created_at: string }[];
    return rows.map((m) => ({ id: m.id, taskId: m.task_id, role: m.role, content: m.content, createdAt: m.created_at }));
  });

  // 多轮追问：纯 JSON 或 multipart（带附件）。附件在确认本轮可执行后落进任务工作区，
  // 与提示词一起合成附件清单交给 agent；若并发竞态撞上 busy 则回滚刚登记的附件。
  app.post("/tasks/:id/messages", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    if (row.status === "awaiting_approval") {
      return reply.code(409).send({ error: "任务等待高风险审批，请先在上方逐项确认执行清单" });
    }
    const isMultipart = (req.headers["content-type"] ?? "").startsWith("multipart/");
    const stageDir = isMultipart ? path.join(paths.workspaces, `_stage-${uuid()}`) : "";
    let prompt = "";
    let staged: StagedUpload[] = [];
    try {
      if (isMultipart) {
        const parsed = await stageMultipartFiles(req, stageDir, ["prompt"]);
        prompt = (parsed.fields.prompt ?? "").trim();
        staged = parsed.staged;
        if (staged.some((s) => s.truncated)) {
          return reply.code(413).send({ error: "单个附件不能超过 20MB" });
        }
      } else {
        prompt = ((req.body as { prompt?: string })?.prompt ?? "").trim();
      }
      if (!prompt) return reply.code(400).send({ error: "prompt is required" });

      // 先落附件再启动本轮：agent 首个工具调用就可能读工作区
      let moved: string[] = [];
      if (staged.length) moved = persistUploads(id, row.workspace_path, staged);
      const result = sendMessage(id, withAttachmentNote(prompt, staged));
      if (result === "busy") {
        rollbackUploads(id, row.workspace_path, moved);
        return reply.code(409).send({ error: "agent 正在执行中，请等本轮结束后再继续" });
      }
      if (result === "not-found") return reply.code(404).send({ error: "task not found" });
      return reply.code(202).send({ ok: true });
    } finally {
      if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
    }
  });

  // SSE 实况。EventSource 无法带 Authorization 头，用 ?token= 传递 JWT。
  app.get(
    "/tasks/:id/events",
    {
      preValidation: async (req, reply) => {
        const token = (req.query as { token?: string }).token;
        if (!token) return reply.code(401).send({ error: "token query param required" });
        try {
          (req as { user?: unknown }).user = app.jwt.verify(token);
        } catch {
          return reply.code(401).send({ error: "invalid token" });
        }
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = getTaskRow(id);
      if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
      reply.hijack();
      attachSse(id, reply.raw);
    }
  );

  app.get("/tasks/:id/deliverables", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    const rows = db
      .prepare("SELECT id, task_id, filename, rel_path, size, created_at FROM deliverables WHERE task_id = ? ORDER BY rel_path")
      .all(id) as unknown as {
      id: string;
      task_id: string;
      filename: string;
      rel_path: string;
      size: number;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      filename: r.filename,
      relPath: r.rel_path,
      size: r.size,
      createdAt: r.created_at,
    }));
  });

  app.get("/tasks/:id/deliverables/:fileId/download", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    const row = getTaskRow(id);
    if (!row || !canAccess(req, row)) return reply.code(404).send({ error: "task not found" });
    const file = db.prepare("SELECT filename, rel_path FROM deliverables WHERE id = ? AND task_id = ?").get(fileId, id) as
      | { filename: string; rel_path: string }
      | undefined;
    if (!file) return reply.code(404).send({ error: "deliverable not found" });

    // 下载路径同样锁死在工作区内
    const root = path.resolve(row.workspace_path);
    const abs = path.resolve(root, file.rel_path);
    if (!abs.startsWith(root + path.sep)) return reply.code(400).send({ error: "bad deliverable path" });
    if (!fs.existsSync(abs)) return reply.code(410).send({ error: "file no longer exists" });

    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    return reply.send(fs.createReadStream(abs));
  });
}
