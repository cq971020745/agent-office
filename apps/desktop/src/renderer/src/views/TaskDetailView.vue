<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type {
  AccessMode,
  Deliverable,
  ModelOption,
  Task,
  TaskEventEnvelope,
  TaskMessage,
  TaskTurnStep,
  ToolApprovalDecision,
} from "@office/shared";
import {
  approveTask,
  approveToolCall,
  cancelTask,
  listSessionGrants,
  revokeSessionGrant,
  downloadDeliverable,
  API_BASE,
  getTask,
  getTaskMessages,
  getToken,
  listDeliverables,
  listModelOptions,
  openTaskEvents,
  renameTask,
  sendTaskMessage,
  sendTaskMessageWithFiles,
  updateTaskAccessMode,
  updateTaskModel,
} from "../api";
import { renderMarkdown } from "../utils/markdown";
import { formatSize, previewKind, timeAgo } from "../utils/format";
import { toast, toastError } from "../composables/toast";
import { MAX_FILES, useAttachments } from "../composables/attachments";
import { useMentions } from "../composables/useMentions";
import { useSlashSkills } from "../composables/useSlashSkills";
import AccessModePicker from "../components/AccessModePicker.vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import MentionChips from "../components/MentionChips.vue";
import MentionPopup from "../components/MentionPopup.vue";
import PreviewPanel from "../components/PreviewPanel.vue";
import SkillPopup from "../components/SkillPopup.vue";
import VoiceDictate from "../components/VoiceDictate.vue";

const route = useRoute();
const router = useRouter();
// 详情页组件在同路由下被复用（任务间跳转），taskId 必须跟随路由参数变化
const taskId = ref(route.params.id as string);
watch(
  () => route.params.id,
  (id) => {
    if (!id || id === taskId.value) return;
    closeEvents?.();
    closeEvents = undefined;
    lastSeq = 0;
    resetLive();
    previewFile.value = null;
    previewCollapsed.value = true;
    previewUserOpened.value = false;
    error.value = "";
    task.value = null;
    messages.value = [];
    deliverables.value = [];
    toolApproval.value = null;
    sessionGrants.value = [];
    editingTitle.value = false;
    taskId.value = id as string;
    // 换任务时清掉上一任务遗留的 @ 引用与弹层状态
    mention.state.open = false;
    mention.pendingMentions.value = [];
    slash.state.open = false;
    void refreshAll();
  }
);

const task = ref<Task | null>(null);
/** 会话权限：与任务同步；用户改档时立即 PATCH */
const accessMode = ref<AccessMode>("autonomous");
watch(
  () => task.value?.accessMode,
  (mode) => {
    if (mode) accessMode.value = mode;
  }
);

async function onAccessModeChange(mode: AccessMode): Promise<void> {
  const prev = accessMode.value;
  accessMode.value = mode;
  if (!task.value || task.value.accessMode === mode) return;
  try {
    await updateTaskAccessMode(taskId.value, mode);
    task.value = { ...task.value, accessMode: mode };
  } catch (err) {
    accessMode.value = prev;
    toastError(err, "权限档位更新失败");
  }
}

// ---------- 追问模型选择（非首次会话也可切换；下一轮生效） ----------
const modelOptions = ref<ModelOption[]>([]);
const selProviderId = ref("");
const selModelId = ref("");
const modelOpen = ref(false);
const modelSearch = ref("");
const modelTrigger = ref<HTMLElement | null>(null);
const modelPopStyle = ref<Record<string, string>>({});
const modelSaving = ref(false);

watch(
  () => [task.value?.providerId, task.value?.modelId] as const,
  ([pid, mid]) => {
    if (pid) selProviderId.value = pid;
    if (mid) selModelId.value = mid;
  }
);

const selectedModelLabel = computed(() => selModelId.value || "选择模型");
const selectedProviderName = computed(
  () => modelOptions.value.find((x) => x.providerId === selProviderId.value)?.providerName ?? task.value?.providerName ?? ""
);
const modelCount = computed(() => modelOptions.value.reduce((n, x) => n + x.models.length, 0));
const filteredModelOptions = computed(() => {
  const kw = modelSearch.value.trim().toLowerCase();
  if (!kw) return modelOptions.value;
  return modelOptions.value
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => m.toLowerCase().includes(kw) || g.providerName.toLowerCase().includes(kw)),
    }))
    .filter((g) => g.models.length > 0);
});

function toggleModelOpen(): void {
  const busy = task.value?.status === "running" || task.value?.status === "pending";
  if (busy || modelSaving.value) {
    toast("info", "任务进行中，请等本轮结束或打断后再切换模型");
    return;
  }
  if (!modelOpen.value && modelTrigger.value) {
    const r = modelTrigger.value.getBoundingClientRect();
    const left = Math.max(12, Math.min(r.right - 300, window.innerWidth - 312));
    modelPopStyle.value = { left: `${left}px`, bottom: `${window.innerHeight - r.top + 8}px` };
    modelSearch.value = "";
  }
  modelOpen.value = !modelOpen.value;
}

async function pickModel(providerId: string, modelId: string): Promise<void> {
  if (!task.value) return;
  if (task.value.providerId === providerId && task.value.modelId === modelId) {
    modelOpen.value = false;
    return;
  }
  const prev = { providerId: selProviderId.value, modelId: selModelId.value };
  selProviderId.value = providerId;
  selModelId.value = modelId;
  modelOpen.value = false;
  modelSaving.value = true;
  try {
    const res = await updateTaskModel(taskId.value, providerId, modelId);
    task.value = {
      ...task.value,
      providerId: res.providerId,
      modelId: res.modelId,
      providerName: res.providerName,
    };
    toast("success", `已切换模型：${res.modelId}`);
  } catch (err) {
    selProviderId.value = prev.providerId;
    selModelId.value = prev.modelId;
    toastError(err, "切换模型失败");
  } finally {
    modelSaving.value = false;
  }
}

