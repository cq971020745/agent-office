<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  ACCENT_PRESETS,
  THEME_MODES,
  depthHint,
  useTheme,
  type AccentId,
  type ThemeMode,
} from "../composables/useTheme";
import { useSkin } from "../composables/useSkin";
import { toast, toastError } from "../composables/toast";
import { deleteSkin, exportSkin, installGithubSkin, installNpmSkin, installSkinFromTask, installSkinPack, createTask, getTask, listAdminProviders, listGithubSkins, listMarketSkins, publishSkinToNpm, searchNpmSkins, type NpmSkinEntry, type SkinInfo } from "../api";
import { buildSkinCreationPrompt, SKIN_STYLE_PLACEHOLDER } from "../composables/skinPrompt";
import type { Task } from "@office/shared";
import { playThemePanelIn } from "../composables/useMicroFx";

const props = withDefaults(
  defineProps<{
    /** compact：侧栏图标；inline：登录页 */
    variant?: "compact" | "inline";
  }>(),
  { variant: "compact" }
);

const {
  mode,
  accentId,
  customHex,
  depth,
  fxEnabled,
  buddyEnabled,
  activeBaseColor,
  setMode,
  setAccentId,
  setCustomHex,
  setDepth,
  setFxEnabled,
  setBuddyEnabled,
} = useTheme();

const route = useRoute();
const depthLabel = computed(() => depthHint(mode.value));
const open = ref(false);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const hexDraft = ref(customHex.value);
const panelStyle = ref<Record<string, string>>({});

const { skinId, skins, broken, skinDir, skinNotice, setSkin, refreshSkins } = useSkin();
const skinFileRef = ref<HTMLInputElement | null>(null);
const skinBusy = ref(false);

const MODE_LABELS: Record<string, string> = { light: "浅色", dark: "深色", glass: "玻璃" };

function skinMeta(skin: SkinInfo): string {
  const bits = [skin.version, skin.author].filter(Boolean);
  const modes = skin.modes?.length
    ? skin.modes.map((m) => MODE_LABELS[m] ?? m).join("/") + "适配"
    : "三档通用";
  return [...bits, modes].join(" · ");
}

function pickSkin(id: string): void {
  setSkin(id);
}

function pickSkinFile(): void {
  skinFileRef.value?.click();
}

async function onSkinFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || skinBusy.value) return;
  skinBusy.value = true;
  try {
    const installed = await installSkinPack(file);
    await refreshSkins();
    setSkin(installed.id);
    toast("success", `皮肤「${installed.name}」已安装并应用`);
  } catch (err) {
    toastError(err, "皮肤包安装失败");
  } finally {
    skinBusy.value = false;
  }
}

async function removeSkin(id: string): Promise<void> {
  if (skinBusy.value) return;
  skinBusy.value = true;
  try {
    await deleteSkin(id);
    await refreshSkins();
    toast("info", "皮肤已删除");
  } catch (err) {
    toastError(err, "皮肤删除失败");
  } finally {
    skinBusy.value = false;
  }
}

async function openSkinDir(): Promise<void> {
  if (!skinDir.value) await refreshSkins();
  // 多用户服务端部署不下发数据目录路径，「打开皮肤目录」不可用
  if (!skinDir.value) {
    toast("info", "当前部署不支持打开皮肤目录；请把皮肤包交给管理员安装");
    return;
  }
  // 浏览器直连（非桌面壳）没有 preload 桥，此时不提供打开目录能力
  if (!window.agentOffice) {
    toast("info", `皮肤目录：${skinDir.value}`);
    return;
  }
  const res = await window.agentOffice.openPath(skinDir.value);
  if (!res.ok && res.message) toast("error", res.message);
}

watch(skinNotice, (msg) => {
  if (!msg) return;
  toast("error", msg);
  skinNotice.value = "";
});

// ---------- AI 创造皮肤 ----------
type CreatePhase = "idle" | "creating" | "running" | "ready" | "failed";
const skinCreateOpen = ref(false);
const styleHint = ref("");
const promptDraft = ref("");
const createPhase = ref<CreatePhase>("idle");
const createTaskId = ref("");
const createError = ref("");
const installingCreated = ref(false);
let createPollTimer: ReturnType<typeof setInterval> | null = null;

function stopCreatePoll(): void {
  if (createPollTimer) {
    clearInterval(createPollTimer);
    createPollTimer = null;
  }
}

/** 明显不是对话模型的 ID（向量/重排/语音/审核等）——任务要注入工具，这类模型上游会直接 400 */
const NON_CHAT_MODEL = /embed|bge|m3e|^e5|gte[-._]|rerank|whisper|asr|tts|speech|voice|ocr|moderation/i;
function looksChatCapable(modelId: string): boolean {
  return !NON_CHAT_MODEL.test(modelId);
}

interface SkinModelOption {
  key: string;
  label: string;
  providerId: string;
  providerName: string;
  modelId: string;
}
const modelOptions = ref<SkinModelOption[]>([]);
const modelKey = ref("");
const resolvedModel = computed<SkinModelOption | null>(() => modelOptions.value.find((o) => o.key === modelKey.value) ?? null);

/** 拉取当前用户启用的对话模型，默认选「上次用过的 → 第一个」，可手动换 */
async function loadModelOptions(): Promise<void> {
  try {
    const providers = (await listAdminProviders()).filter((p) => p.enabled);
    const options: SkinModelOption[] = [];
    for (const p of providers) {
      for (const m of p.enabledModels.filter(looksChatCapable)) {
        options.push({ key: `${p.id}::${m}`, label: `${p.name} · ${m}`, providerId: p.id, providerName: p.name, modelId: m });
      }
    }
    modelOptions.value = options;
    let saved: { providerId?: string; modelId?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem("agent-office-last-model") || "null");
    } catch {
      saved = null;
    }
    const lastKey = saved?.providerId && saved?.modelId ? `${saved.providerId}::${saved.modelId}` : "";
    modelKey.value = options.some((o) => o.key === lastKey) ? lastKey : options[0]?.key ?? "";
  } catch {
    modelOptions.value = [];
    modelKey.value = "";
  }
}

