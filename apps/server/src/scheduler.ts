import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  UpdateScheduledTaskRequest,
} from "@office/shared";
import { currentUser } from "./auth.js";
import { paths } from "./config.js";
import { db, now, uuid } from "./db.js";
import { startTask } from "./runner.js";

/**
 * 定时与自动化巡检任务（ScheduledTask）：
 * 支持三种表达式：
 * 1. `daily:HH:mm` — 每日固定时刻（如 `daily:09:00`）
 * 2. `weekly:d:HH:mm` — 每周固定星期与时刻（d=1..7 对应周一..周日，如 `weekly:1:09:00`）
 * 3. `interval:N` — 每隔 N 分钟（5 <= N <= 10080，如 `interval:60`）
 */

export type ParsedSchedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { kind: "interval"; minutes: number };

/** 解析并校验定时表达式；非法格式返回 null */
export function parseScheduleExpr(expr: string): ParsedSchedule | null {
  const s = (expr ?? "").trim();
  const dailyMatch = /^daily:(\d{2}):(\d{2})$/.exec(s);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { kind: "daily", hour, minute };
    }
    return null;
  }
  const weeklyMatch = /^weekly:([1-7]):(\d{2}):(\d{2})$/.exec(s);
  if (weeklyMatch) {
    const dayOfWeek = Number(weeklyMatch[1]);
    const hour = Number(weeklyMatch[2]);
    const minute = Number(weeklyMatch[3]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { kind: "weekly", dayOfWeek, hour, minute };
    }
    return null;
  }
  const intervalMatch = /^interval:(\d+)$/.exec(s);
  if (intervalMatch) {
    const minutes = Number(intervalMatch[1]);
    if (minutes >= 5 && minutes <= 10080) {
      return { kind: "interval", minutes };
    }
    return null;
  }
  return null;
}

/** 根据基准时间计算下一次触发的 ISO 时间戳 */
export function computeNextRunAt(expr: string, fromDate: Date = new Date()): string | null {
  const parsed = parseScheduleExpr(expr);
  if (!parsed) return null;

  if (parsed.kind === "interval") {
    return new Date(fromDate.getTime() + parsed.minutes * 60_000).toISOString();
  }

  if (parsed.kind === "daily") {
    const next = new Date(fromDate.getTime());
    next.setSeconds(0, 0);
    next.setHours(parsed.hour, parsed.minute, 0, 0);
    if (next.getTime() <= fromDate.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }

  // weekly: dayOfWeek 1..7 (Mon..Sun), JS getDay() is 0..6 (Sun..Sat)
  const targetJsDay = parsed.dayOfWeek === 7 ? 0 : parsed.dayOfWeek;
  const next = new Date(fromDate.getTime());
  next.setSeconds(0, 0);
  next.setHours(parsed.hour, parsed.minute, 0, 0);
  const currentJsDay = next.getDay();
  let diffDays = (targetJsDay - currentJsDay + 7) % 7;
  if (diffDays === 0 && next.getTime() <= fromDate.getTime()) {
    diffDays = 7;
  }
  next.setDate(next.getDate() + diffDays);
  return next.toISOString();
}

interface ScheduledTaskRow {
  id: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  provider_id: string | null;
  model_id: string | null;
  title: string;
  prompt: string;
  schedule_expr: string;
  enabled: number;
  last_run_at: string | null;
  last_task_id: string | null;
  next_run_at: string | null;
  created_at: string;
}

const SELECT_SCHEDULED = `
  SELECT s.id, s.user_id, s.agent_id, a.name AS agent_name,
         s.provider_id, s.model_id, s.title, s.prompt, s.schedule_expr,
         s.enabled, s.last_run_at, s.last_task_id, s.next_run_at, s.created_at
  FROM scheduled_tasks s
  JOIN agents a ON a.id = s.agent_id`;

function toScheduledDto(r: ScheduledTaskRow): ScheduledTask {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    providerId: r.provider_id ?? "",
    modelId: r.model_id ?? "",
    title: r.title,
    prompt: r.prompt,
    scheduleExpr: r.schedule_expr,
    enabled: !!r.enabled,
    lastRunAt: r.last_run_at,
    lastTaskId: r.last_task_id,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
  };
}

