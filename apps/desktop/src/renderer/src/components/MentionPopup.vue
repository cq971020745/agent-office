<script setup lang="ts">
import type { UseMentionsApi } from "../composables/useMentions";
import { MENTION_TABS, MENTION_TYPE_LABEL } from "../composables/useMentions";
import WpsDocPicker from "./WpsDocPicker.vue";

// 弹层需要锚在输入框上方：宿主容器需 position:relative（.ta-wrap / .composer）
defineProps<{ api: UseMentionsApi }>();
</script>

<template>
  <!-- @ 弹层：Comate 同款左侧竖排 tab 栏 + 右侧候选区；高度随视口收紧不遮挡 -->
  <div v-if="api.state.open" class="mention-pop" :style="api.popStyle.value">
    <div class="mention-rail">
      <button
        v-for="t in MENTION_TABS"
        :key="t.key"
        type="button"
        class="mention-rail-btn"
        :class="{ active: api.state.tab === t.key }"
        @mousedown.prevent="api.onTab(t.key)"
      >
        {{ t.label }}
      </button>
    </div>
    <div class="mention-main">
      <div v-if="api.state.hint" class="mention-hint">{{ api.state.hint }}</div>
      <div class="mention-list">
        <template v-if="api.state.tab === 'contact' && api.state.directory">
          <!-- 空关键词：最近联系人置顶 + 可展开的组织树 -->
          <template v-if="!api.state.query.trim()">
            <div v-if="api.recentRows.value.length" class="mention-group">
              <div class="mention-group-title plain">最近联系人</div>
              <button
                v-for="(r, i) in api.recentRows.value"
                :key="`recent:${r.item!.id}`"
                type="button"
                class="mention-item"
                :class="{ active: i === api.state.active }"
                @mousedown.prevent="api.pickMention(r.item!)"
                @mousemove="api.state.active = i"
              >
                <span class="mention-type contact">{{ MENTION_TYPE_LABEL.contact }}</span>
                <span class="mention-name">{{ r.item!.name }}</span>
                <span v-if="r.item!.subtitle" class="mention-sub">{{ r.item!.subtitle }}</span>
              </button>
            </div>
            <div class="mention-group">
              <div class="mention-group-title plain">组织架构</div>
              <button
                v-for="(r, i) in api.treeRows.value"
                :key="`${r.kind}:${r.path || r.item!.id}:${i}`"
                type="button"
                class="mention-item"
                :class="{ active: api.recentRows.value.length + i === api.state.active, dept: r.kind === 'dept' }"
                :style="{ paddingLeft: `${10 + r.depth * 18}px` }"
                @mousedown.prevent="r.kind === 'dept' ? api.toggleDept(r.path) : api.pickMention(r.item!)"
                @mousemove="api.state.active = api.recentRows.value.length + i"
              >
                <template v-if="r.kind === 'dept'">
                  <span class="dept-chevron" :class="{ open: api.expandedKeys.has(r.path) }"></span>
                  <span class="mention-name dept-label">{{ r.label }}</span>
                  <span class="mention-sub">{{ r.total }}人</span>
                </template>
                <template v-else>
                  <span class="mention-name">{{ r.item!.name }}</span>
                  <span v-if="r.item!.subtitle" class="mention-sub leader">{{ r.item!.subtitle }}</span>
                </template>
              </button>
              <div v-if="!api.treeRows.value.length" class="mention-empty">通讯录为空</div>
            </div>
          </template>
          <!-- 关键词搜索：按组织路径分组平铺 -->
          <template v-else>
            <div v-for="g in api.contactGroups.value" :key="g.deptPath" class="mention-group">
              <div class="mention-group-title" :title="g.deptPath">{{ g.deptPath || "未分组" }}</div>
              <button
                v-for="(it, i) in g.items"
                :key="`${it.type}:${it.id}`"
                type="button"
                class="mention-item"
                :class="{ active: g.start + i === api.state.active }"
                @mousedown.prevent="api.pickMention(it)"
                @mousemove="api.state.active = g.start + i"
              >
                <span class="mention-name">{{ it.name }}</span>
                <span v-if="it.subtitle" class="mention-sub leader">{{ it.subtitle }}</span>
              </button>
            </div>
            <div v-if="!api.contactGroups.value.length" class="mention-empty">无匹配结果</div>
          </template>
        </template>
        <template v-else>
          <button
            v-for="(it, i) in api.filteredMentions.value"
            :key="`${it.type}:${it.id}`"
            type="button"
            class="mention-item"
            :class="{ active: i === api.state.active }"
            @mousedown.prevent="api.pickMention(it)"
            @mousemove="api.state.active = i"
          >
            <span class="mention-type" :class="it.type">{{ MENTION_TYPE_LABEL[it.type] }}</span>
            <span class="mention-name">{{ it.name }}</span>
            <span v-if="it.subtitle" class="mention-sub">{{ it.subtitle }}</span>
          </button>
          <div v-if="!api.filteredMentions.value.length && !api.state.loading" class="mention-empty">无匹配结果</div>
          <div v-if="api.state.loading" class="mention-empty">搜索中…</div>
        </template>
        <div v-if="api.state.tab === 'contact' && !api.state.directory" class="mention-dir-note">
          {{ api.state.directoryLoading ? "正在加载完整通讯录（首次约数秒）…" : "完整通讯录未加载，当前为搜索结果" }}
        </div>
      </div>
      <!-- Comate 同款底部入口：打开云文档选择器（浏览目录 + 多选） -->
      <button type="button" class="mention-picker-btn" @mousedown.prevent="api.state.pickerOpen = true">
        <svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        从云文档选择
      </button>
    </div>

    <!-- 云文档选择器（Comate「从云文档选择」）：浏览最近/我的云文档/团队文档库 + 多选回填 -->
    <WpsDocPicker v-if="api.state.pickerOpen" @close="api.state.pickerOpen = false" @confirm="api.onDocsPicked" />
  </div>
