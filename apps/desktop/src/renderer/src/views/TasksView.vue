<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { AgentConfig, ScheduledTask, Task } from "@office/shared";
import {
  createSchedule,
  deleteSchedule,
  deleteTask,
  listAgents,
  listSchedules,
  listTasksPaged,
  runScheduleNow,
  updateSchedule,
} from "../api";
import { toast, toastError } from "../composables/toast";
import { confirmDialog } from "../composables/confirm";
import { timeAgo } from "../utils/format";

type Filter = "all" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
type ViewMode = "tasks" | "schedules";

const PAGE_SIZE = 30;

const router = useRouter();
const viewMode = ref<ViewMode>("tasks");
const tasks = ref<Task[]>([]);
const schedules = ref<ScheduledTask[]>([]);
const agents = ref<AgentConfig[]>([]);
const error = ref("");
const filter = ref<Filter>("all");
const keyword = ref("");
const total = ref(0);
// 状态计数由服务端按可见范围统计（不受当前筛选影响），前端不再本地算
const counts = ref<Record<Filter, number>>({
  all: 0,
  running: 0,
  awaiting_approval: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
});

// ---------- 定时任务弹窗表单 ----------
const showScheduleModal = ref(false);
const editingSchedule = ref<ScheduledTask | null>(null);
const sTitle = ref("");
const sPrompt = ref("");
const sAgentId = ref("");
const sKind = ref<"daily" | "weekly" | "interval">("daily");
const sTime = ref("09:00");
const sWeekday = ref(1);
const sInterval = ref(60);
const sSaving = ref(false);

const WEEKDAY_NAMES: Record<number, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

function formatScheduleExpr(expr: string): string {
  const daily = /^daily:(\d{2}:\d{2})$/.exec(expr);
  if (daily) return `每天 ${daily[1]}`;
  const weekly = /^weekly:([1-7]):(\d{2}:\d{2})$/.exec(expr);
  if (weekly) return `每${WEEKDAY_NAMES[Number(weekly[1])] ?? "周"} ${weekly[2]}`;
  const interval = /^interval:(\d+)$/.exec(expr);
  if (interval) return `每隔 ${interval[1]} 分钟`;
  return expr;
}

function buildScheduleExpr(): string {
  if (sKind.value === "daily") return `daily:${sTime.value || "09:00"}`;
  if (sKind.value === "weekly") return `weekly:${sWeekday.value}:${sTime.value || "09:00"}`;
  return `interval:${Math.max(5, Math.min(10080, Math.round(Number(sInterval.value) || 60)))}`;
}

async function loadSchedules(): Promise<void> {
  try {
    schedules.value = await listSchedules();
  } catch (err) {
    toastError(err, "加载定时任务失败");
  }
}

async function openCreateSchedule(): Promise<void> {
  editingSchedule.value = null;
  sTitle.value = "";
  sPrompt.value = "";
  sAgentId.value = "";
  sKind.value = "daily";
  sTime.value = "09:00";
  sWeekday.value = 1;
  sInterval.value = 60;
  showScheduleModal.value = true;
  if (!agents.value.length) {
    try {
      agents.value = await listAgents();
    } catch {
      // ignore
    }
  }
}

async function openEditSchedule(s: ScheduledTask): Promise<void> {
  editingSchedule.value = s;
  sTitle.value = s.title;
  sPrompt.value = s.prompt;
  sAgentId.value = s.agentId;
  const daily = /^daily:(\d{2}:\d{2})$/.exec(s.scheduleExpr);
  const weekly = /^weekly:([1-7]):(\d{2}:\d{2})$/.exec(s.scheduleExpr);
  const interval = /^interval:(\d+)$/.exec(s.scheduleExpr);
  if (daily) {
    sKind.value = "daily";
    sTime.value = daily[1]!;
  } else if (weekly) {
    sKind.value = "weekly";
    sWeekday.value = Number(weekly[1]);
    sTime.value = weekly[2]!;
  } else if (interval) {
    sKind.value = "interval";
    sInterval.value = Number(interval[1]);
  }
  showScheduleModal.value = true;
  if (!agents.value.length) {
    try {
      agents.value = await listAgents();
    } catch {
      // ignore
    }
  }
}