function openSkinCreate(): void {
  styleHint.value = "";
  promptDraft.value = buildSkinCreationPrompt("");
  createPhase.value = "idle";
  createTaskId.value = "";
  createError.value = "";
  skinCreateOpen.value = true;
  void loadModelOptions();
}

function closeSkinCreate(): void {
  skinCreateOpen.value = false;
  stopCreatePoll();
}

/** 用当前提示词创建一个后台任务；任务在工作区里产出 skin-pack/，完成后可一键安装 */
async function startSkinCreate(): Promise<void> {
  if (createPhase.value === "creating" || createPhase.value === "running") return;
  if (!resolvedModel.value) {
    createPhase.value = "failed";
    createError.value = "请先在「模型供应商」页启用一个对话模型（qwen / glm / deepseek / llama 等支持工具调用的），再回来创造皮肤";
    return;
  }
  createPhase.value = "creating";
  createError.value = "";
  try {
    const hint = styleHint.value.trim();
    const created = await createTask(
      undefined,
      buildSkinCreationPrompt(hint),
      hint ? `创造皮肤包：${hint.slice(0, 24)}` : "创造皮肤包",
      { providerId: resolvedModel.value.providerId, modelId: resolvedModel.value.modelId }
    );
    // 记住这次的选择，与首页派发任务的记忆一致
    localStorage.setItem(
      "agent-office-last-model",
      JSON.stringify({ providerId: resolvedModel.value.providerId, modelId: resolvedModel.value.modelId })
    );
    createTaskId.value = created.id;
    createPhase.value = "running";
    savePendingSkinCreate(created.id);
    stopCreatePoll();
    createPollTimer = setInterval(pollCreateTask, 3000);
  } catch (err) {
    createPhase.value = "failed";
    createError.value = err instanceof Error ? err.message : "任务创建失败";
  }
}

async function pollCreateTask(): Promise<void> {
  if (!createTaskId.value) return;
  try {
    const task = await getTask(createTaskId.value);
    if (task.status === "completed") {
      createPhase.value = "ready";
      stopCreatePoll();
      // 完成即自动安装：不依赖用户回到对话框点按钮（关掉面板/刷新都不会丢）
      await installCreatedSkin();
    } else if (task.status === "failed" || task.status === "cancelled") {
      createPhase.value = "failed";
      createError.value = "任务没有正常完成，可在任务页查看原因后重试";
      stopCreatePoll();
      clearPendingSkinCreate();
    }
  } catch {
    // 单次轮询失败忽略，下一轮再试
  }
}

/** 待安装的创造任务持久化：对话框关掉 / 页面刷新后仍能续上，装完即清 */
const PENDING_SKIN_TASK_KEY = "agent-office-skin-pending-task";

function savePendingSkinCreate(taskId: string): void {
  localStorage.setItem(PENDING_SKIN_TASK_KEY, taskId);
}

function clearPendingSkinCreate(): void {
  localStorage.removeItem(PENDING_SKIN_TASK_KEY);
}

/** 恢复上次未完成的创造任务（面板重开/页面刷新后自动轮询并安装） */
function resumePendingSkinCreate(): void {
  const saved = localStorage.getItem(PENDING_SKIN_TASK_KEY);
  if (!saved || createPollTimer) return;
  createTaskId.value = saved;
  createPhase.value = "running";
  createPollTimer = setInterval(pollCreateTask, 3000);
}

async function installCreatedSkin(): Promise<void> {
  if (!createTaskId.value || installingCreated.value) return;
  installingCreated.value = true;
  try {
    const installed = await installSkinFromTask(createTaskId.value);
    clearPendingSkinCreate();
    await refreshSkins();
    setSkin(installed.id);
    closeSkinCreate();
    toast("success", `皮肤「${installed.name}」已安装并应用`);
  } catch (err) {
    // 失败清掉持久化：自动重试不循环；对话框若开着仍可手动重试（createTaskId 还在）
    clearPendingSkinCreate();
    toastError(err, "皮肤安装失败");
  } finally {
    installingCreated.value = false;
  }
}

async function exportSkinPack(id: string): Promise<void> {
  try {
    await exportSkin(id);
  } catch (err) {
    toastError(err, "皮肤导出失败");
  }
}

// ---------- 皮肤市场 ----------
const marketOpen = ref(false);
const marketSkins = ref<SkinInfo[]>([]);
const marketLoading = ref(false);
const marketError = ref("");
/** 市场三源：本服务器（同服务端全员共享）/ GitHub（注册表仓库）/ npm（镜像 registry，国内最稳） */
const marketSource = ref<"server" | "github" | "npm">("server");
const REGISTRY_KEY = "agent-office-skin-registry";
const DEFAULT_SKIN_REGISTRY = "https://raw.githubusercontent.com/muniu-liuma/skins/main/registry.json";
const registryUrl = ref(localStorage.getItem(REGISTRY_KEY) ?? DEFAULT_SKIN_REGISTRY);
const githubSkins = ref<Array<{ id: string; name: string; version?: string; author?: string; description?: string; modes?: string[] }>>([]);
const githubLoading = ref(false);
const githubError = ref("");
const githubBusy = ref("");
/** npm 源：约定包名 muniu-skin-*，走镜像 registry，国内可达性最好 */
const npmQuery = ref("muniu-skin");
const npmSkins = ref<NpmSkinEntry[]>([]);
const npmLoading = ref(false);
const npmError = ref("");
const npmBusy = ref("");
const npmPkgDraft = ref("");
/** 一键发布：本地皮肤 → npm（用发布者自己的 npm 令牌，服务端不留存） */
const publishOpen = ref(false);
const publishSkinId = ref("");
const publishName = ref("");
const publishVersion = ref("");
const publishToken = ref(localStorage.getItem("agent-office-npm-token") ?? "");
const publishRemember = ref(!!publishToken.value);
const publishing = ref(false);

