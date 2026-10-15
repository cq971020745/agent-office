<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { MAX_DURATION_SEC, useVoiceInput } from "../composables/useVoiceInput";

// 语音输入与音频转写组件：
// 1. 麦克风实时听写（支持动态 8 段声波、时长显示、Esc 取消、Enter/点击完成、Alt+V 快捷键）
// 2. 转写失败保留录音，支持一键「重试」
// 3. 支持直接上传本地音频文件（.wav/.mp3/.m4a/.webm/.ogg）转写为文字回填输入框
const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ (e: "text", text: string): void }>();

const voice = useVoiceInput({ onText: (text) => emit("text", text) });
const audioFileInput = ref<HTMLInputElement | null>(null);

const timeText = computed(() => {
  const s = voice.seconds.value;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});

const maxTimeText = computed(() => `${Math.floor(MAX_DURATION_SEC / 60)}:00`);

function onGlobalKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  // 录音中按 Escape 立即取消录音，不触发转写
  if (voice.recording.value && e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    voice.cancel();
    return;
  }
  // Alt+V 快捷键快速启动/结束语音听写
  if (e.altKey && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    void voice.toggle();
  }
}

function pickAudioFile(): void {
  if (props.disabled || voice.recording.value || voice.transcribing.value) return;
  audioFileInput.value?.click();
}

function onAudioFilePicked(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void voice.transcribeFile(file);
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown, true);
  voice.dispose();
});
</script>

<template>
  <div v-if="voice.supported.value" class="voice-wrap">
    <!-- 录音进行中：展开沉浸式声波控制胶囊 -->
    <div v-if="voice.recording.value" class="voice-rec-bar" role="status" aria-label="正在录音">
      <span class="rec-dot" />
      <div class="wave-bars" aria-hidden="true">
        <span
          v-for="(lv, idx) in voice.levels.value"
          :key="idx"
          class="wave-bar"
          :style="{ height: `${Math.round(lv * 16)}px` }"
        />
      </div>
      <span class="voice-time" :title="`最长可录 ${maxTimeText}`">{{ timeText }}</span>
      <button
        type="button"
        class="rec-action cancel"
        title="取消本次录音（Esc）"
        @click.stop="voice.cancel()"
      >
        ✕ 取消
      </button>
      <button
        type="button"
        class="rec-action finish"
        title="结束录音并转写为文字"
        @click.stop="voice.stop()"
      >
        ✓ 完成
      </button>
    </div>

    <!-- 转写进行中 -->
    <div v-else-if="voice.transcribing.value" class="voice-busy-pill" title="正在将语音转写为文字…">
      <span class="voice-spinner" />
      <span class="busy-label">转写中…</span>
    </div>

    <!-- 待机态：麦克风听写按钮 + 音频文件转写入口 + 失败重试胶囊 -->
    <template v-else>
      <button
        type="button"
        class="voice-btn"
        :disabled="disabled"
        title="语音听写（点击说话，或按 Alt+V）"
        @click="voice.start()"
      >
        <svg class="icon" viewBox="0 0 24 24">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
        </svg>
      </button>

      <button
        type="button"
        class="voice-btn file-transcribe"
        :disabled="disabled"
        title="上传音频文件转写为文字（支持 .mp3 / .wav / .m4a / .webm / .ogg）"
        @click="pickAudioFile"
      >
        <svg class="icon" viewBox="0 0 24 24">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </button>
      <input
        ref="audioFileInput"
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac"
        hidden
        @change="onAudioFilePicked"
      />

      <!-- 上次转写失败时保留录音，支持一键重试 -->
      <div v-if="voice.lastFailedAudio.value" class="retry-pill">
        <button
          type="button"
          class="retry-btn"
          title="重新识别刚才的录音"
          @click="voice.retryLast()"
        >
          ↻ 重试转写
        </button>
        <button
          type="button"
          class="retry-dismiss"
          title="丢弃录音"
          @click="voice.clearFailed()"
        >
          ✕
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.voice-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
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
  transition: color 0.14s, background 0.14s, transform 0.1s;
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

/* 沉浸式声波录音控制条 */
.voice-rec-bar {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 8px 0 10px;
  border-radius: 999px;
  background: var(--danger-soft);
  border: 1px solid rgba(239, 68, 68, 0.28);
  animation: fade-in 0.15s ease-out;
}
.rec-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
  animation: voice-pulse 1.1s ease-in-out infinite;
  flex-shrink: 0;
}
.wave-bars {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 16px;
}
.wave-bar {
  width: 2.5px;
  min-height: 3px;
  max-height: 16px;
  border-radius: 2px;
  background: var(--danger);
  transition: height 0.08s ease-out;
}
.voice-time {
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--danger);
  min-width: 28px;
}
.rec-action {
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: none;
  box-shadow: none;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
.rec-action.cancel {
  background: transparent;
  color: var(--text-2);
}
.rec-action.cancel:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--text);
}
.rec-action.finish {
  background: var(--danger);
  color: #fff;
}
.rec-action.finish:hover {
  filter: brightness(1.08);
}

/* 转写中状态胶囊 */
.voice-busy-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}
.voice-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  animation: voice-spin 0.8s linear infinite;
}

/* 失败重试胶囊 */
.retry-pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  border-radius: 999px;
  background: var(--warn-soft);
  border: 1px solid rgba(217, 119, 6, 0.3);
  overflow: hidden;
}
.retry-btn {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--warn);
  font-size: 11px;
  font-weight: 600;
  padding: 0 7px;
  height: 100%;
}
.retry-btn:hover {
  background: rgba(217, 119, 6, 0.12);
}
.retry-dismiss {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font-size: 10px;
  padding: 0 6px 0 3px;
  height: 100%;
}
.retry-dismiss:hover {
  color: var(--text);
}

@keyframes voice-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.85);
  }
}
@keyframes voice-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes fade-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