async function saveSchedule(): Promise<void> {
  if (!sPrompt.value.trim()) {
    toast("error", "请填写任务提示词");
    return;
  }
  sSaving.value = true;
  try {
    const scheduleExpr = buildScheduleExpr();
    if (editingSchedule.value) {
      await updateSchedule(editingSchedule.value.id, {
        title: sTitle.value.trim() || sPrompt.value.trim().slice(0, 32),
        prompt: sPrompt.value.trim(),
        agentId: sAgentId.value || undefined,
        scheduleExpr,
      });
      toast("success", "定时任务已更新");
    } else {
      await createSchedule({
        title: sTitle.value.trim() || sPrompt.value.trim().slice(0, 32),
        prompt: sPrompt.value.trim(),
        agentId: sAgentId.value || undefined,
        scheduleExpr,
      });
      toast("success", "定时任务已创建");
    }
    showScheduleModal.value = false;
    await loadSchedules();
  } catch (err) {
    toastError(err, "保存定时任务失败");
  } finally {
    sSaving.value = false;
  }
}

async function toggleScheduleEnabled(s: ScheduledTask): Promise<void> {
  try {
    await updateSchedule(s.id, { enabled: !s.enabled });
    await loadSchedules();
    toast("success", !s.enabled ? "定时任务已启用" : "定时任务已暂停");
  } catch (err) {
    toastError(err, "状态更新失败");
  }
}

async function triggerSchedule(s: ScheduledTask): Promise<void> {
  try {
    const res = await runScheduleNow(s.id);
    toast("success", "已触发立即执行");
    await router.push(`/tasks/${res.taskId}`);
  } catch (err) {
    toastError(err, "触发执行失败");
  }
}