function togglePublish(): void {
  publishOpen.value = !publishOpen.value;
  if (publishOpen.value) {
    const first = skins.value.find((s) => s.id) ?? skins.value[0];
    if (first) selectPublishSkin(first.id);
  }
}

function selectPublishSkin(id: string): void {
  publishSkinId.value = id;
  const s = skins.value.find((x) => x.id === id);
  publishName.value = `muniu-skin-${id}`;
  publishVersion.value = s?.version || "1.0.0";
}

async function publishToNpm(): Promise<void> {
  if (publishing.value || !publishSkinId.value) return;
  if (!publishToken.value.trim()) {
    toast("error", "先填 npm 访问令牌（npmjs.com → Access Tokens → Generate New Token）");
    return;
  }
  publishing.value = true;
  try {
    // 记住/清除不依赖发布结果：令牌错发布失败时也别让用户重新粘贴
    if (publishRemember.value) localStorage.setItem("agent-office-npm-token", publishToken.value.trim());
    else localStorage.removeItem("agent-office-npm-token");
    const result = await publishSkinToNpm({
      id: publishSkinId.value,
      name: publishName.value.trim() || undefined,
      version: publishVersion.value.trim() || undefined,
      token: publishToken.value.trim(),
    });
    toast("success", `已发布 ${result.name}@${result.version}——其他人 npm 页签直接装`);
    npmPkgDraft.value = result.name;
    await searchNpm();
  } catch (err) {
    toastError(err, "发布失败");
  } finally {
    publishing.value = false;
  }
}

async function openMarket(): Promise<void> {
  marketOpen.value = true;
  marketLoading.value = true;
  marketError.value = "";
  try {
    marketSkins.value = (await listMarketSkins()).skins;
  } catch (err) {
    marketError.value = err instanceof Error ? err.message : "皮肤市场暂时不可用";
  } finally {
    marketLoading.value = false;
  }
  if (marketSource.value === "npm" && !npmSkins.value.length && !npmLoading.value) void searchNpm();
}

/** 直达 npm 市场（皮肤包区的快捷按钮） */
function openMarketNpm(): void {
  marketSource.value = "npm";
  void openMarket();
}

function saveRegistryUrl(): void {
  const t = registryUrl.value.trim();
  localStorage.setItem(REGISTRY_KEY, t || DEFAULT_SKIN_REGISTRY);
  if (t) registryUrl.value = t;
}

async function loadGithubSkins(): Promise<void> {
  saveRegistryUrl();
  githubLoading.value = true;
  githubError.value = "";
  try {
    githubSkins.value = await listGithubSkins(registryUrl.value);
  } catch (err) {
    githubSkins.value = [];
    githubError.value = err instanceof Error ? err.message : "GitHub 市场暂时不可用";
  } finally {
    githubLoading.value = false;
  }
}

function switchMarketSource(source: "server" | "github" | "npm"): void {
  marketSource.value = source;
  if (source === "github" && !githubSkins.value.length && !githubLoading.value) void loadGithubSkins();
  if (source === "npm" && !npmSkins.value.length && !npmLoading.value) void searchNpm();
}

async function searchNpm(): Promise<void> {
  npmLoading.value = true;
  npmError.value = "";
  try {
    npmSkins.value = (await searchNpmSkins(npmQuery.value.trim() || "muniu-skin")).skins;
  } catch (err) {
    npmSkins.value = [];
    npmError.value = err instanceof Error ? err.message : "npm 市场暂时不可用";
  } finally {
    npmLoading.value = false;
  }
}

async function installFromNpm(pkg: string): Promise<void> {
  if (npmBusy.value) return;
  npmBusy.value = pkg;
  try {
    const installed = await installNpmSkin(pkg);
    await refreshSkins();
    setSkin(installed.id);
    toast("success", `皮肤「${installed.name}」已从 npm 市场安装并应用`);
  } catch (err) {
    toastError(err, "npm 皮肤安装失败");
  } finally {
    npmBusy.value = "";
  }
}

async function installFromGithub(id: string): Promise<void> {
  if (githubBusy.value) return;
  githubBusy.value = id;
  try {
    const installed = await installGithubSkin(registryUrl.value, id);
    await refreshSkins();
    setSkin(installed.id);
    toast("success", `皮肤「${installed.name}」已从 GitHub 市场安装并应用`);
  } catch (err) {
    toastError(err, "GitHub 皮肤安装失败");
  } finally {
    githubBusy.value = "";
  }
}

/** 市场里的皮肤即本机可见皮肤（同一服务端目录），应用 = setSkin */
function applyFromMarket(id: string): void {
  pickSkin(id);
  marketOpen.value = false;
}

onBeforeUnmount(stopCreatePoll);

watch(
  [customHex, accentId, activeBaseColor],
  () => {
    hexDraft.value = activeBaseColor.value;
  },
  { immediate: true }
);

const modeLabel = computed(
  () => THEME_MODES.find((m) => m.id === mode.value)?.label ?? "主题"
);

const PANEL_W = 300;