function openModelConfig(): void {
  modelOpen.value = false;
  void router.push("/models");
}

async function loadModelOptions(): Promise<void> {
  try {
    modelOptions.value = await listModelOptions();
  } catch {
    modelOptions.value = [];
  }
}

const messages = ref<TaskMessage[]>([]);
const deliverables = ref<Deliverable[]>([]);

/** 图片附件：气泡内联 + 点击放大 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}
function isImageFile(f: File): boolean {
  return (f.type && f.type.startsWith("image/")) || isImageName(f.name);
}
function attachmentSrc(att: { relPath?: string; previewUrl?: string; filename: string }): string {
  if (att.previewUrl) return att.previewUrl;
  if (att.relPath) {
    return `${API_BASE}/tasks/${taskId.value}/workspace/file?path=${encodeURIComponent(att.relPath)}&token=${encodeURIComponent(getToken())}`;
  }
  return "";
}
function imageAttachments(m: TaskMessage) {
  return (m.attachments ?? []).filter((a) => isImageName(a.filename) && attachmentSrc(a));
}
function fileAttachments(m: TaskMessage) {
  return (m.attachments ?? []).filter((a) => !isImageName(a.filename));
}
function revokeMessagePreviews(list: TaskMessage[]): void {
  for (const m of list) {
    for (const a of m.attachments ?? []) {
      if (a.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
    }
  }
}
function mapFilesToAttachments(files: File[]) {
  return files.map((f) => ({
    filename: f.name,
    size: f.size,
    ...(isImageFile(f) ? { previewUrl: URL.createObjectURL(f) } : {}),
  }));
}

/** 输入条附件缩略图：按 File 缓存 blob URL，移除时释放 */
const composerPreviewCache = new Map<File, string>();
function composerPreviewUrl(f: File): string {
  let url = composerPreviewCache.get(f);
  if (!url) {
    url = URL.createObjectURL(f);
    composerPreviewCache.set(f, url);
  }
  return url;
}
watch(
  attachments,
  (list) => {
    const keep = new Set(list);
    for (const [f, url] of composerPreviewCache) {
      if (!keep.has(f)) {
        URL.revokeObjectURL(url);
        composerPreviewCache.delete(f);
      }
    }
  },
  { deep: true }
);

const lightbox = ref<{ src: string; title: string } | null>(null);
function openLightbox(src: string, title: string): void {
  if (!src) return;
  lightbox.value = { src, title };
}
function closeLightbox(): void {
  lightbox.value = null;
}
function onLightboxKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeLightbox();
}
watch(lightbox, (v) => {
  if (v) window.addEventListener("keydown", onLightboxKey);
  else window.removeEventListener("keydown", onLightboxKey);
});
// 当前进行中轮次的实时结构化输出（思考流 + 工具步骤 + 实时 Markdown 正文）
const liveThinking = ref("");
const liveSteps = ref<TaskTurnStep[]>([]);
const liveText = ref("");
const editingTitle = ref(false);
const titleDraft = ref("");

function resetLive(): void {
  liveThinking.value = "";
  liveSteps.value = [];
  liveText.value = "";
}

const TOOL_LABELS: Record<string, string> = {
  workspace_list: "📂 列出工作区",
  workspace_read: "📖 读取文件",
  workspace_write: "📄 写入文件",
  workspace_edit: "✏️ 局部编辑",
  transcribe_audio: "🎙️ 音频转写",
  delegate_to_agent: "🤝 委派专家",
  fetch_url: "🌐 抓取网页",
  web_enable: "🔓 启用网页工具",
  web_search: "🔍 网页搜索",
  fetch_content: "🌐 抓取内容",
  get_search_content: "📑 检索缓存",
  source_check: "📎 来源核验",
  run_code: "🐍 运行代码",
  read_skill: "📚 加载技能",
  run_skill_script: "⚡ 执行技能脚本",
  terminal: "⌨️ 终端",
  doc_to_md: "📄 文档转 Markdown",
};

function formatToolName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]!;
  if (name.startsWith("mcp_")) return `🔌 ${name.replace(/^mcp_/, "")}`;
  return `🛠️ ${name}`;
}

function startEditTitle(): void {
  if (!task.value) return;
  titleDraft.value = task.value.title || "";
  editingTitle.value = true;
}

async function saveTitle(): Promise<void> {
  if (!task.value || !editingTitle.value) return;
  editingTitle.value = false;
  const next = titleDraft.value.trim();
  if (!next || next === task.value.title) return;
  try {
    const res = await renameTask(task.value.id, next);
    task.value.title = res.title;
    toast("success", "任务标题已更新");
  } catch (err) {
    toastError(err, "重命名失败");
  }
}
const draft = ref("");
const error = ref("");
const sendError = ref("");
const previewFile = ref<Deliverable | null>(null);
/** 默认收起；有成果物或用户主动展开时才显示，避免每条对话都撑开浏览器预览 */
const previewCollapsed = ref(true);
/** 用户点过「展开预览」后，即使没有成果物也可打开（含浏览器页签） */
const previewUserOpened = ref(false);
const previewAvailable = computed(
  () => previewFile.value !== null || deliverables.value.length > 0 || previewUserOpened.value
);
const showPreview = computed(() => previewAvailable.value && !previewCollapsed.value);
/** 浏览器起始地址：空则显示空白页，由用户输入要预览的 URL（勿默认 5173，那是桌面端自身 Vite） */
const browserStartUrl = ref("");
const workspaceFolderName = computed(() => {
  const raw = (task.value?.workspacePath ?? "").replace(/[\\/]+$/, "");
  return raw.split(/[\\/]/).pop() || "工作区";
});
const chatEl = ref<HTMLElement | null>(null);
// 用户是否停留在聊天底部附近（决定新消息是否自动滚动，避免打断回看）
const atBottom = ref(true);
let closeEvents: (() => void) | undefined;
let lastSeq = 0;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

