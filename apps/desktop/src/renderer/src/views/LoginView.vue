<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { fetchCaptcha, login, setToken, setUsername } from "../api";

const router = useRouter();
const username = ref("");
const password = ref("");
const showPassword = ref(false);
const remember = ref(true);
const code = ref("");
const captchaUuid = ref("");
const captchaImg = ref("");
const error = ref("");
const busy = ref(false);

/** 本机记住账密（仅存此电脑 localStorage，方便下次登录） */
const REMEMBER_KEY = "ao.rememberLogin";
const USER_KEY = "ao.savedUsername";
const PASS_KEY = "ao.savedPassword";

function loadSavedLogin(): void {
  try {
    const on = localStorage.getItem(REMEMBER_KEY) === "1";
    remember.value = on;
    if (!on) return;
    username.value = localStorage.getItem(USER_KEY) ?? "";
    const enc = localStorage.getItem(PASS_KEY) ?? "";
    password.value = enc ? decodeURIComponent(atob(enc)) : "";
  } catch {
    // ignore bad storage
  }
}

function persistLogin(name: string, pwd: string): void {
  try {
    if (remember.value) {
      localStorage.setItem(REMEMBER_KEY, "1");
      localStorage.setItem(USER_KEY, name);
      localStorage.setItem(PASS_KEY, btoa(encodeURIComponent(pwd)));
    } else {
      localStorage.removeItem(REMEMBER_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(PASS_KEY);
    }
  } catch {
    // ignore quota / private mode
  }
}

async function refreshCaptcha(): Promise<void> {
  try {
    const captcha = await fetchCaptcha();
    captchaUuid.value = captcha.uuid;
    captchaImg.value = captcha.img ? `data:image/gif;base64,${captcha.img}` : "";
    code.value = "";
  } catch (err) {
    error.value = authErrorMessage(err);
  }
}

onMounted(() => {
  loadSavedLogin();
  void refreshCaptcha();
});

async function submit(): Promise<void> {
  const name = username.value.trim();
  if (!name || !password.value) {
    error.value = "请输入用户名和密码";
    return;
  }
  if (!code.value.trim()) {
    error.value = "请输入验证码";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res = await login(name, password.value, code.value.trim(), captchaUuid.value);
    persistLogin(name, password.value);
    setToken(res.token);
    setUsername(res.user.username);
    void router.push("/");
  } catch (err) {
    error.value = authErrorMessage(err);
    void refreshCaptcha();
  } finally {
    busy.value = false;
  }
}

function authErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (/failed to fetch|networkerror|load failed/i.test(err.message)) {
      return "无法连接服务器，请确认服务已启动";
    }
    if (err.message) return err.message;
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
        <h2>欢迎回来</h2>
        <p class="sub">使用企业知识库账号登录</p>
        <label>
          <span>用户名</span>
          <input v-model="username" placeholder="知识库登录账号" autocomplete="username" />
        </label>
        <div class="field">
          <div class="field-head">
            <span>密码</span>
          </div>
          <div class="pwd-box">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              placeholder="知识库密码"
              autocomplete="current-password"
            />
            <button
              type="button"
              class="pwd-eye"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              :aria-pressed="showPassword"
              @click="showPassword = !showPassword"
            >
              <svg v-if="showPassword" class="icon" viewBox="0 0 24 24">
                <path d="M3 3l18 18" />
                <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                <path d="M9.9 5.1A10.8 10.8 0 0 1 12 5c5.5 0 9.5 4.2 10.5 7-1 2.7-3.2 5-6.1 6.3" />
                <path d="M6.1 6.1C3.9 7.6 2.3 9.7 1.5 12c1 2.8 5 7 10.5 7 1.3 0 2.5-.2 3.6-.7" />
              </svg>
              <svg v-else class="icon" viewBox="0 0 24 24">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </div>
        <label>
          <span>验证码</span>
          <span class="captcha-row">
            <input v-model="code" placeholder="计算结果" autocomplete="off" />
            <button type="button" class="captcha" title="换一张" @click="refreshCaptcha">
              <img v-if="captchaImg" :src="captchaImg" alt="验证码" />
              <span v-else>获取验证码</span>
            </button>
          </span>
        </label>
        <label class="remember">
          <input v-model="remember" type="checkbox" />
          <span>记住账号密码（仅保存在本机）</span>
        </label>
        <button class="primary" type="submit" :disabled="busy">登 录</button>
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
label,
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
label span,
.field-head span {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pwd-box {
  position: relative;
}
.pwd-box input {
  padding-right: 40px;
}
.pwd-eye {
  position: absolute;
  right: 4px;
  top: 0;
  bottom: 0;
  margin: auto 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  display: grid;
  place-items: center;
}
.pwd-eye:hover {
  color: var(--text);
  background: transparent;
  border-color: transparent;
}
.pwd-eye:active {
  transform: none;
}
.pwd-eye .icon {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.forgot {
  border: none;
  background: none;
  color: var(--accent);
  padding: 0;
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: none;
}
.forgot:hover {
  color: var(--accent-strong);
}
.captcha-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.captcha-row input {
  flex: 1;
}
.captcha {
  width: 112px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--line, #d9e2dc);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  overflow: hidden;
}
.captcha img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.remember {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.remember input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
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