function placePanel(): void {
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 12;
  let left = rect.right - PANEL_W;
  left = Math.min(Math.max(margin, left), window.innerWidth - PANEL_W - margin);

  const spaceAbove = rect.top - margin;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  // 登录页按钮在右上角：向上展开会冲出视口，改为向下；侧栏仍优先向上
  const openBelow = props.variant === "inline" || spaceAbove < 240;

  if (openBelow) {
    const maxHeight = Math.max(200, Math.min(spaceBelow - 8, window.innerHeight - margin * 2));
    panelStyle.value = {
      position: "fixed",
      left: `${Math.round(left)}px`,
      top: `${Math.round(rect.bottom + 8)}px`,
      bottom: "auto",
      width: `${PANEL_W}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
      zIndex: "1300",
    };
    return;
  }

  const bottom = Math.max(margin, window.innerHeight - rect.top + 8);
  const maxHeight = Math.max(180, Math.min(spaceAbove - 8, window.innerHeight - bottom - margin));
  panelStyle.value = {
    position: "fixed",
    left: `${Math.round(left)}px`,
    top: "auto",
    bottom: `${Math.round(bottom)}px`,
    width: `${PANEL_W}px`,
    maxHeight: `${Math.round(maxHeight)}px`,
    zIndex: "1300",
  };
}

function toggle(): void {
  open.value = !open.value;
}

function close(): void {
  open.value = false;
}

function pickMode(id: ThemeMode): void {
  setMode(id);
}

function pickAccent(id: AccentId): void {
  setAccentId(id);
}

function onCustomColorInput(e: Event): void {
  const value = (e.target as HTMLInputElement).value;
  setCustomHex(value);
  hexDraft.value = value;
}

function onHexBlur(): void {
  const next = hexDraft.value.trim();
  if (next) setCustomHex(next.startsWith("#") ? next : `#${next}`);
  hexDraft.value = customHex.value;
}

function onDocPointer(e: PointerEvent): void {
  if (!open.value) return;
  const t = e.target as Node;
  if (panelRef.value?.contains(t) || triggerRef.value?.contains(t)) return;
  close();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && open.value) close();
}

function onViewportChange(): void {
  if (open.value) placePanel();
}

onMounted(() => {
  document.querySelectorAll(".theme-layer, .theme-backdrop").forEach((el) => el.remove());
  document.addEventListener("pointerdown", onDocPointer);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onViewportChange);
  // 恢复未完成的创造任务：完成即自动安装，不依赖对话框开着
  resumePendingSkinCreate();
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer);
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", onViewportChange);
  close();
});

// 一换路由就关，避免面板残留挡住侧栏
watch(
  () => route.fullPath,
  () => close()
);

watch(open, async (v) => {
  if (!v) return;
  placePanel();
  await nextTick();
  placePanel();
  panelRef.value?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  if (panelRef.value) playThemePanelIn(panelRef.value);
  void refreshSkins();
});
</script>

