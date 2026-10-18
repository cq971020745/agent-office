import type { ServerResponse } from "node:http";
import type { TaskContextUsage, TaskEventEnvelope, TaskStatus } from "@office/shared";

type Listener = (envelope: TaskEventEnvelope) => void;

const listeners = new Map<string, Set<Listener>>();
const seqs = new Map<string, number>();
// 每任务事件回放缓冲：任务可能快于前端建立 SSE 连接就跑完（毫秒级模型），
// 不缓冲的话晚到的订阅者永远收不到过程与终态，界面会一直转圈。
const history = new Map<string, TaskEventEnvelope[]>();
const HISTORY_CAP = 500;
// 跨任务也设上限：服务长期运行时逐任务累积会无界增长，超限时淘汰最久未更新的任务缓冲。
const MAX_TRACKED_TASKS = 100;

function record(taskId: string, envelope: TaskEventEnvelope): void {
  const list = history.get(taskId) ?? [];
  list.push(envelope);
  if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
  // 删除再插入以刷新 Map 的插入序，history 头部即最久未活跃的任务
  history.delete(taskId);
  history.set(taskId, list);
  if (history.size > MAX_TRACKED_TASKS) {
    const oldest = history.keys().next().value;
    if (oldest !== undefined) {
      history.delete(oldest);
      seqs.delete(oldest);
    }
  }
}

/** 任务被删除时同步丢弃其事件缓冲与序号，避免常驻内存。 */
export function clearTask(taskId: string): void {
  history.delete(taskId);
  seqs.delete(taskId);
}

function nextSeq(taskId: string): number {
  const seq = (seqs.get(taskId) ?? 0) + 1;
  seqs.set(taskId, seq);
  return seq;
}

export function publishPi(taskId: string, event: { type: string; [key: string]: unknown }): void {
  const envelope: TaskEventEnvelope = { seq: nextSeq(taskId), kind: "pi", event };
  record(taskId, envelope);
  for (const fn of listeners.get(taskId) ?? []) fn(envelope);
}

export function publishStatus(taskId: string, status: TaskStatus, error?: string): void {
  const envelope: TaskEventEnvelope = { seq: nextSeq(taskId), kind: "task", status, error };
  record(taskId, envelope);
  for (const fn of listeners.get(taskId) ?? []) fn(envelope);
}

export function publishUser(taskId: string, text: string): void {
  const envelope: TaskEventEnvelope = { seq: nextSeq(taskId), kind: "user", text };
  record(taskId, envelope);
  for (const fn of listeners.get(taskId) ?? []) fn(envelope);
}

/** 任务会话上下文占用（供桌面端会话框底部展示） */
export function publishContext(taskId: string, usage: TaskContextUsage): void {
  const envelope: TaskEventEnvelope = { seq: nextSeq(taskId), kind: "context", usage };
  record(taskId, envelope);
  for (const fn of listeners.get(taskId) ?? []) fn(envelope);
}

export function subscribe(taskId: string, fn: Listener): void {
  if (!listeners.has(taskId)) listeners.set(taskId, new Set());
  listeners.get(taskId)!.add(fn);
}

export function unsubscribe(taskId: string, fn: Listener): void {
  const set = listeners.get(taskId);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) listeners.delete(taskId);
}

/** 在已 hijack 的 Fastify 原生 response 上挂 SSE 流；连接断开时自动退订并回调清理。 */
export function attachSse(taskId: string, res: ServerResponse, onDetach?: () => void): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // 先回放历史事件再订阅增量；单线程内同步执行，之间不会有新事件插入
  for (const envelope of history.get(taskId) ?? []) {
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  }
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  const listener: Listener = (envelope) => {
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  };
  subscribe(taskId, listener);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe(taskId, listener);
    onDetach?.();
  });
}
