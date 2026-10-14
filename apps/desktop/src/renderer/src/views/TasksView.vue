<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { Task } from "@office/shared";
import { deleteTask, listTasksPaged } from "../api";
import { toast, toastError } from "../composables/toast";
import { confirmDialog } from "../composables/confirm";
import { timeAgo } from "../utils/format";

type Filter = "all" | "running" | "completed" | "failed";

const PAGE_SIZE = 30;

const router = useRouter();
const tasks = ref<Task[]>([]);
const error = ref("");
const filter = ref<Filter>("all");
const keyword = ref("");
const total = ref(0);
// 状态计数由服务端按可见范围统计（不受当前筛选影响），前端不再本地算
const counts = ref<Record<Filter, number>>({ all: 0, running: 0, completed: 0, failed: 0 });

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
];

const STATUS_TEXT: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  awaiting_approval: "待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const EMPTY_TEXT: Record<Filter, string> = {
  all: "还没有任务，点击右上角「新建任务」派发第一个",
  running: "当前没有进行中的任务",
  completed: "还没有已完成的任务",
  failed: "没有失败的任务，一切正常",
};

const hasActive = computed(() => tasks.value.some((t) => t.status === "running" || t.status === "pending"));
const hasMore = computed(() => tasks.value.length < total.value);
let timer: number | undefined;
// 已加载条数（追加加载后变大；切换筛选时重置）
let loaded = PAGE_SIZE;

async function refresh(): Promise<void> {
  try {
    const page = await listTasksPaged({
      limit: loaded,
      offset: 0,
      status: filter.value,
      q: keyword.value.trim() || undefined,
    });
    tasks.value = page.items;
    total.value = page.total;
    counts.value = {
      all: page.counts.all,
      running: page.counts.running,
      completed: page.counts.completed,
      failed: page.counts.failed,
    };
    error.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  }
}

async function loadMore(): Promise<void> {
  loaded += PAGE_SIZE;
  await refresh();
}

async function removeTask(t: Task): Promise<void> {
  const ok = await confirmDialog({
    title: "删除任务",
    message: `「${t.title || "（无标题）"}」的登记、消息与成果物索引将被删除，且不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteTask(t.id);
    toast("success", "任务已删除");
    await refresh();
  } catch (err) {
    toastError(err, "删除失败");
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => {
    if (hasActive.value) void refresh();
  }, 4000);
});
onUnmounted(() => window.clearInterval(timer));

watch(filter, () => {
  loaded = PAGE_SIZE;
  void refresh();
});

// 关键词防抖 300ms 后走服务端搜索
let kwTimer: number | undefined;
watch(keyword, () => {
  window.clearTimeout(kwTimer);
  kwTimer = window.setTimeout(() => {
    loaded = PAGE_SIZE;
    void refresh();
  }, 300);
});

const STATUS_LABEL: Record<string, string> = { ...STATUS_TEXT };
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>任务列表</h2>
      <RouterLink to="/" class="new-btn">
        <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        新建任务
      </RouterLink>
    </div>

    <div class="toolbar">
      <div class="tabs">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          type="button"
          class="tab"
          :class="{ active: filter === f.key }"
          @click="filter = f.key"
        >
          {{ f.label }}
          <span class="tab-count">{{ counts[f.key] }}</span>
        </button>
      </div>
      <div class="search">
        <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
        <input v-model="keyword" placeholder="搜索任务标题…" />
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="tasks.length" class="list">
      <div v-for="t in tasks" :key="t.id" class="row" @click="router.push(`/tasks/${t.id}`)">
        <span class="dot" :class="t.status" />
        <div class="main">
          <div class="t-title">{{ t.title || "（无标题）" }}</div>
          <div class="t-meta">
            <span class="agent-chip">
              <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M12 7V4M8 4h8" /></svg>
              {{ t.agentName }}
            </span>
            · {{ timeAgo(t.createdAt) }}
          </div>
        </div>
        <span class="status" :class="t.status">{{ STATUS_LABEL[t.status] ?? t.status }}</span>
        <button
          v-if="t.status !== 'running' && t.status !== 'pending'"
          type="button"
          class="del-btn"
          title="删除任务"
          @click.stop="removeTask(t)"
        >
          <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
        </button>
        <svg class="icon chev" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
      </div>
    </div>
    <div v-else class="card empty-card">
      <div class="empty-icon">
        <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M12 7V4M8 4h8M9 13h.01M15 13h.01M9.5 16.5h5" /></svg>
      </div>
      <div class="empty">{{ EMPTY_TEXT[filter] }}</div>
      <RouterLink v-if="filter === 'all' && !keyword" to="/" class="cta">派发第一个任务</RouterLink>
    </div>

    <div v-if="hasMore" class="more-wrap">
      <button type="button" class="more-btn" :disabled="!tasks.length" @click="loadMore">
        加载更多（已显示 {{ tasks.length }} / {{ total }}）
      </button>
    </div>
  </div>
</template>

<style scoped>
.page {
  max-width: 820px;
  margin: 0 auto;
  padding: 28px 24px;
  animation: rise 0.22s ease-out;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.head h2 {
  margin: 0;
  font-size: 20px;
}
.new-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
  border-radius: 9px;
  padding: 7px 14px;
  font-size: 13.5px;
  font-weight: 600;
}
.new-btn:hover {
  background: var(--accent-strong);
  color: var(--on-accent);
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.tabs {
  display: flex;
  gap: 4px;
  background: var(--surface-2);
  border-radius: 10px;
  padding: 3px;
}
.tab {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 5px 12px;
  font-size: 13px;
  color: var(--text-2);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab:hover {
  border-color: transparent;
  color: var(--text);
  background: transparent;
}
.tab.active {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.tab-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}
.tab.active .tab-count {
  background: var(--accent-soft);
  color: var(--accent);
}
.search {
  position: relative;
  width: 220px;
}
.search .icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--text-3);
}
.search input {
  padding: 7px 12px 7px 32px;
  font-size: 13px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 18px;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s, transform 0.1s;
}
.row:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-1);
}
.main {
  flex: 1;
  min-width: 0;
}
.t-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-meta {
  color: var(--text-3);
  font-size: 12.5px;
  margin-top: 3px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.agent-chip .icon {
  width: 12px;
  height: 12px;
}
.chev {
  color: var(--text-3);
}
.del-btn {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  padding: 6px;
  border-radius: 8px;
}
.del-btn:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}
.empty-card {
  padding: 44px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.empty-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--surface-2);
  display: grid;
  place-items: center;
  color: var(--text-3);
  margin-bottom: 6px;
}
.empty-icon .icon {
  width: 24px;
  height: 24px;
}
.cta {
  margin-top: 10px;
  background: var(--accent);
  color: var(--on-accent);
  text-decoration: none;
  border-radius: 9px;
  padding: 8px 18px;
  font-size: 13.5px;
  font-weight: 600;
}
.cta:hover {
  background: var(--accent-strong);
  color: var(--on-accent);
}
.more-wrap {
  display: flex;
  justify-content: center;
  margin-top: 14px;
}
.more-btn {
  font-size: 13px;
  color: var(--text-2);
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  padding: 7px 18px;
}
.more-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
