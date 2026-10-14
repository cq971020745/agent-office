<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { AdminProvider, AdminUser } from "../api";
import {
  addProviderModel,
  createAdminProvider,
  createAdminUser,
  deleteAdminProvider,
  disableProviderModel,
  enableProviderModel,
  fetchProviderModels,
  listAdminProviders,
  listAdminUsers,
  removeProviderModel,
  resetUserPassword,
  setProviderEnabled,
  updateAdminProvider,
} from "../api";
import type { ProviderModelsState } from "../api";
import { confirmDialog } from "../composables/confirm";
import { toast, toastError } from "../composables/toast";
import { timeAgo } from "../utils/format";

type Tab = "providers" | "users";
const tab = ref<Tab>("providers");

const TABS: { key: Tab; label: string }[] = [
  { key: "providers", label: "模型供应商" },
  { key: "users", label: "成员账号" },
];

const providers = ref<AdminProvider[]>([]);
const users = ref<AdminUser[]>([]);
const error = ref("");

const counts = computed<Record<Tab, number>>(() => ({
  providers: providers.value.length,
  users: users.value.length,
}));

async function refresh(): Promise<void> {
  try {
    [providers.value, users.value] = await Promise.all([listAdminProviders(), listAdminUsers()]);
    error.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
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
    });
    toast("success", "供应商已更新");
    showEdit.value = false;
    await refresh();
  } catch (err) {
    toastError(err, "更新供应商失败");
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

// 用户表单
const uName = ref("");
const uPass = ref("");
const uRole = ref<"admin" | "member">("member");

async function addUser(): Promise<void> {
  if (!uName.value.trim() || !uPass.value) return;
  try {
    await createAdminUser(uName.value.trim(), uPass.value, uRole.value);
    toast("success", `账号「${uName.value.trim()}」已创建`);
    uName.value = uPass.value = "";
    await refresh();
  } catch (err) {
    toastError(err, "创建账号失败");
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
    <h2 class="page-title">管理后台</h2>
    <p class="sub">供应商与成员账号在这里维护；专家的创建与删除已移至「专家·技能·连接器」页。</p>
    <p v-if="error" class="error">{{ error }}</p>

    <div class="tabs">
      <button
        v-for="t in TABS"
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
      <div v-if="providers.length" class="provider-list">
        <div v-for="p in providers" :key="p.id" class="provider-card">
          <div class="p-head">
            <div class="p-title">
              <span class="p-name">{{ p.name }}</span>
              <span class="status" :class="p.enabled ? 'completed' : 'cancelled'">{{ p.enabled ? "启用" : "停用" }}</span>
            </div>
            <div class="p-actions">
              <button type="button" @click="openEdit(p)">编辑</button>
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
                  <span v-for="m in enabledFiltered(p)" :key="m" class="model-pill on">
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
                  <span class="m-tip">点击直接添加为可用</span>
                </div>
                <div class="model-list">
                  <span v-for="m in candidatesFiltered(p)" :key="m" class="model-pill cand">
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

    <!-- 成员账号 -->
    <section v-show="tab === 'users'" class="card">
      <h3>成员账号</h3>
      <table v-if="users.length">
        <thead>
          <tr><th>用户名</th><th>角色</th><th>创建时间</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="strong">{{ u.username }}</td>
            <td><span class="status" :class="u.role === 'admin' ? 'running' : 'cancelled'">{{ u.role === "admin" ? "管理员" : "成员" }}</span></td>
            <td class="time">{{ timeAgo(u.createdAt) }}</td>
            <td class="row-actions">
              <button type="button" @click="openReset(u)">重置密码</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">还没有成员</div>
      <form class="grid" @submit.prevent="addUser">
        <input v-model="uName" placeholder="用户名" required />
        <input v-model="uPass" type="password" placeholder="初始密码" required />
        <select v-model="uRole">
          <option value="member">成员</option>
          <option value="admin">管理员</option>
        </select>
        <button class="primary" type="submit">创建账号</button>
      </form>
      <p class="hint">忘记密码不用找旧密码：管理员在上方点「重置密码」直接设新密码。</p>
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
.field-note {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 4px;
}
</style>
