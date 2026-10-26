<script setup lang="ts">
/**
 * 任务预览区内嵌浏览器：多标签 + 网页标注。
 * 依赖 Electron <webview>（非桌面环境显示降级提示）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  buildArmPickerScript,
  buildCancelPickerScript,
  formatAnnotationPrompt,
  type PickedElement,
} from "../browser/annotate-picker";
import { toast, toastError } from "../composables/toast";

const props = withDefaults(
  defineProps<{
    /** 首个标签的初始地址 */
    initialUrl?: string;
  }>(),
  { initialUrl: "" }
);

const emit = defineEmits<{
  annotate: [payload: { prompt: string; screenshot?: File }];
}>();

const hasElectron = computed(() => typeof window !== "undefined" && !!window.agentOffice);

/** Electron webview 运行时类型 */
interface ElectronWebview extends HTMLElement {
  src: string;
  getURL: () => string;
  getTitle: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  getWebContentsId?: () => number;
  executeJavaScript: <T = unknown>(code: string, userGesture?: boolean) => Promise<T>;
  capturePage?: () => Promise<{ toPNG: () => Uint8Array; toDataURL: () => string }>;
  addEventListener: HTMLElement["addEventListener"];
  removeEventListener: HTMLElement["removeEventListener"];
}

interface BrowserTab {
  id: string;
  title: string;
  url: string;
  address: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

let tabSeq = 1;
function newTabId(): string {
  return `tab-${Date.now()}-${tabSeq++}`;
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t;
  return `http://${t}`;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname || u.href;
  } catch {
    return url.slice(0, 32) || "新标签页";
  }
}

/** 空白起始；勿默认 38618（开发时那是 Electron 渲染进程自己的 Vite，嵌进 webview 会一直转圈） */
const BLANK = "about:blank";
const startUrl = normalizeUrl(props.initialUrl) || BLANK;
const tabs = ref<BrowserTab[]>([
  {
    id: newTabId(),
    title: startUrl === BLANK ? "新标签页" : titleFromUrl(startUrl),
    url: startUrl,
    address: startUrl === BLANK ? "" : startUrl,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  },
]);
const activeTabId = ref(tabs.value[0]!.id);
const webviewMap = new Map<string, ElectronWebview>();

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? tabs.value[0]!);
const showStartPage = computed(() => {
  const t = activeTab.value;
  return !t || t.url === BLANK || !t.url;
});
const address = computed({
  get: () => activeTab.value?.address ?? "",
  set: (v: string) => {
    const t = tabs.value.find((x) => x.id === activeTabId.value);
    if (t) t.address = v;
  },
});
const loading = computed(() => activeTab.value?.loading ?? false);
const canGoBack = computed(() => activeTab.value?.canGoBack ?? false);
const canGoForward = computed(() => activeTab.value?.canGoForward ?? false);

const annotating = ref(false);
const picking = ref(false);
const pick = ref<PickedElement | null>(null);
const comment = ref("");
const submitting = ref(false);
let pickAbort = false;

function activeWebview(): ElectronWebview | null {
  return webviewMap.get(activeTabId.value) ?? null;
}

function syncNav(tabId: string): void {
  const wv = webviewMap.get(tabId);
  const tab = tabs.value.find((t) => t.id === tabId);
  if (!wv || !tab) return;
  try {
    tab.canGoBack = wv.canGoBack();
    tab.canGoForward = wv.canGoForward();
    const u = wv.getURL();
    if (u && u !== "about:blank") {
      tab.url = u;
      if (tabId === activeTabId.value) tab.address = u;
      try {
        const title = wv.getTitle()?.trim();
        tab.title = title || titleFromUrl(u);
      } catch {
        tab.title = titleFromUrl(u);
      }
    }
  } catch {
    // webview 尚未就绪
  }
}

