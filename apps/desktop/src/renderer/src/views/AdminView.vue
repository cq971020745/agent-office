<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { isAsrModel } from "@office/shared";
import type { AdminProvider, AdminUser, VoiceStatus } from "../api";
import {
  addProviderModel,
  createAdminProvider,
  deleteAdminProvider,
  disableProviderModel,
  enableProviderModel,
  fetchProviderModels,
  getVoiceStatus,
  listAdminProviders,
  listAdminUsers,
  removeProviderModel,
  resetUserPassword,
  setProviderEnabled,
  updateAdminProvider,
  warmupLocalVoice,
} from "../api";
import type { ProviderModelsState } from "../api";
import { confirmDialog } from "../composables/confirm";
import { toast, toastError } from "../composables/toast";
import { timeAgo } from "../utils/format";

type Tab = "providers" | "users";
const route = useRoute();
const tab = ref<Tab>(route.path === "/admin" ? "users" : "providers");
const visibleTabs = computed(() =>
  TABS.filter((item) => (route.path === "/admin" ? item.key === "users" : item.key === "providers"))
);
watch(
  () => route.path,
  (path) => {
    tab.value = path === "/admin" ? "users" : "providers";
  }
);

const TABS: { key: Tab; label: string }[] = [
  { key: "providers", label: "模型供应商" },
  { key: "users", label: "用户账号" },
];

const providers = ref<AdminProvider[]>([]);
const users = ref<AdminUser[]>([]);
const error = ref("");
const voiceStatus = ref<VoiceStatus | null>(null);
const checkingVoice = ref(false);
const warmingUpLocal = ref(false);

const counts = computed<Record<Tab, number>>(() => ({
  providers: providers.value.length,
  users: users.value.length,
}));

async function refresh(): Promise<void> {
  const modelsPage = route.path !== "/admin";
  try {
    const [nextProviders, nextUsers, nextVoice] = await Promise.all([
      listAdminProviders(),
      modelsPage ? Promise.resolve([] as AdminUser[]) : listAdminUsers(),
      getVoiceStatus().catch(() => null),
    ]);
    providers.value = nextProviders;
    if (!modelsPage) users.value = nextUsers;
    voiceStatus.value = nextVoice;
    error.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  }
}

async function checkVoiceNow(): Promise<void> {
  checkingVoice.value = true;
  try {
    const st = await getVoiceStatus();
    voiceStatus.value = st;
    if (st.hasExplicit && st.candidates[0]) {
      const top = st.candidates[0]!;
      toast("success", `已显式配置远端 ASR：${top.providerName} / ${top.model}（开源本地引擎随时兜底）`);
    } else if (st.localFallback?.cached) {
      toast("success", `当前未显式绑定远端 ASR，已启用开源本地模型（${st.localFallback.model}，本地权重已就绪）兜底`);
    } else {
      toast(
        "info",
        `当前未显式绑定远端 ASR，将使用开源本地模型（${st.localFallback?.model ?? "Paraformer-zh-small"}）兜底；可点「预热本地引擎」提前加载权重`
      );
    }
  } catch (err) {
    toastError(err, "检测语音状态失败");
  } finally {
    checkingVoice.value = false;
  }
}

async function handleWarmupLocal(): Promise<void> {
  if (warmingUpLocal.value) return;
  warmingUpLocal.value = true;
  try {
    toast("info", "正在准备开源本地语音模型（Paraformer-zh-small ONNX 离线权重，请稍候）…");
    const res = await warmupLocalVoice();
    if (voiceStatus.value) {
      voiceStatus.value = { ...voiceStatus.value, localFallback: res.localFallback };
    } else {
      voiceStatus.value = await getVoiceStatus().catch(() => null);
    }
    toast("success", `开源本地语音模型（${res.localFallback.model}）已就绪，可随时离线转写`);
  } catch (err) {
    toastError(err, "预热本地开源语音模型失败");
  } finally {
    warmingUpLocal.value = false;
  }
}

// 供应商表单
const pName = ref("");
const pBaseUrl = ref("");
const pKey = ref("");

