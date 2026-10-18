<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { WpsMention } from "@office/shared";
import {
  getWpsDriveDoclibs,
  getWpsDriveEntries,
  getWpsDriveRecent,
  getWpsDriveSearch,
  type WpsDriveEntry,
} from "../api";

const emit = defineEmits<{ (e: "close"): void; (e: "confirm", picks: WpsMention[]): void }>();

// ---------- 视图与浏览层级（面包屑栈） ----------
type View = "recent" | "private" | "team";

interface Level {
  title: string;
  parent: string;
  drive: string; // 空串表示团队文档库顶层（列出文档库本身）
}

const VIEW_TITLES: Record<View, string> = {
  recent: "最近",
  private: "我的云文档",
  team: "团队文档库",
};

const view = ref<View>("recent");
const stack = ref<Level[]>([{ title: "最近", parent: "root", drive: "" }]);
const entries = ref<WpsDriveEntry[]>([]);
const loading = ref(false);
const error = ref("");
const query = ref("");
const searching = ref(false);

const isSearchMode = computed(() => !!query.value.trim());

async function loadCurrent(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    if (view.value === "recent") {
      entries.value = (await getWpsDriveRecent()).entries;
    } else if (view.value === "team" && stack.value.length <= 1) {
      // 团队文档库首层：列出我有权限的文档库（每个库再进入按目录浏览）
      entries.value = (await getWpsDriveDoclibs()).entries;
    } else {
      const top = stack.value[stack.value.length - 1]!;
      entries.value = (await getWpsDriveEntries(top.parent || "root", top.drive || undefined)).entries;
    }
  } catch (err) {
    error.value = String((err as Error)?.message ?? err);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function setView(v: View): void {
  view.value = v;
  query.value = "";
  stack.value = [{ title: VIEW_TITLES[v], parent: "root", drive: "" }];
  void loadCurrent();
}

function openFolder(e: WpsDriveEntry): void {
  const top = stack.value[stack.value.length - 1]!;
  // 团队文档库首层点进某个库：从「列出库」切到「列该库根目录」
  const drive = view.value === "team" && stack.value.length <= 1 ? e.id : top.drive;
  const parent = view.value === "team" && stack.value.length <= 1 ? "root" : e.id;
  stack.value = [...stack.value, { title: e.name, parent, drive }];
  void loadCurrent();
}

function crumbTo(i: number): void {
  stack.value = stack.value.slice(0, i + 1);
  void loadCurrent();
}

// ---------- 搜索（防抖；清空关键词回到当前浏览层级） ----------
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (q) => {
  clearTimeout(searchTimer);
  const t = q.trim();
  if (!t) return;
  searchTimer = setTimeout(async () => {
    searching.value = true;
    error.value = "";
    try {
      entries.value = (await getWpsDriveSearch(t)).entries;
    } catch (err) {
      error.value = String((err as Error)?.message ?? err);
      entries.value = [];
    } finally {
      searching.value = false;
    }
  }, 350);
});

// ---------- 多选（跨层级/跨视图去重，按文件 id） ----------
const selected = ref(new Map<string, WpsMention>());
const selectedList = computed(() => [...selected.value.values()]);

function toggleSelect(e: WpsDriveEntry): void {
  const next = new Map(selected.value);
  if (next.has(e.id)) next.delete(e.id);
  else next.set(e.id, { type: "doc", id: e.id, name: e.name });
  selected.value = next;
}

function onRowClick(e: WpsDriveEntry): void {
  if (e.folder) {
    // 搜索结果里的文件夹不带层级上下文，不支持继续浏览
    if (isSearchMode.value) return;
    openFolder(e);
    return;
  }
  toggleSelect(e);
}