function openPreview(file: Deliverable): void {
  previewFile.value = file;
  previewUserOpened.value = true;
  previewCollapsed.value = false;
}

function togglePreview(): void {
  if (previewCollapsed.value || !previewAvailable.value) {
    previewUserOpened.value = true;
    previewCollapsed.value = false;
  } else {
    previewCollapsed.value = true;
  }
}

// 首次出现成果物时展开预览（成果物列表），不切换到浏览器页签
watch(
  () => deliverables.value.length,
  (n, prev) => {
    if (n > 0 && !prev) previewCollapsed.value = false;
  }
);

interface ChatFileRow {
  key: string;
  kind: "dir" | "file";
  label: string;
  depth: number;
  file?: Deliverable;
}

/** 自选目录把本轮新文件嵌进工作区文件夹；平台工作区只有出现子目录时才分组。 */
function chatFileRows(files: Deliverable[] | undefined): ChatFileRow[] {
  const list = files ?? [];
  const custom = !!task.value?.customWorkspace;
  const nested = list.some((file) => file.relPath.includes("/") || file.relPath.includes("\\"));
  if (!custom && !nested) {
    return list.map((file) => ({ key: file.id, kind: "file", label: file.relPath, depth: 0, file }));
  }
  interface DirNode {
    name: string;
    path: string;
    dirs: Map<string, DirNode>;
    files: Deliverable[];
  }
  const root: DirNode = { name: workspaceFolderName.value, path: "", dirs: new Map(), files: [] };
  for (const file of list) {
    const parts = file.relPath.replace(/\\/g, "/").split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      const dirPath = parts.slice(0, i + 1).join("/");
      let child = node.dirs.get(name);
      if (!child) {
        child = { name, path: dirPath, dirs: new Map(), files: [] };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const rows: ChatFileRow[] = [];
  const walk = (node: DirNode, depth: number, includeSelf: boolean): void => {
    if (includeSelf) rows.push({ key: `dir:${node.path || "root"}`, kind: "dir", label: node.name, depth });
    const childDepth = includeSelf ? depth + 1 : depth;
    for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
      walk(child, childDepth, true);
    }
    for (const file of [...node.files].sort((a, b) => a.filename.localeCompare(b.filename, "zh"))) {
      rows.push({ key: file.id, kind: "file", label: file.filename, depth: childDepth, file });
    }
  };
  walk(root, 0, custom);
  return rows;
}

const running = computed(() => task.value?.status === "running" || task.value?.status === "pending");
const awaitingApproval = computed(() => task.value?.status === "awaiting_approval");
// 运行中也可发送（发送 = 打断当前轮并开新一轮），只挡重复提交
const canSend = computed(() => draft.value.trim().length > 0 && !sending.value);

// ---------- 附件（随追问一起上传，落进任务工作区，支持 Ctrl+V 粘贴截图） ----------
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
  onPaste,
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
    // 服务端确认后会把 plan 升为 autonomous
    accessMode.value = "autonomous";
    if (task.value) task.value = { ...task.value, accessMode: "autonomous" };
    toast("success", "已确认计划，Agent 开始执行");
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
const sessionGrants = ref<string[]>([]);

function fmtToolInput(input: unknown): string {
  try {
    if (input && typeof input === "object" && "command" in input && typeof input.command === "string") {
      return input.command.length > 800 ? `${input.command.slice(0, 800)}…` : input.command;
    }
    const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return String(input ?? "");
  }
}

async function refreshSessionGrants(): Promise<void> {
  const res = await listSessionGrants(taskId.value).catch(() => ({ tools: sessionGrants.value }));
  sessionGrants.value = res.tools;
}

async function decideToolCall(decision: ToolApprovalDecision): Promise<void> {
  if (toolDeciding.value || !toolApproval.value) return;
  toolDeciding.value = true;
  try {
    await approveToolCall(taskId.value, decision);
    const tip =
      decision === "deny"
        ? "已拒绝本次工具调用"
        : decision === "allow_session"
          ? "已允许该工具在本会话继续调用"
          : "已允许本次工具调用，任务继续执行";
    toast("success", tip);
    toolApproval.value = null;
    if (decision === "allow_session") await refreshSessionGrants();
  } catch (err) {
    toastError(err, "操作失败");
  } finally {
    toolDeciding.value = false;
  }
}

async function revokeGrant(tool: string): Promise<void> {
  try {
    await revokeSessionGrant(taskId.value, tool);
    sessionGrants.value = sessionGrants.value.filter((name) => name !== tool);
    toast("success", `已撤销本会话对 ${tool} 的授权`);
  } catch (err) {
    toastError(err, "撤销失败");
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

// 有新内容时自动滚动到底部（仅当用户停留在底部附近，回看历史不打扰）
watch(
  () => [messages.value.length, liveSteps.value.length, liveThinking.value.length, liveText.value.length] as const,
  async () => {
    await nextTick();
    if (atBottom.value) {
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

function maybeNotifyDesktop(title: string, body: string): void {
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  void window.agentOffice?.notify?.(title, body);
}

function summarizeLiveToolArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  if (typeof args.path === "string" && args.path) return args.path;
  if (typeof args.agent === "string" && args.agent) return args.agent;
  if (typeof args.skill === "string" && args.skill) {
    return typeof args.script === "string" ? `${args.skill}/${args.script}` : args.skill;
  }
  if (typeof args.name === "string" && args.name) return args.name;
  if (typeof args.url === "string" && args.url) return args.url;
  return undefined;
}

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
    const prevStatus = task.value?.status;
    if (task.value) {
      task.value.status = env.status;
      // 以本事件为准清掉上一轮残留的 error。横幅若一直停在「请重新派发」，
      // 用户会再次发送，把正在跑的轮次打断，问句就只剩一串堆在上面。
      task.value.error = env.error ?? null;
    }
    if (env.status === "running") {
      resetLive();
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
      resetLive();
      if (prevStatus === "running" || prevStatus === "pending") {
        const tName = task.value?.title || "任务";
        if (env.status === "completed") maybeNotifyDesktop("任务已完成", `「${tName}」已执行完毕`);
        else if (env.status === "failed") maybeNotifyDesktop("任务执行失败", `「${tName}」执行出错`);
        else if (env.status === "awaiting_approval") maybeNotifyDesktop("任务待确认", `「${tName}」已生成执行清单，请确认后继续`);
      }
    }
    return;
  }
  if (env.kind !== "pi") return;
  const event = env.event as {
    type: string;
    assistantMessageEvent?: { type: string; delta?: string };
    toolName?: string;
    args?: Record<string, unknown>;
    isError?: boolean;
    tool?: string;
    input?: unknown;
  };
  if (event.type === "tool_approval_request") {
    toolApproval.value = { tool: event.tool ?? "", input: fmtToolInput(event.input) };
    maybeNotifyDesktop("工具调用待确认", `任务请求调用工具 ${event.tool ?? ""}`);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta" && event.assistantMessageEvent.delta) {
    liveThinking.value += event.assistantMessageEvent.delta;
    if (liveThinking.value.length > 4000) liveThinking.value = "…" + liveThinking.value.slice(-3800);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta) {
    liveText.value += event.assistantMessageEvent.delta;
  } else if (event.type === "tool_execution_start" && event.toolName) {
    liveSteps.value.push({
      tool: event.toolName,
      detail: summarizeLiveToolArgs(event.args),
      status: "done",
    });
  } else if (event.type === "tool_execution_end" && event.isError && liveSteps.value.length > 0) {
    liveSteps.value[liveSteps.value.length - 1]!.status = "error";
  }
}

async function refreshMessages(): Promise<void> {
  const next = await getTaskMessages(taskId.value).catch(() => null);
  if (next) {
    revokeMessagePreviews(messages.value);
    messages.value = next;
  }
  if (task.value?.status === "awaiting_approval") parsePlanItems();
}

async function refreshDeliverables(): Promise<void> {
  deliverables.value = await listDeliverables(taskId.value).catch(() => deliverables.value);
}

async function refreshAll(): Promise<void> {
  try {
    task.value = await getTask(taskId.value);
    await Promise.all([refreshMessages(), refreshDeliverables(), refreshSessionGrants(), loadModelOptions()]);
    // 常驻订阅：多轮对话期间页面不关流，重连靠 seq 去重
    closeEvents = openTaskEvents(taskId.value, handleEnvelope);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  }
}

/** 预览区网页标注 → 作为用户消息（可带截图附件）发进当前任务 */
async function onBrowserAnnotate(payload: { prompt: string; screenshot?: File }): Promise<void> {
  if (sending.value) {
    toast("info", "当前正在发送，请稍后再标注");
    return;
  }
  const wasRunning = running.value;
  sending.value = true;
  sendError.value = "";
  if (!wasRunning) {
    messages.value = [
      ...messages.value,
      {
        id: `local-annotate-${Date.now()}`,
        taskId: taskId.value,
        role: "user",
        content: payload.prompt,
        createdAt: new Date().toISOString(),
        ...(payload.screenshot
          ? { attachments: mapFilesToAttachments([payload.screenshot]) }
          : {}),
      },
    ];
  }
  try {
    if (payload.screenshot) {
      await sendTaskMessageWithFiles(
        taskId.value,
        payload.prompt,
        [payload.screenshot],
        undefined,
        wasRunning
      );
    } else {
      await sendTaskMessage(taskId.value, payload.prompt, undefined, wasRunning);
    }
    previewUserOpened.value = true;
    previewCollapsed.value = false;
    await Promise.all([refreshMessages(), refreshDeliverables()]);
  } catch (err) {
    toastError(err, "标注发送失败");
    sendError.value = err instanceof Error ? err.message : "标注发送失败";
    await refreshMessages();
  } finally {
    sending.value = false;
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
  // 运行中不先把新问句插进列表：服务端要先把当前轮的回复落库，新问句才排在它后面。
  // 先乐观插入的话，新问句会跑到正在生成的回答上面。
  if (!wasRunning) {
    messages.value = [
      ...messages.value,
      {
        id: `local-${Date.now()}`,
        taskId: taskId.value,
        role: "user",
        content: prompt,
        createdAt: new Date().toISOString(),
        attachments: mapFilesToAttachments(files),
      },
    ];
  }
  try {
    if (files.length) await sendTaskMessageWithFiles(taskId.value, prompt, files, mentions, wasRunning);
    else await sendTaskMessage(taskId.value, prompt, mentions, wasRunning);
    mention.pendingMentions.value = [];
    resetAttachments();
    if (wasRunning) toast("info", "已打断当前轮次，正在以新消息继续对话");
    // 用服务端消息覆盖乐观插入，带上附件 meta
    await refreshMessages();
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
const slashAgentId = computed(() => task.value?.agentId ?? "");
const slash = useSlashSkills({ prompt: draft, taRef, agentId: slashAgentId });

/** 弹层键盘链：/ 技能弹层优先，其次 @ 引用弹层，最后宿主（Enter 发送） */
function onTaKeydown(e: KeyboardEvent): void {
  if (slash.onKeydown(e)) return;
  mention.onTaKeydown(e);
}

/** 输入/点击时同时探测 / 与 @ 两个弹层（检测正则互斥，不会同时开），并自适应高度 */
function detectPopups(): void {
  slash.detectSlash();
  mention.detectMention();
  const ta = taRef.value;
  if (ta) {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(180, Math.max(46, ta.scrollHeight))}px`;
  }
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

const speakingId = ref("");

function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "（代码段已省略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toggleSpeakMessage(m: TaskMessage): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    toast("error", "当前系统不支持语音合成（TTS）");
    return;
  }
  const synth = window.speechSynthesis;
  if (speakingId.value === m.id) {
    synth.cancel();
    speakingId.value = "";
    return;
  }
  synth.cancel();
  const text = stripMarkdownForSpeech(m.content);
  if (!text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "zh-CN";
  utter.rate = 1.05;
  utter.onend = () => {
    if (speakingId.value === m.id) speakingId.value = "";
  };
  utter.onerror = () => {
    if (speakingId.value === m.id) speakingId.value = "";
  };
  speakingId.value = m.id;
  synth.speak(utter);
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
  revokeMessagePreviews(messages.value);
  for (const url of composerPreviewCache.values()) URL.revokeObjectURL(url);
  composerPreviewCache.clear();
  closeLightbox();
  window.removeEventListener("keydown", onLightboxKey);
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
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
        <!-- Codex 式：项目文件夹任务在标题前显示文件夹名 -->
        <span
          v-if="task.customWorkspace && task.workspacePath"
          class="tb-folder"
          :title="task.workspacePath"
        >
          <svg class="icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          <span class="tb-folder-name">{{ workspaceFolderName }}</span>
        </span>
        <div class="tb-text">
          <div v-if="editingTitle" class="tb-title-edit">
            <input
              v-model="titleDraft"
              class="tb-title-input"
              maxlength="120"
              autofocus
              @keydown.enter="saveTitle"
              @keydown.esc="editingTitle = false"
              @blur="saveTitle"
            />
          </div>
          <h2 v-else class="tb-title" title="点击修改标题" @click="startEditTitle">
            {{ task.title || "（无标题）" }}
            <span class="tb-edit-hint">✎</span>
          </h2>
          <p class="tb-meta">
            <AgentAvatar :name="task.agentName" :size="15" />
            {{ task.agentName }} · 创建于 {{ timeAgo(task.createdAt) }}
          </p>
        </div>
      </div>
      <div class="tb-right">
        <span class="status" :class="task.status">{{ STATUS_TEXT[task.status] ?? task.status }}</span>
        <button
          type="button"
          class="panel-toggle"
          :class="{ on: showPreview }"
          :title="showPreview ? '收起预览' : '展开预览（成果物 / 浏览器）'"
          :aria-pressed="showPreview"
          @click="togglePreview"
        >
          <svg class="icon" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
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
                <div class="bubble" :class="{ 'has-images': imageAttachments(m).length }">
                  <!-- 主流：图片在上、问题在下；点击缩略图放大 -->
                  <div v-if="imageAttachments(m).length" class="msg-images">
                    <button
                      v-for="(att, ai) in imageAttachments(m)"
                      :key="`${m.id}-img-${ai}`"
                      type="button"
                      class="msg-img-btn"
                      :title="`点击放大 · ${att.filename}`"
                      @click="openLightbox(attachmentSrc(att), att.filename)"
                    >
                      <img :src="attachmentSrc(att)" :alt="att.filename" class="msg-img" loading="lazy" />
                    </button>
                  </div>
                  <div v-if="m.content.trim()" class="bubble-text">{{ m.content }}</div>
                  <div v-if="fileAttachments(m).length" class="msg-attach">
                    <span
                      v-for="(att, ai) in fileAttachments(m)"
                      :key="`${m.id}-att-${ai}`"
                      class="msg-file"
                      :title="att.relPath || att.filename"
                    >
                      <svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                      <span class="msg-fname">{{ att.filename }}</span>
                      <span class="msg-fsize">{{ formatSize(att.size) }}</span>
                    </span>
                  </div>
                </div>
              </div>
              <div v-else class="msg assistant">
                <AgentAvatar :name="task.agentName" :size="26" class="msg-avatar" />
                <div class="a-body">
                  <!-- 历史轮次的深度思考与工具调用轨迹（持久化自 task_messages.meta） -->
                  <details v-if="m.thinking || m.steps?.length" class="trace-box history-trace">
                    <summary class="trace-summary">
                      <span v-if="m.thinking" class="trace-pill">💭 深度思考</span>
                      <span v-if="m.steps?.length" class="trace-pill">🛠️ 调用了 {{ m.steps.length }} 个工具步骤</span>
                    </summary>
                    <div class="trace-content">
                      <div v-if="m.steps?.length" class="step-chips">
                        <span
                          v-for="(st, idx) in m.steps"
                          :key="idx"
                          class="step-chip"
                          :class="{ err: st.status === 'error' }"
                        >
                          <span class="step-tool">{{ formatToolName(st.tool) }}</span>
                          <span v-if="st.detail" class="step-detail mono">{{ st.detail }}</span>
                        </span>
                      </div>
                      <pre v-if="m.thinking" class="think-block">{{ m.thinking }}</pre>
                    </div>
                  </details>

                  <div class="md" v-html="renderMarkdown(m.content)"></div>
                  <div v-if="!m.id.startsWith('local-')" class="msg-actions">
                    <button
                      class="copy"
                      title="复制全文"
                      @click="copyMessage(m)"
                    >
                      <svg class="icon" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      复制
                    </button>
                    <button
                      class="copy"
                      :class="{ speaking: speakingId === m.id }"
                      :title="speakingId === m.id ? '停止朗读' : '语音朗读此回复'"
                      @click="toggleSpeakMessage(m)"
                    >
                      {{ speakingId === m.id ? "⏹ 停止朗读" : "🔊 朗读" }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="m.role === 'assistant' && filesAfterMsg.get(m.id)?.length" class="msg-files">
                <div class="files-bar">
                  <div class="fb-head">
                    <svg class="icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                    成果物
                    <span class="fb-count">{{ filesAfterMsg.get(m.id)?.length }}</span>
                  </div>
                  <template v-for="row in chatFileRows(filesAfterMsg.get(m.id))" :key="row.key">
                    <div v-if="row.kind === 'dir'" class="fb-row fb-dir" :style="{ paddingLeft: `${12 + row.depth * 16}px` }">
                      <span class="file-icon">📁</span>
                      <span class="fc-name mono">{{ row.label }}</span>
                    </div>
                    <button
                      v-else-if="row.file"
                      class="fb-row"
                      :style="{ paddingLeft: `${12 + row.depth * 16}px` }"
                      @click="openPreview(row.file)"
                    >
                      <span class="file-icon">{{ fileEmoji(row.file.filename) }}</span>
                      <span class="fc-name mono">{{ row.label }}</span>
                      <span class="fc-size">{{ formatSize(row.file.size) }}</span>
                      <span class="fb-dl" title="下载" @click.stop="downloadDeliverable(taskId, row.file)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
                      </span>
                    </button>
                  </template>
                </div>
              </div>
            </template>
            <div v-if="!messages.length" class="empty">对话记录为空</div>

            <div v-if="running" class="msg assistant">
              <AgentAvatar :name="task.agentName" :size="26" class="msg-avatar" />
              <div class="a-body">
                <div class="turn-label"><span class="spinner"></span> {{ task.agentName }} 正在处理<span v-if="elapsedText"> · {{ elapsedText }}</span></div>

                <!-- 实时思考过程与工具步骤条 -->
                <details v-if="liveThinking || liveSteps.length" class="trace-box live-trace" open>
                  <summary class="trace-summary">
                    <span v-if="liveThinking" class="trace-pill">💭 思考中…</span>
                    <span v-if="liveSteps.length" class="trace-pill">🛠️ 已执行 {{ liveSteps.length }} 步</span>
                  </summary>
                  <div class="trace-content">
                    <div v-if="liveSteps.length" class="step-chips">
                      <span
                        v-for="(st, idx) in liveSteps"
                        :key="idx"
                        class="step-chip"
                        :class="{ err: st.status === 'error' }"
                      >
                        <span class="step-tool">{{ formatToolName(st.tool) }}</span>
                        <span v-if="st.detail" class="step-detail mono">{{ st.detail }}</span>
                      </span>
                    </div>
                    <pre v-if="liveThinking" class="think-block">{{ liveThinking }}</pre>
                  </div>
                </details>

                <!-- 实时流式 Markdown 正文 -->
                <div v-if="liveText" class="md live-md" v-html="renderMarkdown(liveText)" />
                <div v-else-if="!liveThinking && !liveSteps.length" class="live-waiting">
                  正在思考与规划任务步骤，输出将实时呈现在这里…
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          class="composer-zone"
          :class="{ 'drop-hover': dragging }"
          @dragenter.prevent="onDragEnter"
          @dragover.prevent="onDragEnter"
          @dragleave.prevent="onDragLeave"
          @drop.prevent="onDrop"
        >
          <div v-if="sessionGrants.length" class="session-grants">
            <span>本会话已授权</span>
            <span v-for="tool in sessionGrants" :key="tool" class="grant-chip">
              {{ tool }}
              <button type="button" @click="revokeGrant(tool)">撤销</button>
            </span>
          </div>
          <!-- ask 级工具调用审批：拒绝、仅本次、本会话 -->
          <div v-if="toolApproval" class="approval-panel">
            <div class="ap-head">
              <span class="ap-badge tool">需确认</span>
              <div class="ap-head-text">
                <h3>工具调用待确认</h3>
                <p>该调用需要确认。拒绝或仅本次允许只影响这一次；本会话允许后，同一任务里再调用该工具不再询问。超过 5 分钟未处理将自动拒绝。</p>
              </div>
            </div>
            <div class="ap-tool-box">
              <div class="ap-tool-name">{{ toolApproval.tool }}</div>
              <pre v-if="toolApproval.input && toolApproval.input !== '{}'" class="ap-tool-input">{{ toolApproval.input }}</pre>
            </div>
            <div class="ap-actions">
              <span class="ap-spacer" />
              <button class="sm ap-reject" :disabled="toolDeciding" @click="decideToolCall('deny')">
                {{ toolDeciding ? "提交中…" : "拒绝" }}
              </button>
              <button class="sm" :disabled="toolDeciding" @click="decideToolCall('allow_once')">
                {{ toolDeciding ? "提交中…" : "仅本次允许" }}
              </button>
              <button class="sm retry" :disabled="toolDeciding" @click="decideToolCall('allow_session')">
                {{ toolDeciding ? "提交中…" : "本会话允许" }}
              </button>
            </div>
          </div>
          <!-- 高风险审批面板：等待逐项确认时接管输入区 -->
          <div v-else-if="awaitingApproval" class="approval-panel">
            <div class="ap-head">
              <span class="ap-badge">计划模式</span>
              <div class="ap-head-text">
                <h3>确认计划并执行</h3>
                <p>Agent 已生成执行计划但尚未改动文件。请逐项勾选确认后放行，未勾选的项目不会被执行；确认后权限将升为自主模式。</p>
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
          <div v-else class="composer">
            <MentionChips :api="mention" />
            <div v-if="attachments.length" class="attach-strip">
              <span
                v-for="(f, i) in attachments"
                :key="`${f.name}-${f.size}-${i}`"
                class="file-chip"
                :class="{ image: isImageFile(f) }"
                :title="`${f.name}（${formatSize(f.size)}）`"
              >
                <img v-if="isImageFile(f)" :src="composerPreviewUrl(f)" :alt="f.name" class="chip-thumb" />
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
              :placeholder="running ? 'Agent 正在执行本轮，输入消息将打断并继续对话…' : '继续追问；可拖入文件，或 Ctrl+V 粘贴截图；输入 @ / 调用引用与技能'"
              @keydown="onTaKeydown"
              @input="detectPopups"
              @click="detectPopups"
              @paste="onPaste"
            ></textarea>
            <MentionPopup :api="mention" />
            <SkillPopup :api="slash" />
            <div class="composer-bar">
              <span class="agent-chip">
                <AgentAvatar :name="task.agentName" :size="15" />
                {{ task.agentName }}
              </span>
              <AccessModePicker :model-value="accessMode" compact @update:model-value="onAccessModeChange" />
              <div class="model-select">
                <button
                  type="button"
                  ref="modelTrigger"
                  class="model-trigger"
                  :class="{ on: !!selModelId, open: modelOpen }"
                  :disabled="modelSaving"
                  :title="selModelId ? `${selectedProviderName} · ${selModelId}（点击切换）` : '选择模型'"
                  @click="toggleModelOpen"
                >
                  <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></svg>
                  <span class="model-label">{{ selectedModelLabel }}</span>
                  <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
                </button>
                <teleport to="body">
                  <div v-if="modelOpen" class="model-overlay" @click.self="modelOpen = false">
                    <div class="model-pop" :style="modelPopStyle">
                      <div class="pop-head">选择模型 <span class="pop-count">{{ modelCount }} 个可用</span></div>
                      <div v-if="modelCount > 4" class="pop-search-wrap">
                        <input v-model="modelSearch" class="pop-search" placeholder="搜索模型名称…" />
                      </div>
                      <div v-if="filteredModelOptions.length" class="pop-list">
                        <div v-for="g in filteredModelOptions" :key="g.providerId" class="pop-group">
                          <div class="group-name">{{ g.providerName }}</div>
                          <button
                            v-for="m in g.models"
                            :key="g.providerId + '/' + m"
                            type="button"
                            class="pop-item"
                            :class="{ active: g.providerId === selProviderId && m === selModelId }"
                            @click="pickModel(g.providerId, m)"
                          >
                            <span class="m-id">{{ m }}</span>
                            <svg v-if="g.providerId === selProviderId && m === selModelId" class="check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
                          </button>
                        </div>
                      </div>
                      <div v-else-if="modelCount" class="pop-empty">无匹配模型</div>
                      <div v-else class="pop-empty">还没有可用模型，请先在「模型供应商」添加并启用</div>
                      <div class="pop-foot">
                        <button type="button" class="config-link" @click="openModelConfig">配置模型</button>
                      </div>
                    </div>
                  </div>
                </teleport>
              </div>
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
        v-if="showPreview"
        class="splitter"
        :class="{ active: draggingCol }"
        title="拖拽调整预览宽度 · 双击复位"
        @mousedown="onSplitterDown"
        @dblclick="onSplitterDblClick"
      ></div>

      <PreviewPanel
        v-if="showPreview"
        :task-id="taskId"
        :workspace-path="task.workspacePath"
        :file="previewFile"
        :deliverables="deliverables"
        :width="previewCssWidth"
        enable-browser
        :browser-url="browserStartUrl"
        allow-empty
        @open="openPreview"
        @close="previewFile = null"
        @annotate="onBrowserAnnotate"
      />
    </div>
  </div>
  <p v-else-if="error" class="err-page">{{ error }}</p>

  <!-- 图片放大灯箱（主流聊天：点缩略图全屏看） -->
  <teleport to="body">
    <div
      v-if="lightbox"
      class="img-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="lightbox.title"
      @click.self="closeLightbox"
    >
      <button type="button" class="lb-close" title="关闭（Esc）" @click="closeLightbox">✕</button>
      <img :src="lightbox.src" :alt="lightbox.title" class="lb-img" @click.stop />
      <p class="lb-caption">{{ lightbox.title }}</p>
    </div>
  </teleport>
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
.tb-folder {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  max-width: 140px;
  padding: 3px 8px 3px 6px;
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
}
.tb-folder .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-3);
}
.tb-folder-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tb-edit-hint {
  font-size: 12px;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.14s;
}
.tb-title:hover .tb-edit-hint {
  opacity: 1;
}
.tb-title-edit {
  display: flex;
  align-items: center;
}
.tb-title-input {
  width: 280px;
  padding: 3px 8px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 6px;
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
.panel-toggle {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
}
.panel-toggle:hover {
  background: var(--surface-2);
  color: var(--text);
}
.panel-toggle.on {
  background: var(--surface-2);
  color: var(--text);
}
.panel-toggle .icon {
  width: 16px;
  height: 16px;
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
}
.msg.user .bubble.has-images {
  padding: 8px;
}
.msg.user .msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.msg.user .msg-img-btn {
  display: block;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  box-shadow: none;
  cursor: zoom-in;
  overflow: hidden;
  max-width: 100%;
}
.msg.user .msg-img {
  display: block;
  max-width: min(360px, 100%);
  max-height: 240px;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 10px;
  background: var(--surface);
  vertical-align: middle;
}
.msg.user .msg-img-btn:hover .msg-img {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.msg.user .bubble-text {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0 5px 2px;
}
.msg.user .msg-attach {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding: 0 4px;
}
.msg.user .msg-file {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
}
.msg.user .msg-file .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--accent);
}
.msg.user .msg-fname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
  color: var(--text);
  font-weight: 500;
}
.msg.user .msg-fsize {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 11px;
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
.msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
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
}
.copy.speaking {
  opacity: 1;
  color: var(--accent);
  background: var(--accent-soft);
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
.fb-dir {
  cursor: default;
  color: var(--text-2);
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

/* ---------- 思考过程与工具步骤轨迹（实时 + 历史） ---------- */
.turn-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  margin-bottom: 8px;
}
.trace-box {
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  overflow: hidden;
}
.trace-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.trace-summary::-webkit-details-marker {
  display: none;
}
.trace-summary::before {
  content: "▸";
  font-size: 11px;
  color: var(--text-3);
  transition: transform 0.15s ease;
}
.trace-box[open] .trace-summary::before {
  transform: rotate(90deg);
}
.trace-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-2);
}
.trace-content {
  padding: 10px 12px;
  border-top: 1px solid var(--border-faint);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.step-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.step-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 7px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text);
  max-width: 100%;
}
.step-chip.err {
  border-color: var(--danger-border);
  background: var(--danger-soft);
  color: var(--danger);
}
.step-tool {
  font-weight: 600;
  flex-shrink: 0;
}
.step-detail {
  color: var(--text-3);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}
.think-block {
  margin: 0;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border-faint);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}
.live-md {
  padding-top: 2px;
}
.live-waiting {
  font-size: 12.5px;
  color: var(--text-3);
  font-style: italic;
  padding: 6px 0;
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
.composer-zone.drop-hover .composer {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(23, 126, 91, 0.14);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
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
.file-chip.image {
  max-width: 280px;
  padding-left: 4px;
}
.file-chip .chip-thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--surface);
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
.session-grants {
  max-width: 780px;
  margin: 0 auto 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--text-2);
}
.grant-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
}
.grant-chip button {
  border: 0;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
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
.model-select {
  position: relative;
  flex-shrink: 1;
  min-width: 0;
}
.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 160px;
  padding: 3px 8px 3px 6px;
  border: none;
  border-radius: 999px;
  background: var(--surface-2);
  box-shadow: none;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.model-trigger .icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  color: var(--accent);
}
.model-trigger .caret {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  color: var(--text-3);
}
.model-trigger.open .caret {
  transform: rotate(180deg);
}
.model-trigger.on {
  color: var(--text);
  background: var(--accent-soft);
}
.model-trigger:hover:not(:disabled) {
  color: var(--text);
}
.model-trigger:disabled {
  opacity: 0.6;
  cursor: wait;
}
.model-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-overlay {
  position: fixed;
  inset: 0;
  z-index: 55;
}
.model-pop {
  position: fixed;
  width: 300px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.pop-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 14px 8px;
  font-size: 13px;
  font-weight: 600;
}
.pop-count {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
}
.pop-search-wrap {
  padding: 0 10px 6px;
}
.pop-search {
  width: 100%;
  font-size: 12.5px;
  padding: 5px 10px;
  border-radius: 8px;
}
.pop-list {
  max-height: 280px;
  overflow-y: auto;
  padding: 0 6px 6px;
}
.pop-group {
  margin-bottom: 4px;
}
.group-name {
  padding: 6px 8px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}
.pop-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.pop-item:hover {
  background: var(--surface-2);
}
.pop-item.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.pop-item .check {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  flex-shrink: 0;
}
.m-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pop-empty {
  padding: 16px 14px;
  font-size: 12.5px;
  color: var(--text-3);
}
.pop-foot {
  border-top: 1px solid var(--border-faint);
  padding: 6px;
}
.config-link {
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  color: var(--accent);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.config-link:hover {
  background: var(--accent-soft);
}
</style>

<!-- 灯箱挂到 body，须全局样式 -->
<style>
.img-lightbox {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 24px 28px;
  background: rgba(10, 12, 16, 0.78);
  backdrop-filter: blur(4px);
  cursor: zoom-out;
}
.img-lightbox .lb-close {
  position: absolute;
  top: 16px;
  right: 18px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
}
.img-lightbox .lb-close:hover {
  background: rgba(255, 255, 255, 0.22);
}
.img-lightbox .lb-img {
  max-width: min(96vw, 1200px);
  max-height: calc(100vh - 100px);
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45);
  cursor: default;
  background: #111;
}
.img-lightbox .lb-caption {
  margin: 0;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.75);
  max-width: 90vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
