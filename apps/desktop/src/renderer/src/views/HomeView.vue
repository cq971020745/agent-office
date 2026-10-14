<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AgentConfig, ModelOption, Task } from "@office/shared";
import { createTask, createTaskWithFiles, listAgents, listModelOptions, listTasks } from "../api";
import { toast, toastError } from "../composables/toast";
import { MAX_FILES, useAttachments } from "../composables/attachments";
import { formatSize, timeAgo } from "../utils/format";

const router = useRouter();
const route = useRoute();
const agents = ref<AgentConfig[]>([]);
const tasks = ref<Task[]>([]);
const modelOptions = ref<ModelOption[]>([]);
const agentId = ref("");
const prompt = ref("");
const busy = ref(false);

// ---------- 附件（随任务一起上传，落进任务工作区；支持拖入） ----------
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

const selectedAgent = computed(() => agents.value.find((a) => a.id === agentId.value));
const runningCount = computed(() => tasks.value.filter((t) => t.status === "running" || t.status === "pending").length);
const doneCount = computed(() => tasks.value.filter((t) => t.status === "completed").length);

// ---------- 模型选择（专家与模型解耦，派发时选定） ----------
const selProviderId = ref("");
const selModelId = ref("");
const modelOpen = ref(false);
const modelTrigger = ref<HTMLElement | null>(null);
const popStyle = ref<Record<string, string>>({});

/** 弹层锚定在模型按钮上方（参照 WorkBuddy 的模型选择气泡） */
function toggleModelOpen(): void {
  if (!modelOpen.value && modelTrigger.value) {
    const r = modelTrigger.value.getBoundingClientRect();
    const left = Math.max(12, Math.min(r.right - 320, window.innerWidth - 332));
    popStyle.value = { left: `${left}px`, bottom: `${window.innerHeight - r.top + 8}px` };
  }
  modelOpen.value = !modelOpen.value;
}

const selectedModelLabel = computed(() =>
  selModelId.value ? selModelId.value : "选择模型"
);
const selectedProviderName = computed(
  () => modelOptions.value.find((x) => x.providerId === selProviderId.value)?.providerName ?? ""
);
const modelCount = computed(() => modelOptions.value.reduce((n, x) => n + x.models.length, 0));

function pickModel(providerId: string, modelId: string): void {
  selProviderId.value = providerId;
  selModelId.value = modelId;
  modelOpen.value = false;
}

function openModelConfig(): void {
  modelOpen.value = false;
  void router.push("/admin");
}

/** 专家切换：优先预选该专家的默认模型；没有默认或当前未选时取第一个可用模型 */
function syncModelWithAgent(): void {
  const a = selectedAgent.value;
  if (a?.providerId && a?.modelId) {
    const known = modelOptions.value.some((x) => x.providerId === a.providerId && x.models.includes(a.modelId));
    if (known) {
      selProviderId.value = a.providerId;
      selModelId.value = a.modelId;
      return;
    }
  }
  if ((!selProviderId.value || !selModelId.value) && modelCount.value) {
    const first = modelOptions.value[0]!;
    selProviderId.value = first.providerId;
    selModelId.value = first.models[0]!;
  }
}

const TEMPLATES = [
  { label: "本周工作周报", text: "帮我写一份本周工作周报，输出为 周报.md，包含本周进展、数据亮点与下周计划。" },
  { label: "产品介绍单页", text: "制作一个产品介绍的单页 HTML（index.html），要求视觉现代、含产品卖点与联系方式。" },
  { label: "会议纪要整理", text: "把以下要点整理成结构化会议纪要，输出 纪要.md：\n" },
  { label: "数据报表分析", text: "读取工作区里的数据文件，做一份分析报告 report.md，给出关键结论与建议。" },
];

// ---------- 工作目录（自选目录进行会话；空 = 平台隔离工作区） ----------
const dirPath = ref("");
const dirName = computed(() => {
  if (!dirPath.value) return "";
  const norm = dirPath.value.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
});

