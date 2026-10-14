<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Deliverable } from "@office/shared";
import { API_BASE, getToken } from "../api";
import { formatSize, previewKind, timeAgo } from "../utils/format";
import { renderMarkdown } from "../utils/markdown";
import { toastError } from "../composables/toast";

const props = defineProps<{ taskId: string; file: Deliverable | null; deliverables: Deliverable[]; width?: string }>();
const emit = defineEmits<{ open: [file: Deliverable]; close: [] }>();

const kind = ref<"html" | "image" | "text" | "download">("text");
const content = ref("");
const htmlDoc = ref("");
const blobUrl = ref("");
const loading = ref(false);
// .md 默认渲染成排版视图，可切回源码
const viewMode = ref<"rendered" | "source">("rendered");
const isMd = computed(() => props.file !== null && /\.md$/i.test(props.file.filename));
const mdHtml = computed(() => (isMd.value ? renderMarkdown(content.value) : ""));

const TEXT_LIMIT = 512 * 1024;

// 没有成果物也没有打开文件时不占空间，会话独占宽度
const visible = computed(() => !!props.file || props.deliverables.length > 0);

function dlUrl(f: Deliverable): string {
  return `${API_BASE}/tasks/${props.taskId}/deliverables/${f.id}/download?token=${encodeURIComponent(getToken())}`;
}

function fileEmoji(name: string): string {
  const k = previewKind(name);
  if (k === "html") return "🌐";
  if (k === "image") return "🖼️";
  if (k === "text") return "📄";
  return "📦";
}

async function load(): Promise<void> {
  if (!props.file) return;
  kind.value = previewKind(props.file.filename);
  loading.value = true;
  content.value = "";
  htmlDoc.value = "";
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
      // sandbox + blob: src 在部分 Chromium 场景下不加载，改用 srcdoc（scripts 仍被 sandbox 阻止）
      htmlDoc.value = await blob.text();
    } else if (kind.value === "image") {
      blobUrl.value = URL.createObjectURL(blob);
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
    <aside v-if="visible" class="panel" :style="width ? { width } : undefined">
      <!-- 文件预览态 -->
      <template v-if="file">
        <header>
          <button class="icon-btn" title="返回成果物列表（Esc）" @click="emit('close')">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div class="head-text">
            <span class="fname" :title="file.relPath">{{ file.filename }}</span>
            <span class="fsize">{{ formatSize(file.size) }}</span>
          </div>
          <div class="head-actions">
            <div v-if="isMd && !loading && content" class="seg">
              <button type="button" :class="{ on: viewMode === 'rendered' }" @click="viewMode = 'rendered'">渲染</button>
              <button type="button" :class="{ on: viewMode === 'source' }" @click="viewMode = 'source'">源码</button>
            </div>
            <a class="mini" :href="dlUrl(file)" :download="file.filename">下载</a>
            <button class="icon-btn" title="关闭" @click="emit('close')">
              <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </header>
        <div class="body">
          <div v-if="loading" class="placeholder">加载中…</div>
          <iframe
            v-else-if="kind === 'html' && htmlDoc"
            :srcdoc="htmlDoc"
            sandbox=""
            class="frame"
            title="HTML 预览"
          ></iframe>
          <div v-else-if="kind === 'image' && blobUrl" class="image-wrap">
            <img :src="blobUrl" :alt="file.filename" />
          </div>
          <div
            v-else-if="isMd && viewMode === 'rendered' && content !== ''"
            class="md md-view"
            v-html="mdHtml"
          ></div>
          <pre v-else-if="content !== ''" class="code"><code>{{ content }}</code></pre>
          <div v-else class="placeholder">
            {{ truncated() ? "文件过大，仅支持下载查看" : "该类型暂不支持在线预览" }}
            <a class="dl" :href="dlUrl(file)" :download="file.filename">下载文件</a>
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
          </div>
        </header>
        <div class="list">
          <div v-for="f in deliverables" :key="f.id" class="row" @click="emit('open', f)">
            <span class="file-icon">{{ fileEmoji(f.filename) }}</span>
            <div class="f-main">
              <div class="f-name mono" :title="f.relPath">{{ f.relPath }}</div>
              <div class="f-sub">{{ formatSize(f.size) }} · {{ timeAgo(f.createdAt) }}</div>
            </div>
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
  gap: 8px;
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