async function removeSchedule(s: ScheduledTask): Promise<void> {
  const ok = await confirmDialog({
    title: "删除定时任务",
    message: `确定删除定时任务「${s.title}」吗？此前已生成的历史任务记录仍会保留。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteSchedule(s.id);
    toast("success", "定时任务已删除");
    await loadSchedules();
  } catch (err) {
    toastError(err, "删除失败");
  }
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "awaiting_approval", label: "待确认" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
  { key: "cancelled", label: "已取消" },
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
  awaiting_approval: "当前没有等待人工确认的高风险任务",
  completed: "还没有已完成的任务",
  failed: "没有失败的任务，一切正常",
  cancelled: "没有已取消的任务",
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
      awaiting_approval: page.counts.awaiting_approval ?? 0,
      completed: page.counts.completed,
      failed: page.counts.failed,
      cancelled: page.counts.cancelled ?? 0,
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
  void loadSchedules();
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
      <div class="head-left">
        <h2>任务中心</h2>
        <div class="mode-switch">
          <button
            type="button"
            class="mode-btn"
            :class="{ active: viewMode === 'tasks' }"
            @click="viewMode = 'tasks'"
          >
            任务列表
            <span class="tab-count">{{ counts.all }}</span>
          </button>
          <button
            type="button"
            class="mode-btn"
            :class="{ active: viewMode === 'schedules' }"
            @click="viewMode = 'schedules'"
          >
            ⏰ 定时巡检
            <span class="tab-count">{{ schedules.length }}</span>
          </button>
        </div>
      </div>

      <button v-if="viewMode === 'schedules'" type="button" class="new-btn" @click="openCreateSchedule">
        <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        新建定时任务
      </button>
      <RouterLink v-else to="/" class="new-btn">
        <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        新建任务
      </RouterLink>
    </div>

    <template v-if="viewMode === 'tasks'">
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
    </template>

    <!-- 定时与自动化巡检任务视图 -->
    <template v-else>
      <div v-if="schedules.length" class="list">
        <div v-for="s in schedules" :key="s.id" class="row schedule-row">
          <span class="dot" :class="s.enabled ? 'completed' : 'cancelled'" />
          <div class="main" @click="openEditSchedule(s)">
            <div class="t-title">
              {{ s.title }}
              <span class="cron-badge">{{ formatScheduleExpr(s.scheduleExpr) }}</span>
            </div>
            <div class="t-meta">
              <span class="agent-chip">
                <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M12 7V4M8 4h8" /></svg>
                {{ s.agentName }}
              </span>
              <span v-if="s.nextRunAt && s.enabled">· 下次执行：{{ timeAgo(s.nextRunAt) }}</span>
              <span v-if="s.lastRunAt">· 上次执行：{{ timeAgo(s.lastRunAt) }}</span>
              <button
                v-if="s.lastTaskId"
                type="button"
                class="last-task-link"
                @click.stop="router.push(`/tasks/${s.lastTaskId}`)"
              >
                查看最近产出 →
              </button>
            </div>
          </div>
          <div class="sched-actions">
            <button type="button" class="sm-btn" title="立即执行一次" @click.stop="triggerSchedule(s)">
              ▶ 立即执行
            </button>
            <button
              type="button"
              class="sm-btn"
              :class="{ active: s.enabled }"
              @click.stop="toggleScheduleEnabled(s)"
            >
              {{ s.enabled ? "已启用" : "已暂停" }}
            </button>
            <button type="button" class="del-btn" title="删除定时任务" @click.stop="removeSchedule(s)">
              <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div v-else class="card empty-card">
        <div class="empty-icon">⏰</div>
        <div class="empty">还没有配置定时巡检任务（如每日早报、每周数据汇总、定期巡检）</div>
        <button type="button" class="cta" @click="openCreateSchedule">新建第一个定时任务</button>
      </div>
    </template>

    <!-- 新建/编辑定时任务弹窗 -->
    <div v-if="showScheduleModal" class="modal-backdrop" @click.self="showScheduleModal = false">
      <div class="modal-card">
        <h3>{{ editingSchedule ? "编辑定时任务" : "新建定时任务" }}</h3>
        <div class="form-row">
          <label>任务名称</label>
          <input v-model="sTitle" placeholder="例如：每日群聊与待办早报汇总" />
        </div>
        <div class="form-row">
          <label>指派专家（不选则使用通用助手）</label>
          <select v-model="sAgentId">
            <option value="">通用助手（默认）</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>执行周期</label>
          <div class="sched-picker">
            <select v-model="sKind" class="sched-kind">
              <option value="daily">每天固定时刻</option>
              <option value="weekly">每周固定时刻</option>
              <option value="interval">固定分钟间隔</option>
            </select>
            <select v-if="sKind === 'weekly'" v-model.number="sWeekday" class="sched-sub">
              <option v-for="(label, d) in WEEKDAY_NAMES" :key="d" :value="Number(d)">{{ label }}</option>
            </select>
            <input v-if="sKind !== 'interval'" v-model="sTime" type="time" class="sched-sub" />
            <div v-else class="interval-box">
              <span>每隔</span>
              <input v-model.number="sInterval" type="number" min="5" max="10080" />
              <span>分钟</span>
            </div>
          </div>
        </div>
        <div class="form-row">
          <label>任务指令（Prompt）</label>
          <textarea
            v-model="sPrompt"
            rows="4"
            placeholder="详细描述每次定时触发时专家需要执行的动作与产出的文件…"
          ></textarea>
        </div>
        <div class="modal-foot">
          <button type="button" class="ghost-btn" @click="showScheduleModal = false">取消</button>
          <button type="button" class="new-btn" :disabled="sSaving" @click="saveSchedule">
            {{ sSaving ? "保存中…" : "保存" }}
          </button>
        </div>
      </div>
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
.head-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.head h2 {
  margin: 0;
  font-size: 20px;
}
.mode-switch {
  display: inline-flex;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 2px;
  gap: 3px;
}
.mode-btn {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 5px 12px;
  font-size: 12.5px;
  border-radius: 7px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mode-btn.active {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.cron-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.last-task-link {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0 4px;
  font-size: 12px;
  color: var(--accent);
}
.last-task-link:hover {
  text-decoration: underline;
}
.sched-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm-btn {
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 7px;
}
.sm-btn.active {
  color: var(--success);
  border-color: rgba(16, 185, 129, 0.35);
  background: var(--success-soft);
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: grid;
  place-items: center;
  z-index: 60;
}
.modal-card {
  width: min(520px, 92vw);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-card h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.form-row label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.sched-picker {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sched-kind {
  width: 160px;
}
.sched-sub {
  width: 130px;
}
.interval-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.interval-box input {
  width: 90px;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
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