function navigate(): void {
  const tab = activeTab.value;
  const wv = activeWebview();
  const url = normalizeUrl(tab.address);
  if (!tab || !wv || !url) return;
  tab.address = url;
  tab.url = url;
  tab.title = titleFromUrl(url);
  tab.loading = true;
  try {
    wv.src = url;
  } catch (err) {
    toastError(err, "无法打开地址");
    tab.loading = false;
  }
}

function openQuick(url: string): void {
  const tab = activeTab.value;
  if (!tab) return;
  tab.address = url;
  navigate();
}

function goBack(): void {
  activeWebview()?.goBack();
}
function goForward(): void {
  activeWebview()?.goForward();
}
function reload(): void {
  activeWebview()?.reload();
}

function addTab(url?: string): void {
  const raw = normalizeUrl(url || "");
  const u = raw || BLANK;
  const tab: BrowserTab = {
    id: newTabId(),
    title: u === BLANK ? "新标签页" : titleFromUrl(u),
    url: u,
    address: u === BLANK ? "" : u,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  // 切换标签时若在标注，先停掉旧页拾取
  if (annotating.value) {
    void cancelPicker().then(() => {
      pick.value = null;
      void nextTick(() => armPicker());
    });
  }
}

async function closeTab(id: string, ev?: Event): Promise<void> {
  ev?.stopPropagation();
  if (tabs.value.length <= 1) {
    // 最后一个标签：重置为空白页，不关掉整个浏览器区
    const only = tabs.value[0]!;
    only.url = BLANK;
    only.address = "";
    only.title = "新标签页";
    only.loading = false;
    only.canGoBack = false;
    only.canGoForward = false;
    const wv = webviewMap.get(only.id);
    if (wv) {
      try {
        wv.src = BLANK;
      } catch {
        // ignore
      }
    }
    return;
  }
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (id === activeTabId.value && annotating.value) await cancelPicker();
  tabs.value.splice(idx, 1);
  webviewMap.delete(id);
  if (activeTabId.value === id) {
    const next = tabs.value[Math.max(0, idx - 1)]!;
    activeTabId.value = next.id;
    if (annotating.value) {
      pick.value = null;
      void nextTick(() => armPicker());
    }
  }
}

async function selectTab(id: string): Promise<void> {
  if (id === activeTabId.value) return;
  if (annotating.value) {
    await cancelPicker();
    pick.value = null;
  }
  activeTabId.value = id;
  syncNav(id);
  if (annotating.value) void nextTick(() => armPicker());
}

async function cancelPicker(): Promise<void> {
  pickAbort = true;
  picking.value = false;
  const wv = activeWebview();
  if (!wv) return;
  try {
    await wv.executeJavaScript(buildCancelPickerScript());
  } catch {
    // ignore
  }
}

async function armPicker(): Promise<void> {
  const wv = activeWebview();
  if (!wv || !annotating.value) return;
  pickAbort = false;
  picking.value = true;
  pick.value = null;
  try {
    const result = await wv.executeJavaScript<PickedElement | null>(buildArmPickerScript(), true);
    if (pickAbort || !annotating.value) return;
    picking.value = false;
    if (result) {
      pick.value = result;
      comment.value = "";
    } else if (annotating.value) {
      void armPicker();
    }
  } catch (err) {
    picking.value = false;
    if (annotating.value) {
      toastError(err, "标注拾取失败，请刷新页面后重试");
      annotating.value = false;
    }
  }
}

async function toggleAnnotate(): Promise<void> {
  if (!hasElectron.value) {
    toast("error", "网页标注仅在桌面客户端可用");
    return;
  }
  if (annotating.value) {
    annotating.value = false;
    pick.value = null;
    await cancelPicker();
    return;
  }
  annotating.value = true;
  await nextTick();
  void armPicker();
}

/** 优先走主进程截图；失败则跳过截图，绝不在渲染进程硬调 capturePage（易整窗白屏） */
async function captureActivePage(): Promise<File | undefined> {
  const wv = activeWebview();
  if (!wv) return undefined;
  try {
    const id = typeof wv.getWebContentsId === "function" ? wv.getWebContentsId() : 0;
    if (id && window.agentOffice?.captureWebContents) {
      const res = await window.agentOffice.captureWebContents(id);
      if (res.ok && res.png?.byteLength) {
        // IPC 传回的 Uint8Array 底层是 ArrayBufferLike，BlobPart 需要确切的 ArrayBuffer
        const bytes = new Uint8Array(res.png);
        return new File([bytes.buffer as ArrayBuffer], `annotate-${Date.now()}.png`, { type: "image/png" });
      }
    }
  } catch {
    // 无截图也能发文字标注
  }
  return undefined;
}

async function submitAnnotation(): Promise<void> {
  if (!pick.value || submitting.value) return;
  submitting.value = true;
  try {
    // 先关掉拾取态，避免发送过程中 guest 再弹窗/导航干扰主窗口
    const picked = pick.value;
    const note = comment.value;
    pick.value = null;
    comment.value = "";
    annotating.value = false;
    await cancelPicker();

    const screenshot = await captureActivePage();
    const prompt = formatAnnotationPrompt(picked, note, !!screenshot);
    emit("annotate", { prompt, screenshot });
    toast("success", screenshot ? "标注已发送到任务对话" : "标注已发送（截图跳过）");
  } catch (err) {
    toastError(err, "发送标注失败");
  } finally {
    submitting.value = false;
  }
}

function dismissPick(): void {
  pick.value = null;
  if (annotating.value) void armPicker();
}

function onDidStartLoading(tabId: string): void {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab && tab.url !== BLANK) tab.loading = true;
}
function onDidStopLoading(tabId: string): void {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab) tab.loading = false;
  syncNav(tabId);
}
function onDidFailLoad(tabId: string): void {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab) tab.loading = false;
}
function onDidNavigate(tabId: string): void {
  syncNav(tabId);
  if (tabId === activeTabId.value && annotating.value && !pick.value) {
    void cancelPicker().then(() => armPicker());
  }
}

