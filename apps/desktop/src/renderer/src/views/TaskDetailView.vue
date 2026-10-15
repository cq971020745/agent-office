<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { Deliverable, Task, TaskEventEnvelope, TaskMessage } from "@office/shared";
import {
  approveTask,
  approveToolCall,
  cancelTask,
  downloadDeliverable,
  getTask,
  getTaskMessages,
  listDeliverables,
  openTaskEvents,
  sendTaskMessage,
  sendTaskMessageWithFiles,
} from "../api";
import { renderMarkdown } from "../utils/markdown";
import { formatSize, previewKind, timeAgo } from "../utils/format";
import { toast, toastError } from "../composables/toast";
import { MAX_FILES, useAttachments } from "../composables/attachments";
import { useMentions } from "../composables/useMentions";
import { useSlashSkills } from "../composables/useSlashSkills";
import AgentAvatar from "../components/AgentAvatar.vue";
import MentionChips from "../components/MentionChips.vue";
import MentionPopup from "../components/MentionPopup.vue";
import PreviewPanel from "../components/PreviewPanel.vue";
import SkillPopup from "../components/SkillPopup.vue";
import VoiceDictate from "../components/VoiceDictate.vue";

const route = useRoute();
// 详情页组件在同路由下被复用（任务间跳转），taskId 必须跟随路由参数变化
const taskId = ref(route.params.id as string);
watch(
  () => route.params.id,
  (id) => {
    if (!id || id === taskId.value) return;
    closeEvents?.();
    closeEvents = undefined;
    lastSeq = 0;
    live.value = [];
    previewFile.value = null;
    error.value = "";
    task.value = null;
    messages.value = [];
    deliverables.value = [];
    toolApproval.value = null;
    taskId.value = id as string;
    // 换任务时清掉上一任务遗留的 @ 引用与弹层状态
    mention.state.open = false;
    mention.pendingMentions.value = [];
    slash.state.open = false;
    void refreshAll();
  }
);

const task = ref<Task | null>(null);
const messages = ref<TaskMessage[]>([]);
const deliverables = ref<Deliverable[]>([]);
// 当前进行中轮次的实时输出（轮次结束即被消息列表取代）；think 为模型思考流（think）
const live = ref<{ kind: "text" | "tool" | "file" | "think"; text: string }[]>([]);
const draft = ref("");
const error = ref("");
const sendError = ref("");
const previewFile = ref<Deliverable | null>(null);
const chatEl = ref<HTMLElement | null>(null);
const liveEl = ref<HTMLElement | null>(null);
// 用户是否停留在聊天底部附近（决定新消息是否自动滚动，避免打断回看）
const atBottom = ref(true);
let closeEvents: (() => void) | undefined;
let lastSeq = 0;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

const running = computed(() => task.value?.status === "running" || task.value?.status === "pending");
const awaitingApproval = computed(() => task.value?.status === "awaiting_approval");
// 运行中也可发送（发送 = 打断当前轮并开新一轮），只挡重复提交
const canSend = computed(() => draft.value.trim().length > 0 && !sending.value);

// ---------- 附件（随追问一起上传，落进任务工作区） ----------
const {
  attachments,
  fileInput,
  dragging,
  pickFiles,
  onFilesPicked,
  removeAttachment,
  reset: resetAttachments,
  onDragEnter,
  onDragLeave,
  onDrop,
} = useAttachments();
const sending = ref(false);

// ---------- 高风险审批面板 ----------
// Agent 首轮只输出执行清单（- [ ] 条目），用户逐项勾选后提交；默认全选，取消勾选的项目不会执行
interface PlanItem {
  text: string;
  checked: boolean;
}
const planItems = ref<PlanItem[]>([]);
const approving = ref(false);
const rejecting = ref(false);
const checkedCount = computed(() => planItems.value.filter((i) => i.checked).length);
const allChecked = computed(() => planItems.value.length > 0 && checkedCount.value === planItems.value.length);

function parsePlanItems(): void {
  const lastAssistant = [...messages.value].reverse().find((m) => m.role === "assistant");
  const items: PlanItem[] = [];
  if (lastAssistant) {
    for (const line of lastAssistant.content.split("\n")) {
      const m = line.match(/^\s*[-*]\s\[( |x|X)?\]\s*(.+?)\s*$/);
      if (m) items.push({ text: m[2], checked: true });
    }
  }
  if (!items.length && lastAssistant) {
    // 清单格式缺失时兜底：整段计划作为一个可确认项，保证审批流程不被卡死
    const text = lastAssistant.content.trim();
    if (text) items.push({ text: text.length > 300 ? `${text.slice(0, 300)}…` : text, checked: true });
  }
  planItems.value = items;
}