</template>

<style scoped>
.mention-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  display: flex;
  align-items: stretch;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  z-index: 60;
  overflow: hidden;
}
/* Comate 同款左侧竖排 tab 栏 */
.mention-rail {
  width: 92px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.mention-rail-btn {
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--text-2);
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  flex-shrink: 0;
}
.mention-rail-btn:hover {
  background: var(--surface);
  color: var(--text);
}
.mention-rail-btn.active {
  background: var(--accent-weak, rgba(23, 126, 91, 0.12));
  color: var(--accent);
  font-weight: 600;
}
.mention-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.mention-hint {
  padding: 8px 12px 0;
  font-size: 12px;
  color: var(--danger);
}
.mention-list {
  max-height: var(--mention-list-max, 380px);
  overflow-y: auto;
  padding: 6px;
}
/* Comate 底部入口：打开云文档选择器 */
.mention-picker-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  border: none;
  border-top: 1px solid var(--border);
  background: transparent;
  padding: 9px 12px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  flex-shrink: 0;
}
.mention-picker-btn .icon {
  width: 14px;
  height: 14px;
  color: #d97706;
}
.mention-picker-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.mention-group-title {
  padding: 8px 8px 3px;
  font-size: 11.5px;
  color: var(--text-3, var(--text-2));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-group-title::before {
  content: "▸ ";
}
/* 章节标题（最近联系人/组织架构）不是可折叠节点，不带箭头 */
.mention-group-title.plain::before {
  content: "";
}
/* 组织树部门行：三角指示展开态，展开时右旋 90° */
.dept-chevron {
  width: 0;
  height: 0;
  border-left: 5px solid var(--text-3, var(--text-2));
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  flex-shrink: 0;
  transition: transform 0.12s ease;
}
.dept-chevron.open {
  transform: rotate(90deg);
}
.mention-item.dept {
  font-weight: 500;
}
.mention-item.dept .mention-name.dept-label {
  color: var(--text-2);
}
.mention-dir-note {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3, var(--text-2));
}
.mention-sub.leader {
  color: var(--accent);
}
.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.mention-item.active {
  background: var(--surface-2);
}
.mention-name {
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-sub {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3, var(--text-2));
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 45%;
}
.mention-empty {
  padding: 14px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3, var(--text-2));
}
/* 候选类型徽标（chips 与候选行共用配色） */
.mention-type {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.mention-type.contact {
  background: rgba(37, 99, 235, 0.14);
  color: #2563eb;
}
.mention-type.chat {
  background: rgba(22, 163, 74, 0.14);
  color: #16a34a;
}
.mention-type.doc {
  background: rgba(217, 119, 6, 0.14);
  color: #d97706;
}
.mention-type.kb {
  background: rgba(147, 51, 234, 0.14);
  color: #9333ea;
}
.mention-type.meeting {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}
</style>