function bindTabWebview(tabId: string, el: ElectronWebview | null): void {
  const prev = webviewMap.get(tabId);
  const start = () => onDidStartLoading(tabId);
  const stop = () => onDidStopLoading(tabId);
  const fail = () => onDidFailLoad(tabId);
  const nav = () => onDidNavigate(tabId);
  if (prev) {
    prev.removeEventListener("did-start-loading", start);
    prev.removeEventListener("did-stop-loading", stop);
    prev.removeEventListener("did-fail-load", fail);
    prev.removeEventListener("did-navigate", nav);
    prev.removeEventListener("did-navigate-in-page", nav);
    prev.removeEventListener("page-title-updated", nav);
  }
  if (!el) {
    webviewMap.delete(tabId);
    return;
  }
  webviewMap.set(tabId, el);
  el.addEventListener("did-start-loading", start);
  el.addEventListener("did-stop-loading", stop);
  el.addEventListener("did-fail-load", fail);
  el.addEventListener("did-navigate", nav);
  el.addEventListener("did-navigate-in-page", nav);
  el.addEventListener("page-title-updated", nav);
  const tab = tabs.value.find((t) => t.id === tabId);
  // 仅在有真实 URL 时赋值；about:blank 保持空白，避免误加载
  if (tab?.url && tab.url !== BLANK) {
    try {
      const cur = el.getURL();
      if (!cur || cur === "about:blank") el.src = tab.url;
    } catch {
      try {
        el.src = tab.url;
      } catch {
        // ignore
      }
    }
  }
}

function setWebviewRef(tabId: string, el: unknown): void {
  bindTabWebview(tabId, (el as ElectronWebview | null) ?? null);
}

