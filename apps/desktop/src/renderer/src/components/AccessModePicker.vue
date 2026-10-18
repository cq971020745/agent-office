<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { AccessMode } from "@office/shared";

const props = withDefaults(
  defineProps<{
    modelValue: AccessMode;
    /** 紧凑样式：任务详情 composer 用 */
    compact?: boolean;
  }>(),
  { compact: false }
);

const emit = defineEmits<{
  "update:modelValue": [value: AccessMode];
}>();

const OPTIONS: {
  id: AccessMode;
  label: string;
  hint: string;
  icon: "plan" | "confirm" | "autonomous" | "full";
}[] = [
  { id: "plan", label: "计划模式", hint: "编辑前先出计划。", icon: "plan" },
  { id: "confirm", label: "变更前确认", hint: "改文件前先问我。", icon: "confirm" },
  { id: "autonomous", label: "自主模式", hint: "低风险自动通过。", icon: "autonomous" },
  { id: "full", label: "完全访问", hint: "减少确认次数。", icon: "full" },
];

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const popStyle = ref<Record<string, string>>({});

const current = computed(() => OPTIONS.find((o) => o.id === props.modelValue) ?? OPTIONS[2]!);

function toggle(): void {
  if (!open.value && trigger.value) {
    const r = trigger.value.getBoundingClientRect();
    const width = 280;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    popStyle.value = {
      left: `${left}px`,
      bottom: `${window.innerHeight - r.top + 8}px`,
      width: `${width}px`,
    };
  }
  open.value = !open.value;
}

function pick(id: AccessMode): void {
  emit("update:modelValue", id);
  open.value = false;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") open.value = false;
}

watch(open, (v) => {
  if (v) window.addEventListener("keydown", onKey);
  else window.removeEventListener("keydown", onKey);
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="access-mode" :class="{ compact }">
    <button
      ref="trigger"
      type="button"
      class="am-trigger"
      :class="{ open, on: modelValue !== 'autonomous' }"
      :title="`${current.label}：${current.hint}`"
      @click="toggle"
    >
      <!-- 盾牌图标 -->
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
        <path
          v-if="modelValue === 'full' || modelValue === 'autonomous'"
          d="M9 12l2 2 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
      <span class="am-label">{{ current.label }}</span>
      <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" /></svg>
    </button>

    <teleport to="body">
      <div v-if="open" class="am-overlay" @click.self="open = false">
        <div class="am-pop" :style="popStyle" role="listbox" aria-label="会话权限">
          <button
            v-for="opt in OPTIONS"
            :key="opt.id"
            type="button"
            class="am-item"
            :class="{ active: opt.id === modelValue }"
            role="option"
            :aria-selected="opt.id === modelValue"
            @click="pick(opt.id)"
          >
            <span class="am-ico" :data-icon="opt.icon">
              <!-- plan: 灯泡 -->
              <svg v-if="opt.icon === 'plan'" viewBox="0 0 24 24">
                <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <!-- confirm: 时钟回环 -->
              <svg v-else-if="opt.icon === 'confirm'" viewBox="0 0 24 24">
                <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <!-- autonomous: 盾+勾 -->
              <svg v-else-if="opt.icon === 'autonomous'" viewBox="0 0 24 24">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" stroke-width="2" />
                <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <!-- full: 盾+锁 -->
              <svg v-else viewBox="0 0 24 24">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" stroke-width="2" />
                <rect x="9" y="10" width="6" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.8" />
                <path d="M10.5 10V8.5a1.5 1.5 0 0 1 3 0V10" fill="none" stroke="currentColor" stroke-width="1.8" />
              </svg>
            </span>
            <span class="am-text">
              <span class="am-title">{{ opt.label }}</span>
              <span class="am-hint">{{ opt.hint }}</span>
            </span>
            <svg v-if="opt.id === modelValue" class="check" viewBox="0 0 24 24">
              <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.am-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 4px 12px;
  max-width: 180px;
  cursor: pointer;
  white-space: nowrap;
}
.compact .am-trigger {
  padding: 3px 10px;
  font-size: 12px;
}
.am-trigger .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.am-trigger .caret {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--text-3);
  transition: transform 0.15s ease;
}
.am-trigger.open .caret {
  transform: rotate(180deg);
}
.am-trigger:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.am-trigger.on,
.am-trigger.open {
  color: var(--text);
  background: var(--accent-soft);
}
.am-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.am-overlay {
  position: fixed;
  inset: 0;
  z-index: 56;
}
.am-pop {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-pop);
  padding: 6px;
  animation: am-rise 0.16s ease-out;
}
@keyframes am-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.am-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.am-item:hover {
  background: var(--surface-2);
}
.am-item.active {
  background: var(--accent-soft);
}
.am-ico {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-2);
  flex-shrink: 0;
}
.am-item.active .am-ico {
  color: var(--accent);
  background: var(--surface);
}
.am-ico svg {
  width: 16px;
  height: 16px;
}
.am-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.am-title {
  font-size: 13px;
  font-weight: 600;
}
.am-hint {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.35;
}
.check {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--accent);
  margin-top: 4px;
}
</style>