function confirm(): void {
  if (!selectedList.value.length) return;
  emit("confirm", selectedList.value);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void loadCurrent();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="picker-overlay" @click.self="emit('close')">
    <div class="picker" role="dialog" aria-label="从云文档选择">
      <div class="picker-head">
        <span class="picker-title">从云文档选择</span>
        <input v-model="query" class="picker-search" type="text" placeholder="搜索文件名" />
        <button type="button" class="picker-close" title="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="picker-body">
        <div class="picker-nav">
          <button
            v-for="v in (['recent', 'private', 'team'] as View[])"
            :key="v"
            type="button"
            class="nav-btn"
            :class="{ active: view === v }"
            @click="setView(v)"
          >
            <svg v-if="v === 'recent'" class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <svg v-else-if="v === 'private'" class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            <svg v-else class="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M21 21v-2a4 4 0 0 0-3-3.87" /></svg>
            {{ VIEW_TITLES[v] }}
          </button>
        </div>

        <div class="picker-main">
          <div v-if="view !== 'recent' && !isSearchMode" class="picker-crumb">
            <template v-for="(lv, i) in stack" :key="i">
              <span v-if="i" class="crumb-sep">/</span>
              <button type="button" class="crumb" :class="{ cur: i === stack.length - 1 }" @click="crumbTo(i)">
                {{ lv.title }}
              </button>
            </template>
          </div>

          <div class="picker-list">
            <div v-if="loading || searching" class="picker-empty">加载中…</div>
            <div v-else-if="error" class="picker-empty picker-error">
              {{ error }}
              <button type="button" class="retry" @click="loadCurrent">重试</button>
            </div>
            <div v-else-if="!entries.length" class="picker-empty">
              {{ isSearchMode ? "无匹配文件" : "此目录为空" }}
            </div>
            <template v-else>
              <div
                v-for="e in entries"
                :key="e.id"
                class="picker-row"
                :class="{ folder: e.folder && !isSearchMode, checked: selected.has(e.id) }"
                :title="e.folder && isSearchMode ? '搜索结果中的文件夹不支持继续浏览' : e.name"
                @click="onRowClick(e)"
              >
                <svg v-if="e.folder" class="icon folder-icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                <span v-else class="checkbox" :class="{ on: selected.has(e.id) }">
                  <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
                </span>
                <span class="row-name">{{ e.name }}</span>
                <span v-if="e.subtitle" class="row-sub">{{ e.subtitle }}</span>
                <svg v-if="e.folder && !isSearchMode" class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="picker-foot">
        <span class="picker-count">已选 {{ selectedList.length }} 个文件</span>
        <button type="button" class="btn" @click="emit('close')">取消</button>
        <button type="button" class="btn primary" :disabled="!selectedList.length" @click="confirm">确认</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(15, 23, 42, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
}
.picker {
  width: 640px;
  max-width: calc(100vw - 48px);
  height: 520px;
  max-height: calc(100vh - 64px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: rise 0.16s ease-out;
}
.picker-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.picker-title {
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}
.picker-search {
  flex: 1;
  max-width: 280px;
  margin-left: auto;
  height: 30px;
  font-size: 12.5px;
  padding: 0 10px;
}
.picker-close {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 8px;
  cursor: pointer;
}
.picker-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.picker-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.picker-nav {
  width: 128px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--text-2);
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.nav-btn .icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.nav-btn:hover {
  background: var(--surface);
  color: var(--text);
}
.nav-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.picker-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.picker-crumb {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  white-space: nowrap;
}
.crumb {
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 6px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb:hover {
  background: var(--surface-2);
  color: var(--text);
}
.crumb.cur {
  color: var(--text);
  font-weight: 600;
  cursor: default;
}
.crumb-sep {
  color: var(--text-3);
  font-size: 12px;
}
.picker-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.picker-empty {
  padding: 28px 14px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.picker-error {
  color: var(--danger);
  word-break: break-all;
}
.retry {
  border: 1px solid var(--border-strong);
  background: transparent;
  border-radius: 8px;
  padding: 3px 12px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.retry:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.picker-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.picker-row:hover {
  background: var(--surface-2);
}
.picker-row.checked {
  background: var(--accent-soft);
}
.folder-icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  color: #d97706;
}
.checkbox {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  display: inline-grid;
  place-items: center;
  color: transparent;
  background: var(--surface);
}
.checkbox svg {
  width: 11px;
  height: 11px;
}
.checkbox.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-1);
}
.row-sub {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.chev {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-3);
}
.picker-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
.picker-count {
  font-size: 12.5px;
  color: var(--text-2);
  margin-right: auto;
}
.btn {
  height: 30px;
  padding: 0 16px;
  font-size: 12.5px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--text-3);
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.btn.primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
  color: var(--on-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
