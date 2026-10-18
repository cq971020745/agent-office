<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Task, WpsProfile } from "@office/shared";
import {
  detachProject,
  getRole,
  getToken,
  getUsername,
  getWpsMe,
  listTasks,
  pingKbSession,
  setToken,
  setUsername,
  syncWpsAccount,
} from "./api";
import { timeAgo } from "./utils/format";
import Toasts from "./components/Toasts.vue";
import ConfirmHost from "./components/ConfirmHost.vue";
import { confirmDialog } from "./composables/confirm";
import { toast, toastError } from "./composables/toast";

type ProjectGroup = { key: string; name: string; path: string; tasks: Task[] };

const route = useRoute();
const router = useRouter();
const loggedIn = computed(() => route.path !== "/login" && !!getToken());
// route.path 作为响应式依赖，确保同一应用进程切换账号后角色与用户名立即刷新。
const isAdmin = computed(() => route.path !== "/login" && getRole() === "admin");
const username = computed(() => (route.path === "/login" ? "用户" : getUsername() || "用户"));

const theme = ref<"light" | "dark">(
  document.documentElement.dataset.theme === "dark" ? "dark" : "light"
);
function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem("agent-office-theme", theme.value);
}

const sidebarCollapsed = ref(localStorage.getItem("agent-office-sidebar-collapsed") === "1");
function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem("agent-office-sidebar-collapsed", sidebarCollapsed.value ? "1" : "0");
}

const allTasks = ref<Task[]>([]);
const folderCollapsed = ref<Record<string, boolean>>({});

function folderKey(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function folderName(path: string): string {
  const raw = path.replace(/[\\/]+$/, "");
  return raw.split(/[\\/]/).pop() || "文件夹";
}

const folderGroups = computed(() => {
  const groups = new Map<string, ProjectGroup>();
  for (const task of allTasks.value) {
    if (!task.customWorkspace || !task.workspacePath) continue;
    const key = folderKey(task.workspacePath);
    const group = groups.get(key) ?? { key, name: folderName(task.workspacePath), path: task.workspacePath, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()];
});

/** 项目行 ⋯ 菜单（Codex / ZCode 式：打开、查看文件、移除） */
const projectMenuKey = ref("");
function toggleProjectMenu(key: string, e?: Event): void {
  e?.stopPropagation();
  projectMenuKey.value = projectMenuKey.value === key ? "" : key;
}
function closeProjectMenu(): void {
  projectMenuKey.value = "";
}

const recentTasks = computed(() => allTasks.value.filter((task) => !task.customWorkspace).slice(0, 8));
const runningCount = computed(
  () => allTasks.value.filter((t) => t.status === "running" || t.status === "pending").length
);
const awaitingCount = computed(
  () => allTasks.value.filter((t) => t.status === "awaiting_approval").length
);

async function refreshRecent(): Promise<void> {
  if (!getToken()) return;
  try {
    allTasks.value = await listTasks();
  } catch {
    allTasks.value = [];
  }
}

// 侧栏轮询：让运行状态与徽标保持新鲜（页面隐藏时跳过）
let pollTimer: ReturnType<typeof setInterval> | undefined;
// 知识库访问凭证有空闲超时；本应用 JWT 不过期，必须主动续期，否则工作台会落到知识库自己的登录页。
const KB_PING_MS = 8 * 60_000;
let lastKbPing = 0;
async function pingKb(): Promise<void> {
  if (!getToken() || document.visibilityState !== "visible") return;
  lastKbPing = Date.now();
  try {
    await pingKbSession();
  } catch {
    // 401 由 api.ts 清登录态并回登录页；其它错误忽略，避免打扰
  }
}
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void refreshRecent();
    if (Date.now() - lastKbPing >= KB_PING_MS) void pingKb();
  }, 5000);
  void pingKb();
}
function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function onVisibilityChange(): void {
  if (document.visibilityState !== "visible" || !getToken()) return;
  void refreshRecent();
  if (Date.now() - lastKbPing >= KB_PING_MS) void pingKb();
}

