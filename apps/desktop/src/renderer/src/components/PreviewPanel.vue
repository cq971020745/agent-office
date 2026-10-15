<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Deliverable } from "@office/shared";
import { API_BASE, getToken } from "../api";
import { formatSize, previewKind, timeAgo, type PreviewKind } from "../utils/format";
import { renderMarkdown } from "../utils/markdown";
import { toast, toastError } from "../composables/toast";

const props = defineProps<{
  taskId: string;
  file: Deliverable | null;
  deliverables: Deliverable[];
  collapsed: boolean;
  width?: string;
  workspacePath?: string;
}>();
const emit = defineEmits<{
  open: [file: Deliverable];
  close: [];
  "update:collapsed": [value: boolean];
}>();

const kind = ref<PreviewKind>("text");
const content = ref("");
const htmlDoc = ref("");
const blobUrl = ref("");
const loading = ref(false);
// .md / .csv 默认渲染成排版/表格视图，可切回源码
const viewMode = ref<"rendered" | "source">("rendered");
const csvFilter = ref("");

const isMd = computed(() => props.file !== null && /\.md$/i.test(props.file.filename));
const isCsv = computed(() => props.file !== null && /\.(csv|tsv)$/i.test(props.file.filename));
const mdHtml = computed(() => (isMd.value ? renderMarkdown(content.value) : ""));

/** 解析 CSV/TSV 为二维数组（支持双引号包裹字段与转义引号） */
function parseDelimited(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= 500) break; // 预览上限 500 行，防止超大表卡顿
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

const csvTable = computed(() => {
  if (!isCsv.value || !content.value) return { headers: [] as string[], rows: [] as string[][] };
  const sep = /\.tsv$/i.test(props.file?.filename ?? "") ? "\t" : ",";
  const all = parseDelimited(content.value, sep);
  if (!all.length) return { headers: [] as string[], rows: [] as string[][] };
  const headers = all[0]!;
  const body = all.slice(1);
  const kw = csvFilter.value.trim().toLowerCase();
  const rows = kw ? body.filter((r) => r.some((c) => c.toLowerCase().includes(kw))) : body;
  return { headers, rows };
});

const TEXT_LIMIT = 512 * 1024;
const hasElectronBridge = computed(() => typeof window !== "undefined" && !!window.agentOffice);

// 没有成果物也没有打开文件时不占空间，会话独占宽度
const visible = computed(() => !!props.file || props.deliverables.length > 0);

function dlUrl(f: Deliverable): string {
  return `${API_BASE}/tasks/${props.taskId}/deliverables/${f.id}/download?token=${encodeURIComponent(getToken())}`;
}

function fileEmoji(name: string): string {
  const k = previewKind(name);
  if (k === "html") return "🌐";
  if (k === "image") return "🖼️";
  if (k === "pdf") return "📕";
  if (k === "audio") return "🎧";
  if (/\.(csv|tsv|xlsx|xls)$/i.test(name)) return "📊";
  if (k === "text") return "📄";
  return "📦";
}

function resolveLocalFilePath(f: Deliverable): string {
  if (!props.workspacePath) return "";
  const base = props.workspacePath.replace(/[\\/]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  const rel = f.relPath.replace(/[\\/]+/g, sep);
  return `${base}${sep}${rel}`;
}

async function openInSystemApp(f: Deliverable): Promise<void> {
  const fullPath = resolveLocalFilePath(f);
  if (!fullPath || !window.agentOffice?.openPath) return;
  const res = await window.agentOffice.openPath(fullPath);
  if (!res.ok) toastError(new Error(res.message || "无法打开文件"), "打开失败");
}

async function revealInFolder(f: Deliverable): Promise<void> {
  const fullPath = resolveLocalFilePath(f);
  if (!fullPath || !window.agentOffice?.showItemInFolder) return;
  const res = await window.agentOffice.showItemInFolder(fullPath);
  if (!res.ok) toastError(new Error(res.message || "无法在文件夹中显示"), "定位失败");
}

async function copyTextContent(): Promise<void> {
  const txt = content.value || htmlDoc.value;
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    toast("success", "文件内容已复制到剪贴板");
  } catch {
    toastError(new Error("复制失败"));
  }
}