watch(
  () => props.initialUrl,
  (u) => {
    if (!u?.trim() || tabs.value.length !== 1) return;
    const url = normalizeUrl(u);
    if (!url || url === BLANK) return;
    const tab = tabs.value[0]!;
    tab.url = url;
    tab.address = url;
    tab.title = titleFromUrl(url);
    const wv = webviewMap.get(tab.id);
    if (wv) {
      try {
        wv.src = url;
      } catch {
        // ignore
      }
    }
  }
);

onBeforeUnmount(() => {
  void cancelPicker();
  for (const id of [...webviewMap.keys()]) bindTabWebview(id, null);
});
</script>

<template>
  <div class="browser">
    <!-- 多标签栏 -->
    <div class="tab-bar">
      <div class="tab-scroll">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          class="tab"
          :class="{ on: t.id === activeTabId }"
          :title="t.url"
          @click="selectTab(t.id)"
        >
          <span class="tab-title">{{ t.title }}</span>
          <span class="tab-close" title="关闭标签" @click="closeTab(t.id, $event)">✕</span>
        </button>
      </div>
      <button type="button" class="tab-add" title="新建标签页" :disabled="!hasElectron" @click="addTab()">
        +
      </button>
    </div>

    <div class="chrome">
      <button type="button" class="nav" :disabled="!canGoBack" title="后退" @click="goBack">
        <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <button type="button" class="nav" :disabled="!canGoForward" title="前进" @click="goForward">
        <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
      </button>
      <button type="button" class="nav" title="刷新" @click="reload">
        <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
      </button>
      <form class="addr-form" @submit.prevent="navigate">
        <input
          v-model="address"
          class="addr"
          type="text"
          spellcheck="false"
          placeholder="输入要预览的地址，例如 http://127.0.0.1:3000/"
          :disabled="!hasElectron"
        />
      </form>
      <button
        type="button"
        class="annotate-btn"
        :class="{ on: annotating }"
        :disabled="!hasElectron"
        :title="annotating ? '退出标注（Esc 取消当前拾取）' : '开启网页标注：点击页面元素并说明修改'"
        @click="toggleAnnotate"
      >
        <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
        {{ annotating ? "标注中" : "标注" }}
      </button>
    </div>

    <div v-if="annotating" class="annotate-bar">
      <span v-if="picking && !pick">在页面上点击要修改的元素…（Esc 取消本次）</span>
      <span v-else-if="pick">已选中 &lt;{{ pick.tag }}&gt;，填写说明后发送</span>
      <span v-else>标注模式已开</span>
    </div>

    <div class="stage">
      <div v-if="!hasElectron" class="fallback">
        <p>内嵌浏览器与网页标注仅在桌面客户端可用。</p>
        <p class="muted">请使用 Electron 打包的木牛流马客户端打开任务详情。</p>
      </div>
      <template v-else>
        <!-- 不用 allowpopups：guest 弹窗会变成只剩菜单的空白 BrowserWindow -->
        <webview
          v-for="t in tabs"
          :key="t.id"
          :ref="(el: unknown) => setWebviewRef(t.id, el)"
          class="wv"
          :class="{ hidden: t.id !== activeTabId }"
          webpreferences="contextIsolation=yes, nodeIntegration=no, javascript=yes"
        />
        <div v-if="showStartPage" class="start-page">
          <h3>打开网页预览</h3>
          <p>在上方地址栏输入本地或内网前端地址后回车。</p>
          <p class="muted">开发时请勿填本客户端的 38618 端口（那是桌面窗口自己的页面）。</p>
          <div class="quick">
            <button type="button" @click="openQuick('http://127.0.0.1:3000/')">localhost:3000</button>
            <button type="button" @click="openQuick('http://127.0.0.1:8080/')">localhost:8080</button>
            <button type="button" @click="openQuick('http://127.0.0.1:4173/')">localhost:4173</button>
          </div>
        </div>
      </template>
      <div v-if="loading && !showStartPage" class="loading-mask">加载中…</div>

      <div v-if="pick" class="pick-card">
        <div class="pick-head">
          <strong>&lt;{{ pick.tag }}&gt;</strong>
          <span class="pick-path" :title="pick.cssPath">{{ pick.cssPath }}</span>
          <button type="button" class="x" title="取消" @click="dismissPick">✕</button>
        </div>
        <p v-if="pick.text" class="pick-text">{{ pick.text }}</p>
        <textarea
          v-model="comment"
          rows="3"
          placeholder="说明要怎么改（文案、样式、布局…）"
          @keydown.ctrl.enter.prevent="submitAnnotation"
        />
        <div class="pick-actions">
          <button type="button" class="ghost" @click="dismissPick">重选</button>
          <button type="button" class="primary" :disabled="submitting" @click="submitAnnotation">
            {{ submitting ? "发送中…" : "发送到对话" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface);
}
.tab-bar {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 6px 0;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  min-height: 34px;
}
.tab-scroll {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 160px;
  min-width: 72px;
  height: 28px;
  padding: 0 8px 0 10px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.tab:hover {
  background: var(--surface);
  color: var(--text-2);
}
.tab.on {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
  font-weight: 600;
}
.tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.tab-close {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  font-size: 10px;
  color: var(--text-3);
  flex-shrink: 0;
  line-height: 1;
}
.tab-close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.tab-add {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  margin-bottom: 1px;
}
.tab-add:hover:not(:disabled) {
  background: var(--surface);
  color: var(--text);
}
.tab-add:disabled {
  opacity: 0.4;
  cursor: default;
}
.chrome {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--surface-2);
}
.nav {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.nav:disabled {
  opacity: 0.35;
  cursor: default;
}
.nav:not(:disabled):hover {
  background: var(--surface);
  color: var(--text);
}
.nav svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.addr-form {
  flex: 1;
  min-width: 0;
}
.addr {
  width: 100%;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 10px;
  font-size: 12.5px;
  background: var(--surface);
  color: var(--text);
  outline: none;
}
.addr:focus {
  border-color: var(--accent);
}
.annotate-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.annotate-btn svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.annotate-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}
.annotate-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
  font-weight: 600;
}
.annotate-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.annotate-bar {
  flex-shrink: 0;
  padding: 5px 10px;
  font-size: 11.5px;
  color: var(--accent);
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border);
}
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #fff;
}
.wv {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
}
.wv.hidden {
  visibility: hidden;
  pointer-events: none;
  z-index: 0;
}
.wv:not(.hidden) {
  z-index: 1;
}
.fallback {
  height: 100%;
  display: grid;
  place-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}
