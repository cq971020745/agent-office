<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { fetchCaptcha, login, setToken, setUsername } from "../api";

const router = useRouter();
const username = ref("");
const password = ref("");
const code = ref("");
const captchaUuid = ref("");
const captchaImg = ref("");
const error = ref("");
const busy = ref(false);

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
          <input v-model="password" type="password" placeholder="知识库密码" autocomplete="current-password" />
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