async function load(): Promise<void> {
  if (!props.file) return;
  kind.value = previewKind(props.file.filename);
  loading.value = true;
  content.value = "";
  htmlDoc.value = "";
  csvFilter.value = "";
  viewMode.value = "rendered";
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = "";
  }
  try {
    const res = await fetch(`${API_BASE}/tasks/${props.taskId}/deliverables/${props.file.id}/download`, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error("加载文件失败");
    const blob = await res.blob();
    if (kind.value === "html") {
      htmlDoc.value = await blob.text();
    } else if (kind.value === "image" || kind.value === "pdf" || kind.value === "audio") {
      const mimeMap: Record<string, string> = {
        pdf: "application/pdf",
        audio: blob.type || "audio/mpeg",
      };
      const typedBlob =
        kind.value in mimeMap ? new Blob([blob], { type: mimeMap[kind.value] }) : blob;
      blobUrl.value = URL.createObjectURL(typedBlob);
    } else if (kind.value === "text" && blob.size <= TEXT_LIMIT) {
      content.value = await blob.text();
    }
  } catch (err) {
    toastError(err, "加载文件失败");
  } finally {
    loading.value = false;
  }
}

watch(() => props.file?.id, load, { immediate: true });

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && props.file) emit("close");
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});

const truncated = () => kind.value === "text" && props.file !== null && props.file.size > TEXT_LIMIT;
</script>