.fallback .muted {
  color: var(--text-3);
  font-size: 12px;
}
.start-page {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  background: var(--surface);
  color: var(--text-2);
  text-align: center;
}
.start-page h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text);
}
.start-page p {
  margin: 0;
  font-size: 13px;
  max-width: 320px;
  line-height: 1.45;
}
.start-page .muted {
  color: var(--text-3);
  font-size: 12px;
}
.start-page .quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 8px;
}
.start-page .quick button {
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}
.start-page .quick button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.loading-mask {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  pointer-events: none;
  z-index: 3;
}
.pick-card {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: min(320px, calc(100% - 24px));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-pop);
  padding: 10px 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pick-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pick-head strong {
  font-size: 12.5px;
  flex-shrink: 0;
}
.pick-path {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
}
.pick-head .x {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.pick-head .x:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.pick-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  max-height: 3.2em;
  overflow: hidden;
}
.pick-card textarea {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--surface-2);
  color: var(--text);
  outline: none;
}
.pick-card textarea:focus {
  border-color: var(--accent);
}
.pick-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pick-actions .ghost,
.pick-actions .primary {
  border-radius: 8px;
  font-size: 12.5px;
  padding: 5px 12px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
.pick-actions .primary {
  background: var(--accent);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}
.pick-actions .primary:disabled {
  opacity: 0.55;
  cursor: default;
}
.pick-actions .ghost:hover {
  background: var(--surface-2);
}
</style>
