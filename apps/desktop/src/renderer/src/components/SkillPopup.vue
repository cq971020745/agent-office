<script setup lang="ts">
import type { UseSlashApi } from "../composables/useSlashSkills";

// 弹层需要锚在输入框上方：宿主容器需 position:relative（.ta-wrap / .composer）
defineProps<{ api: UseSlashApi }>();
</script>

<template>
  <!-- / 斜杠技能弹层：与 @ 弹层同款锚定与视觉，键入 / 触发 -->
  <div v-if="api.state.open" class="skill-pop" :style="api.popStyle.value">
    <div class="skill-head">
      <span class="skill-head-title">技能</span>
      <span class="skill-head-sub">Enter 选用 · Esc 关闭</span>
    </div>
    <div v-if="api.state.hint" class="skill-hint">{{ api.state.hint }}</div>
    <div class="skill-list">
      <button
        v-for="(s, i) in api.filtered.value"
        :key="s.name"
        type="button"
        class="skill-item"
        :class="{ active: i === api.state.active }"
        @mousedown.prevent="api.pickSkill(s)"
        @mousemove="api.state.active = i"
      >
        <span class="skill-row">
          <span class="skill-name">/{{ s.name }}</span>
          <span v-if="s.argumentHint" class="skill-args">{{ s.argumentHint }}</span>
        </span>
        <span v-if="s.description" class="skill-desc">{{ s.description }}</span>
      </button>
      <div v-if="!api.filtered.value.length && !api.state.loading && api.skills.value.length" class="skill-empty">无匹配技能</div>
      <div v-if="api.state.loading" class="skill-empty">加载技能中…</div>
    </div>
  </div>
</template>

<style scoped>
.skill-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  z-index: 60;
  overflow: hidden;
}
.skill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.skill-head-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-1);
}
.skill-head-sub {
  font-size: 11.5px;
  color: var(--text-3, var(--text-2));
}
.skill-hint {
  padding: 8px 12px 0;
  font-size: 12px;
  color: var(--danger);
}
.skill-list {
  max-height: var(--slash-list-max, 320px);
  overflow-y: auto;
  padding: 6px;
}
.skill-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.skill-item.active {
  background: var(--surface-2);
}
.skill-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.skill-name {
  font-family: var(--mono, monospace);
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.skill-args {
  font-size: 11.5px;
  color: var(--text-3, var(--text-2));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-desc {
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-empty {
  padding: 14px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3, var(--text-2));
}
</style>