<template>
  <Transition name="slide">
    <aside
      v-if="visible"
      class="panel"
      :class="{ collapsed }"
      :style="collapsed ? undefined : width ? { width } : undefined"
    >
      <!-- 收起后保留窄侧栏，避免用户失去重新展开成果物的入口 -->
      <button
        v-if="collapsed"
        type="button"
        class="collapsed-trigger"
        title="展开成果物面板"
        aria-label="展开成果物面板"
        :aria-expanded="false"
        @click="emit('update:collapsed', false)"
      >
        <svg class="icon rail-chevron" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
        <svg class="icon rail-folder" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
        <span class="rail-label">成果物</span>
        <span class="rail-count">{{ deliverables.length }}</span>
      </button>

      <!-- 文件预览态 -->
      <template v-else-if="file">
        <header>
          <button class="icon-btn" title="返回成果物列表（Esc）" @click="emit('close')">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div class="head-text">
            <span class="fname" :title="file.relPath">{{ file.filename }}</span>
            <span class="fsize">{{ formatSize(file.size) }}</span>
          </div>
          <div class="head-actions">
            <div v-if="(isMd || isCsv) && !loading && content" class="seg">
              <button type="button" :class="{ on: viewMode === 'rendered' }" @click="viewMode = 'rendered'">
                {{ isCsv ? "表格" : "渲染" }}
              </button>
              <button type="button" :class="{ on: viewMode === 'source' }" @click="viewMode = 'source'">源码</button>
            </div>
            <button
              v-if="content || htmlDoc"
              type="button"
              class="icon-btn"
              title="复制全文内容"
              @click="copyTextContent"
            >
              <svg class="icon" viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            <button
              v-if="hasElectronBridge && workspacePath"
              type="button"
              class="icon-btn"
              title="在文件夹中定位文件"
              @click="revealInFolder(file)"
            >
              <svg class="icon" viewBox="0 0 24 24">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              v-if="hasElectronBridge && workspacePath"
              type="button"
              class="icon-btn"
              title="用系统默认程序打开（如 WPS）"
              @click="openInSystemApp(file)"
            >
              <svg class="icon" viewBox="0 0 24 24">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </button>
            <a class="mini" :href="dlUrl(file)" :download="file.filename">下载</a>
            <button
              type="button"
              class="icon-btn"
              title="收起成果物面板"
              aria-label="收起成果物面板"
              :aria-expanded="true"
              @click="emit('update:collapsed', true)"
            >
              <svg class="icon" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
            </button>
            <button class="icon-btn" title="关闭" @click="emit('close')">
              <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </header>
        <div class="body">
          <div v-if="loading" class="placeholder">加载中…</div>
          <!-- HTML 预览：允许脚本运行以支持 ECharts/Chart.js 图表与交互单页，保持同源隔离 -->
          <iframe
            v-else-if="kind === 'html' && htmlDoc"
            :srcdoc="htmlDoc"
            sandbox="allow-scripts"
            class="frame"
            title="HTML 预览"
          ></iframe>
          <!-- PDF 内联预览 -->
          <iframe
            v-else-if="kind === 'pdf' && blobUrl"
            :src="blobUrl"
            class="frame"
            title="PDF 预览"
          ></iframe>
          <!-- 音频成果物内联试听 -->
          <div v-else-if="kind === 'audio' && blobUrl" class="audio-wrap">
            <div class="audio-card">
              <div class="audio-icon">🎧</div>
              <div class="audio-name">{{ file.filename }}</div>
              <audio controls :src="blobUrl" class="audio-player" />
            </div>
          </div>
          <!-- 图片预览 -->
          <div v-else-if="kind === 'image' && blobUrl" class="image-wrap">
            <img :src="blobUrl" :alt="file.filename" />
          </div>
          <!-- CSV / TSV 结构化表格视图 -->
          <div
            v-else-if="isCsv && viewMode === 'rendered' && csvTable.headers.length"
            class="csv-wrap"
          >
            <div class="csv-bar">
              <input v-model="csvFilter" class="csv-search" placeholder="筛选表格内容…" />
              <span class="csv-count">共 {{ csvTable.rows.length }} 行</span>
            </div>
            <div class="csv-scroll">
              <table class="csv-table">
                <thead>
                  <tr>
                    <th class="row-num">#</th>
                    <th v-for="(h, hi) in csvTable.headers" :key="hi">{{ h }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, ri) in csvTable.rows" :key="ri">
                    <td class="row-num">{{ ri + 1 }}</td>
                    <td v-for="(_, ci) in csvTable.headers" :key="ci">{{ r[ci] ?? "" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <!-- Markdown 渲染视图 -->
          <div
            v-else-if="isMd && viewMode === 'rendered' && content !== ''"
            class="md md-view"
            v-html="mdHtml"
          ></div>
          <!-- 源码 / 文本视图 -->
          <pre v-else-if="content !== ''" class="code"><code>{{ content }}</code></pre>
          <div v-else class="placeholder">
            {{ truncated() ? "文件过大，仅支持下载或用本机软件查看" : "该文件格式适合使用专业办公软件查看" }}
            <div class="placeholder-actions">
              <button
                v-if="hasElectronBridge && workspacePath"
                type="button"
                class="primary"
                @click="openInSystemApp(file)"
              >
                用默认程序打开（如 WPS）
              </button>
              <a class="dl" :href="dlUrl(file)" :download="file.filename">下载文件</a>
            </div>
          </div>
        </div>
      </template>

      <!-- 成果物列表态 -->
      <template v-else>
        <header>
          <div class="head-text">
            <svg class="icon lt-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            <span class="lname">成果物</span>
            <span class="lcount">{{ deliverables.length }}</span>
          </div>
          <div class="head-actions">
            <span class="lt-hint">点击文件在线预览</span>
            <button
              type="button"
              class="icon-btn"
              title="收起成果物面板"
              aria-label="收起成果物面板"
              :aria-expanded="true"
              @click="emit('update:collapsed', true)"
            >
              <svg class="icon" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
        </header>
        <div class="list">
          <div v-for="f in deliverables" :key="f.id" class="row" @click="emit('open', f)">
            <span class="file-icon">{{ fileEmoji(f.filename) }}</span>
            <div class="f-main">
              <div class="f-name mono" :title="f.relPath">{{ f.relPath }}</div>
              <div class="f-sub">{{ formatSize(f.size) }} · {{ timeAgo(f.createdAt) }}</div>
            </div>
            <button
              v-if="hasElectronBridge && workspacePath"
              type="button"
              class="icon-btn row-act"
              title="在文件夹中定位"
              @click.stop="revealInFolder(f)"
            >
              <svg class="icon" viewBox="0 0 24 24">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <a class="dl" :href="dlUrl(f)" :download="f.filename" @click.stop>下载</a>
          </div>
          <div v-if="!deliverables.length" class="placeholder">Agent 写入工作区的文件会出现在这里</div>
        </div>
      </template>
    </aside>
  </Transition>
</template>

<style scoped>
.panel {
  width: clamp(340px, 36%, 540px);
  flex-shrink: 0;
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.18s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.panel.collapsed {
  width: 44px !important;
  min-width: 44px;
}
.collapsed-trigger {
  width: 100%;
  height: 100%;
  padding: 11px 0;
  border: none;
  border-radius: 0;
  background: var(--surface);
  box-shadow: none;
  color: var(--text-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.collapsed-trigger:hover {
  border-color: transparent;
  background: var(--surface-2);
  color: var(--text);
}
.collapsed-trigger:active {
  transform: none;
}
.rail-chevron {
  width: 16px;
  height: 16px;
}
.rail-folder {
  width: 15px;
  height: 15px;
  margin-top: 2px;
}
.rail-label {
  writing-mode: vertical-rl;
  text-orientation: upright;
  letter-spacing: 0.08em;
  font-size: 12px;
  font-weight: 600;
}
.rail-count {
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.head-text {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.fname {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fsize {
  color: var(--text-3);
  font-size: 12px;
  flex-shrink: 0;
}
.lt-icon {
  width: 15px;
  height: 15px;
  color: var(--text-3);
  flex-shrink: 0;
}
.lname {
  font-weight: 700;
  font-size: 13.5px;
}
.lcount {
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 0 8px;
  line-height: 1.7;
}
.lt-hint {
  font-size: 11.5px;
  color: var(--text-3);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.mini {
  font-size: 12.5px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}
.mini:hover {
  text-decoration: underline;
}
.icon-btn {
  width: auto;
  padding: 5px;
  border: none;
  background: none;
  box-shadow: none;
  color: var(--text-3);
  display: grid;
  place-items: center;
  border-radius: 7px;
}
.icon-btn:hover {
  color: var(--text);
  background: var(--surface-2);
}
.icon {
  width: 14px;
  height: 14px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.frame {
  border: none;
  width: 100%;
  height: 100%;
  background: #fff;
}
.audio-wrap {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
}
.audio-card {
  width: min(360px, 100%);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.audio-icon {
  font-size: 36px;
}
.audio-name {
  font-weight: 600;
  font-size: 13.5px;
  text-align: center;
  word-break: break-all;
}
.audio-player {
  width: 100%;
}
.image-wrap {
  flex: 1;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 16px;
  background:
    conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%, var(--surface-2) 0 75%, var(--surface) 0) 0 0/20px 20px;
}
.image-wrap img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: var(--shadow-2);
}

/* CSV 表格视图 */
.csv-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.csv-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.csv-search {
  max-width: 240px;
  padding: 5px 10px;
  font-size: 12.5px;
}
.csv-count {
  font-size: 11.5px;
  color: var(--text-3);
}
.csv-scroll {
  flex: 1;
  overflow: auto;
}
.csv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.csv-table th {
  position: sticky;
  top: 0;
  background: var(--surface-2);
  color: var(--text);
  font-weight: 600;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-strong);
  white-space: nowrap;
  z-index: 1;
}
.csv-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-faint);
  white-space: nowrap;
}
.csv-table .row-num {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 11px;
  width: 36px;
  text-align: right;
}

.code {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 16px 18px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
  background: var(--code-bg);
  color: var(--code-text);
  white-space: pre;
}
.md-view {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 28px;
  font-size: 13px;
  line-height: 1.78;
}
.seg {
  display: flex;
  gap: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
}
.seg button {
  border: none;
  background: transparent;
  box-shadow: none;
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 6px;
  color: var(--text-3);
}
.seg button.on {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}

/* 成果物列表 */
.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s;
}
.row:hover {
  background: var(--surface-2);
}
.row .file-icon {
  font-size: 17px;
  flex-shrink: 0;
}
.f-main {
  flex: 1;
  min-width: 0;
}
.f-name {
  font-weight: 600;
  color: var(--text);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 1px;
}
.dl {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 7px;
}
.dl:hover {
  background: var(--accent-soft);
}
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-3);
  font-size: 13px;
  padding: 0 20px;
  text-align: center;
}
.placeholder-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateX(18px);
}
</style>