async function addProvider(): Promise<void> {
  if (!pName.value.trim() || !pBaseUrl.value.trim() || !pKey.value) return;
  try {
    await createAdminProvider(pName.value.trim(), pBaseUrl.value.trim(), pKey.value);
    toast("success", "供应商已添加，点击「获取模型列表」拉取可用模型");
    pName.value = pBaseUrl.value = pKey.value = "";
    await refresh();
  } catch (err) {
    toastError(err, "添加供应商失败");
  }
}

async function toggleProvider(p: AdminProvider): Promise<void> {
  try {
    await setProviderEnabled(p.id, !p.enabled);
    toast("success", p.enabled ? `已停用「${p.name}」` : `已启用「${p.name}」`);
    await refresh();
  } catch (err) {
    toastError(err, "操作失败");
  }
}

// 编辑供应商
const showEdit = ref(false);
const eId = ref("");
const eName = ref("");
const eBaseUrl = ref("");
const eKey = ref("");
const eAsrModel = ref("");
const ASR_PRESETS = ["FunAudioLLM/SenseVoiceSmall", "whisper-1", "glm-asr", "paraformer-v2"];
// 模型能力覆盖（P2-5）：JSON 文本，键为模型 ID；空 = 全部用平台默认（128k / 32768 / 无推理）
const eOverrides = ref("");
const OVERRIDES_EXAMPLE = `{
  "deepseek-reasoner": { "contextWindow": 128000, "maxTokens": 65536, "reasoning": true },
  "deepseek-chat": { "contextWindow": 65536 }
}`;

function openEdit(p: AdminProvider): void {
  eId.value = p.id;
  eName.value = p.name;
  eBaseUrl.value = p.baseUrl;
  eKey.value = "";
  eAsrModel.value = p.asrModel ?? "";
  const ov = p.modelOverrides ?? {};
  eOverrides.value = Object.keys(ov).length ? JSON.stringify(ov, null, 2) : "";
  showEdit.value = true;
}

async function saveEdit(): Promise<void> {
  if (!eName.value.trim() || !eBaseUrl.value.trim()) return;
  let modelOverrides: Record<string, unknown> = {};
  const raw = eOverrides.value.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        toast("error", "能力覆盖需是 JSON 对象，键为模型 ID");
        return;
      }
      modelOverrides = parsed;
    } catch {
      toast("error", "能力覆盖不是合法 JSON，请修正后保存");
      return;
    }
  }
  try {
    await updateAdminProvider(eId.value, {
      name: eName.value.trim(),
      baseUrl: eBaseUrl.value.trim(),
      apiKey: eKey.value,
      modelOverrides: modelOverrides as AdminProvider["modelOverrides"],
      asrModel: eAsrModel.value.trim(),
    });
    toast("success", "供应商已更新");
    showEdit.value = false;
    await refresh();
  } catch (err) {
    toastError(err, "更新供应商失败");
  }
}

async function setProviderAsrModel(p: AdminProvider, model: string): Promise<void> {
  const next = p.asrModel === model ? "" : model;
  try {
    await updateAdminProvider(p.id, { asrModel: next });
    p.asrModel = next;
    voiceStatus.value = await getVoiceStatus().catch(() => voiceStatus.value);
    toast("success", next ? `已将「${next}」设为「${p.name}」的语音转写模型` : `已清除「${p.name}」的显式语音模型绑定`);
  } catch (err) {
    toastError(err, "设置语音转写模型失败");
  }
}

