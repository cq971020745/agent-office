<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { TaskGitBranch, TaskGitCommit, TaskGitStatus } from "@office/shared";
import {
  checkoutTaskGitBranch,
  commitTaskGit,
  createTaskGitBranch,
  getTaskGitBranches,
  getTaskGitLog,
  getTaskGitStatus,
  pushTaskGit,
} from "../api";
import { toast, toastError } from "../composables/toast";

const props = defineProps<{ taskId: string }>();

const status = ref<TaskGitStatus | null>(null);
const loading = ref(false);
const open = ref(false);
const panel = ref<"main" | "branches" | "graph" | "commit">("main");
const branches = ref<TaskGitBranch[]>([]);
const commits = ref<TaskGitCommit[]>([]);
const branchSearch = ref("");
const newBranch = ref("");
const commitMsg = ref("");
const busy = ref(false);
const rootRef = ref<HTMLElement | null>(null);

const visible = computed(() => status.value?.repo === true);

const filteredBranches = computed(() => {
  const kw = branchSearch.value.trim().toLowerCase();
  const list = branches.value;
  if (!kw) return list;
  return list.filter((b) => b.name.toLowerCase().includes(kw));
});

const changeLabel = computed(() => {
  const s = status.value;
  if (!s?.repo) return "";
  const ins = s.insertions ?? 0;
  const del = s.deletions ?? 0;
  return `+${ins} -${del}`;
});

async function refreshStatus(): Promise<void> {
  loading.value = true;
  try {
    status.value = await getTaskGitStatus(props.taskId);
  } catch {
    status.value = { repo: false };
  } finally {
    loading.value = false;
  }
}

async function loadBranches(): Promise<void> {
  try {
    const res = await getTaskGitBranches(props.taskId);
    branches.value = res.items;
  } catch (err) {
    toastError(err, "加载分支失败");
  }
}

async function loadLog(): Promise<void> {
  try {
    const res = await getTaskGitLog(props.taskId, 50);
    commits.value = res.items;
  } catch (err) {
    toastError(err, "加载提交历史失败");
  }
}

function toggle(): void {
  if (!visible.value) return;
  open.value = !open.value;
  if (open.value) {
    panel.value = "main";
    void refreshStatus();
  }
}

function close(): void {
  open.value = false;
  panel.value = "main";
}

async function openBranches(): Promise<void> {
  panel.value = "branches";
  branchSearch.value = "";
  await loadBranches();
}

async function openGraph(): Promise<void> {
  panel.value = "graph";
  await loadLog();
}

function openCommit(): void {
  panel.value = "commit";
  commitMsg.value = "";
}

async function onCheckout(name: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    status.value = await checkoutTaskGitBranch(props.taskId, name);
    toast("success", `已切换到 ${status.value.branch ?? name}`);
    panel.value = "main";
    await loadBranches();
  } catch (err) {
    toastError(err, "切换分支失败");
  } finally {
    busy.value = false;
  }
}

async function onCreateBranch(): Promise<void> {
  const name = newBranch.value.trim();
  if (!name || busy.value) return;
  busy.value = true;
  try {
    status.value = await createTaskGitBranch(props.taskId, name);
    toast("success", `已创建并切换到 ${name}`);
    newBranch.value = "";
    panel.value = "main";
  } catch (err) {
    toastError(err, "创建分支失败");
  } finally {
    busy.value = false;
  }
}

async function onCommit(): Promise<void> {
  if (!commitMsg.value.trim() || busy.value) return;
  busy.value = true;
  try {
    status.value = await commitTaskGit(props.taskId, commitMsg.value);
    toast("success", "已提交");
    panel.value = "main";
    commitMsg.value = "";
  } catch (err) {
    toastError(err, "提交失败");
  } finally {
    busy.value = false;
  }
}

async function onPush(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    status.value = await pushTaskGit(props.taskId);
    toast("success", "已推送");
  } catch (err) {
    toastError(err, "推送失败");
  } finally {
    busy.value = false;
  }
}

function onDocPointer(e: PointerEvent): void {
  if (!open.value) return;
  const t = e.target as Node;
  if (rootRef.value?.contains(t)) return;
  close();
}

watch(
  () => props.taskId,
  () => {
    close();
    void refreshStatus();
  }
);

