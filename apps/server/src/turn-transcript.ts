import type { TaskTurnStep } from "@office/shared";

/** 一轮里已经产生、可以写进对话记录的内容。 */
export interface TurnTranscript {
  text: string;
  thinking: string;
  steps: TaskTurnStep[];
}

export interface SessionMessageLike {
  role?: string;
  content?: unknown;
}

const THINKING_CAP = 4000;
const STEP_CAP = 50;

function capTranscript(turn: TurnTranscript): TurnTranscript {
  let thinking = turn.thinking.trim();
  if (thinking.length > THINKING_CAP) thinking = `…${thinking.slice(-(THINKING_CAP - 200))}`;
  return {
    text: turn.text.trim(),
    thinking,
    steps: turn.steps.slice(0, STEP_CAP),
  };
}

function detailFromArgs(args: unknown): string | undefined {
  let obj = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args) as unknown;
    } catch {
      return args.slice(0, 160);
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  const skill = typeof rec.skill === "string" ? rec.skill : "";
  const script = typeof rec.script === "string" ? rec.script : "";
  if (skill) return (script ? `${skill}/${script}` : skill).slice(0, 160);
  for (const key of ["path", "command", "text", "agent", "name", "url"] as const) {
    const value = rec[key];
    if (typeof value === "string" && value) return value.slice(0, 160);
  }
  return undefined;
}

/** 从一条 assistant 消息的 content（字符串或 pi 内容块）取出正文、思考和工具步骤。 */
export function transcriptFromContent(content: unknown): TurnTranscript {
  if (typeof content === "string") return { text: content.trim(), thinking: "", steps: [] };
  if (!Array.isArray(content)) return { text: "", thinking: "", steps: [] };
  const text: string[] = [];
  const thinking: string[] = [];
  const steps: TaskTurnStep[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
    if (item.type === "text" && item.text) text.push(item.text);
    else if (item.type === "thinking" && item.thinking) thinking.push(item.thinking);
    else if (item.type === "toolCall" && item.name) {
      const detail = detailFromArgs(item.arguments);
      steps.push({ tool: item.name, ...(detail ? { detail } : {}), status: "done" });
    }
  }
  return { text: text.join(""), thinking: thinking.join("\n"), steps };
}

function unwrap(entry: unknown): SessionMessageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const obj = entry as { role?: string; content?: unknown; message?: SessionMessageLike };
  if (obj.message && typeof obj.message === "object") return obj.message;
  if (obj.role) return obj;
  return undefined;
}

/**
 * 按会话记录里的用户消息切轮。每一轮合并该轮全部 assistant 正文，
 * 这样打断或重启后仍是一问一答，而不是把所有问句堆在一起。
 */
export function transcriptsFromSessionEntries(entries: unknown[]): TurnTranscript[] {
  const turns: TurnTranscript[] = [];
  let current: TurnTranscript | null = null;
  const open = (): TurnTranscript => {
    if (!current) {
      current = { text: "", thinking: "", steps: [] };
      turns.push(current);
    }
    return current;
  };
  for (const entry of entries) {
    const msg = unwrap(entry);
    if (!msg?.role) continue;
    if (msg.role === "user") {
      current = { text: "", thinking: "", steps: [] };
      turns.push(current);
      continue;
    }
    if (msg.role !== "assistant") continue;
    const part = transcriptFromContent(msg.content);
    const turn = open();
    if (part.text) turn.text = turn.text ? `${turn.text}\n\n${part.text}` : part.text;
    if (part.thinking) turn.thinking = turn.thinking ? `${turn.thinking}\n${part.thinking}` : part.thinking;
    turn.steps.push(...part.steps);
  }
  return turns
    .map(capTranscript)
    .filter((turn) => turn.text || turn.thinking || turn.steps.length);
}

/** 本轮 prompt 之后新增的 assistant 内容（baseline 是开跑前的消息条数）。 */
export function partialTranscript(messages: SessionMessageLike[], baseline: number): TurnTranscript {
  return transcriptsFromSessionEntries(messages.slice(Math.max(0, baseline))).reduce<TurnTranscript>(
    (acc, turn) => ({
      text: [acc.text, turn.text].filter(Boolean).join("\n\n"),
      thinking: [acc.thinking, turn.thinking].filter(Boolean).join("\n"),
      steps: [...acc.steps, ...turn.steps],
    }),
    { text: "", thinking: "", steps: [] }
  );
}

/** 事件轨迹和会话消息二选一：思考留更完整的那份，工具步骤优先用带来源状态的轨迹。 */
export function mergePartial(
  parsed: TurnTranscript,
  trace?: { thinking?: string; steps?: TaskTurnStep[] }
): TurnTranscript {
  const traceThinking = trace?.thinking?.trim() ?? "";
  const thinking = parsed.thinking.trim().length >= traceThinking.length ? parsed.thinking : traceThinking;
  const steps = trace?.steps?.length ? trace.steps : parsed.steps;
  return capTranscript({ text: parsed.text, thinking, steps });
}

/** 正文后面补一句中断说明；还没有正文时，说明本身就是这条回复。 */
export function withInterruptNote(text: string, note: string): string {
  const body = text.trim();
  const tail = note.trim();
  if (!tail) return body;
  return body ? `${body}\n\n${tail}` : tail;
}

/**
 * 回补消息的时间必须落在对应问句之后、下一问之前。
 * 相等时按 rowid 会把回复排到下一问后面，问句又会堆到上面。
 */
export function createdAtAfter(prevIso: string, nextIso?: string): string {
  const prev = Date.parse(prevIso);
  if (!Number.isFinite(prev)) return new Date().toISOString();
  const next = nextIso ? Date.parse(nextIso) : Number.NaN;
  if (!Number.isFinite(next) || next <= prev) return new Date(prev + 1).toISOString();
  const mid = prev + Math.max(1, Math.floor((next - prev) / 2));
  if (mid >= next) return new Date(next - 1).toISOString();
  return new Date(mid).toISOString();
}
