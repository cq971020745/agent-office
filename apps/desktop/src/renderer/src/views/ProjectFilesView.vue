<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getTask, listWorkspace, type WorkspaceEntry } from "../api";
import { toast, toastError } from "../composables/toast";
import { formatSize } from "../utils/format";

const route = useRoute();
const router = useRouter();

const taskId = computed(() => (typeof route.params.taskId === "string" ? route.params.taskId : ""));
const projectName = ref("项目");
const projectPath = ref("");
const dir = ref("");
const entries = ref<WorkspaceEntry[]>([]);
const truncated = ref(false);
const loading = ref(false);
const error = ref("");
const filter = ref("");
const menuOpen = ref(false);

const crumbs = computed(() => {
  const parts = dir.value.split("/").filter(Boolean);
  const list: { label: string; path: string }[] = [{ label: projectName.value, path: "" }];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    list.push({ label: p, path: acc });
  }
  return list;
});

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = [...entries.value].sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
  if (!q) return list;
  return list.filter((e) => e.name.toLowerCase().includes(q));
});

async function loadMeta(): Promise<void> {
  if (!taskId.value) return;
  try {
    const t = await getTask(taskId.value);
    projectPath.value = t.workspacePath || "";
    const raw = projectPath.value.replace(/[\\/]+$/, "");
    projectName.value = raw.split(/[\\/]/).pop() || "项目";
  } catch (err) {
    toastError(err, "加载项目失败");
  }
}

async function loadDir(next = dir.value): Promise<void> {
  if (!taskId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const res = await listWorkspace(taskId.value, next);
    dir.value = res.dir;
    entries.value = res.entries;
    truncated.value = res.truncated;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "无法读取目录";
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function goDir(rel: string): void {
  filter.value = "";
  void loadDir(rel);
}

function onEntry(e: WorkspaceEntry): void {
  if (e.folder) {
    goDir(e.relPath);
    return;
  }
  void openFile(e);
}

async function openFile(e: WorkspaceEntry): Promise<void> {
  const full = joinPath(projectPath.value, e.relPath);
  if (window.agentOffice?.openPath) {
    const res = await window.agentOffice.openPath(full);
    if (!res.ok) toast("error", res.message || "打开失败");
    return;
  }
  toast("info", `文件路径：${full}`);
}

function joinPath(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return `${base}${sep}${rel.replace(/\//g, sep)}`;
}

async function openInExplorer(): Promise<void> {
  menuOpen.value = false;
  if (!projectPath.value) return;
  if (window.agentOffice?.openPath) {
    const res = await window.agentOffice.openPath(projectPath.value);
    if (!res.ok) toast("error", res.message || "打开失败");
    return;
  }
  toast("info", `项目路径：${projectPath.value}`);
}

async function copyPath(): Promise<void> {
  menuOpen.value = false;
  if (!projectPath.value) return;
  try {
    await navigator.clipboard.writeText(projectPath.value);
    toast("success", "路径已复制");
  } catch {
    toast("error", projectPath.value);
  }
}

function goBack(): void {
  void router.push("/");
}

function newTask(): void {
  void router.push({
    path: "/",
    query: { workspaceDir: projectPath.value },
  });
}

watch(taskId, () => {
  dir.value = "";
  filter.value = "";
  void loadMeta().then(() => loadDir(""));
});

onMounted(() => {
  void loadMeta().then(() => loadDir(""));
});
</script>

<template>
  <div class="project-files">
    <header class="pf-head">
      <button type="button" class="back" title="返回" @click="goBack">
        <svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        返回任务
      </button>
      <div class="pf-actions">
        <button type="button" class="sm" @click="newTask">新建任务</button>
        <button type="button" class="icon-btn" title="刷新" :disabled="loading" @click="loadDir(dir)">
          <svg class="icon" viewBox="0 0 24 24"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.5 9a9 9 0 0 1 14.8-3.3L23 10M1 14l4.7 4.3A9 9 0 0 0 20.5 15" /></svg>
        </button>
        <div class="menu-wrap">
          <button type="button" class="icon-btn" title="更多" @click="menuOpen = !menuOpen">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
          </button>
          <div v-if="menuOpen" class="menu" @mouseleave="menuOpen = false">
            <button type="button" @click="openInExplorer">在资源管理器中打开</button>
            <button type="button" @click="copyPath">复制路径</button>
          </div>
        </div>
      </div>
    </header>

    <div class="pf-title-row">
      <svg class="folder-ic" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
      <div class="pf-title-text">
        <h1>{{ projectName }}</h1>
        <p :title="projectPath">{{ projectPath }}</p>
      </div>
    </div>

    <div class="pf-search">
      <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input v-model="filter" type="search" placeholder="搜索文件…" />
    </div>

    <nav class="crumbs" aria-label="路径">
      <template v-for="(c, i) in crumbs" :key="c.path || 'root'">
        <span v-if="i" class="sep">/</span>
        <button type="button" class="crumb" :class="{ current: i === crumbs.length - 1 }" @click="goDir(c.path)">
          {{ c.label }}
        </button>
      </template>
    </nav>

    <p v-if="error" class="err">{{ error }}</p>
    <p v-else-if="loading" class="hint">加载中…</p>
    <p v-else-if="!visible.length" class="hint">此目录为空</p>
    <ul v-else class="file-list">
      <li v-for="e in visible" :key="e.relPath">
        <button type="button" class="file-row" @click="onEntry(e)">
          <svg v-if="e.folder" class="fic" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          <svg v-else class="fic" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
          <span class="fname">{{ e.name }}</span>
          <span v-if="!e.folder" class="fsize">{{ formatSize(e.size) }}</span>
        </button>
      </li>
    </ul>
    <p v-if="truncated" class="hint truncate">目录项较多，仅显示前若干条</p>
  </div>
</template>

<style scoped>
.project-files {
  max-width: 860px;
  margin: 0 auto;
  padding: 18px 28px 40px;
}
.pf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.back:hover {
  background: var(--surface-2);
  color: var(--text);
}
.back .icon {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pf-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.icon-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: none;
  color: var(--text-2);
  cursor: pointer;
}
.icon-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.icon-btn .icon {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon-btn .icon circle {
  fill: currentColor;
  stroke: none;
}
.menu-wrap {
  position: relative;
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow-2);
}
.menu button {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  box-shadow: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.menu button:hover {
  background: var(--surface-2);
}
.pf-title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.folder-ic {
  width: 28px;
  height: 28px;
  margin-top: 2px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pf-title-text h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.3;
}
.pf-title-text p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 640px;
}
.pf-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.pf-search .icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.8;
}
.pf-search input {
  flex: 1;
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  font-size: 13.5px;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 12.5px;
}
.crumb {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 2px 4px;
  border-radius: 5px;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.crumb:hover {
  background: var(--accent-soft);
}
.crumb.current {
  color: var(--text-2);
  cursor: default;
  font-weight: 600;
}
.sep {
  color: var(--text-3);
}
.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}
.file-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border: none;
  border-bottom: 1px solid var(--border-faint);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
}
.file-list li:last-child .file-row {
  border-bottom: none;
}
.file-row:hover {
  background: var(--surface-2);
}
.fic {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.fname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fsize {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.hint,
.err {
  font-size: 13px;
  color: var(--text-3);
  padding: 16px 4px;
}
.err {
  color: var(--danger);
}
.truncate {
  padding-top: 8px;
}
</style>