onMounted(refreshRecent);
onMounted(() => {
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("click", closeProjectMenu);
});
watch(() => route.path, refreshRecent);
watch(
  () => (typeof route.params.id === "string" ? route.params.id : ""),
  (id) => {
    const task = allTasks.value.find((item) => item.id === id);
    if (!task?.customWorkspace || !task.workspacePath) return;
    const key = folderKey(task.workspacePath);
    if (!folderCollapsed.value[key]) return;
    const next = { ...folderCollapsed.value };
    delete next[key];
    folderCollapsed.value = next;
  }
);
watch(loggedIn, (v) => (v ? startPolling() : stopPolling()), { immediate: true });

// 全局兜底：文件拖到窗口非上传区时阻止默认行为，
// 否则 Electron 会导航到 file:// 覆盖整个应用（各输入框的 drop 在冒泡前已自行处理）
function preventWindowDrop(e: DragEvent): void {
  e.preventDefault();
}
window.addEventListener("dragover", preventWindowDrop);
window.addEventListener("drop", preventWindowDrop);
onBeforeUnmount(() => {
  window.removeEventListener("dragover", preventWindowDrop);
  window.removeEventListener("drop", preventWindowDrop);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.removeEventListener("click", closeProjectMenu);
});

function toggleFolder(key: string): void {
  folderCollapsed.value = { ...folderCollapsed.value, [key]: !folderCollapsed.value[key] };
}

/** 在已有项目文件夹里继续开新任务：跳转首页并预填该工作目录（及最近一次使用的专家） */
function newTaskInFolder(group: ProjectGroup): void {
  closeProjectMenu();
  if (folderCollapsed.value[group.key]) {
    const next = { ...folderCollapsed.value };
    delete next[group.key];
    folderCollapsed.value = next;
  }
  const latest = group.tasks[0];
  void router.push({
    path: "/",
    query: {
      workspaceDir: group.path,
      ...(latest?.agentId ? { agent: latest.agentId } : {}),
    },
  });
}

function viewProjectFiles(group: ProjectGroup): void {
  closeProjectMenu();
  const taskId = group.tasks[0]?.id;
  if (!taskId) {
    toast("error", "该项目下没有任务，无法浏览文件");
    return;
  }
  void router.push(`/projects/${taskId}/files`);
}

async function openProjectFolder(group: ProjectGroup): Promise<void> {
  closeProjectMenu();
  if (window.agentOffice?.openPath) {
    const res = await window.agentOffice.openPath(group.path);
    if (!res.ok) toast("error", res.message || "打开失败");
    return;
  }
  try {
    await navigator.clipboard.writeText(group.path);
    toast("info", "当前环境无法直接打开文件夹，路径已复制");
  } catch {
    toast("info", `项目路径：${group.path}`);
  }
}

async function copyProjectPath(group: ProjectGroup): Promise<void> {
  closeProjectMenu();
  try {
    await navigator.clipboard.writeText(group.path);
    toast("success", "路径已复制");
  } catch {
    toast("error", group.path);
  }
}

