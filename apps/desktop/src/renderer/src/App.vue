<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Task, WpsProfile } from "@office/shared";
import { getRole, getToken, getUsername, listTasks, setToken, changePassword, getWpsMe, syncWpsAccount } from "./api";
import { timeAgo } from "./utils/format";
import Toasts from "./components/Toasts.vue";
import ConfirmHost from "./components/ConfirmHost.vue";
import { confirmDialog } from "./composables/confirm";
import { toast } from "./composables/toast";

const route = useRoute();
const router = useRouter();
const loggedIn = computed(() => route.path !== "/login" && !!getToken());
const isAdmin = computed(() => getRole() === "admin");
const username = computed(() => getUsername() || "用户");

const theme = ref<"light" | "dark">(
  document.documentElement.dataset.theme === "dark" ? "dark" : "light"
);
function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem("agent-office-theme", theme.value);
}

const allTasks = ref<Task[]>([]);
const recentTasks = computed(() => allTasks.value.slice(0, 8));
const runningCount = computed(
  () => allTasks.value.filter((t) => t.status === "running" || t.status === "pending").length
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
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshRecent();
  }, 5000);
}
function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

onMounted(refreshRecent);
watch(() => route.path, refreshRecent);
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
});

async function logout(): Promise<void> {
  const ok = await confirmDialog({
    title: "退出登录？",
    message: "正在执行的任务不会受影响，重新登录后可继续查看。",
    confirmText: "退出",
  });
  if (!ok) return;
  setToken("");
  void router.push("/login");
}

// ---------- 修改密码 ----------
const pwdOpen = ref(false);
const pwdNew = ref("");
const pwdNew2 = ref("");
const pwdError = ref("");
const pwdBusy = ref(false);

function openPwd(): void {
  pwdNew.value = "";
  pwdNew2.value = "";
  pwdError.value = "";
  pwdOpen.value = true;
}

async function submitPwd(): Promise<void> {
  if (!pwdNew.value || !pwdNew2.value) {
    pwdError.value = "请填写完整";
    return;
  }
  if (pwdNew.value.length < 6) {
    pwdError.value = "新密码至少 6 位";
    return;
  }
  if (pwdNew.value !== pwdNew2.value) {
    pwdError.value = "两次输入的新密码不一致";
    return;
  }
  pwdBusy.value = true;
  pwdError.value = "";
  try {
    await changePassword(pwdNew.value);
    pwdOpen.value = false;
    toast("success", "密码已修改，下次登录请使用新密码");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("too short")) pwdError.value = "新密码至少 6 位";
    else if (/failed to fetch|networkerror|load failed/i.test(msg)) pwdError.value = "无法连接服务器";
    else pwdError.value = "修改失败，请稍后重试";
  } finally {
    pwdBusy.value = false;
  }
}

// ---------- WPS 365 账号（同步按钮跑服务端 user-current 脚本） ----------
const wpsOpen = ref(false);
const wpsBusy = ref(false);
const wpsError = ref("");
const wpsConfigured = ref(true);
const wpsProfile = ref<WpsProfile | null>(null);

async function openWps(): Promise<void> {
  wpsError.value = "";
  wpsOpen.value = true;
  try {
    const res = await getWpsMe();
    wpsConfigured.value = res.configured;
    wpsProfile.value = res.profile;
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
    <aside v-if="loggedIn" class="sidebar">
      <RouterLink to="/" class="brand">
        <span class="logo">A</span>
        <span class="brand-text">
          <span class="name">Agent Office</span>
          <span class="ver">AI 数字员工办公室</span>
        </span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/" class="nav-item" exact-active-class="active">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          新建任务
        </RouterLink>
        <RouterLink to="/tasks" class="nav-item" active-class="active">
          <svg class="icon" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
          任务列表
          <span v-if="runningCount" class="nav-badge" title="进行中的任务">{{ runningCount }}</span>
        </RouterLink>
        <RouterLink to="/experts" class="nav-item" active-class="active">
          <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="8.5" cy="11" r="1.5" /><circle cx="15.5" cy="11" r="1.5" /><path d="M8 15.5h8" /></svg>
          专家·技能·连接器
        </RouterLink>
        <RouterLink v-if="isAdmin" to="/admin" class="nav-item" active-class="active">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          管理后台
        </RouterLink>
      </nav>

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

      <div class="spacer" />

      <div class="user">
        <span class="avatar">{{ username.slice(0, 1).toUpperCase() }}</span>
        <span class="user-meta">
          <span class="user-name">{{ username }}</span>
          <span class="user-role" :class="isAdmin ? 'admin' : 'member'">{{ isAdmin ? "管理员" : "成员" }}</span>
        </span>
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
          title="WPS 365 账号"
          aria-label="WPS 365 账号"
          @click="openWps"
        >
          <svg class="icon" viewBox="0 0 24 24"><path d="M17.5 19a4.5 4.5 0 1 0-.88-8.92 6 6 0 0 0-11.4 1.98A3.5 3.5 0 0 0 6 19z" /></svg>
        </button>
        <button
          class="icon-btn"
          title="修改密码"
          aria-label="修改密码"
          @click="openPwd"
        >
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
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

    <!-- 修改密码弹窗 -->
    <div v-if="pwdOpen" class="overlay" @click.self="pwdOpen = false">
      <form class="dialog" @submit.prevent="submitPwd">
        <div class="dialog-head">
          <h3>修改密码</h3>
          <button type="button" class="icon-btn" title="关闭" @click="pwdOpen = false">
            <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="dialog-body">
          <label>
            <span>新密码</span>
            <input v-model="pwdNew" type="password" autocomplete="new-password" placeholder="至少 6 位" />
          </label>
          <label>
            <span>确认新密码</span>
            <input v-model="pwdNew2" type="password" autocomplete="new-password" placeholder="再输入一次" />
          </label>
          <p v-if="pwdError" class="pwd-err">{{ pwdError }}</p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="ghost" @click="pwdOpen = false">取消</button>
          <button type="submit" class="primary" :disabled="pwdBusy">{{ pwdBusy ? "提交中…" : "确认修改" }}</button>
        </div>
      </form>
    </div>
    <!-- WPS 365 账号弹窗 -->
    <div v-if="wpsOpen" class="overlay" @click.self="wpsOpen = false">
      <div class="dialog wps-dialog" role="dialog" aria-label="WPS 365 账号">
        <div class="dialog-head">
          <h3>WPS 365 账号</h3>
          <button type="button" class="icon-btn" title="关闭" @click="wpsOpen = false">
            <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="dialog-body">
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
            {{ wpsBusy ? "同步中…" : "同步账号" }}
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
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  padding: 4px 8px 16px;
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