onMounted(() => {
  void refreshStatus();
  document.addEventListener("pointerdown", onDocPointer, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
});
</script>

<template>
  <div v-if="visible" ref="rootRef" class="git-panel">
    <button type="button" class="git-trigger" :class="{ open }" title="Git 工具" @click="toggle">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2.2" />
        <circle cx="18" cy="6" r="2.2" />
        <circle cx="12" cy="18" r="2.2" />
        <path d="M6 8v4a4 4 0 0 0 4 4h2" />
        <path d="M18 8v2a4 4 0 0 1-4 4h-2" />
      </svg>
      <span class="branch-name">{{ status?.branch || "git" }}</span>
      <span v-if="(status?.dirtyFiles ?? 0) > 0" class="dirty-dot" :title="`${status?.dirtyFiles} 个未提交文件`" />
    </button>

    <div v-if="open" class="git-pop" role="dialog" aria-label="Git 工具">
      <!-- 主面板 -->
      <template v-if="panel === 'main'">
        <div class="pop-head">Git 工具</div>
        <div class="row changes">
          <span class="label">更改</span>
          <span class="diff">
            <span class="ins">+{{ status?.insertions ?? 0 }}</span>
            <span class="del">-{{ status?.deletions ?? 0 }}</span>
          </span>
        </div>
        <button type="button" class="row branch-btn" @click="openBranches">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M6 8v8M18 8v3a5 5 0 0 1-5 5h-1" /></svg>
          <span class="grow">{{ status?.branch }}</span>
          <span v-if="(status?.dirtyFiles ?? 0) > 0" class="hint">{{ status?.dirtyFiles }} 文件</span>
          <svg class="caret" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <div class="actions">
          <button type="button" class="act primary" :disabled="busy || !(status?.dirtyFiles)" @click="openCommit">
            提交
          </button>
          <button type="button" class="act" :disabled="busy" @click="onPush">推送</button>
        </div>
        <p v-if="(status?.ahead || status?.behind)" class="sync">
          <template v-if="status?.ahead">↑{{ status.ahead }}</template>
          <template v-if="status?.behind"> ↓{{ status.behind }}</template>
          相对上游
        </p>
      </template>

      <!-- 分支列表 -->
      <template v-else-if="panel === 'branches'">
        <div class="pop-head">
          <button type="button" class="back" @click="panel = 'main'">←</button>
          分支
        </div>
        <input v-model="branchSearch" class="search" placeholder="搜索分支" />
        <div class="list">
          <button
            v-for="b in filteredBranches"
            :key="b.name"
            type="button"
            class="branch-item"
            :class="{ current: b.current }"
            :disabled="busy || b.current"
            @click="onCheckout(b.name)"
          >
            <span class="check">{{ b.current ? "✓" : "" }}</span>
            <span class="meta">
              <span class="name">{{ b.name }}</span>
              <span v-if="b.current && (status?.dirtyFiles ?? 0) > 0" class="sub">
                未提交的更改：{{ status?.dirtyFiles }} 个文件
              </span>
              <span v-else-if="b.remote" class="sub">远程</span>
            </span>
          </button>
        </div>
        <div class="create">
          <input v-model="newBranch" placeholder="新分支名" @keydown.enter="onCreateBranch" />
          <button type="button" class="act" :disabled="busy || !newBranch.trim()" @click="onCreateBranch">
            + 创建并检出
          </button>
        </div>
        <button type="button" class="graph-link" @click="openGraph">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><path d="M6 8v8M8 6h4a4 4 0 0 1 4 4v0" /></svg>
          Git 图谱
        </button>
      </template>

      <!-- 提交历史 / 图谱 -->
      <template v-else-if="panel === 'graph'">
        <div class="pop-head">
          <button type="button" class="back" @click="panel = 'branches'">←</button>
          Git 图谱
        </div>
        <div class="list commits">
          <div v-for="c in commits" :key="c.hash" class="commit-item" :title="c.hash">
            <span class="g">{{ c.graph }}</span>
            <span class="body">
              <span class="subj">{{ c.subject }}</span>
              <span class="sub">{{ c.shortHash }} · {{ c.author }} · {{ c.relativeTime }}</span>
            </span>
          </div>
          <p v-if="!commits.length" class="empty">暂无提交</p>
        </div>
      </template>

      <!-- 提交表单 -->
      <template v-else-if="panel === 'commit'">
        <div class="pop-head">
          <button type="button" class="back" @click="panel = 'main'">←</button>
          提交更改
        </div>
        <p class="commit-hint">将暂存全部更改（{{ changeLabel }}）并提交</p>
        <textarea v-model="commitMsg" rows="3" placeholder="提交说明…" />
        <button type="button" class="act primary wide" :disabled="busy || !commitMsg.trim()" @click="onCommit">
          {{ busy ? "提交中…" : "确认提交" }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.git-panel {
  position: relative;
  flex-shrink: 0;
}
.git-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  height: 30px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.git-trigger:hover,
.git-trigger.open {
  background: var(--surface-2);
  color: var(--text);
}
.git-trigger .icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  flex-shrink: 0;
}
.branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.git-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 300px;
  max-height: min(420px, 70vh);
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-elevated, var(--surface));
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  z-index: 40;
}
.pop-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--text);
}
.back {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--text);
}
.row.changes .label {
  color: var(--text-3);
}
.diff {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.ins {
  color: #2f9e44;
  margin-right: 8px;
}
.del {
  color: var(--danger);
}
.branch-btn {
  cursor: pointer;
  text-align: left;
}
.branch-btn .icon,
.graph-link .icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  flex-shrink: 0;
}
.branch-btn .grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.branch-btn .hint {
  color: var(--text-3);
  font-size: 11px;
}
.branch-btn .caret {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  opacity: 0.5;
}
.actions {
  display: flex;
  gap: 8px;
}
.act {
  flex: 1;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.act:disabled {
  opacity: 0.5;
  cursor: default;
}
.act.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.act.wide {
  width: 100%;
  margin-top: 8px;
}
.sync {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.search,
.create input,
textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 12.5px;
  padding: 7px 10px;
  margin-bottom: 8px;
}
.list {
  max-height: 220px;
  overflow: auto;
  margin-bottom: 8px;
}
.branch-item,
.commit-item {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  color: var(--text);
  cursor: pointer;
}
.branch-item:hover:not(:disabled),
.commit-item:hover {
  background: var(--surface-2);
}
.branch-item:disabled {
  cursor: default;
}
.branch-item .check {
  width: 14px;
  color: var(--accent);
  flex-shrink: 0;
}
.branch-item .meta,
.commit-item .body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.branch-item .name,
.commit-item .subj {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  font-size: 11px;
  color: var(--text-3);
}
.create {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.create input {
  margin-bottom: 0;
}
.graph-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
}
.graph-link:hover {
  color: var(--text);
  background: var(--surface-2);
}
.commit-item {
  cursor: default;
}
.commit-item .g {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-3);
  white-space: pre;
  flex-shrink: 0;
  min-width: 1.2em;
}
.commit-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-3);
}
.empty {
  margin: 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}
</style>
