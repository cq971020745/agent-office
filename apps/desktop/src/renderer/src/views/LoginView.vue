<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { login, register, setToken, setUsername } from "../api";

const router = useRouter();
const mode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    error.value = "请输入用户名和密码";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res =
      mode.value === "login"
        ? await login(username.value.trim(), password.value)
        : await register(username.value.trim(), password.value);
    setToken(res.token);
    setUsername(username.value.trim());
    void router.push("/");
  } catch (err) {
    error.value = authErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

// 服务端返回的是英文错误码，映射成中文提示
function authErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === "username taken") return "该用户名已被注册，请直接登录";
    if (err.message === "invalid credentials") return "用户名或密码错误";
    if (/failed to fetch|networkerror|load failed/i.test(err.message)) {
      return "无法连接服务器，请确认服务已启动";
    }
  }
  return "请求失败，请稍后重试";
}

const FEATURES = [
  { title: "自主执行", desc: "Agent 在独立工作区里自主读写文件、完成任务" },
  { title: "过程透明", desc: "每一步思考与工具调用实时可见，随时可干预" },
  { title: "成果沉淀", desc: "报告、网页、代码等成果物自动归档，随时取用" },
];
</script>

<template>
  <div class="wrap">
    <aside class="brand-panel">
      <div class="brand-top">
        <span class="logo">A</span>
        <span class="brand-name">Agent Office</span>
      </div>
      <div class="brand-main">
        <h1>把重复的工作<br />交给 Agent</h1>
        <p class="tagline">你的 AI 数字员工办公室 —— 派发任务，Agent 自主完成，成果直接交付。</p>
        <ul class="features">
          <li v-for="f in FEATURES" :key="f.title">
            <span class="check">
              <svg class="icon" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
            </span>
            <span>
              <strong>{{ f.title }}</strong>
              <em>{{ f.desc }}</em>
            </span>
          </li>
        </ul>
      </div>
      <p class="copyright">Agent Office · 团队级 Agent 工作台</p>
    </aside>

    <main class="form-panel">
      <form class="box" @submit.prevent="submit">
        <h2>{{ mode === "register" ? "创建管理员账号" : "欢迎回来" }}</h2>
        <p class="sub">{{ mode === "register" ? "首次注册的用户将成为管理员" : "登录以继续使用" }}</p>
        <label>
          <span>用户名</span>
          <input v-model="username" placeholder="用户名" autocomplete="username" />
        </label>
        <label>
          <span>密码</span>
          <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
        </label>
        <button class="primary" type="submit" :disabled="busy">
          {{ mode === "login" ? "登 录" : "注册并登录" }}
        </button>
        <button type="button" class="link" @click="mode = mode === 'login' ? 'register' : 'login'">
          {{ mode === "login" ? "首次使用？注册管理员账号" : "已有账号？去登录" }}
        </button>
        <p v-if="error" class="error">{{ error }}</p>
      </form>
    </main>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  min-height: 100vh;
}
.brand-panel {
  flex: 1.15;
  background:
    radial-gradient(640px 420px at 80% -10%, rgba(255, 255, 255, 0.12), transparent),
    radial-gradient(520px 380px at -10% 110%, rgba(59, 161, 132, 0.28), transparent),
    linear-gradient(160deg, #0e3d2e, #071f18 70%);
  color: #fff;
  padding: 36px 48px;
  display: flex;
  flex-direction: column;
}
.brand-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: linear-gradient(135deg, #177e5b, #2f9d75);
  color: #fff;
  font-weight: 800;
  font-size: 17px;
  display: grid;
  place-items: center;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
}
.brand-name {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.01em;
}
.brand-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-width: 440px;
}
.brand-main h1 {
  margin: 0 0 14px;
  font-size: 34px;
  line-height: 1.28;
  letter-spacing: -0.01em;
  color: #fff;
}
.tagline {
  margin: 0 0 30px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 14px;
  line-height: 1.7;
}
.features {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.features li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.check {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(47, 157, 117, 0.3);
  border: 1px solid rgba(47, 157, 117, 0.55);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  margin-top: 1px;
}
.check .icon {
  width: 12px;
  height: 12px;
  color: #6fd3ab;
  stroke-width: 2.4;
}
.features strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
}
.features em {
  font-style: normal;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.55);
}
.copyright {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
}
.form-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  padding: 24px;
}
.box {
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 36px 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
}
.box h2 {
  margin: 0;
  font-size: 20px;
  text-align: center;
}
.sub {
  margin: -6px 0 6px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
label span {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.error {
  margin: 0;
  text-align: center;
}
.link {
  align-self: center;
  font-size: 13px;
}
@media (max-width: 860px) {
  .brand-panel {
    display: none;
  }
}
</style>
