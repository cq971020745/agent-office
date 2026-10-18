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
  activeBaseColor,
  setMode,
  setAccentId,
  setCustomHex,
  setDepth,
  setFxEnabled,
} = useTheme();

const route = useRoute();
const depthLabel = computed(() => depthHint(mode.value));
const open = ref(false);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const hexDraft = ref(customHex.value);
const panelStyle = ref<Record<string, string>>({});

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
  // 紧贴触发按钮上方，水平尽量落在侧栏内，绝不铺满全屏
  let left = rect.right - PANEL_W;
  left = Math.min(Math.max(margin, left), window.innerWidth - PANEL_W - margin);
  const bottom = Math.max(margin, window.innerHeight - rect.top + 8);
  const maxHeight = Math.max(180, window.innerHeight - bottom - margin);
  panelStyle.value = {
    position: "fixed",
    left: `${Math.round(left)}px`,
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
  background: var(--surface);
  box-shadow: var(--shadow-pop);
  color: var(--text);
  overflow-x: hidden;
  overflow-y: auto;
}
:root[data-theme="glass"] .theme-panel {
  background: var(--surface);
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
</style>
