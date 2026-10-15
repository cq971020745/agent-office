import { db, now } from "./db.js";
import { publishPi, publishStatus, publishUser } from "./sse.js";

/** 审批决定：仅本次放行、本会话放行、拒绝。旧客户端只传 approved 布尔值。 */
export type ToolApprovalDecision = "allow_once" | "allow_session" | "deny";

export function parseToolDecision(body: { decision?: unknown; approved?: unknown }): ToolApprovalDecision | undefined {
  if (body.decision === "allow_once" || body.decision === "allow_session" || body.decision === "deny") {
    return body.decision;
  }
  if (body.approved === true) return "allow_once";
  if (body.approved === false) return "deny";
  return undefined;
}

export function listSessionGrants(taskId: string): string[] {
  const rows = db
    .prepare("SELECT tool_name FROM task_session_grants WHERE task_id = ? ORDER BY created_at, tool_name")
    .all(taskId) as { tool_name: string }[];
  return rows.map((row) => row.tool_name);
}

export function hasSessionGrant(taskId: string, toolName: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM task_session_grants WHERE task_id = ? AND tool_name = ?").get(taskId, toolName);
  return !!row;
}

export function grantSessionTool(taskId: string, toolName: string): void {
  db.prepare(
    "INSERT INTO task_session_grants (task_id, tool_name, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id, tool_name) DO NOTHING"
  ).run(taskId, toolName, now());
}

export function revokeSessionGrant(taskId: string, toolName: string): boolean {
  const info = db.prepare("DELETE FROM task_session_grants WHERE task_id = ? AND tool_name = ?").run(taskId, toolName);
  return info.changes > 0;
}

/**
 * ask 级工具调用的审批等待（P2-2）：工具执行前暂停，向该任务的 SSE 流发布审批请求，
 * 等管理员在界面上批准/拒绝（POST /tasks/:id/tool-approval）。超时视为拒绝，任务不会永远卡住。
 * pi 串行执行工具，每个任务同时至多一个待审批调用。
 */
interface PendingToolApproval {
  tool: string;
  finish: (approved: boolean, reason?: string) => void;
}

const pending = new Map<string, PendingToolApproval>();

export const TOOL_APPROVAL_TIMEOUT_MS = 5 * 60_000;

export function pendingToolApproval(taskId: string): { tool: string } | undefined {
  const entry = pending.get(taskId);
  return entry ? { tool: entry.tool } : undefined;
}

export function requestToolApproval(taskId: string, tool: string, input: unknown, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const entry: PendingToolApproval = {
      tool,
      finish: (approved, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(taskId);
        // 任务可能在等待期间被删除；状态仅在仍是 awaiting_approval 时回写 running
        db.prepare("UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'awaiting_approval'").run(taskId);
        publishStatus(taskId, "running");
        if (reason) publishUser(taskId, reason);
        resolve(approved);
      },
    };
    const timer = setTimeout(() => {
      entry.finish(false, `[系统] 工具 ${tool} 的审批等待超时（5 分钟），本次调用已自动拒绝`);
    }, TOOL_APPROVAL_TIMEOUT_MS);
    timer.unref();
    const onAbort = () => entry.finish(false, `[系统] 任务已中止，工具 ${tool} 的本次调用取消`);
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(taskId, entry);
    publishPi(taskId, { type: "tool_approval_request", tool, input });
    db.prepare("UPDATE tasks SET status = 'awaiting_approval' WHERE id = ?").run(taskId);
    publishStatus(taskId, "awaiting_approval");
  });
}

/**
 * 界面审批落点：存在待审批则落定并返回 true，否则 false（调用方回 409）。
 * allow_session 先写入任务授权，同一会话里后续同名工具不再询问。
 */
export function resolveToolApproval(taskId: string, decision: ToolApprovalDecision): boolean {
  const entry = pending.get(taskId);
  if (!entry) return false;
  if (decision === "allow_session") grantSessionTool(taskId, entry.tool);
  entry.finish(decision !== "deny");
  return true;
}

/** 任务删除/中止时清理等待中的审批，避免 Promise 悬挂。 */
export function cancelToolApproval(taskId: string): void {
  const entry = pending.get(taskId);
  if (!entry) return;
  entry.finish(false, `[系统] 任务已中止，工具 ${entry.tool} 的本次调用取消`);
}