function toggleAll(): void {
  const target = !allChecked.value;
  for (const item of planItems.value) item.checked = target;
}

async function onApprove(): Promise<void> {
  const items = planItems.value.filter((i) => i.checked).map((i) => i.text);
  if (!items.length || approving.value) return;
  approving.value = true;
  try {
    await approveTask(taskId.value, items);
    toast("success", "已确认执行清单，Agent 开始执行");
    planItems.value = [];
  } catch (err) {
    toastError(err, "提交审批失败");
  } finally {
    approving.value = false;
  }
}

async function onRejectPlan(): Promise<void> {
  if (rejecting.value) return;
  rejecting.value = true;
  try {
    await approveTask(taskId.value, [], true);
    toast("info", "已拒绝执行计划，任务已取消");
    planItems.value = [];
  } catch (err) {
    toastError(err, "操作失败");
  } finally {
    rejecting.value = false;
  }
}

// ---------- ask 级工具调用审批（P2-2） ----------
// 工具执行前任务暂停并广播 tool_approval_request；SSE 重放历史，页面刷新/重连后审批不丢。
const toolApproval = ref<{ tool: string; input: string } | null>(null);
const toolDeciding = ref(false);

function fmtToolInput(input: unknown): string {
  try {
    const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return String(input ?? "");
  }
}

async function decideToolCall(approved: boolean): Promise<void> {
  if (toolDeciding.value || !toolApproval.value) return;
  toolDeciding.value = true;
  try {
    await approveToolCall(taskId.value, approved);
    toast("success", approved ? "已放行本次工具调用，任务继续执行" : "已拒绝本次工具调用");
    toolApproval.value = null;
  } catch (err) {
    toastError(err, "操作失败");
  } finally {
    toolDeciding.value = false;
  }
}

// 成果物归属到对话轮次：服务端在轮次结束时登记（时间戳晚于该轮 assistant 消息），
// 因此每份文件归属「createdAt 之前最近的一条用户消息」所在轮，卡片渲染在该轮 assistant 回复下方。
const filesAfterMsg = computed(() => {
  const map = new Map<string, Deliverable[]>();
  const msgs = messages.value;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "assistant") continue;
    let prevUser: TaskMessage | null = null;
    let nextUser: TaskMessage | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].role === "user") { prevUser = msgs[j]; break; }
    }
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === "user") { nextUser = msgs[j]; break; }
    }
    const files = deliverables.value.filter(
      (f) => (!prevUser || f.createdAt >= prevUser.createdAt) && (!nextUser || f.createdAt < nextUser.createdAt)
    );
    if (files.length) map.set(msgs[i].id, files);
  }
  // 兜底：没有可归属消息的文件挂到最后一条 assistant 上
  const grouped = new Set([...map.values()].flat());
  const orphan = deliverables.value.filter((f) => !grouped.has(f));
  if (orphan.length) {
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) map.set(lastAssistant.id, [...(map.get(lastAssistant.id) ?? []), ...orphan]);
  }
  return map;
});

const STATUS_TEXT: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  awaiting_approval: "待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function pushLive(kind: "text" | "tool" | "file" | "think", text: string): void {
  const last = live.value.at(-1);
  if ((kind === "text" || kind === "think") && last?.kind === kind) last.text += text;
  else live.value.push({ kind, text });
  // 思考流可能很长，只保留末尾一段，避免面板与 DOM 无限增长
  const cur = live.value.at(-1);
  if (kind === "think" && cur && cur.text.length > 4000) cur.text = "…" + cur.text.slice(-3800);
}

