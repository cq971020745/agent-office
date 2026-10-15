<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AgentConfig, AgentTaskWithDeliverables } from "@office/shared";
import { downloadDeliverable, getAgent, listAgentTasks } from "../api";
import { formatSize, timeAgo } from "../utils/format";
import { toast, toastError } from "../composables/toast";
import AgentAvatar from "../components/AgentAvatar.vue";

const route = useRoute();
const router = useRouter();

const agentId = ref(route.params.id as string);
const agent = ref<AgentConfig | null>(null);
const tasks = ref<AgentTaskWithDeliverables[]>([]);
const loading = ref(true);
const pageError = ref("");

const STATUS_TEXT: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  awaiting_approval: "待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const completedCount = computed(() => tasks.value.filter((t) => t.status === "completed").length);
const fileCount = computed(() => tasks.value.reduce((sum, t) => sum + t.deliverables.length, 0));
const hasActive = computed(() => tasks.value.some((t) => t.status === "running" || t.status === "pending"));

async function load(): Promise<void> {
  loading.value = true;
  pageError.value = "";
  try {
    agent.value = await getAgent(agentId.value);
    tasks.value = await listAgentTasks(agentId.value);
  } catch (err) {
    pageError.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

// 有进行中的任务时轻量轮询，全部结束后停止
let pollTimer: ReturnType<typeof setInterval> | undefined;
function ensurePoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!hasActive.value) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      return;
    }
    void listAgentTasks(agentId.value)
      .then((rows) => (tasks.value = rows))
      .catch(() => {});
  }, 6_000);
}

function copyPrompt(): void {
  const text = agent.value?.systemPrompt ?? "";
  if (!text) return;
  navigator.clipboard
    .writeText(text)
    .then(() => toast("success", "系统提示词已复制"))
    .catch(() => toastError(new Error("复制失败，请手动选择文本"), ""));
}

function dispatch(): void {
  if (!agent.value) return;
  void router.push({ path: "/", query: { agent: agent.value.id } });
}

async function openFolder(): Promise<void> {
  if (!agent.value?.folderPath) return;
  try {
    const res = await window.agentOffice.openPath(agent.value.folderPath);
    if (!res.ok) toast("error", res.message ?? "无法打开文件夹");
  } catch (err) {
    toastError(err, "无法打开文件夹");
  }
}

function openTask(id: string): void {
  void router.push(`/tasks/${id}`);
}

onMounted(load);
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

// 详情页在同路由下被复用（专家间跳转），id 必须跟随路由参数变化
watch(
  () => route.params.id,
  (id) => {
    if (!id || id === agentId.value) return;
    agentId.value = id as string;
    void load();
  }
);
watch(hasActive, (active) => {
  if (active) ensurePoll();
});
</script>