<template>
  <div class="theme-picker" :class="props.variant">
    <button
      ref="triggerRef"
      type="button"
      class="theme-trigger"
      :class="{ active: open }"
      :title="`外观：${modeLabel}`"
      :aria-label="`外观设置，当前${modeLabel}`"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click.stop="toggle"
    >
      <svg v-if="mode === 'glass'" class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="3" />
        <path d="M7 14l3-3 2.5 2.5L16 10l4 4" />
        <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
      </svg>
      <svg v-else-if="mode === 'dark'" class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"
        />
      </svg>
      <svg v-else class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
      </svg>
      <span v-if="props.variant === 'inline'" class="trigger-label">外观</span>
      <span class="swatch-dot" :style="{ background: activeBaseColor }" aria-hidden="true" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="theme-panel"
        :style="panelStyle"
        role="dialog"
        aria-label="外观与主题色"
        @pointerdown.stop
      >
        <header class="panel-head">
          <strong>外观</strong>
          <span>模式与主色即时生效</span>
        </header>

        <section class="block">
          <p class="block-label">显示模式</p>
          <div class="mode-grid" role="radiogroup" aria-label="显示模式">
            <button
              v-for="(m, i) in THEME_MODES"
              :key="m.id"
              type="button"
              class="mode-card"
              :class="{ selected: mode === m.id }"
              role="radio"
              :aria-checked="mode === m.id"
              :data-autofocus="i === 0 ? '' : undefined"
              @click="pickMode(m.id)"
            >
              <span class="mode-preview" :data-mode="m.id">
                <i /><i /><i />
              </span>
              <span class="mode-text">
                <em>{{ m.label }}</em>
                <small>{{ m.hint }}</small>
              </span>
            </button>
          </div>
        </section>

        <section class="block">
          <p class="block-label">皮肤包</p>
          <div class="skin-list" role="radiogroup" aria-label="皮肤包">
            <button
              type="button"
              class="skin-card"
              :class="{ selected: skinId === '' }"
              role="radio"
              :aria-checked="skinId === ''"
              @click="pickSkin('')"
            >
              <span class="skin-text">
                <em>默认</em>
                <small>不使用皮肤包</small>
              </span>
            </button>
            <div v-for="s in skins" :key="s.id" class="skin-row">
              <button
                type="button"
                class="skin-card"
                :class="{ selected: skinId === s.id }"
                role="radio"
                :aria-checked="skinId === s.id"
                :title="s.description || s.id"
                @click="pickSkin(s.id)"
              >
                <span class="skin-text">
                  <em>{{ s.name }}<i v-if="s.builtin" class="skin-badge">内置</i></em>
                  <small>{{ skinMeta(s) }}</small>
                </span>
              </button>
              <button
                type="button"
                class="skin-mini"
                :title="`导出 ${s.name}（zip 分享）`"
                aria-label="导出皮肤"
                @click.stop="exportSkinPack(s.id)"
              >
                <svg class="icon tiny" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
              </button>
              <button
                v-if="!s.builtin"
                type="button"
                class="skin-mini skin-remove"
                :title="`删除皮肤 ${s.name}`"
                aria-label="删除皮肤"
                :disabled="skinBusy"
                @click.stop="removeSkin(s.id)"
              >
                <svg class="icon tiny" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <p v-if="broken.length" class="skin-note">另有 {{ broken.length }} 个损坏皮肤包已跳过</p>
          <div class="skin-actions">
            <button type="button" class="skin-action skin-action-create" @click="openSkinCreate">AI 创造皮肤</button>
          </div>
          <div class="skin-actions">
            <button type="button" class="skin-action" @click="openMarket">皮肤市场</button>
            <button type="button" class="skin-action" :disabled="skinBusy" @click="pickSkinFile">上传 zip</button>
          </div>
          <div class="skin-actions">
            <button type="button" class="skin-action skin-action-create" @click="openMarketNpm">npm 市场 →</button>
            <button type="button" class="skin-action" @click="openSkinDir">打开皮肤目录</button>
          </div>
          <input
            ref="skinFileRef"
            class="skin-file"
            type="file"
            accept=".zip,application/zip"
            aria-label="选择皮肤包 zip"
            @change="onSkinFile"
          />
          <p class="skin-note">皮肤市场：上传即对这台服务端的所有用户可见，人人可装可切换；管理员可在「平台插件」停用市场。内置皮肤不可覆盖删除。</p>
        </section>

        <section class="block">
          <div class="depth-head">
            <p class="block-label">深浅</p>
            <span class="depth-value">{{ depth }}</span>
          </div>
          <p class="depth-hint">{{ depthLabel }}</p>
          <div class="depth-row">
            <span>浅</span>
            <input
              class="depth-slider"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="depth"
              :aria-label="`深浅 ${depth}`"
              @input="setDepth(Number(($event.target as HTMLInputElement).value))"
            />
            <span>深</span>
          </div>
        </section>

        <section class="block">
          <div class="fx-toggle">
            <div class="fx-copy">
              <p class="block-label">微特效</p>
              <p class="depth-hint">光斑漂浮、悬停抬起、进场动效（GSAP）</p>
            </div>
            <button
              type="button"
              class="fx-switch"
              role="switch"
              :aria-checked="fxEnabled"
              :title="fxEnabled ? '关闭微特效' : '开启微特效'"
              @click="setFxEnabled(!fxEnabled)"
            >
              <span class="fx-knob" />
            </button>
          </div>
        </section>

        <section class="block">
          <div class="fx-toggle">
            <div class="fx-copy">
              <p class="block-label">牛马桌宠</p>
              <p class="depth-hint">右下角的小牛马，开启时可拖拽换位</p>
            </div>
            <button
              type="button"
              class="fx-switch"
              role="switch"
              :aria-checked="buddyEnabled"
              :title="buddyEnabled ? '关闭牛马桌宠' : '开启牛马桌宠'"
              @click="setBuddyEnabled(!buddyEnabled)"
            >
              <span class="fx-knob" />
            </button>
          </div>
        </section>

        <section class="block">
          <p class="block-label">主题色</p>
          <div class="swatch-grid" role="listbox" aria-label="主题色">
            <button
              v-for="p in ACCENT_PRESETS"
              :key="p.id"
              type="button"
              class="swatch"
              :class="{ selected: accentId === p.id }"
              role="option"
              :aria-selected="accentId === p.id"
              :title="p.label"
              :aria-label="p.label"
              :style="{ '--swatch': p.color }"
              @click="pickAccent(p.id)"
            >
              <span class="swatch-fill" />
            </button>
            <label
              class="swatch custom"
              :class="{ selected: accentId === 'custom' }"
              title="自选颜色"
            >
              <input
                type="color"
                :value="customHex"
                aria-label="自选主题色"
                @input="onCustomColorInput"
              />
              <span class="swatch-fill custom-fill" :style="{ background: customHex }">
                <svg class="icon tiny" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </span>
            </label>
          </div>
          <div class="hex-row">
            <span>HEX</span>
            <input
              v-model="hexDraft"
              class="hex-input"
              spellcheck="false"
              maxlength="7"
              aria-label="主题色十六进制"
              @focus="hexDraft = activeBaseColor"
              @blur="onHexBlur"
              @keydown.enter.prevent="onHexBlur"
            />
          </div>
        </section>
      </div>
    </Teleport>

    <!-- AI 创造皮肤对话框 -->
    <Teleport to="body">
      <div v-if="skinCreateOpen" class="skin-create-overlay" @click.self="closeSkinCreate">
        <div class="skin-create" role="dialog" aria-label="AI 创造皮肤" @pointerdown.stop>
          <header class="create-head">
            <strong>AI 创造皮肤</strong>
            <button type="button" class="create-close" aria-label="关闭" @click="closeSkinCreate">
              <svg class="icon tiny" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>
          <p class="create-lead">
            描述想要的方向，澄台会在后台任务里完成整套设计（配色/边框/阴影/圆角一体）并产出皮肤包；任务完成后回到这里一键安装。
          </p>
          <label class="create-field">
            <span>使用模型（已过滤非对话模型）</span>
            <select v-model="modelKey" :disabled="!modelOptions.length" aria-label="选择创造皮肤用的模型">
              <option v-if="!modelOptions.length" value="">无可用对话模型</option>
              <option v-for="o in modelOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
            </select>
          </label>
          <p v-if="!modelOptions.length" class="create-model warn">未找到支持工具调用的对话模型——请先到「模型供应商」页启用一个</p>
          <label class="create-field">
            <span>风格方向</span>
            <input
              v-model="styleHint"
              :placeholder="SKIN_STYLE_PLACEHOLDER"
              @input="promptDraft = buildSkinCreationPrompt(styleHint)"
            />
          </label>
          <label class="create-field">
            <span>提示词（可改）</span>
            <textarea v-model="promptDraft" rows="9" spellcheck="false" />
          </label>
          <div v-if="createPhase === 'running' || createPhase === 'ready'" class="create-status">
            <span>
              任务已创建：<a :href="`#/tasks/${createTaskId}`" @click="closeSkinCreate">去任务页看过程</a>
            </span>
            <small>{{ createPhase === "running" ? "正在设计中…" : "设计完成 ✓" }}</small>
          </div>
          <div v-if="createPhase === 'failed'" class="create-error">{{ createError }}</div>
          <footer class="create-foot">
            <button class="ghost" type="button" @click="closeSkinCreate">{{ createPhase === "ready" ? "暂不安装" : "取消" }}</button>
            <button
              v-if="createPhase !== 'ready'"
              class="primary"
              type="button"
              :disabled="createPhase === 'creating' || createPhase === 'running' || !resolvedModel || !promptDraft.trim()"
              @click="startSkinCreate"
            >
              {{ createPhase === "creating" ? "创建中…" : createPhase === "running" ? "设计中…" : "创建任务开始设计" }}
            </button>
            <button v-else class="primary" type="button" :disabled="installingCreated" @click="installCreatedSkin">
              {{ installingCreated ? "安装中…" : "安装到皮肤列表" }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 皮肤市场：本服务器（全员共享）/ GitHub（跨组织共享）双源 -->
    <Teleport to="body">
      <div v-if="marketOpen" class="skin-create-overlay" @click.self="marketOpen = false">
        <div class="skin-create" role="dialog" aria-label="皮肤市场" @pointerdown.stop>
          <header class="create-head">
            <strong>皮肤市场</strong>
            <button type="button" class="create-close" aria-label="关闭" @click="marketOpen = false">
              <svg class="icon tiny" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>

          <div class="market-tabs" role="tablist">
            <button type="button" role="tab" :aria-selected="marketSource === 'server'" :class="{ active: marketSource === 'server' }" @click="switchMarketSource('server')">本服务器</button>
            <button type="button" role="tab" :aria-selected="marketSource === 'github'" :class="{ active: marketSource === 'github' }" @click="switchMarketSource('github')">GitHub</button>
            <button type="button" role="tab" :aria-selected="marketSource === 'npm'" :class="{ active: marketSource === 'npm' }" @click="switchMarketSource('npm')">npm</button>
          </div>

          <template v-if="marketSource === 'server'">
            <p class="create-lead">
              当前服务端上所有人共享的皮肤。任何登录用户「上传 zip」后，大家的列表里都会出现；管理员可在「平台插件」停用市场。
            </p>
            <div v-if="marketLoading" class="create-model">正在读取市场…</div>
            <div v-else-if="marketError" class="create-error">{{ marketError }}</div>
            <div v-else class="market-list">
              <div v-for="s in marketSkins" :key="s.id" class="market-row">
                <span class="skin-text">
                  <em>{{ s.name }}<i v-if="s.builtin" class="skin-badge">内置</i></em>
                  <small>{{ skinMeta(s) }}</small>
                </span>
                <button
                  type="button"
                  class="skin-action"
                  :class="{ 'skin-action-create': skinId === s.id }"
                  @click="applyFromMarket(s.id)"
                >
                  {{ skinId === s.id ? "已应用" : "应用" }}
                </button>
              </div>
              <p v-if="!marketSkins.length" class="create-model">市场还是空的——上传一个 zip 或用 AI 创造一个吧</p>
            </div>
            <footer class="create-foot">
              <button class="ghost" type="button" @click="marketOpen = false">关闭</button>
              <button class="primary" type="button" :disabled="skinBusy" @click="pickSkinFile">上传 zip 到市场</button>
            </footer>
          </template>

          <template v-else-if="marketSource === 'github'">
            <p class="create-lead">
              注册表托管在 GitHub 仓库，跨组织共享。想分享皮肤：在外观面板「导出」zip，提交到市场仓库并发 PR（见仓库 README）。
            </p>
            <div class="market-registry">
              <input v-model="registryUrl" placeholder="registry.json 的 raw 地址" spellcheck="false" @change="loadGithubSkins" />
              <button type="button" class="skin-action" :disabled="githubLoading" @click="loadGithubSkins">刷新</button>
            </div>
            <div v-if="githubLoading" class="create-model">正在从 GitHub 拉取清单…</div>
            <div v-else-if="githubError" class="create-error">{{ githubError }}</div>
            <div v-else class="market-list">
              <div v-for="s in githubSkins" :key="s.id" class="market-row">
                <span class="skin-text">
                  <em>{{ s.name }}<i v-if="skins.some((x) => x.id === s.id)" class="skin-badge">已装</i></em>
                  <small>{{ [s.version, s.author].filter(Boolean).join(" · ") || s.id }}</small>
                </span>
                <button
                  type="button"
                  class="skin-action"
                  :disabled="githubBusy === s.id"
                  @click="installFromGithub(s.id)"
                >
                  {{ githubBusy === s.id ? "安装中…" : skins.some((x) => x.id === s.id) ? "重装" : "安装" }}
                </button>
              </div>
              <p v-if="!githubSkins.length" class="create-model">注册表是空的或不可达——检查地址，或去贡献第一个皮肤</p>
            </div>
            <footer class="create-foot">
              <button class="ghost" type="button" @click="marketOpen = false">关闭</button>
            </footer>
          </template>

          <template v-else>
            <p class="create-lead">
              皮肤发布为 npm 包（约定包名 <code>muniu-skin-*</code>），走国内镜像，版本管理白送。发布：给皮肤目录加个 package.json 后 <code>npm publish</code>。
            </p>
            <div class="market-registry">
              <input v-model="npmQuery" placeholder="搜索 npm 皮肤（默认 muniu-skin）" spellcheck="false" @keydown.enter.prevent="searchNpm" />
              <button type="button" class="skin-action" :disabled="npmLoading" @click="searchNpm">搜索</button>
            </div>
            <div v-if="npmLoading" class="create-model">正在搜索…</div>
            <div v-else-if="npmError" class="create-error">{{ npmError }}</div>
            <div v-else class="market-list">
              <div v-for="s in npmSkins" :key="s.name" class="market-row">
                <span class="skin-text">
                  <em>{{ s.name }}</em>
                  <small>{{ [s.version, s.author].filter(Boolean).join(" · ") }}{{ s.description ? ` · ${s.description}` : "" }}</small>
                </span>
                <button type="button" class="skin-action" :disabled="npmBusy === s.name" @click="installFromNpm(s.name)">
                  {{ npmBusy === s.name ? "安装中…" : "安装" }}
                </button>
              </div>
            </div>
            <p v-if="!npmLoading && !npmError && !npmSkins.length" class="market-empty">
              没有搜到「{{ npmQuery }}」——可在下方直接输包名安装，或展开「发布我的皮肤」发第一个
            </p>
            <div class="market-registry">
              <input v-model="npmPkgDraft" placeholder="直接安装：包名 或 包名@版本" spellcheck="false" @keydown.enter.prevent="npmPkgDraft.trim() ? installFromNpm(npmPkgDraft.trim()) : undefined" />
              <button type="button" class="skin-action" :disabled="!npmPkgDraft.trim() || !!npmBusy" @click="installFromNpm(npmPkgDraft.trim())">安装</button>
            </div>

            <!-- 一键发布到 npm：其他人零配置直接装 -->
            <div class="publish-area">
              <button type="button" class="server-toggle-like" @click="togglePublish">
                {{ publishOpen ? "收起发布" : "发布我的皮肤到 npm" }}
              </button>
              <div v-if="publishOpen" class="publish-form">
                <label class="create-field">
                  <span>皮肤</span>
                  <select :value="publishSkinId" @change="selectPublishSkin(($event.target as HTMLSelectElement).value)">
                    <option v-for="s in skins" :key="s.id" :value="s.id">{{ s.name }}（{{ s.id }}）</option>
                  </select>
                </label>
                <div class="publish-row">
                  <label class="create-field">
                    <span>包名</span>
                    <input v-model="publishName" placeholder="muniu-skin-xxx" spellcheck="false" />
                  </label>
                  <label class="create-field">
                    <span>版本</span>
                    <input v-model="publishVersion" placeholder="1.0.0" spellcheck="false" />
                  </label>
                </div>
                <label class="create-field">
                  <span>npm 令牌 <a class="token-help" href="https://www.npmjs.com/settings/~/tokens" target="_blank" rel="noreferrer">如何获取？</a></span>
                  <input v-model="publishToken" type="password" placeholder="粘贴 npm 访问令牌（npm_xxx…）" spellcheck="false" />
                </label>
                <label class="remember-like">
                  <input v-model="publishRemember" type="checkbox" />
                  <span>记住令牌，下次发布免填（只存本机）</span>
                </label>
                <div class="create-foot">
                  <button class="primary" type="button" :disabled="publishing || !publishSkinId" @click="publishToNpm">
                    {{ publishing ? "发布中…" : "发布" }}
                  </button>
                </div>
              </div>
            </div>
            <footer class="create-foot">
              <button class="ghost" type="button" @click="marketOpen = false">关闭</button>
            </footer>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.theme-picker {
  position: relative;
  display: inline-flex;
}
.theme-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 9px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  box-shadow: none;
}
.theme-picker.inline .theme-trigger {
  width: auto;
  height: 36px;
  padding: 0 12px 0 10px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-1, 0 1px 3px rgba(0, 0, 0, 0.08));
}
/* 登录页白底上提高对比，避免「白按钮贴白底」 */
.theme-picker.inline .theme-trigger {
  background: #fff;
  border-color: #cfd6d1;
  color: #1a201d;
}
.theme-picker.inline .theme-trigger:hover,
.theme-picker.inline .theme-trigger.active {
  background: #f3f5f3;
  border-color: var(--accent);
  color: #1a201d;
}
.theme-trigger:hover,
.theme-trigger.active {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--border);
}
.theme-trigger:active {
  transform: none;
}
.trigger-label {
  font-size: 13px;
  font-weight: 560;
}
.swatch-dot {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--surface);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.theme-picker.inline .swatch-dot {
  position: static;
  width: 10px;
  height: 10px;
  margin-left: 2px;
}
</style>

