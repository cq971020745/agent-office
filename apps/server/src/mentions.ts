import type { WpsMention, WpsMentionType } from "@office/shared";

const MENTION_TYPES: WpsMentionType[] = ["chat", "contact", "doc", "kb", "meeting"];
const TYPE_LABELS: Record<WpsMentionType, string> = {
  chat: "群聊",
  contact: "联系人",
  doc: "云文档",
  kb: "知识库",
  meeting: "会议",
};
const ID_FIELDS: Record<WpsMentionType, string> = {
  chat: "chat_id",
  contact: "user_id",
  doc: "file_id",
  kb: "space_id",
  meeting: "record_id",
};

/** 防御性净化：前端传来的 mentions 只保留白名单字段，截断到合理长度与数量。 */
export function sanitizeMentions(raw: unknown): WpsMention[] {
  if (!Array.isArray(raw)) return [];
  const out: WpsMention[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    const id = String((item as { id?: unknown }).id ?? "").trim().slice(0, 128);
    const name = String((item as { name?: unknown }).name ?? "").trim().slice(0, 200);
    if (typeof type !== "string" || !MENTION_TYPES.includes(type as WpsMentionType)) continue;
    if (!id || !name) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: type as WpsMentionType, id, name });
  }
  return out;
}

/** multipart 里 mentions 以 JSON 字符串字段携带，解析失败按空处理（不因它拒绝任务）。 */
export function parseMentionsField(raw: string | undefined): WpsMention[] {
  if (!raw) return [];
  try {
    return sanitizeMentions(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * 把 @ 引用注入任务提示词：首轮即告诉专家引用了哪些对象与如何回查，
 * 不要求专家立即执行任何查询（是否需要由任务内容决定）。
 */
export function buildMentionsNote(mentions: WpsMention[]): string {
  if (!mentions.length) return "";
  const lines = mentions.map((m) => `- [${TYPE_LABELS[m.type]}] ${m.name}（${ID_FIELDS[m.type]}: ${m.id}）`);
  // 知识库的 id 字段名（space_id）与技能参数名（--drive-id）不一致，单独给出召回动线
  const kbHint = mentions.some((m) => m.type === "kb")
    ? [
        "知识库召回：space_id 即技能里的 drive_id，用 `ai-docs recall \"问题\" --drive-id <space_id> --topk 5` 检索片段；",
        "ref_score ≥ 0.5 才能作为关键结论依据（0.45–0.5 仅作旁证），召回为空时先用 `drive doclibs` 核对库名。",
      ]
    : [];
  return [
    "",
    "<wps_mentions>",
    "用户在输入框通过 @ 引用了以下 WPS 对象，它们是任务上下文的一部分：",
    ...lines,
    "如需查询或操作这些对象（查联系人/部门、读群消息、读云文档内容、发消息等），先用 read_skill 加载 wps365-skill 了解用法，再用 run_skill_script 执行对应子命令。",
    ...kbHint,
    "</wps_mentions>",
  ].join("\n");
}