<template>
  <div class="page" v-if="agent">
    <header class="topbar">
      <div class="tb-left">
        <RouterLink to="/experts" class="back" title="返回专家列表">
          <svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </RouterLink>
        <span class="v-divider" />
        <AgentAvatar :name="agent.name" :size="34" />
        <div class="tb-text">
          <h2 class="tb-title">{{ agent.name }}</h2>
          <p class="tb-meta">
            <template v-if="agent.modelId">{{ agent.providerName }} · {{ agent.modelId }}</template>
            <template v-else>模型 · 派发任务时选择</template>
          </p>
        </div>
      </div>
      <div class="tb-right">
        <button v-if="agent.folderPath" type="button" class="ghost-btn" @click="openFolder">
          <svg class="icon" viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          打开文件夹
        </button>
        <button type="button" class="primary dispatch-btn" @click="dispatch">
          <svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          派发任务
        </button>
      </div>
    </header>
    <p v-if="pageError" class="err-page">{{ pageError }}</p>

    <div class="body">
      <div class="wrap">
        <!-- 简介 -->
        <section class="card profile">
          <p class="desc">{{ agent.description || "暂无说明" }}</p>
          <div class="meta-rows">
            <div v-if="agent.tags.length" class="meta-row">
              <span class="meta-label">标签</span>
              <span class="tags">
                <span v-for="t in agent.tags" :key="t" class="tag">{{ t }}</span>
              </span>
            </div>
            <div v-if="agent.folderPath" class="meta-row">
              <span class="meta-label">常驻文件夹</span>
              <span class="folder-path" :title="agent.folderPath">{{ agent.folderPath }}</span>
            </div>
          </div>
        </section>

        <!-- 系统提示词（仅管理员可见，D8 商业提示词保护） -->
        <section v-if="agent.systemPrompt" class="card">
          <header class="card-head">
            <h3>
              <svg class="icon" viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" /><path d="M9 13h6M9 17h4" />
              </svg>
              系统提示词
            </h3>
            <button type="button" class="ghost-btn sm" @click="copyPrompt">复制</button>
          </header>
          <pre class="prompt-pre">{{ agent.systemPrompt }}</pre>
        </section>

        <!-- 历史任务 -->
        <section class="card">
          <header class="card-head">
            <h3>
              <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              历史任务
              <span class="count">{{ tasks.length }}</span>
            </h3>
            <span class="head-note">{{ completedCount }} 个完成 · {{ fileCount }} 个产出文件</span>
          </header>

          <div v-if="loading" class="empty">加载中…</div>
          <div v-else-if="tasks.length" class="task-list">
            <div v-for="t in tasks" :key="t.id" class="task-row" @click="openTask(t.id)">
              <div class="tr-head">
                <span class="tr-title">{{ t.title || "（无标题）" }}</span>
                <span class="status" :class="t.status">{{ STATUS_TEXT[t.status] ?? t.status }}</span>
              </div>
              <p class="tr-meta">
                {{ timeAgo(t.createdAt) }} · {{ t.modelId || "未选模型" }}
                <!-- 工作目录与专家常驻文件夹一致时不重复展示（上方简介卡已给出） -->
                <template v-if="t.customWorkspace && t.workspacePath !== agent.folderPath">
                  · {{ t.workspacePath }}
                </template>
              </p>
              <p v-if="t.error" class="tr-err">{{ t.error }}</p>
              <div v-if="t.deliverables.length" class="file-chips" @click.stop>
                <button
                  v-for="f in t.deliverables"
                  :key="f.id"
                  type="button"
                  class="file-chip"
                  :title="`${f.relPath} · 点击下载`"
                  @click="downloadDeliverable(t.id, f)"
                >
                  <svg class="icon" viewBox="0 0 24 24">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
                  </svg>
                  {{ f.relPath }}
                  <span class="f-size">{{ formatSize(f.size) }}</span>
                </button>
              </div>
            </div>
          </div>
          <div v-else class="empty">
            该专家还没有任务记录 —— 点击右上角「派发任务」把第一件事交给它
          </div>
        </section>
      </div>
    </div>
  </div>
  <div class="page loading-page" v-else-if="loading">
    <p class="empty">加载中…</p>
  </div>
  <p v-else class="err-page">{{ pageError || "专家不存在或已被删除" }}</p>
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
.loading-page {
  align-items: center;
  justify-content: center;
}
.err-page {
  padding: 40px;
  text-align: center;
  color: var(--text-3);
}

/* ---------- 顶栏 ---------- */
.topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
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
  height: 24px;
  background: var(--border);
  flex-shrink: 0;
}
.tb-text {
  min-width: 0;
}
.tb-title {
  margin: 0;
  font-size: 15.5px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-meta {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.tb-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.icon {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: auto;
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  color: var(--text-2);
}
.ghost-btn:hover {
  color: var(--text);
  background: var(--surface-2);
}
.ghost-btn.sm {
  padding: 4px 10px;
  font-size: 12px;
}
.dispatch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: auto;
  padding: 6px 14px;
  font-size: 12.5px;
  border-radius: 8px;
}

/* ---------- 主体 ---------- */
.body {
  flex: 1;
  overflow-y: auto;
  padding: 22px 28px 40px;
}
.wrap {
  max-width: 880px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border-faint);
}
.card-head h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
  display: inline-grid;
  place-items: center;
}
.head-note {
  font-size: 11.5px;
  color: var(--text-3);
}

/* 简介 */
.profile {
  padding: 16px 18px;
}
.desc {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-2);
}
.meta-rows {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.meta-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
}
.meta-label {
  flex-shrink: 0;
  width: 68px;
  color: var(--text-3);
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border-faint);
  color: var(--text-2);
  font-size: 11.5px;
}
.folder-path {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 系统提示词 */
.prompt-pre {
  margin: 0;
  padding: 14px 18px;
  max-height: 300px;
  overflow-y: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-2);
  background: var(--surface);
}

/* 历史任务 */
.task-list {
  display: flex;
  flex-direction: column;
}
.task-row {
  padding: 12px 18px;
  border-bottom: 1px solid var(--border-faint);
  cursor: pointer;
  transition: background 0.12s;
}
.task-row:last-child {
  border-bottom: none;
}
.task-row:hover {
  background: var(--surface-2);
}
.tr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.tr-title {
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tr-meta {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tr-err {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--danger);
}
.file-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  width: auto;
  max-width: 340px;
}
.file-chip .icon {
  width: 13px;
  height: 13px;
}
.file-chip:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.file-chip .f-size {
  color: var(--text-3);
  font-size: 11px;
  flex-shrink: 0;
}
.file-chip:hover .f-size {
  color: var(--accent);
}

/* 全局 .status 药丸在 style.css；这里补一个空隙，防止 title 过长贴住状态 */
.status {
  flex-shrink: 0;
}
.empty {
  padding: 26px 18px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
</style>