async function chooseDirectory(): Promise<void> {
  let picked: string | null = null;
  if (window.agentOffice?.pickDirectory) {
    picked = await window.agentOffice.pickDirectory();
  } else {
    // 纯浏览器环境没有原生目录选择框，退化为手动输入
    picked = window.prompt("输入工作目录的绝对路径（如 D:\\docs）", dirPath.value);
  }
  if (picked) dirPath.value = picked;
}

function clearDirectory(): void {
  dirPath.value = "";
}

async function refresh(): Promise<void> {
  try {
    agents.value = await listAgents();
    // 从专家页「发任务」跳转过来时按 query 预选
    const fromQuery = typeof route.query.agent === "string" ? route.query.agent : "";
    if (fromQuery && agents.value.some((a) => a.id === fromQuery)) {
      agentId.value = fromQuery;
    } else if (!agentId.value && agents.value.length) {
      agentId.value = agents.value[0]!.id;
    }
  } catch (err) {
    toastError(err, "加载专家失败");
  }
  try {
    modelOptions.value = await listModelOptions();
  } catch {
    modelOptions.value = [];
  }
  syncModelWithAgent();
  try {
    tasks.value = await listTasks();
  } catch {
    tasks.value = [];
  }
}

async function submit(): Promise<void> {
  if (!agentId.value || !prompt.value.trim() || busy.value) return;
  if (!selProviderId.value || !selModelId.value) {
    toast("error", "请先选择模型");
    modelOpen.value = true;
    return;
  }
  busy.value = true;
  try {
    const model = { providerId: selProviderId.value, modelId: selModelId.value };
    const { id } = attachments.value.length
      ? await createTaskWithFiles(agentId.value, prompt.value.trim(), [...attachments.value], {
          model,
          workspaceDir: dirPath.value || undefined,
        })
      : await createTask(agentId.value, prompt.value.trim(), undefined, model, dirPath.value || undefined);
    prompt.value = "";
    resetAttachments();
    await router.push(`/tasks/${id}`);
  } catch (err) {
    toastError(err, "任务创建失败");
  } finally {
    busy.value = false;
  }
}

function useTemplate(text: string): void {
  prompt.value = text;
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void submit();
}

onMounted(refresh);
</script>

