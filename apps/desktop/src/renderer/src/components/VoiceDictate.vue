<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { useVoiceInput } from "../composables/useVoiceInput";

// 语音输入按钮：点击开始录音 → 再点结束并转写 → 文本回填宿主输入框
const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ (e: "text", text: string): void }>();

const voice = useVoiceInput({ onText: (text) => emit("text", text) });

const timeText = computed(() => {
  const s = voice.seconds.value;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});
const title = computed(() =>
  voice.transcribing.value
    ? "语音转写中…"
    : voice.recording.value
      ? `点击结束并转写（已录 ${timeText.value}）`
      : "语音输入（点击说话，再次点击结束）"
);

onBeforeUnmount(() => voice.dispose());
</script>

<template>
  <button
    v-if="voice.supported.value"
    type="button"
    class="voice-btn"
    :class="{ rec: voice.recording.value, busy: voice.transcribing.value }"
    :disabled="disabled"
    :title="title"
    @click="voice.toggle()"
  >
    <span v-if="voice.transcribing.value" class="voice-spinner" />
    <svg v-else-if="!voice.recording.value" class="icon" viewBox="0 0 24 24">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
    </svg>
    <span v-if="voice.recording.value" class="voice-time">{{ timeText }}</span>
  </button>
</template>

<style scoped>
.voice-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-3);
  border: none;
  box-shadow: none;
  flex-shrink: 0;
}
.voice-btn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-soft);
}
.voice-btn:disabled {
  opacity: 0.5;
}
.voice-btn .icon {
  width: 14px;
  height: 14px;
}
/* 录音中：红点脉冲 + 计时 */
.voice-btn.rec {
  color: var(--danger);
  background: var(--danger-soft);
}
.voice-btn.rec .icon {
  color: var(--danger);
  animation: voice-pulse 1.2s ease-in-out infinite;
}
.voice-time {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--danger);
}
@keyframes voice-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
/* 转写中：小 spinner */
.voice-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  animation: voice-spin 0.8s linear infinite;
}
@keyframes voice-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