<!-- Teleport 到 body：面板样式放全局，避免 scoped 丢样式导致「看不见却挡点击」 -->
<style>
.theme-panel {
  box-sizing: border-box;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--surface) 92%, #ffffff);
  box-shadow: var(--shadow-pop);
  color: var(--text);
  overflow-x: hidden;
  overflow-y: auto;
}
:root[data-theme="glass"] .theme-panel {
  background: var(--glass-pop);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
}
.theme-panel .panel-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 12px;
}
.theme-panel .panel-head strong {
  font-size: 14px;
}
.theme-panel .panel-head span {
  font-size: 12px;
  color: var(--text-3);
}
.theme-panel .block + .block {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border-faint);
}
.theme-panel .block-label {
  margin: 0 0 8px;
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
.theme-panel .mode-grid {
  display: grid;
  gap: 6px;
}
.theme-panel .mode-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  text-align: left;
  box-shadow: none;
}
.theme-panel .mode-card.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.theme-panel .mode-preview {
  width: 42px;
  height: 30px;
  border-radius: 8px;
  overflow: hidden;
  display: grid;
  grid-template-columns: 12px 1fr;
  gap: 3px;
  padding: 4px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
}
.theme-panel .mode-preview i {
  display: block;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.35;
}
.theme-panel .mode-preview i:first-child {
  grid-row: 1 / 3;
  opacity: 0.55;
}
.theme-panel .mode-preview[data-mode="light"] {
  background: #f4f6f4;
  color: #1a201d;
}
.theme-panel .mode-preview[data-mode="dark"] {
  background: #171c19;
  color: #e7ebe8;
}
.theme-panel .mode-preview[data-mode="glass"] {
  background: linear-gradient(160deg, #1a2740, #0b1220);
  color: #fff;
}
.theme-panel .mode-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.theme-panel .mode-text em {
  font-style: normal;
  font-size: 13px;
  font-weight: 650;
}
.theme-panel .mode-text small {
  font-size: 11.5px;
  color: var(--text-3);
}
.theme-panel .swatch-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.theme-panel .swatch {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: transparent;
  box-shadow: none;
  overflow: hidden;
}
.theme-panel .swatch-fill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--swatch);
  border-radius: 11px;
}
.theme-panel .swatch.selected,
.theme-panel .swatch.custom.selected {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
}
.theme-panel .swatch.custom {
  display: block;
  cursor: pointer;
  margin: 0;
}
.theme-panel .swatch.custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  border: none;
  padding: 0;
}
.theme-panel .custom-fill {
  display: grid;
  place-items: center;
}
.theme-panel .custom-fill .tiny {
  width: 14px;
  height: 14px;
  color: #fff;
  pointer-events: none;
}
.theme-panel .depth-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.theme-panel .depth-head .block-label {
  margin: 0;
}
.theme-panel .depth-value {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.theme-panel .depth-hint {
  margin: 4px 0 10px;
  font-size: 12px;
  color: var(--text-3);
}
.theme-panel .depth-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-3);
}
.theme-panel .depth-slider {
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--accent);
  height: 22px;
}
.theme-panel .fx-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.theme-panel .fx-copy .block-label {
  margin: 0;
}
.theme-panel .fx-copy .depth-hint {
  margin: 4px 0 0;
}
.theme-panel .fx-switch {
  position: relative;
  width: 42px;
  height: 24px;
  flex-shrink: 0;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  box-shadow: none;
}
.theme-panel .fx-switch[aria-checked="true"] {
  background: var(--accent);
  border-color: var(--accent);
}
.theme-panel .fx-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 0.18s ease;
}
.theme-panel .fx-switch[aria-checked="true"] .fx-knob {
  transform: translateX(18px);
}
.theme-panel .hex-row {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-3);
}
.theme-panel .hex-input {
  flex: 1;
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 6px 10px;
}
.theme-panel .skin-list {
  display: grid;
  gap: 6px;
}
.theme-panel .skin-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}
.theme-panel .skin-card {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  text-align: left;
  box-shadow: none;
}
.theme-panel .skin-card.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.theme-panel .skin-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.theme-panel .skin-text em {
  font-style: normal;
  font-size: 13px;
  font-weight: 650;
  display: flex;
  align-items: center;
  gap: 6px;
}
.theme-panel .skin-text small {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.theme-panel .skin-badge {
  font-style: normal;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  flex-shrink: 0;
}
.theme-panel .skin-remove {
  flex-shrink: 0;
  width: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-3);
}
.theme-panel .skin-remove:hover {
  color: var(--danger);
  border-color: var(--danger-border);
}
.theme-panel .skin-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.theme-panel .skin-action {
  flex: 1;
  padding: 7px 0;
  font-size: 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
}
.theme-panel .skin-action:hover {
  border-color: var(--accent-border);
  color: var(--accent-strong);
}
.theme-panel .skin-file {
  display: none;
}
.theme-panel .skin-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
}
.theme-panel .skin-action-create {
  color: var(--accent-strong);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}
