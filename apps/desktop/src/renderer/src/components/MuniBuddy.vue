<script setup lang="ts">
/**
 * 木牛流马桌宠：机甲能量牛（SVG+CSS3 角色，与登录页主视觉同源）。
 * 双前腿 + 远侧液压腿交替踏步，双能量轮转动，车身起伏、能量流线流动。
 * 状态用能量色与步频表达：idle 冰蓝 · working 主题色 · success 金 · error 赤 · curious 青。
 * 支持拖拽换位（整个形象区域可抓取），位置记忆在 localStorage，默认右下角；
 * 启动时会把历史位置拉回可视区内，避免拖出屏幕后「消失」。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import MuniCartArt from "./MuniCartArt.vue";

const props = defineProps<{
  mood?: "idle" | "working" | "success" | "error" | "curious";
}>();

const STORAGE_POS = "agent-office-muni-pos";
const MARGIN = 4;

const mood = computed(() => props.mood ?? "idle");
const root = ref<HTMLElement | null>(null);
const dragging = ref(false);

// ---------- 拖拽换位 ----------

function readStoredPos(): { left: number; top: number } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_POS) || "") as { left?: unknown; top?: unknown };
    const left = Number(parsed.left);
    const top = Number(parsed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  } catch {
    return null;
  }
}

const pos = ref<{ left: number; top: number } | null>(readStoredPos());

/** 限制在视口内（宽度按当前渲染尺寸量） */
function clampPos(next: { left: number; top: number }): { left: number; top: number } {
  const w = root.value?.offsetWidth ?? 150;
  const h = root.value?.offsetHeight ?? 102;
  const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
  return {
    left: Math.min(maxX, Math.max(MARGIN, next.left)),
    top: Math.min(maxY, Math.max(MARGIN, next.top)),
  };
}

let dragPointerId = -1;
let dragOffsetX = 0;
let dragOffsetY = 0;

function onDragStart(e: PointerEvent): void {
  if (!e.isPrimary || dragging.value) return;
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // 从 right/bottom 锚点切换到 left/top，起始位置取当前渲染位置避免跳动
  pos.value = { left: r.left, top: r.top };
  dragPointerId = e.pointerId;
  dragOffsetX = e.clientX - r.left;
  dragOffsetY = e.clientY - r.top;
  dragging.value = true;
  el.setPointerCapture?.(e.pointerId);
}

function onDragMove(e: PointerEvent): void {
  if (!dragging.value || e.pointerId !== dragPointerId) return;
  pos.value = clampPos({ left: e.clientX - dragOffsetX, top: e.clientY - dragOffsetY });
}

function onDragEnd(e: PointerEvent): void {
  if (!dragging.value || e.pointerId !== dragPointerId) return;
  dragging.value = false;
  dragPointerId = -1;
  if (pos.value) localStorage.setItem(STORAGE_POS, JSON.stringify(pos.value));
}

function onResize(): void {
  if (pos.value) pos.value = clampPos(pos.value);
}

onMounted(() => {
  // 历史位置可能落在当前窗口外（换过分辨率/拖到边缘），启动时拉回可视区
  if (pos.value) pos.value = clampPos(pos.value);
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
});

const title = computed(() => {
  switch (mood.value) {
    case "working":
      return "木牛流马 · 驮运中";
    case "success":
      return "木牛流马 · 已送达";
    case "error":
      return "木牛流马 · 路受阻";
    case "curious":
      return "木牛流马 · 在看你";
    default:
      return "木牛流马 · 待命";
  }
});
</script>

<template>
  <aside
    ref="root"
    class="muni"
    :class="[{ dragging }]"
    :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px`, right: 'auto', bottom: 'auto' } : undefined"
    :title="title"
    aria-hidden="true"
  >
    <span class="aura" />
    <span class="dust d1" />
    <span class="dust d2" />
    <div
      class="rig"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <MuniCartArt id-prefix="mb" :mood="mood" />
    </div>
  </aside>
</template>

<style scoped>
.muni {
  position: fixed;
  right: 16px;
  bottom: 12px;
  z-index: 40;
  width: 150px;
  pointer-events: none;
  user-select: none;
}
.muni .rig {
  position: relative;
  z-index: 1;
  width: 100%;
  pointer-events: auto;
  cursor: grab;
  user-select: none;
  filter: drop-shadow(0 10px 16px rgba(0, 0, 0, 0.3));
  animation: bob 4.6s ease-in-out infinite;
}
.muni .rig :deep(.cart) {
  animation: trot 0.9s ease-in-out infinite;
}
.muni .rig.fast-true :deep(.cart) {
  animation-duration: 0.55s;
}
.muni.dragging .rig {
  cursor: grabbing;
  animation-play-state: paused;
}
.muni.dragging .rig :deep(.cart) {
  animation-play-state: paused;
}
.muni .aura {
  position: absolute;
  left: 6%;
  right: 6%;
  bottom: -2px;
  height: 16px;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(87, 200, 255, 0.35), transparent 70%);
  filter: blur(6px);
  animation: aura 2.4s ease-in-out infinite;
}
.muni .dust {
  position: absolute;
  bottom: 10px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #7fa8c9;
  filter: blur(1px);
  opacity: 0;
  animation: dust 0.72s ease-out infinite;
}
.muni .dust.d1 {
  right: 26px;
}
.muni .dust.d2 {
  right: 40px;
  animation-delay: 0.36s;
}

@keyframes trot {
  0%,
  100% {
    transform: translateY(0) rotate(-0.5deg);
  }
  50% {
    transform: translateY(-2.5px) rotate(0.5deg);
  }
}
@keyframes dust {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.6);
  }
  35% {
    opacity: 0.5;
  }
  100% {
    opacity: 0;
    transform: translate(10px, -6px) scale(1.3);
  }
}
@keyframes aura {
  0%,
  100% {
    opacity: 0.45;
    transform: scaleX(1);
  }
  50% {
    opacity: 0.9;
    transform: scaleX(1.12);
  }
}

@media (max-width: 720px) {
  .muni {
    width: 116px;
    right: 10px;
    bottom: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .muni .rig,
  .muni .rig :deep(.cart),
  .muni .dust,
  .muni .aura {
    animation: none !important;
  }
}
</style>