async function removeProvider(p: AdminProvider): Promise<void> {
  const ok = await confirmDialog({
    title: `删除供应商「${p.name}」？`,
    message: "仅当没有专家使用该供应商时才能删除；其缓存的模型列表会一并清除。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteAdminProvider(p.id);
    toast("success", "供应商已删除");
    await refresh();
  } catch (err) {
    toastError(err, "删除失败");
  }
}

// 供应商模型：两层结构 —— models 是候选池，enabledModels 是可用集合（专家只能选可用的）
const modelsLoading = reactive<Record<string, boolean>>({});
const modelsError = reactive<Record<string, string>>({});
const modelFilter = reactive<Record<string, string>>({});
const newModel = reactive<Record<string, string>>({});

function byFilter(list: string[], kw: string): string[] {
  if (!kw) return list;
  return list.filter((m) => m.toLowerCase().includes(kw));
}

function enabledFiltered(p: AdminProvider): string[] {
  return byFilter(p.enabledModels, (modelFilter[p.id] ?? "").trim().toLowerCase());
}

function candidateModels(p: AdminProvider): string[] {
  const enabled = new Set(p.enabledModels);
  return p.models.filter((m) => !enabled.has(m));
}

function candidatesFiltered(p: AdminProvider): string[] {
  return byFilter(candidateModels(p), (modelFilter[p.id] ?? "").trim().toLowerCase());
}

function applyState(id: string, state: ProviderModelsState): void {
  providers.value = providers.value.map((x) =>
    x.id === id ? { ...x, models: state.models, enabledModels: state.enabledModels } : x
  );
}

async function addModel(p: AdminProvider): Promise<void> {
  const model = (newModel[p.id] ?? "").trim();
  if (!model) return;
  try {
    applyState(p.id, await addProviderModel(p.id, model));
    newModel[p.id] = "";
    toast("success", `已添加模型 ${model}`);
  } catch (err) {
    toastError(err, "添加模型失败");
  }
}

/** 停用：从可用集合移除，但保留在候选池。 */
async function disableModel(p: AdminProvider, model: string): Promise<void> {
  try {
    applyState(p.id, await disableProviderModel(p.id, model));
    toast("success", `已停用 ${model}`);
  } catch (err) {
    toastError(err, "停用模型失败");
  }
}

/** 启用：把候选模型加入可用集合。 */
async function enableModel(p: AdminProvider, model: string): Promise<void> {
  try {
    applyState(p.id, await enableProviderModel(p.id, model));
    toast("success", `已添加可用模型 ${model}`);
  } catch (err) {
    toastError(err, "添加模型失败");
  }
}

/** 彻底移除：候选池与可用集合一并删除。 */
async function removeModel(p: AdminProvider, model: string): Promise<void> {
  try {
    applyState(p.id, await removeProviderModel(p.id, model));
    toast("success", `已移除模型 ${model}`);
  } catch (err) {
    toastError(err, "移除模型失败");
  }
}

async function refetchModels(p: AdminProvider): Promise<void> {
  if (modelsLoading[p.id]) return;
  modelsLoading[p.id] = true;
  modelsError[p.id] = "";
  try {
    const res = await fetchProviderModels(p.id);
    providers.value = providers.value.map((x) =>
      x.id === p.id
        ? { ...x, models: res.models, enabledModels: res.enabledModels, modelsFetchedAt: res.fetchedAt }
        : x
    );
    toast("success", `「${p.name}」共 ${res.models.length} 个模型，${res.enabledModels.length} 个可用`);
  } catch (err) {
    modelsError[p.id] = err instanceof Error ? err.message : "获取模型列表失败";
  } finally {
    modelsLoading[p.id] = false;
  }
}

// 重置密码（管理员特权，无需旧密码）
const rpOpen = ref(false);
const rpTarget = ref<AdminUser | null>(null);
const rpPass = ref("");
const rpBusy = ref(false);

function openReset(u: AdminUser): void {
  rpTarget.value = u;
  rpPass.value = "";
  rpOpen.value = true;
}

async function submitReset(): Promise<void> {
  if (!rpTarget.value || rpPass.value.length < 6 || rpBusy.value) return;
  rpBusy.value = true;
  try {
    await resetUserPassword(rpTarget.value.id, rpPass.value);
    toast("success", `「${rpTarget.value.username}」的密码已重置，请用新密码重新登录`);
    rpOpen.value = false;
  } catch (err) {
    toastError(err, "重置密码失败");
  } finally {
    rpBusy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <h2 class="page-title">{{ route.path === "/admin" ? "管理后台" : "模型供应商" }}</h2>
    <p class="sub">{{ route.path === "/admin" ? "查看已登录过的企业知识库用户。密码在知识库里管理。" : "这里配置你自己的模型供应商、密钥和启用的模型。" }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <div class="tabs">
      <button
        v-for="t in visibleTabs"
        :key="t.key"
        type="button"
        class="tab"
        :class="{ active: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
        <span class="tab-count">{{ counts[t.key] }}</span>
      </button>
    </div>

    <!-- 模型供应商 -->
    <template v-if="tab === 'providers'">
      <div v-if="voiceStatus" class="voice-status-bar">
        <div class="vs-main">
          <span class="vs-icon">🎙️</span>
          <span v-if="voiceStatus.hasExplicit && voiceStatus.candidates[0]" class="vs-text">
            远端语音识别已显式绑定：<strong>{{ voiceStatus.candidates[0].providerName }} / {{ voiceStatus.candidates[0].model }}</strong>
            <span class="vs-sub">（远端异常时由开源本地 <code>{{ voiceStatus.localFallback?.model ?? "Paraformer-zh-small" }}</code> 自动兜底）</span>
          </span>
          <span v-else class="vs-text">
            未显式配置远端 ASR 模型，当前由<strong>开源本地引擎（{{ voiceStatus.localFallback?.model ?? "Paraformer-zh-small" }}）</strong>离线兜底
            <span class="vs-badge" :class="voiceStatus.localFallback?.cached ? 'ready' : 'pending'">
              {{ voiceStatus.localFallback?.cached ? "本地权重已就绪" : "首次调用自动拉取" }}
            </span>
            <span class="vs-sub">（绝不盲猜未配置的模型名；如需远端 ASR 请在供应商「编辑 / 语音配置」中显式指定）</span>
          </span>
        </div>
        <div class="vs-actions">
          <button
            v-if="!voiceStatus.localFallback?.cached || !voiceStatus.localFallback?.ready"
            type="button"
            class="mini"
            :disabled="warmingUpLocal"
            @click="handleWarmupLocal"
          >
            {{ warmingUpLocal ? "下载预热中…" : voiceStatus.localFallback?.cached ? "预热本地引擎" : "下载开源模型" }}
          </button>
          <button type="button" class="mini" :disabled="checkingVoice" @click="checkVoiceNow">
            {{ checkingVoice ? "检测中…" : "检测语音配置" }}
          </button>
        </div>
      </div>
      <div v-if="providers.length" class="provider-list">
        <div v-for="p in providers" :key="p.id" class="provider-card">
          <div class="p-head">
            <div class="p-title">
              <span class="p-name">{{ p.name }}</span>
              <span class="status" :class="p.enabled ? 'completed' : 'cancelled'">{{ p.enabled ? "启用" : "停用" }}</span>
              <span v-if="p.asrModel" class="asr-badge" title="语音听写与音频转写优先使用该模型（点击清除）" @click="setProviderAsrModel(p, p.asrModel)">
                🎙️ 语音：{{ p.asrModel }} ✕
              </span>
            </div>
            <div class="p-actions">
              <button type="button" @click="openEdit(p)">编辑 / 语音配置</button>
              <button type="button" @click="toggleProvider(p)">{{ p.enabled ? "停用" : "启用" }}</button>
              <button type="button" class="danger" @click="removeProvider(p)">删除</button>
            </div>
          </div>
          <div class="p-url">
            <span class="mono">{{ p.baseUrl }}</span>
            <span class="dot-sep">·</span>
            密钥{{ p.hasKey ? "已配置" : "未配置" }}
          </div>

          <div class="p-models">
            <div class="p-models-head">
              <span class="p-models-title">模型</span>
              <span v-if="p.modelsFetchedAt" class="fetched-at">更新于 {{ timeAgo(p.modelsFetchedAt) }}</span>
              <button type="button" class="mini" :disabled="modelsLoading[p.id]" @click="refetchModels(p)">
                {{ modelsLoading[p.id] ? "获取中…" : p.models.length ? "重新获取" : "获取模型列表" }}
              </button>
            </div>
            <div v-if="modelsError[p.id]" class="model-error">
              {{ modelsError[p.id] }}
              <button type="button" class="mini" @click="refetchModels(p)">重试</button>
            </div>
            <template v-else-if="p.models.length">
              <input v-model="modelFilter[p.id]" class="model-search" placeholder="搜索模型…" />
              <div class="m-block">
                <div class="m-label">
                  可用模型 <span class="m-count">{{ p.enabledModels.length }}</span>
                  <span class="m-tip">创建专家时可选</span>
                </div>
                <div v-if="p.enabledModels.length" class="model-list">
                  <span v-for="m in enabledFiltered(p)" :key="m" class="model-pill on" :class="{ asr: p.asrModel === m }">
                    <button
                      v-if="isAsrModel(m)"
                      type="button"
                      class="pill-asr"
                      :title="p.asrModel === m ? '当前默认语音转写模型（点击取消绑定）' : '设为该供应商默认语音转写（ASR）模型'"
                      @click="setProviderAsrModel(p, m)"
                    >🎙️</button>
                    {{ m }}
                    <button type="button" class="pill-x" title="停用（保留在候选）" @click="disableModel(p, m)">×</button>
                  </span>
                  <span v-if="!enabledFiltered(p).length" class="model-none">无匹配模型</span>
                </div>
                <div v-else class="model-none">暂无可用模型，点击下方候选模型启用</div>
              </div>
              <div v-if="candidateModels(p).length" class="m-block">
                <div class="m-label">
                  候选模型 <span class="m-count">{{ candidateModels(p).length }}</span>
                  <span class="m-tip">点击直接添加为可用；带 🎙️ 图标的可直接设为语音转写模型</span>
                </div>
                <div class="model-list">
                  <span v-for="m in candidatesFiltered(p)" :key="m" class="model-pill cand" :class="{ asr: p.asrModel === m }">
                    <button
                      v-if="isAsrModel(m)"
                      type="button"
                      class="pill-asr"
                      :title="p.asrModel === m ? '当前默认语音转写模型（点击取消绑定）' : '设为该供应商默认语音转写（ASR）模型'"
                      @click="setProviderAsrModel(p, m)"
                    >🎙️</button>
                    <button type="button" class="pill-add" title="添加为可用模型" @click="enableModel(p, m)">
                      + {{ m }}
                    </button>
                    <button type="button" class="pill-x" title="从列表移除" @click="removeModel(p, m)">×</button>
                  </span>
                  <span v-if="!candidatesFiltered(p).length" class="model-none">无匹配模型</span>
                </div>
              </div>
            </template>
            <div v-else class="model-none">尚未获取模型列表，点击上方按钮拉取，或在下方手动添加</div>
            <div class="model-add">
              <input
                v-model="newModel[p.id]"
                placeholder="手动添加模型 ID，如 deepseek-chat"
                @keydown.enter.prevent="addModel(p)"
              />
              <button type="button" class="mini" @click="addModel(p)">添加</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty">还没有供应商，先在下方添加一个</div>

      <form class="grid" @submit.prevent="addProvider">
        <input v-model="pName" placeholder="名称，如 DeepSeek 中转" required />
        <input v-model="pBaseUrl" placeholder="Base URL，如 https://api.deepseek.com/v1" required />
        <input v-model="pKey" type="password" placeholder="API Key" required />
        <button class="primary" type="submit">添加供应商</button>
      </form>
      <p class="hint">兼容 OpenAI Chat Completions 协议的任意端点均可；添加后可拉取该供应商下的模型列表。</p>
    </template>

    <!-- 用户自行注册；管理端只保留账号查看与密码重置 -->
    <section v-show="tab === 'users'" class="card">
      <h3>用户账号</h3>
      <table v-if="users.length">
        <thead>
          <tr><th>用户名</th><th>角色</th><th>创建时间</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="strong">{{ u.username }}</td>
            <td><span class="status" :class="u.role === 'admin' ? 'running' : 'cancelled'">{{ u.role === "admin" ? "管理员" : "成员" }}</span></td>
            <td class="time">{{ timeAgo(u.createdAt) }}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">还没有登录过的企业知识库用户</div>
      <p class="hint">账号来自企业知识库。超级管理员在本应用里是管理员，其余人是成员。密码请到知识库修改。</p>
    </section>

    <!-- 重置密码弹窗 -->
    <teleport to="body">
      <div v-if="rpOpen" class="overlay" @click.self="rpOpen = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>重置「{{ rpTarget?.username }}」的密码</h3>
            <button type="button" class="close" @click="rpOpen = false">✕</button>
          </div>
          <form class="form" @submit.prevent="submitReset">
            <label class="field">
              <span>新密码 <i>*</i></span>
              <input v-model="rpPass" type="password" placeholder="至少 6 位" required minlength="6" />
            </label>
            <p class="hint">管理员重置不需要旧密码；重置后请通知该成员用新密码重新登录。</p>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="rpOpen = false">取消</button>
              <button type="submit" class="primary" :disabled="rpPass.length < 6 || rpBusy">
                {{ rpBusy ? "提交中…" : "确认重置" }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </teleport>

    <!-- 编辑供应商弹窗 -->
    <teleport to="body">
      <div v-if="showEdit" class="overlay" @click.self="showEdit = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>编辑供应商</h3>
            <button type="button" class="close" @click="showEdit = false">✕</button>
          </div>
          <form class="form" @submit.prevent="saveEdit">
            <label class="field">
              <span>名称 <i>*</i></span>
              <input v-model="eName" required />
            </label>
            <label class="field">
              <span>Base URL <i>*</i></span>
              <input v-model="eBaseUrl" placeholder="https://api.deepseek.com/v1" required />
            </label>
            <label class="field">
              <span>API Key</span>
              <input v-model="eKey" type="password" placeholder="留空则不修改" />
            </label>
            <label class="field">
              <span>语音转写（ASR）模型（可选）</span>
              <input v-model="eAsrModel" placeholder="如 FunAudioLLM/SenseVoiceSmall、whisper-1、glm-asr" />
              <div class="asr-presets">
                <span class="preset-label">常用预设：</span>
                <button
                  v-for="preset in ASR_PRESETS"
                  :key="preset"
                  type="button"
                  class="preset-chip"
                  :class="{ active: eAsrModel === preset }"
                  @click="eAsrModel = eAsrModel === preset ? '' : preset"
                >
                  {{ preset }}
                </button>
              </div>
              <span class="field-note">
                必须显式指定才会调用该供应商的 <code>/audio/transcriptions</code> 端点（不会盲猜未配置的模型）；留空时将自动使用平台内置开源本地 Whisper ONNX 模型离线兜底。
              </span>
            </label>
            <label class="field">
              <span>模型能力覆盖（JSON，可选）</span>
              <textarea
                v-model="eOverrides"
                class="overrides-editor"
                rows="5"
                :placeholder="OVERRIDES_EXAMPLE"
                spellcheck="false"
              ></textarea>
              <span class="field-note">
                平台默认按 128k 上下文 / 32768 输出 / 无推理调用模型；对长上下文或推理模型在这里按模型 ID 覆盖
                contextWindow、maxTokens、reasoning。留空或传 {} 表示全部用默认。
              </span>
            </label>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="showEdit = false">取消</button>
              <button type="submit" class="primary" :disabled="!eName.trim() || !eBaseUrl.trim()">保存</button>
            </div>
          </form>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 24px auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 24px 40px;
  animation: rise 0.22s ease-out;
}
.page-title {
  margin: 0;
  font-size: 20px;
}
.sub {
  margin: -6px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.tabs {
  display: flex;
  gap: 4px;
  background: var(--surface-2);
  border-radius: 10px;
  padding: 3px;
  width: fit-content;
}
.tab {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 6px 14px;
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
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.card h3 {
  margin: 0;
}
.voice-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12.5px;
}
.vs-main {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  flex: 1;
  min-width: 0;
}
.vs-text {
  line-height: 1.5;
}
.vs-sub {
  color: var(--text-3);
  font-size: 12px;
}
.vs-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  margin: 0 4px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.vs-badge.ready {
  background: var(--accent-soft);
  color: var(--accent);
}
.vs-badge.pending {
  background: var(--surface);
  color: var(--text-3);
  border: 1px solid var(--border);
}
.vs-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.vs-actions .mini {
  margin-left: 0;
}
.vs-text.warn {
  color: var(--warn);
}
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.provider-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.p-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.p-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.p-name {
  font-weight: 700;
  font-size: 14.5px;
}
.p-url {
  font-size: 12.5px;
  color: var(--text-2);
}
.dot-sep {
  margin: 0 6px;
  color: var(--text-3);
}
.p-actions {
  display: flex;
  gap: 6px;
}
.p-models {
  border-top: 1px dashed var(--border-strong);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.p-models-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.p-models-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.fetched-at {
  font-size: 11.5px;
  color: var(--text-3);
}
.mini {
  margin-left: auto;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 8px;
}
.model-error {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 8px;
  padding: 8px 10px;
}
.model-error .mini {
  margin-left: auto;
}
.model-search {
  height: 32px;
  font-size: 12.5px;
  border-radius: 8px;
}
.model-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 140px;
  overflow-y: auto;
}
.m-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.m-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 0 6px;
}
.m-tip {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
}
.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-family: var(--mono, monospace);
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 6px 3px 10px;
}
.model-pill.on {
  color: var(--text);
  background: var(--accent-soft);
  border-color: transparent;
}
.model-pill.cand {
  border-style: dashed;
  padding: 3px 6px 3px 8px;
  transition: border-color 0.15s ease;
}
.model-pill.cand:hover {
  border-color: var(--accent);
}
.pill-add {
  border: none;
  box-shadow: none;
  background: transparent;
  font: inherit;
  font-family: inherit;
  color: inherit;
  padding: 0;
  cursor: pointer;
}
.pill-add:hover {
  color: var(--accent);
}
.pill-x {
  border: none;
  box-shadow: none;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 50%;
}
.pill-x:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.model-add {
  display: flex;
  gap: 6px;
}
.model-add input {
  flex: 1;
  height: 32px;
  font-size: 12.5px;
  border-radius: 8px;
}
.model-add .mini {
  margin-left: 0;
}
.model-none {
  font-size: 12.5px;
  color: var(--text-3);
}
.strong {
  font-weight: 600;
}
.time {
  color: var(--text-3);
  font-size: 12.5px;
}
.row-actions {
  text-align: right;
}
.row-actions button {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}
.grid .primary {
  justify-self: end;
  width: auto;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.empty {
  padding: 40px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 13.5px;
  border: 1px dashed var(--border-strong);
  border-radius: 16px;
}
.p-actions .danger:hover {
  color: var(--danger);
  border-color: var(--danger-border);
  background: var(--danger-soft);
}

/* 编辑弹窗 */
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
  width: min(460px, calc(100vw - 48px));
  background: var(--surface);
  border-radius: 18px;
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
.close {
  border: none;
  box-shadow: none;
  background: transparent;
  color: var(--text-3);
  padding: 4px 8px;
  border-radius: 8px;
}
.close:hover {
  color: var(--text);
  background: var(--surface-2);
}
.form {
  padding: 14px 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
.field i {
  color: var(--danger);
  font-style: normal;
}
.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
.ghost {
  background: transparent;
}
.overrides-editor {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  resize: vertical;
  white-space: pre;
}
.asr-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent-border);
  cursor: pointer;
}
.asr-badge:hover {
  opacity: 0.85;
}
.model-pill.asr {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-border);
}
.pill-asr {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0 2px;
  font-size: 12px;
  cursor: pointer;
}
.asr-presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.preset-label {
  font-size: 11.5px;
  color: var(--text-3);
}
.preset-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
  box-shadow: none;
}
.preset-chip.active,
.preset-chip:hover {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent-border);
}
.field-note {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 4px;
}
</style>