.theme-panel .skin-action-create:hover {
  color: var(--accent-strong);
}
.theme-panel .skin-mini {
  flex: 0 0 30px;
  width: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-3);
}
.theme-panel .skin-mini:hover {
  color: var(--accent-strong);
  border-color: var(--accent-border);
}
.theme-panel .skin-mini.skin-remove:hover {
  color: var(--danger);
  border-color: var(--danger-border);
}
.theme-panel .skin-mini svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.skin-create-overlay {
  position: fixed;
  inset: 0;
  z-index: 1400;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--overlay);
}
:root[data-theme="glass"] .skin-create-overlay {
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.skin-create {
  box-sizing: border-box;
  width: min(560px, 100%);
  max-height: min(84vh, 720px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  box-shadow: var(--shadow-pop);
  color: var(--text);
}
:root[data-theme="glass"] .skin-create {
  background: var(--glass-pop);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
}
.create-head { display: flex; align-items: center; justify-content: space-between; }
.create-head strong { font-size: 15px; }
.create-close {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-3);
}
.create-close:hover { color: var(--text); }
.create-close svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.create-lead { margin: 0; font-size: 12px; line-height: 1.6; color: var(--text-3); }
.create-model { margin: -4px 0 0; font-size: 11.5px; color: var(--text-3); }
.create-model.warn { color: var(--warn); }
.create-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-2); }
.create-field input,
.create-field textarea { font-size: 12.5px; line-height: 1.6; }
.create-field textarea { font-family: var(--mono); resize: vertical; }
.create-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-2);
}
.create-status a { color: var(--accent); text-decoration: none; }
.create-status a:hover { text-decoration: underline; }
.create-error { font-size: 12px; color: var(--danger); }
.create-foot { display: flex; justify-content: flex-end; gap: 8px; }
.market-list { display: grid; gap: 8px; max-height: 46vh; overflow-y: auto; }
.market-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-2);
}
.market-row .skin-action { flex: 0 0 84px; }
.market-tabs { display: flex; gap: 6px; }
.market-tabs button {
  flex: 1;
  padding: 7px 0;
  font-size: 12.5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-3);
}
.market-tabs button.active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 650;
}
.market-registry { display: flex; gap: 8px; }
.market-registry input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 11.5px; }
.market-registry .skin-action { flex: 0 0 64px; }
.publish-area { border-top: 1px solid var(--border-faint); margin-top: 4px; padding-top: 10px; display: grid; gap: 8px; }
.market-empty { margin: 2px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); color: var(--text-3); font-size: 11.5px; line-height: 1.6; }
.token-help { color: var(--accent); text-decoration: none; margin-left: 6px; font-size: 11px; }
.token-help:hover { text-decoration: underline; }
.remember-like { display: flex; align-items: center; gap: 6px; margin: -2px 0 2px; font-size: 11.5px; color: var(--text-3); cursor: pointer; }
.remember-like input { width: 14px; height: 14px; }
.server-toggle-like {
  width: 100%;
  padding: 7px 0;
  font-size: 12px;
  border-radius: 10px;
  border: 1px dashed var(--border-strong);
  background: transparent;
  color: var(--text-3);
}
.server-toggle-like:hover { color: var(--accent-strong); border-color: var(--accent-border); }
.publish-form { display: grid; gap: 8px; }
.publish-row { display: grid; grid-template-columns: 1fr 100px; gap: 8px; }
.remember-like { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
</style>