<template>
  <div class="home">
    <div class="hero">
      <h1 class="title">Agent Office<br />把重复的工作交给 Agent</h1>

      <div v-if="tasks.length" class="stats">
        <div class="stat">
          <span class="num">{{ tasks.length }}</span>
          <span class="label">全部任务</span>
        </div>
        <div class="stat">
          <span class="num running">{{ runningCount }}</span>
          <span class="label">进行中</span>
        </div>
        <div class="stat">
          <span class="num done">{{ doneCount }}</span>
          <span class="label">已完成</span>
        </div>
      </div>

      <div v-if="agents.length" class="chips">
        <button
          v-for="a in agents"
          :key="a.id"
          type="button"
          class="chip"
          :class="{ active: a.id === agentId }"
          @click="agentId = a.id"
        >
          <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M12 7V4M8 4h8M9 13h.01M15 13h.01M9.5 16.5h5" /></svg>
          {{ a.name }}
        </button>
      </div>

      <div
        class="prompt-card"
        :class="{ 'drop-hover': dragging }"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent="onDragEnter"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <textarea
          v-model="prompt"
          rows="3"
          placeholder="描述你要完成的任务，可附上文件或直接拖入，例如：写一个 hello world 的 HTML 页面…"
          @keydown="onKeydown"
        ></textarea>
        <div class="toolbar">
          <span class="agent-tag" v-if="selectedAgent">
            <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M12 7V4M8 4h8M9 13h.01M15 13h.01" /></svg>
            {{ selectedAgent.name }}
          </span>
          <span v-else class="agent-tag muted">暂无可用专家，请管理员在后台配置</span>

          <button
            type="button"
            class="attach-btn"
            :title="`添加附件（最多 ${MAX_FILES} 个，单个 ≤ 20MB）`"
            @click="pickFiles"
          >
            <svg class="icon" viewBox="0 0 24 24"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.5 8.35l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
          </button>
          <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked" />

          <button
            type="button"
            class="dir-chip"
            :class="{ on: !!dirPath }"
            :title="dirPath ? `工作目录：${dirPath}（点击更换）` : '默认使用平台隔离工作区（点击选择本机目录）'"
            @click="chooseDirectory"
          >
            <svg class="icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            <span class="dir-label">{{ dirPath ? dirName : "独立工作区" }}</span>
            <span
              v-if="dirPath"
              class="dir-clear"
              title="恢复为隔离工作区"
              @click.stop="clearDirectory"
            >✕</span>
          </button>

          <div class="model-select">
            <button
              type="button"
              ref="modelTrigger"
              class="model-trigger"
              :class="{ on: !!selModelId, open: modelOpen }"
              :title="selModelId ? `${selectedProviderName} · ${selModelId}` : '选择本次任务使用的模型'"
              @click="toggleModelOpen"
            >
              <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></svg>
              {{ selectedModelLabel }}
              <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
            </button>

            <teleport to="body">
              <div v-if="modelOpen" class="model-overlay" @click.self="modelOpen = false">
                <div class="model-pop" :style="popStyle">
                  <div class="pop-head">选择模型 <span class="pop-count">{{ modelCount }} 个可用</span></div>
                  <div v-if="modelCount" class="pop-list">
                    <div v-for="g in modelOptions" :key="g.providerId" class="pop-group">
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
                  <div v-else class="pop-empty">还没有可用模型，请管理员先在管理后台添加并启用</div>
                  <div class="pop-foot">
                    <button type="button" class="config-link" @click="openModelConfig">
                      <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                      配置自定义模型
                    </button>
                  </div>
                </div>
              </div>
            </teleport>
          </div>

          <button
            class="send"
            type="button"
            :disabled="busy || !prompt.trim() || !agentId"
            :title="busy ? '派发中…' : '派发任务（Ctrl+Enter）'"
            @click="submit"
          >
            <svg class="icon" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </button>
        </div>

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
      </div>

      <div v-if="agents.length" class="templates">
        <button v-for="t in TEMPLATES" :key="t.label" type="button" class="template" @click="useTemplate(t.text)">
          {{ t.label }}
        </button>
      </div>

      <div class="meta-strip">
        <span class="meta-item">
          <svg class="icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          支持自选工作目录
        </span>
        <span class="meta-item">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          过程实时可见
        </span>
        <span class="meta-item">
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
          成果物可下载
        </span>
        <span class="meta-item">
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          支持多轮追问
        </span>
      </div>

      <div v-if="tasks.length" class="recent-line">
        <RouterLink v-for="t in tasks.slice(0, 3)" :key="t.id" :to="`/tasks/${t.id}`" class="recent-link">
          {{ (t.title || "任务").slice(0, 14) }} · {{ timeAgo(t.createdAt) }}
        </RouterLink>
      </div>

      <div v-if="!agents.length" class="hint" style="text-align: center; margin-top: 18px">
        还没有可用的 Agent —— 管理员登录后在「管理后台」添加供应商与 Agent
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background:
    radial-gradient(720px 320px at 50% -80px, rgba(23, 126, 91, 0.07), transparent),
    var(--bg);
  padding: 0 24px;
}
:root[data-theme="dark"] .home {
  background:
    radial-gradient(720px 320px at 50% -80px, rgba(47, 157, 117, 0.12), transparent),
    var(--bg);
}
.hero {
  width: 100%;
  max-width: 760px;
  margin-top: 9vh;
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: rise 0.3s ease-out;
}
.title {
  margin: 0;
  font-size: 40px;
  line-height: 1.22;
  font-weight: 800;
  letter-spacing: -0.02em;
  text-align: center;
}
.stats {
  display: flex;
  justify-content: center;
  gap: 36px;
}
.stat {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.stat .num {
  font-size: 22px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.stat .num.running { color: var(--accent); }
.stat .num.done { color: var(--success); }
.stat .label {
  font-size: 12.5px;
  color: var(--text-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border-radius: 999px;
  padding: 7px 16px;
  font-size: 13.5px;
  font-weight: 500;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  color: var(--text-2);
}
.chip:hover {
  border-color: var(--text-3);
  color: var(--text);
}
.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.chip.active .icon {
  color: var(--on-accent);
}
.prompt-card {
  background: var(--surface);
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 14px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.prompt-card:focus-within {
  border-color: var(--accent-border);
}
.prompt-card.drop-hover {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(23, 126, 91, 0.14);
}
.prompt-card textarea {
  border: none;
  box-shadow: none;
  padding: 6px 6px 2px;
  font-size: 15px;
  background: transparent;
}
.prompt-card textarea:focus {
  box-shadow: none;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.agent-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 4px 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tag.muted {
  color: var(--text-3);
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
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
.dir-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 4px 12px;
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
}
.dir-chip .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--text-3);
}
.dir-chip:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.dir-chip.on {
  color: var(--text);
  background: var(--accent-soft);
}
.dir-chip.on .icon {
  color: var(--accent);
}
.dir-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dir-clear {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  padding: 1px 3px;
  border-radius: 6px;
}
.dir-clear:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.model-select {
  margin-left: auto;
}
.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 4px 12px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-trigger .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.model-trigger .caret {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--text-3);
  transition: transform 0.15s ease;
}
.model-trigger.open .caret {
  transform: rotate(180deg);
}
.model-trigger:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.model-trigger.on {
  color: var(--text);
  background: var(--accent-soft);
}

/* 模型选择弹层 */
.model-overlay {
  position: fixed;
  inset: 0;
  z-index: 55;
}
.model-pop {
  position: fixed;
  width: 320px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  animation: rise 0.16s ease-out;
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
.pop-list {
  max-height: 300px;
  overflow-y: auto;
  padding: 0 6px 6px;
}
.pop-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}
.group-name {
  font-size: 11.5px;
  color: var(--text-3);
  padding: 4px 8px 2px;
}
.pop-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  border: none;
  box-shadow: none;
  background: transparent;
  border-radius: 8px;
  padding: 7px 8px;
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
}
.pop-item:hover {
  background: var(--surface-2);
  color: var(--text);
}
.pop-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.m-id {
  font-family: var(--mono, monospace);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.pop-empty {
  padding: 14px;
  font-size: 12.5px;
  color: var(--text-3);
}
.pop-foot {
  border-top: 1px solid var(--border);
  padding: 6px;
}
.config-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  box-shadow: none;
  background: transparent;
  border-radius: 8px;
  padding: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.config-link:hover {
  background: var(--surface-2);
  color: var(--text);
}
.config-link .icon {
  width: 14px;
  height: 14px;
  color: var(--text-3);
}
.send {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  display: grid;
  place-items: center;
  padding: 0;
  flex-shrink: 0;
}
.send:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
  color: var(--on-accent);
}
.send .icon {
  width: 17px;
  height: 17px;
}
.templates {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.template {
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  padding: 5px 14px;
}
.template:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.meta-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 18px;
  font-size: 12.5px;
  color: var(--text-3);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.meta-item .icon {
  width: 14px;
  height: 14px;
}
.recent-line {
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
  display: flex;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}
.recent-link {
  color: var(--text-2);
  text-decoration: none;
}
.recent-link:hover {
  color: var(--accent);
}
@media (max-width: 640px) {
  .title {
    font-size: 28px;
  }
  .hero {
    margin-top: 6vh;
  }
}
</style>