/** 移除项目：取消侧栏归组，不删磁盘与任务 */
async function removeProject(group: ProjectGroup): Promise<void> {
  closeProjectMenu();
  const ok = await confirmDialog({
    title: `移除项目「${group.name}」？`,
    message: "仅从侧栏项目列表移除，不会删除文件夹里的文件，也不会删除其中的任务（任务会回到「最近任务」）。",
    confirmText: "移除项目",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await detachProject(group.path);
    toast("success", `已移除项目（${res.detached} 个任务）`);
    await refreshRecent();
  } catch (err) {
    toastError(err, "移除项目失败");
  }
}

async function logout(): Promise<void> {
  const ok = await confirmDialog({
    title: "退出登录？",
    message: "正在执行的任务不会受影响，重新登录后可继续查看。",
    confirmText: "退出",
  });
  if (!ok) return;
  setToken("");
  setUsername("");
  void router.push("/login");
}

// ---------- WPS 365 账号（同步按钮跑服务端 user-current 脚本） ----------
const wpsOpen = ref(false);
const wpsBusy = ref(false);
const wpsError = ref("");
const wpsConfigured = ref(true);
const wpsProfile = ref<WpsProfile | null>(null);
const roleLabel = computed(() => (isAdmin.value ? "管理员" : "成员"));
const accountDisplayName = computed(() => wpsProfile.value?.name || username.value);

async function refreshWpsProfile(): Promise<void> {
  const res = await getWpsMe();
  wpsConfigured.value = res.configured;
  wpsProfile.value = res.profile;
}

watch(
  loggedIn,
  (value) => {
    if (!value) {
      wpsProfile.value = null;
      return;
    }
    // 登录后加载当前平台账号自己的 WPS 缓存，用于侧栏身份展示。
    void refreshWpsProfile().catch(() => {
      wpsProfile.value = null;
    });
  },
  { immediate: true }
);

async function openWps(): Promise<void> {
  wpsError.value = "";
  wpsOpen.value = true;
  try {
    await refreshWpsProfile();
  } catch {
    wpsError.value = "无法获取账号状态，请稍后重试";
  }
}

async function submitWpsSync(): Promise<void> {
  wpsBusy.value = true;
  wpsError.value = "";
  try {
    const res = await syncWpsAccount();
    wpsConfigured.value = res.configured;
    wpsProfile.value = res.profile;
    toast("success", `已同步 WPS 365 账号：${res.profile.name}`);
  } catch (err) {
    wpsError.value = err instanceof Error ? err.message : "同步失败，请稍后重试";
  } finally {
    wpsBusy.value = false;
  }
}
</script>

<template>
  <div class="shell">
    <aside v-if="loggedIn" class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="brand-row">
        <RouterLink to="/" class="brand" :title="sidebarCollapsed ? 'Agent Office' : undefined">
          <span class="logo">A</span>
          <span v-if="!sidebarCollapsed" class="brand-text">
            <span class="name">Agent Office</span>
            <span class="ver">AI 数字员工办公室</span>
          </span>
        </RouterLink>
        <button
          type="button"
          class="icon-btn collapse-btn"
          :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="toggleSidebar"
        >
          <svg class="icon" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
      </div>

      <nav class="nav">
        <RouterLink to="/" class="nav-item" exact-active-class="active" :title="sidebarCollapsed ? '新建任务' : undefined">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          <span v-if="!sidebarCollapsed">新建任务</span>
        </RouterLink>
        <RouterLink to="/tasks" class="nav-item" active-class="active" :title="sidebarCollapsed ? '任务列表' : undefined">
          <svg class="icon" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
          <span v-if="!sidebarCollapsed">任务列表</span>
          <span v-if="awaitingCount && !sidebarCollapsed" class="nav-badge warn" title="待确认任务">{{ awaitingCount }}</span>
          <span v-else-if="runningCount && !sidebarCollapsed" class="nav-badge" title="进行中的任务">{{ runningCount }}</span>
        </RouterLink>
        <RouterLink to="/experts" class="nav-item" active-class="active" :title="sidebarCollapsed ? '专家·技能·连接器' : undefined">
          <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="8.5" cy="11" r="1.5" /><circle cx="15.5" cy="11" r="1.5" /><path d="M8 15.5h8" /></svg>
          <span v-if="!sidebarCollapsed">专家·技能·连接器</span>
        </RouterLink>
        <RouterLink to="/kb" class="nav-item" active-class="active" :title="sidebarCollapsed ? '企业知识库' : undefined">
          <svg class="icon" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
          <span v-if="!sidebarCollapsed">企业知识库</span>
        </RouterLink>
        <RouterLink to="/models" class="nav-item" active-class="active" :title="sidebarCollapsed ? '模型供应商' : undefined">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /></svg>
          <span v-if="!sidebarCollapsed">模型供应商</span>
        </RouterLink>
        <RouterLink v-if="isAdmin" to="/admin" class="nav-item" active-class="active" :title="sidebarCollapsed ? '管理后台' : undefined">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          <span v-if="!sidebarCollapsed">管理后台</span>
        </RouterLink>
      </nav>

      <div v-if="!sidebarCollapsed" class="side-scroll">
      <div v-if="folderGroups.length" class="section projects-section">
        <div class="section-head">
          <span>项目</span>
        </div>
        <div v-for="group in folderGroups" :key="group.key" class="project">
          <div class="project-row-wrap">
            <button
              type="button"
              class="project-row"
              :title="group.path"
              :aria-expanded="!folderCollapsed[group.key]"
              @click="toggleFolder(group.key)"
            >
              <svg class="icon folder-ic" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
              <span class="project-name">{{ group.name }}</span>
            </button>
            <div class="project-actions" @click.stop>
              <button
                type="button"
                class="project-new"
                title="在此项目新建任务"
                @click="newTaskInFolder(group)"
              >
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <button
                type="button"
                class="project-more"
                title="项目操作"
                :aria-expanded="projectMenuKey === group.key"
                @click="toggleProjectMenu(group.key, $event)"
              >
                <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></svg>
              </button>
              <div v-if="projectMenuKey === group.key" class="project-menu">
                <button type="button" @click="viewProjectFiles(group)">查看文件夹内容</button>
                <button type="button" @click="openProjectFolder(group)">在资源管理器中打开</button>
                <button type="button" @click="copyProjectPath(group)">复制路径</button>
                <button type="button" class="danger" @click="removeProject(group)">移除项目</button>
              </div>
            </div>
          </div>
          <div v-if="!folderCollapsed[group.key]" class="project-tasks">
            <RouterLink
              v-for="t in group.tasks"
              :key="t.id"
              :to="`/tasks/${t.id}`"
              class="project-chat"
              active-class="current"
              :title="t.title || '（无标题）'"
            >
              {{ t.title || "（无标题）" }}
            </RouterLink>
          </div>
        </div>
      </div>

      <div v-if="recentTasks.length" class="section">
        <div class="section-head">
          <span>最近任务</span>
          <span class="count">{{ recentTasks.length }}</span>
        </div>
        <RouterLink
          v-for="t in recentTasks"
          :key="t.id"
          :to="`/tasks/${t.id}`"
          class="task-item"
          active-class="current"
        >
          <span class="dot" :class="t.status" />
          <span class="task-title">{{ t.title || "（无标题）" }}</span>
          <span class="task-time">{{ timeAgo(t.createdAt) }}</span>
        </RouterLink>
        <RouterLink to="/tasks" class="see-all">查看全部 →</RouterLink>
      </div>
      </div>
      <div v-else class="spacer" />

      <div class="user" :class="{ compact: sidebarCollapsed }">
        <button
          type="button"
          class="user-identity"
          :title="sidebarCollapsed ? `${accountDisplayName}（${roleLabel}）` : '账号与 WPS 用户信息'"
          @click="openWps"
        >
          <span class="avatar">{{ accountDisplayName.slice(0, 1).toUpperCase() }}</span>
          <span v-if="!sidebarCollapsed" class="user-meta">
            <span class="user-name">{{ accountDisplayName }}</span>
            <span class="user-role" :class="isAdmin ? 'admin' : 'member'">
              {{ wpsProfile ? `${username} · ${roleLabel}` : roleLabel }}
            </span>
          </span>
        </button>
        <button
          class="icon-btn"
          :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
          :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'"
          @click="toggleTheme"
        >
          <svg v-if="theme === 'dark'" class="icon" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
          </svg>
          <svg v-else class="icon" viewBox="0 0 24 24">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
          </svg>
        </button>
        <button
          class="icon-btn"
          title="账号与 WPS 用户信息"
          aria-label="账号与 WPS 用户信息"
          @click="openWps"
        >
          <svg class="icon" viewBox="0 0 24 24"><path d="M17.5 19a4.5 4.5 0 1 0-.88-8.92 6 6 0 0 0-11.4 1.98A3.5 3.5 0 0 0 6 19z" /></svg>
        </button>
        <button class="icon-btn danger-hover" title="退出登录" aria-label="退出登录" @click="logout">
          <svg class="icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
        </button>
      </div>
    </aside>

    <main class="content">
      <RouterView />
    </main>

    <Toasts />
    <ConfirmHost />

    <!-- 平台账号与当前用户自己的 WPS 365 信息 -->
    <div v-if="wpsOpen" class="overlay" @click.self="wpsOpen = false">
      <div class="dialog wps-dialog" role="dialog" aria-label="账号与 WPS 用户信息">
        <div class="dialog-head">
          <h3>账号与 WPS 用户信息</h3>
          <button type="button" class="icon-btn" title="关闭" @click="wpsOpen = false">
            <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="dialog-body">
          <div class="platform-account">
            <span>平台账号</span>
            <strong>{{ username }}</strong>
            <em>{{ roleLabel }}</em>
          </div>
          <p class="wps-section-label">WPS 365 用户信息</p>
          <p v-if="!wpsConfigured" class="pwd-err">
            未检测到 WPS 登录态：请先在本机登录紫金协作客户端，或检查服务端 ~/.wps365/env.json 是否已写入 WPS_SID。
          </p>
          <template v-if="wpsProfile">
            <div class="wps-profile">
              <span class="wps-avatar">{{ wpsProfile.name.slice(0, 1) }}</span>
              <div class="wps-meta">
                <strong>{{ wpsProfile.name }}</strong>
                <span>{{ wpsProfile.deptPath || wpsProfile.deptName || "—" }}</span>
                <span v-if="wpsProfile.phone || wpsProfile.email">
                  {{ [wpsProfile.phone, wpsProfile.email].filter(Boolean).join(" · ") }}
                </span>
              </div>
            </div>
            <p class="wps-synced-at">上次同步：{{ new Date(wpsProfile.syncedAt).toLocaleString() }}</p>
          </template>
          <p v-else-if="wpsConfigured" class="wps-hint">尚未同步。点击下方按钮获取当前登录的 WPS 365 账号。</p>
          <p v-if="wpsError" class="pwd-err">{{ wpsError }}</p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="ghost" @click="wpsOpen = false">关闭</button>
          <button type="button" class="primary" :disabled="wpsBusy || !wpsConfigured" @click="submitWpsSync">
            {{ wpsBusy ? "同步中…" : wpsProfile ? "重新同步 WPS 信息" : "同步 WPS 用户信息" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
}
.sidebar {
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  padding: 14px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
  transition: width 0.18s ease, padding 0.18s ease;
}
.sidebar.collapsed {
  width: 60px;
  padding: 14px 8px;
}
.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 16px 8px;
}
.sidebar.collapsed .brand-row {
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 12px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  min-width: 0;
}
.collapse-btn {
  flex-shrink: 0;
}
.sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 9px 0;
}
.sidebar.collapsed .user.compact {
  flex-direction: column;
  gap: 6px;
  padding: 8px 2px 2px;
}
.nav-badge.warn {
  background: var(--warn);
  color: #fff;
}
.logo {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: linear-gradient(135deg, #177e5b, #2f9d75);
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  display: grid;
  place-items: center;
  box-shadow: 0 2px 8px rgba(23, 126, 91, 0.35);
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.name {
  font-weight: 700;
  font-size: 14.5px;
  color: var(--text);
}
.ver {
  font-size: 10.5px;
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  color: var(--text-2);
  text-decoration: none;
  font-weight: 500;
  transition: background 0.12s, color 0.12s;
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
}
.nav-item.active {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.nav-item.active .icon {
  color: var(--accent);
}
.nav-badge {
  margin-left: auto;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  padding: 1px 7px;
  line-height: 1.5;
}
.side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.side-scroll .section {
  overflow: visible;
}
.section {
  margin-top: 22px;
  padding: 0 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  overflow-y: auto;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}
.count {
  background: var(--surface-2);
  color: var(--text-3);
  border-radius: 999px;
  font-size: 11px;
  padding: 0 7px;
  font-weight: 600;
}
/* Codex 式项目树：文件夹 + 缩进会话标题，悬停出新建 */
.projects-section {
  gap: 2px;
}
.project {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 4px;
}
.project-row-wrap {
  display: flex;
  align-items: center;
  gap: 0;
  border-radius: 7px;
  min-height: 30px;
}
.project-row-wrap:hover {
  background: var(--surface-2);
}
.project-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  box-shadow: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.project-row:hover {
  background: transparent;
  border-color: transparent;
}
.project-row:active {
  transform: none;
}
.project-row .folder-ic {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-3);
}
.project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-actions {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-right: 2px;
  opacity: 0;
}
.project-row-wrap:hover .project-actions,
.project-actions:focus-within,
.project-row-wrap:has(.project-menu) .project-actions {
  opacity: 1;
}
.project-new,
.project-more {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
}
.project-new:hover,
.project-more:hover {
  color: var(--text);
  background: var(--surface);
}
.project-new .icon {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
.project-more .icon {
  width: 14px;
  height: 14px;
}
.project-more .icon circle {
  fill: currentColor;
  stroke: none;
}
.project-menu {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 40;
  min-width: 168px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow-2);
}
.project-menu button {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  box-shadow: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.project-menu button:hover {
  background: var(--surface-2);
}
.project-menu button.danger {
  color: var(--danger);
}
.project-tasks {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 1px 0 4px;
}
.project-chat {
  display: block;
  margin-left: 8px;
  padding: 5px 10px 5px 22px;
  border-radius: 7px;
  text-decoration: none;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-chat:hover {
  background: var(--surface-2);
  color: var(--text);
}
.project-chat.current {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--text-2);
  font-size: 13px;
}
.task-item:hover {
  background: var(--surface-2);
  color: var(--text);
}
.task-item.current {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.task-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
}
.see-all {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-3);
  text-decoration: none;
  border-radius: 8px;
}
.see-all:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
.spacer {
  flex: 1;
}
.user {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 10px 4px 2px;
  border-top: 1px solid var(--border);
}
.user-identity {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  text-align: left;
}
.user-identity:hover {
  background: transparent;
}
.sidebar.collapsed .user-identity {
  flex: none;
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: linear-gradient(135deg, #177e5b, #2f9d75);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.user-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  margin-right: auto;
}
.user-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-role {
  font-size: 10.5px;
  color: var(--text-3);
}
.user-role.admin {
  color: var(--accent);
}
.icon-btn {
  border: none;
  background: none;
  color: var(--text-3);
  padding: 6px;
  border-radius: 8px;
  box-shadow: none;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.icon-btn:hover {
  color: var(--text);
  background: var(--surface-2);
  border-color: transparent;
}
.icon-btn.danger-hover:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.content {
  flex: 1;
  min-width: 0;
  height: 100vh;
  overflow-y: auto;
  background: var(--bg);
}

/* ---------- 修改密码弹窗 ---------- */
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(2px);
  display: grid;
  place-items: center;
  z-index: 60;
}
.dialog {
  width: min(400px, calc(100vw - 48px));
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  animation: rise 0.18s ease-out;
}
.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 0;
}
.dialog-head h3 {
  margin: 0;
  font-size: 16px;
}
.dialog-body {
  padding: 14px 22px 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dialog-body label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dialog-body label span {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.pwd-err {
  margin: 0;
  color: var(--danger);
  font-size: 12.5px;
}
.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 22px 20px;
}
.ghost {
  background: transparent;
}
/* ---------- WPS 365 账号弹窗 ---------- */
.wps-dialog {
  width: 420px;
}
.platform-account {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 12.5px;
}
.platform-account span {
  color: var(--text-3);
}
.platform-account strong {
  flex: 1;
  color: var(--text);
}
.platform-account em {
  color: var(--accent);
  font-size: 11.5px;
  font-style: normal;
}
.wps-section-label {
  margin: 2px 0 -4px;
  color: var(--text-3);
  font-size: 12px;
  font-weight: 600;
}
.wps-profile {
  display: flex;
  align-items: center;
  gap: 12px;
}
.wps-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent-weak, rgba(59, 130, 246, 0.15));
  color: var(--accent, #3b82f6);
  font-weight: 700;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.wps-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: var(--text-2);
  min-width: 0;
}
.wps-meta strong {
  font-size: 15px;
  color: var(--text-1);
}
.wps-synced-at,
.wps-hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3, var(--text-2));
}
</style>