// 有新内容时自动滚动到底部（仅当用户停留在底部附近，回看历史不打扰）
watch(
  () => [messages.value.length, live.value.length, live.value.at(-1)?.text.length] as const,
  async () => {
    await nextTick();
    if (live.value.length) {
      const el = liveEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    } else if (atBottom.value) {
      const el = chatEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }
);

function onChatScroll(e: Event): void {
  const el = e.target as HTMLElement;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// 运行中显示已运行时长
const elapsedText = ref("");
watch(
  () => task.value?.status,
  (status) => {
    clearInterval(elapsedTimer);
    elapsedText.value = "";
    if (status !== "running") return;
    const t0 = Date.now();
    const tick = (): void => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      elapsedText.value = sec < 60 ? `已运行 ${sec} 秒` : `已运行 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  },
  { immediate: true }
);

function handleEnvelope(env: TaskEventEnvelope): void {
  // SSE 断线重连会整段重放历史，按 seq 去重
  if (env.seq <= lastSeq) return;
  lastSeq = env.seq;

  if (env.kind === "user") {
    // 别的端发出的新消息：以服务端消息列表为准
    void refreshMessages();
    return;
  }
  if (env.kind === "task") {
    if (task.value) task.value.status = env.status;
    if (env.status === "running") {
      live.value = [];
      toolApproval.value = null; // 审批落定（放行/拒绝/超时）后任务回到运行态
    }
    if (
      env.status === "completed" ||
      env.status === "failed" ||
      env.status === "cancelled" ||
      env.status === "awaiting_approval"
    ) {
      void refreshMessages();
      void refreshDeliverables();
      live.value = [];
    }
    return;
  }
  if (env.kind !== "pi") return;
  const event = env.event as {
    type: string;
    assistantMessageEvent?: { type: string; delta?: string };
    toolName?: string;
    args?: { path?: string };
    tool?: string;
    input?: unknown;
  };
  if (event.type === "tool_approval_request") {
    toolApproval.value = { tool: event.tool ?? "", input: fmtToolInput(event.input) };
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta" && event.assistantMessageEvent.delta) {
    // 思考阶段也有输出：不显示就是"看起来卡住"（正文开始前的 ~90s 空窗）
    pushLive("think", event.assistantMessageEvent.delta);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta) {
    pushLive("text", event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start" && event.toolName === "workspace_write") {
    pushLive("file", event.args?.path ?? "");
  } else if (event.type === "tool_execution_start") {
    pushLive("tool", `调用工具 ${event.toolName ?? ""}`);
  }
}

async function refreshMessages(): Promise<void> {
  messages.value = await getTaskMessages(taskId.value).catch(() => messages.value);
  if (task.value?.status === "awaiting_approval") parsePlanItems();
}

async function refreshDeliverables(): Promise<void> {
  deliverables.value = await listDeliverables(taskId.value).catch(() => deliverables.value);
}

async function refreshAll(): Promise<void> {
  try {
    task.value = await getTask(taskId.value);
    await Promise.all([refreshMessages(), refreshDeliverables()]);
    // 常驻订阅：多轮对话期间页面不关流，重连靠 seq 去重
    closeEvents = openTaskEvents(taskId.value, handleEnvelope);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  }
}

async function onSend(): Promise<void> {
  const prompt = draft.value.trim();
  if (!prompt || sending.value) return;
  // 运行中发送 = 打断：服务端先中止当前轮，等其落定后以该消息开新一轮
  const wasRunning = running.value;
  const files = [...attachments.value];
  const mentions = [...mention.pendingMentions.value];
  sending.value = true;
  sendError.value = "";
  draft.value = "";
  slash.state.open = false;
  mention.state.open = false;
  // 本地乐观插入，服务端确认后由消息列表刷新接管
  messages.value = [
    ...messages.value,
    { id: `local-${Date.now()}`, taskId: taskId.value, role: "user", content: prompt, createdAt: new Date().toISOString() },
  ];
  try {
    if (files.length) await sendTaskMessageWithFiles(taskId.value, prompt, files, mentions, wasRunning);
    else await sendTaskMessage(taskId.value, prompt, mentions, wasRunning);
    mention.pendingMentions.value = [];
    resetAttachments();
    if (wasRunning) toast("info", "已打断当前轮次，正在以新消息继续对话");
  } catch (err) {
    sendError.value = err instanceof Error ? err.message : "发送失败";
    await refreshMessages();
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent): void {
  // 中文输入法选词的 Enter 不当作发送
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void onSend();
  }
}

// ---------- 追问输入框的 @ 引用：与新建任务共用弹层组件与数据源 ----------
const taRef = ref<HTMLTextAreaElement | null>(null);
const mention = useMentions({ prompt: draft, taRef, onFallbackKey: onKeydown });
// ---------- / 斜杠技能：键入 / 弹技能候选，与 @ 弹层互斥 ----------
const slash = useSlashSkills({ prompt: draft, taRef });

/** 弹层键盘链：/ 技能弹层优先，其次 @ 引用弹层，最后宿主（Enter 发送） */
function onTaKeydown(e: KeyboardEvent): void {
  if (slash.onKeydown(e)) return;
  mention.onTaKeydown(e);
}

/** 输入/点击时同时探测 / 与 @ 两个弹层（检测正则互斥，不会同时开） */
function detectPopups(): void {
  slash.detectSlash();
  mention.detectMention();
}

/** 语音转写回填：插入光标处，与前后已有内容补空格分隔 */
function appendVoiceText(text: string): void {
  const ta = taRef.value;
  const pos = ta?.selectionStart ?? draft.value.length;
  const before = draft.value.slice(0, pos);
  const after = draft.value.slice(pos);
  const glue = (s: string, re: RegExp) => (s && !re.test(s) ? " " : "");
  draft.value = before + glue(before, /\s$/) + text + glue(after, /^\s/) + after;
  ta?.focus();
}

async function onCancel(): Promise<void> {
  try {
    await cancelTask(taskId.value);
    toast("info", "已请求取消本轮");
  } catch (err) {
    toastError(err, "取消失败");
  }
}

// 失败重试：把最近一条用户消息原样再发一次
const retrying = ref(false);
async function onRetry(): Promise<void> {
  if (retrying.value) return;
  const lastUser = [...messages.value].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    toastError(new Error("没有可重试的消息"));
    return;
  }
  retrying.value = true;
  try {
    await sendTaskMessage(taskId.value, lastUser.content);
    toast("info", "已重新发起，Agent 将重试本轮");
    await refreshMessages();
  } catch (err) {
    toastError(err, "重试失败");
  } finally {
    retrying.value = false;
  }
}

async function copyMessage(m: TaskMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText(m.content);
    toast("success", "已复制到剪贴板");
  } catch {
    toastError(new Error("复制失败，请手动选择文本"));
  }
}

function fileEmoji(name: string): string {
  const kind = previewKind(name);
  if (kind === "html") return "🌐";
  if (kind === "image") return "🖼️";
  if (kind === "text") return "📄";
  return "📦";
}

// ---------- 预览面板宽度：按内容区比例存储，拖拽分隔条调整，随窗口同比例缩放 ----------
const PREVIEW_RATIO_KEY = "agent-office-preview-width-ratio";
const SIDEBAR_W = 248; // 与 App.vue 侧栏宽度一致
const PREVIEW_MIN_PX = 320; // 预览最小宽度
const CHAT_MIN_PX = 300; // 中间会话区最小宽度

function contentWidth(): number {
  return Math.max(620, window.innerWidth - SIDEBAR_W);
}
function clampRatio(r: number): number {
  const cw = contentWidth();
  return Math.min((cw - CHAT_MIN_PX) / cw, Math.max(PREVIEW_MIN_PX / cw, r));
}
function loadSavedRatio(): number {
  const raw = Number(localStorage.getItem(PREVIEW_RATIO_KEY));
  if (Number.isFinite(raw) && raw > 0.05 && raw < 1) return raw;
  // 旧版存的是像素值，按当前内容区宽度换算成比例
  const legacy = Number(localStorage.getItem("agent-office-preview-width"));
  if (Number.isFinite(legacy) && legacy >= PREVIEW_MIN_PX) return clampRatio(legacy / contentWidth());
  return 0.5;
}

const previewRatio = ref(clampRatio(loadSavedRatio()));
const draggingCol = ref(false);
const previewCssWidth = computed(
  () => `clamp(${PREVIEW_MIN_PX}px, ${Math.round(previewRatio.value * 10000) / 100}%, calc(100% - ${CHAT_MIN_PX}px))`
);

function onSplitterDown(e: MouseEvent): void {
  e.preventDefault();
  draggingCol.value = true;
  document.body.classList.add("col-resizing");
}
function onSplitterMove(e: MouseEvent): void {
  if (!draggingCol.value) return;
  previewRatio.value = clampRatio((window.innerWidth - e.clientX) / contentWidth());
}
function onSplitterUp(): void {
  if (!draggingCol.value) return;
  draggingCol.value = false;
  document.body.classList.remove("col-resizing");
  localStorage.setItem(PREVIEW_RATIO_KEY, String(Math.round(previewRatio.value * 10000) / 10000));
}
function onSplitterDblClick(): void {
  previewRatio.value = 0.5;
  localStorage.setItem(PREVIEW_RATIO_KEY, "0.5");
}

onMounted(() => {
  void refreshAll();
  window.addEventListener("mousemove", onSplitterMove);
  window.addEventListener("mouseup", onSplitterUp);
});
onBeforeUnmount(() => {
  closeEvents?.();
  clearInterval(elapsedTimer);
  window.removeEventListener("mousemove", onSplitterMove);
  window.removeEventListener("mouseup", onSplitterUp);
  document.body.classList.remove("col-resizing");
});
</script>

<template>
  <div class="page" v-if="task">
    <header class="topbar">
      <div class="tb-left">
        <RouterLink to="/tasks" class="back" title="返回任务列表">
          <svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </RouterLink>
        <span class="v-divider" />
        <div class="tb-text">
          <h2 class="tb-title">{{ task.title || "（无标题）" }}</h2>
          <p class="tb-meta">
            <AgentAvatar :name="task.agentName" :size="15" />
            {{ task.agentName }} · 创建于 {{ timeAgo(task.createdAt) }}
          </p>
        </div>
      </div>
      <div class="tb-right">
        <span class="status" :class="task.status">{{ STATUS_TEXT[task.status] ?? task.status }}</span>
        <button v-if="running" class="sm danger" @click="onCancel">取消本轮</button>
        <button v-if="task.status === 'failed'" class="sm retry" :disabled="retrying" @click="onRetry">
          {{ retrying ? "重试中…" : "重试本轮" }}
        </button>
      </div>
    </header>

    <p v-if="task.error" class="err-strip">{{ task.error }}</p>

    <div class="body">
      <section class="chat-col">
        <div class="chat-scroll" ref="chatEl" @scroll="onChatScroll">
          <div class="thread">
            <template v-for="m in messages" :key="m.id">
              <div v-if="m.role === 'user'" class="msg user">
                <div class="bubble">{{ m.content }}</div>
              </div>
              <div v-else class="msg assistant">
                <AgentAvatar :name="task.agentName" :size="26" class="msg-avatar" />
                <div class="a-body">
                  <div class="md" v-html="renderMarkdown(m.content)"></div>
                  <button
                    v-if="!m.id.startsWith('local-')"
                    class="copy"
                    title="复制全文"
                    @click="copyMessage(m)"
                  >
                    <svg class="icon" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    复制
                  </button>
                </div>
              </div>
              <div v-if="m.role === 'assistant' && filesAfterMsg.get(m.id)?.length" class="msg-files">
                <div class="files-bar">
                  <div class="fb-head">
                    <svg class="icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                    成果物
                    <span class="fb-count">{{ filesAfterMsg.get(m.id)?.length }}</span>
                  </div>
                  <button v-for="f in filesAfterMsg.get(m.id)" :key="f.id" class="fb-row" @click="previewFile = f">
                    <span class="file-icon">{{ fileEmoji(f.filename) }}</span>
                    <span class="fc-name mono">{{ f.relPath }}</span>
                    <span class="fc-size">{{ formatSize(f.size) }}</span>
                    <span class="fb-dl" title="下载" @click.stop="downloadDeliverable(taskId, f)">
                      <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
                    </span>
                  </button>
                </div>
              </div>
            </template>
            <div v-if="!messages.length" class="empty">对话记录为空</div>

            <div v-if="running" class="msg assistant">
              <AgentAvatar :name="task.agentName" :size="26" class="msg-avatar" />
              <div class="a-body">
                <div class="turn-label"><span class="spinner"></span> {{ task.agentName }} 正在处理<span v-if="elapsedText"> · {{ elapsedText }}</span></div>
                <div class="lines" ref="liveEl">
                  <template v-for="(line, i) in live" :key="i">
                    <p v-if="line.kind === 'file'" class="file-line">📄 {{ line.text }}</p>
                    <p v-else-if="line.kind === 'think'" class="think-line">💭 {{ line.text }}</p>
                    <p v-else :class="line.kind">{{ line.text }}</p>
                  </template>
                  <p v-if="!live.length" class="hint-dark">正在思考，输出将实时出现在这里…</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="composer-zone">
          <!-- ask 级工具调用审批（P2-2）：任务在工具执行前暂停，等待人工放行 -->
          <div v-if="toolApproval" class="approval-panel">
            <div class="ap-head">
              <span class="ap-badge tool">需确认</span>
              <div class="ap-head-text">
                <h3>工具调用待确认</h3>
                <p>该专家的工具策略要求对敏感调用逐次确认。任务已暂停：放行后继续执行，超过 5 分钟未处理将自动拒绝本次调用。</p>
              </div>
            </div>
            <div class="ap-tool-box">
              <div class="ap-tool-name">{{ toolApproval.tool }}</div>
              <pre v-if="toolApproval.input && toolApproval.input !== '{}'" class="ap-tool-input">{{ toolApproval.input }}</pre>
            </div>
            <div class="ap-actions">
              <span class="ap-spacer" />
              <button class="sm ap-reject" :disabled="toolDeciding" @click="decideToolCall(false)">
                {{ toolDeciding ? "提交中…" : "拒绝本次调用" }}
              </button>
              <button class="sm retry" :disabled="toolDeciding" @click="decideToolCall(true)">
                {{ toolDeciding ? "提交中…" : "放行执行" }}
              </button>
            </div>
          </div>
          <!-- 高风险审批面板：等待逐项确认时接管输入区 -->
          <div v-else-if="awaitingApproval" class="approval-panel">
            <div class="ap-head">
              <span class="ap-badge">高风险任务</span>
              <div class="ap-head-text">
                <h3>执行清单待确认</h3>
                <p>Agent 已生成执行计划但尚未执行。请逐项勾选确认后放行，未勾选的项目不会被执行。</p>
              </div>
            </div>
            <ul v-if="planItems.length" class="ap-items">
              <li v-for="(item, i) in planItems" :key="i">
                <label class="ap-item">
                  <input v-model="item.checked" type="checkbox" />
                  <span class="ap-item-text">{{ item.text }}</span>
                </label>
              </li>
            </ul>
            <p v-else class="ap-empty">正在解析执行清单，请稍候…</p>
            <div class="ap-actions">
              <label v-if="planItems.length" class="ap-all">
                <input type="checkbox" :checked="allChecked" @change="toggleAll" />
                全选
              </label>
              <span class="ap-count">{{ checkedCount }}/{{ planItems.length }} 项已确认</span>
              <span class="ap-spacer" />
              <button class="sm ap-reject" :disabled="rejecting" @click="onRejectPlan">
                {{ rejecting ? "取消中…" : "拒绝执行" }}
              </button>
              <button class="sm retry" :disabled="!checkedCount || approving" @click="onApprove">
                {{ approving ? "提交中…" : "确认执行" }}
              </button>
            </div>
          </div>
          <div
            v-else
            class="composer"
            :class="{ 'drop-hover': dragging }"
            @dragenter.prevent="onDragEnter"
            @dragover.prevent="onDragEnter"
            @dragleave.prevent="onDragLeave"
            @drop.prevent="onDrop"
          >
            <MentionChips :api="mention" />
            <div v-if="attachments.length" class="attach-strip">
              <span
                v-for="(f, i) in attachments"
                :key="`${f.name}-${f.size}-${i}`"
                class="file-chip"
                :title="`${f.name}（${formatSize(f.size)}）`"
              >
                <span class="fname">{{ f.name }}</span>
                <span class="fsize">{{ formatSize(f.size) }}</span>
                <span class="fremove" title="移除附件" @click="removeAttachment(i)">✕</span>
              </span>
            </div>
            <!-- 运行中不锁定输入：此时发送 = 打断当前轮并以新消息开新一轮 -->
            <textarea
              ref="taRef"
              v-model="draft"
              rows="2"
              :placeholder="running ? 'Agent 正在执行本轮，输入消息将打断并继续对话…' : '继续追问，输入 @ 引用联系人 / 云文档，输入 / 调用技能'"
              @keydown="onTaKeydown"
              @input="detectPopups"
              @click="detectPopups"
            ></textarea>
            <MentionPopup :api="mention" />
            <SkillPopup :api="slash" />
            <div class="composer-bar">
              <span class="agent-chip">
                <AgentAvatar :name="task.agentName" :size="15" />
                {{ task.agentName }}
              </span>
              <button
                type="button"
                class="attach-btn"
                :title="`添加附件（最多 ${MAX_FILES} 个，单个 ≤ 20MB）`"
                @click="pickFiles"
              >
                <svg class="icon" viewBox="0 0 24 24"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.5 8.35l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
              </button>
              <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked" />

              <!-- 语音输入：点击录音 → 再点结束并转写回填 -->
              <VoiceDictate @text="appendVoiceText" />

              <span class="key-hint">{{ running ? "Enter 打断并继续对话 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行" }}</span>
              <!-- 运行中且无输入 = 停止本轮；有输入 = 发送（打断当前轮并继续对话） -->
              <button
                v-if="running && !draft.trim()"
                class="send stop"
                :disabled="sending"
                title="停止本轮执行"
                @click="onCancel"
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
              </button>
              <button v-else class="send" :disabled="!canSend" :title="running ? '发送并打断当前轮次（Enter）' : '发送（Enter）'" @click="onSend">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
          <p v-if="sendError" class="send-err">{{ sendError }}</p>
        </div>
      </section>

      <div
        class="splitter"
        :class="{ active: draggingCol }"
        title="拖拽调整预览宽度 · 双击复位"
        @mousedown="onSplitterDown"
        @dblclick="onSplitterDblClick"
      ></div>

      <PreviewPanel
        :task-id="taskId"
        :file="previewFile"
        :deliverables="deliverables"
        :width="previewCssWidth"
        @open="previewFile = $event"
        @close="previewFile = null"
      />
    </div>
  </div>
  <p v-else-if="error" class="err-page">{{ error }}</p>
</template>

<style scoped>
.page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  animation: rise 0.22s ease-out;
}

/* ---------- 顶栏 ---------- */
.topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.tb-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.back {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--text-2);
  text-decoration: none;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.back:hover {
  background: var(--surface-2);
  color: var(--text);
}
.v-divider {
  width: 1px;
  height: 22px;
  background: var(--border);
  flex-shrink: 0;
}
.tb-text {
  min-width: 0;
}
.tb-title {
  margin: 0;
  font-size: 15px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-meta {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 5px;
}
.tb-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
button.sm {
  width: auto;
  padding: 5px 12px;
  font-size: 12.5px;
  border-radius: 8px;
}
.retry {
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}
.retry:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
  color: var(--on-accent);
}
.retry:disabled {
  opacity: 0.6;
  cursor: default;
}
.err-strip {
  margin: 0;
  padding: 8px 20px;
  color: var(--danger);
  background: var(--danger-soft);
  border-bottom: 1px solid var(--danger-border);
  font-size: 13px;
}

/* ---------- 三栏主体 ---------- */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.splitter {
  flex-shrink: 0;
  width: 7px;
  margin-left: -3px;
  position: relative;
  z-index: 6;
  cursor: col-resize;
}
.splitter::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  border-radius: 1px;
  background: transparent;
  transition: background 0.12s;
}
.splitter:hover::after,
.splitter.active::after {
  background: var(--accent);
}
.chat-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.thread {
  max-width: 780px;
  margin: 0 auto;
  padding: 26px 28px 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ---------- 消息 ---------- */
.msg.user {
  display: flex;
  justify-content: flex-end;
}
.msg.user .bubble {
  max-width: 78%;
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  border-radius: 14px 14px 4px 14px;
  padding: 9px 13px;
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.assistant {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.msg-avatar {
  margin-top: 2px;
  flex-shrink: 0;
}
.a-body {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  line-height: 1.7;
}
.copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  box-shadow: none;
  color: var(--text-3);
  padding: 3px 8px;
  border-radius: 7px;
  font-size: 11.5px;
  opacity: 0;
  transition: opacity 0.12s;
  margin-top: 4px;
}
.a-body:hover .copy {
  opacity: 1;
}
.copy:hover {
  color: var(--text);
  background: var(--surface-2);
}
.copy .icon {
  width: 12px;
  height: 12px;
}

/* ---------- 成果物条（对话轮次内） ---------- */
.msg-files {
  margin-left: 36px;
}
.files-bar {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-2);
  overflow: hidden;
  max-width: 560px;
}
.fb-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
}
.fb-head .icon {
  width: 14px;
  height: 14px;
  color: var(--text-3);
}
.fb-count {
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  padding: 0 7px;
  font-weight: 600;
}
.fb-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--border-faint);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 8px 12px;
  font-size: 13px;
  text-align: left;
}
.fb-row:last-child {
  border-bottom: none;
}
.fb-row:hover {
  background: var(--surface-2);
  border-color: transparent;
}
.file-icon {
  font-size: 15px;
  flex-shrink: 0;
}
.fc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}
.fc-size {
  color: var(--text-3);
  font-size: 12px;
  flex-shrink: 0;
}
.fb-dl {
  display: grid;
  place-items: center;
  color: var(--text-3);
  padding: 4px;
  border-radius: 6px;
  flex-shrink: 0;
}
.fb-dl:hover {
  color: var(--text);
  background: var(--border);
}
.fb-dl .icon {
  width: 14px;
  height: 14px;
}

/* ---------- 进行中轮次 ---------- */
.turn-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  margin-bottom: 8px;
}
.lines {
  background: var(--term-bg);
  color: var(--term-text);
  border-radius: 10px;
  padding: 12px 14px;
  max-height: 260px;
  overflow-y: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.lines .tool {
  color: #7dd3fc;
}
.lines .file-line {
  color: #6ee7b7;
}
/* 模型思考流：弱化显示，与正文区分 */
.lines .think-line {
  color: #8b96ab;
  font-style: italic;
}
.lines p {
  margin: 0 0 4px;
}
.hint-dark {
  color: rgba(215, 224, 238, 0.55);
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(107, 114, 128, 0.3);
  border-top-color: var(--text-2);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---------- 钉底输入区 ---------- */
.composer-zone {
  flex-shrink: 0;
  padding: 6px 28px 16px;
}
.composer {
  max-width: 780px;
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  padding: 12px 14px 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
  /* @ 弹层（MentionPopup）以本容器为锚点向上展开 */
  position: relative;
}
.composer:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(23, 126, 91, 0.14);
}
:root[data-theme="dark"] .composer:focus-within {
  box-shadow: 0 0 0 3px rgba(47, 157, 117, 0.22);
}
.composer.drop-hover {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(23, 126, 91, 0.14);
}
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 3px 8px;
  max-width: 220px;
}
.file-chip .fname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-chip .fsize {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 11px;
}
.file-chip .fremove {
  flex-shrink: 0;
  color: var(--text-3);
  padding: 0 2px;
  border-radius: 4px;
  cursor: pointer;
}
.file-chip .fremove:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.attach-btn {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-3);
  border: none;
  box-shadow: none;
  flex-shrink: 0;
}
.attach-btn:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
.attach-btn .icon {
  width: 14px;
  height: 14px;
}
.composer textarea {
  border: none;
  background: transparent;
  resize: none;
  outline: none;
  font: inherit;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text);
  box-shadow: none;
  padding: 0;
  width: 100%;
}
.composer textarea:focus {
  box-shadow: none;
  border: none;
}
.composer-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 3px 10px 3px 4px;
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
}
.key-hint {
  font-size: 11.5px;
  color: var(--text-3);
}
.send {
  margin-left: auto;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  cursor: pointer;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  padding: 0;
  transition: background 0.15s, transform 0.1s;
}
.send:hover:not(:disabled) {
  background: var(--accent-strong);
}
.send:active:not(:disabled) {
  transform: scale(0.94);
}
.send:disabled {
  background: var(--surface-2);
  color: var(--text-3);
  cursor: default;
}
.send svg {
  width: 16px;
  height: 16px;
}
/* 运行中的停止按钮：红色方块，与顶栏取消一致的危险色 */
.send.stop {
  background: var(--danger);
  color: #fff;
}
.send.stop:hover:not(:disabled) {
  background: var(--danger);
  filter: brightness(1.08);
}
.send-err {
  max-width: 780px;
  margin: 8px auto 0;
  color: var(--danger);
  font-size: 12.5px;
}
/* ---------- 高风险审批面板 ---------- */
.approval-panel {
  max-width: 780px;
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--warn);
  border-radius: 16px;
  padding: 14px 16px 12px;
  box-shadow: 0 0 0 3px var(--warn-soft);
}
.ap-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.ap-badge {
  flex-shrink: 0;
  margin-top: 2px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--on-accent);
  background: var(--warn);
}
.ap-badge.tool {
  background: var(--accent);
}
.ap-tool-box {
  margin: 12px 0 0;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  max-height: 220px;
  overflow-y: auto;
}
.ap-tool-name {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.ap-tool-input {
  margin: 8px 0 0;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.ap-head-text h3 {
  margin: 0;
  font-size: 14px;
  color: var(--text);
}
.ap-head-text p {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.55;
}
.ap-items {
  list-style: none;
  margin: 12px 0 0;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ap-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.55;
}
.ap-item input[type="checkbox"] {
  margin-top: 3px;
  accent-color: var(--warn);
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.ap-item-text {
  color: var(--text);
  word-break: break-word;
}
.ap-empty {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.ap-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.ap-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
}
.ap-all input {
  accent-color: var(--warn);
}
.ap-count {
  font-size: 12px;
  color: var(--text-3);
}
.ap-spacer {
  flex: 1;
}
.ap-reject {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: var(--danger-border);
}
.ap-reject:hover:not(:disabled) {
  background: var(--danger-border);
}
.err-page {
  max-width: 640px;
  margin: 48px auto;
  padding: 16px 20px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius);
  font-size: 13.5px;
}
</style>