/** 触发一次定时任务：创建真实 Task 并调用 startTask 后台异步执行 */
export function triggerScheduledTaskNow(scheduleId: string): { taskId: string } {
  const row = db
    .prepare(
      `SELECT s.*, a.folder AS agent_folder, a.provider_id AS agent_provider_id, a.model_id AS agent_model_id
       FROM scheduled_tasks s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.id = ?`
    )
    .get(scheduleId) as
    | (ScheduledTaskRow & {
        agent_folder: string;
        agent_provider_id: string | null;
        agent_model_id: string | null;
      })
    | undefined;
  if (!row) throw new Error("定时任务不存在");

  let providerId = row.provider_id || "";
  let modelId = row.model_id || "";
  if (!providerId || !modelId) {
    // 只回退到这条巡检所属用户自己的供应商，不用专家或其他人的模型
    const p = db
      .prepare("SELECT id, enabled_models FROM model_providers WHERE enabled = 1 AND user_id = ? ORDER BY created_at LIMIT 1")
      .get(row.user_id) as { id: string; enabled_models: string } | undefined;
    if (p) {
      try {
        const arr = JSON.parse(p.enabled_models);
        if (Array.isArray(arr) && typeof arr[0] === "string") {
          providerId = p.id;
          modelId = arr[0];
        }
      } catch {
        // ignore
      }
    }
  }
  if (!providerId || !modelId) {
    throw new Error("未找到可用模型，请先配置模型供应商或为该定时任务指定模型");
  }

  const taskId = uuid();
  let workspace: string;
  let customWorkspace = 0;
  if (row.agent_folder && fs.existsSync(row.agent_folder)) {
    workspace = row.agent_folder;
    customWorkspace = 1;
  } else {
    workspace = path.join(paths.workspaces, taskId);
    fs.mkdirSync(workspace, { recursive: true });
  }

  const dateTag = new Date().toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  const taskTitle = `⏰ ${row.title} (${dateTag})`;
  const runTimeIso = now();
  const nextRunIso = row.enabled ? computeNextRunAt(row.schedule_expr, new Date()) : null;

  db.prepare(
    `INSERT INTO tasks (id, user_id, agent_id, provider_id, model_id, title, prompt, context_note, status, workspace_path, custom_workspace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', 'pending', ?, ?, ?)`
  ).run(taskId, row.user_id, row.agent_id, providerId, modelId, taskTitle, row.prompt, workspace, customWorkspace, runTimeIso);

  db.prepare(
    "UPDATE scheduled_tasks SET last_run_at = ?, last_task_id = ?, next_run_at = ? WHERE id = ?"
  ).run(runTimeIso, taskId, nextRunIso, scheduleId);

  startTask(taskId);
  return { taskId };
}

/** 扫描并触发所有已到期的启用定时任务 */
export function tickDueSchedules(nowDate: Date = new Date()): string[] {
  const nowIso = nowDate.toISOString();
  const dueRows = db
    .prepare(
      "SELECT id FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?"
    )
    .all(nowIso) as { id: string }[];
  const triggeredTaskIds: string[] = [];
  for (const r of dueRows) {
    try {
      const { taskId } = triggerScheduledTaskNow(r.id);
      triggeredTaskIds.push(taskId);
      console.log(`[scheduler] 已触发定时任务 ${r.id} -> Task ${taskId}`);
    } catch (err) {
      // 触发失败时也要推进 next_run_at，避免每 30 秒死循环重试
      const row = db.prepare("SELECT schedule_expr FROM scheduled_tasks WHERE id = ?").get(r.id) as
        | { schedule_expr: string }
        | undefined;
      if (row) {
        const nextIso = computeNextRunAt(row.schedule_expr, nowDate);
        db.prepare("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?").run(nextIso, r.id);
      }
      console.warn(`[scheduler] 定时任务 ${r.id} 触发失败：`, err);
    }
  }
  return triggeredTaskIds;
}

/** 启动后台定时任务轮询器（每 30 秒扫描一次到期任务） */
export function startScheduler(): void {
  const timer = setInterval(() => {
    try {
      tickDueSchedules();
    } catch (err) {
      console.warn("[scheduler] 扫描异常：", err);
    }
  }, 30_000);
  timer.unref();
}

export function registerScheduleRoutes(app: FastifyInstance): void {
  app.get("/schedules", { onRequest: [app.authenticate] }, async (req) => {
    const user = currentUser(req);
    const rows =
      user.role === "admin"
        ? (db.prepare(`${SELECT_SCHEDULED} ORDER BY s.created_at DESC`).all() as unknown as ScheduledTaskRow[])
        : (db
            .prepare(`${SELECT_SCHEDULED} WHERE s.user_id = ? ORDER BY s.created_at DESC`)
            .all(user.id) as unknown as ScheduledTaskRow[]);
    return rows.map(toScheduledDto);
  });

  app.post("/schedules", { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = currentUser(req);
    const body = (req.body ?? {}) as CreateScheduledTaskRequest;
    const prompt = body.prompt?.trim() ?? "";
    if (!prompt) return reply.code(400).send({ error: "任务提示词不能为空" });

    const scheduleExpr = body.scheduleExpr?.trim() ?? "";
    if (!parseScheduleExpr(scheduleExpr)) {
      return reply.code(400).send({
        error: "非法的定时周期格式（支持 daily:HH:mm、weekly:1..7:HH:mm、interval:分钟数）",
      });
    }

    let agentId = body.agentId?.trim() ?? "";
    if (agentId) {
      const exists = db.prepare("SELECT id FROM agents WHERE id = ? AND deleted = 0").get(agentId);
      if (!exists) return reply.code(400).send({ error: "指定的专家不存在" });
    } else {
      const def = db
        .prepare(
          "SELECT id FROM agents WHERE deleted = 0 ORDER BY (id = 'builtin-general-assistant') DESC, created_at LIMIT 1"
        )
        .get() as { id: string } | undefined;
      if (!def) return reply.code(400).send({ error: "暂无可用专家" });
      agentId = def.id;
    }

    const providerId = body.providerId?.trim() ?? "";
    const modelId = body.modelId?.trim() ?? "";
    if (providerId || modelId) {
      if (!providerId || !modelId) return reply.code(400).send({ error: "providerId 与 modelId 需同时提供" });
      const owned = db
        .prepare("SELECT enabled, enabled_models FROM model_providers WHERE id = ? AND user_id = ?")
        .get(providerId, user.id) as { enabled: number; enabled_models: string } | undefined;
      if (!owned || !owned.enabled) return reply.code(400).send({ error: "模型供应商不可用" });
      let models: unknown = [];
      try {
        models = JSON.parse(owned.enabled_models);
      } catch {
        models = [];
      }
      if (!Array.isArray(models) || !models.includes(modelId)) {
        return reply.code(400).send({ error: "模型不在该供应商的可用列表中" });
      }
    }

    const title = body.title?.trim() || prompt.slice(0, 32);
    const enabled = body.enabled !== false;
    const nextRunAt = enabled ? computeNextRunAt(scheduleExpr) : null;
    const id = uuid();

    db.prepare(
      `INSERT INTO scheduled_tasks (id, user_id, agent_id, provider_id, model_id, title, prompt, schedule_expr, enabled, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      user.id,
      agentId,
      providerId || null,
      modelId || null,
      title,
      prompt,
      scheduleExpr,
      enabled ? 1 : 0,
      nextRunAt,
      now()
    );

    const created = db.prepare(`${SELECT_SCHEDULED} WHERE s.id = ?`).get(id) as unknown as ScheduledTaskRow;
    return toScheduledDto(created);
  });

  app.patch("/schedules/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const existing = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as ScheduledTaskRow | undefined;
    if (!existing) return reply.code(404).send({ error: "定时任务不存在" });
    if (user.role !== "admin" && existing.user_id !== user.id) {
      return reply.code(403).send({ error: "无权修改此定时任务" });
    }

    const body = (req.body ?? {}) as UpdateScheduledTaskRequest;
    const title = body.title !== undefined ? body.title.trim() || existing.title : existing.title;
    const prompt = body.prompt !== undefined ? body.prompt.trim() || existing.prompt : existing.prompt;
    const agentId = body.agentId !== undefined ? body.agentId.trim() || existing.agent_id : existing.agent_id;
    const providerId = body.providerId !== undefined ? body.providerId.trim() || null : existing.provider_id;
    const modelId = body.modelId !== undefined ? body.modelId.trim() || null : existing.model_id;
    const scheduleExpr = body.scheduleExpr !== undefined ? body.scheduleExpr.trim() : existing.schedule_expr;
    if (!parseScheduleExpr(scheduleExpr)) {
      return reply.code(400).send({ error: "非法的定时周期格式" });
    }
    const enabled = body.enabled !== undefined ? body.enabled : !!existing.enabled;
    const nextRunAt = enabled ? computeNextRunAt(scheduleExpr) : null;

    db.prepare(
      `UPDATE scheduled_tasks
       SET title = ?, prompt = ?, agent_id = ?, provider_id = ?, model_id = ?, schedule_expr = ?, enabled = ?, next_run_at = ?
       WHERE id = ?`
    ).run(title, prompt, agentId, providerId, modelId, scheduleExpr, enabled ? 1 : 0, nextRunAt, id);

    const updated = db.prepare(`${SELECT_SCHEDULED} WHERE s.id = ?`).get(id) as unknown as ScheduledTaskRow;
    return toScheduledDto(updated);
  });

  app.delete("/schedules/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const existing = db.prepare("SELECT user_id FROM scheduled_tasks WHERE id = ?").get(id) as
      | { user_id: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "定时任务不存在" });
    if (user.role !== "admin" && existing.user_id !== user.id) {
      return reply.code(403).send({ error: "无权删除此定时任务" });
    }
    db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    return { ok: true };
  });

  app.post("/schedules/:id/run", { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const existing = db.prepare("SELECT user_id FROM scheduled_tasks WHERE id = ?").get(id) as
      | { user_id: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "定时任务不存在" });
    if (user.role !== "admin" && existing.user_id !== user.id) {
      return reply.code(403).send({ error: "无权触发此定时任务" });
    }
    try {
      const { taskId } = triggerScheduledTaskNow(id);
      return { ok: true, taskId };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
