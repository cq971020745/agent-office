<script setup lang="ts">
/**
 * 木牛流马桌宠：无文字气泡，用光色 / 形态表达状态。
 * idle 暖木色慢走 · working 主题色疾走 · success 金辉 · error 赤闪 · curious 瞳孔亮起
 * 支持拖拽换位（按绘画区域命中，透明处可穿透），位置记忆在 localStorage，默认右下角。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  mood?: "idle" | "working" | "success" | "error" | "curious";
}>();

const STORAGE_POS = "agent-office-muni-pos";
const MARGIN = 4;

const mood = computed(() => props.mood ?? "idle");
const root = ref<HTMLElement | null>(null);
const pupilX = ref(0);
const pupilY = ref(0);
const wink = ref(false);
const dragging = ref(false);
let winkTimer = 0;

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
  const w = root.value?.offsetWidth ?? 118;
  const h = root.value?.offsetHeight ?? 110;
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

function onMove(e: MouseEvent): void {
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width * 0.34;
  const cy = r.top + r.height * 0.32;
  const dx = (e.clientX - cx) / Math.max(window.innerWidth, 1);
  const dy = (e.clientY - cy) / Math.max(window.innerHeight, 1);
  pupilX.value = Math.max(-2.4, Math.min(2.4, dx * 11));
  pupilY.value = Math.max(-1.8, Math.min(1.8, dy * 8));
}

function scheduleWink(): void {
  winkTimer = window.setTimeout(() => {
    wink.value = true;
    window.setTimeout(() => {
      wink.value = false;
      scheduleWink();
    }, 140);
  }, 4800 + Math.random() * 5000);
}

onMounted(() => {
  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("resize", onResize);
  scheduleWink();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("resize", onResize);
  window.clearTimeout(winkTimer);
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
    :class="[`mood-${mood}`, { wink, dragging }]"
    :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px`, right: 'auto', bottom: 'auto' } : undefined"
    :title="title"
    aria-hidden="true"
  >
    <span class="aura" />
    <span class="dust d1" />
    <span class="dust d2" />

    <svg
      class="ox"
      viewBox="0 0 140 124"
      xmlns="http://www.w3.org/2000/svg"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <defs>
        <linearGradient id="mb-wood" x1="24" y1="20" x2="120" y2="110" gradientUnits="userSpaceOnUse">
          <stop class="wood-a" stop-color="#f0d9b0" />
          <stop class="wood-b" offset="0.5" stop-color="#c9955a" />
          <stop class="wood-c" offset="1" stop-color="#6e421c" />
        </linearGradient>
        <linearGradient id="mb-deep" x1="0" y1="0" x2="0" y2="1">
          <stop class="deep-a" stop-color="#b88448" />
          <stop class="deep-b" offset="1" stop-color="#3d2410" />
        </linearGradient>
        <linearGradient id="mb-horn" x1="0" y1="1" x2="1" y2="0">
          <stop class="horn-a" stop-color="#e8c896" />
          <stop class="horn-b" offset="1" stop-color="#5c3416" />
        </linearGradient>
        <filter id="mb-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <ellipse class="ground" cx="72" cy="116" rx="40" ry="4.5" fill="rgba(0,0,0,0.12)" />

      <g class="legs back">
        <ellipse cx="92" cy="78" rx="8" ry="4" fill="#6a3d18" stroke="#3d2410" stroke-width="0.9" />
        <path class="leg" d="M86 78 L82 98 L90 100 L96 80 Z" fill="url(#mb-deep)" stroke="#3d2410" stroke-width="1" />
        <path class="leg" d="M84 98 L80 112 L90 114 L92 100 Z" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="1" />
        <ellipse cx="85" cy="114" rx="5.5" ry="2.4" fill="#2a1a08" />
      </g>
      <g class="legs back b">
        <ellipse cx="108" cy="76" rx="7" ry="3.5" fill="#6a3d18" stroke="#3d2410" stroke-width="0.9" />
        <path class="leg" d="M102 76 L100 96 L108 98 L112 78 Z" fill="url(#mb-deep)" stroke="#3d2410" stroke-width="1" />
        <path class="leg" d="M102 96 L106 112 L114 112 L110 98 Z" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="1" />
        <ellipse cx="110" cy="113" rx="5.5" ry="2.4" fill="#2a1a08" />
      </g>

      <g class="crate">
        <path d="M46 42 L110 36 L116 70 L50 78 Z" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="1.35" />
        <path d="M46 42 L110 36 L110 46 L46 52 Z" fill="#e8c896" opacity="0.5" />
        <path d="M56 52h46M60 64h40" stroke="#3d2410" stroke-opacity="0.25" stroke-width="1" />
        <path class="rim" d="M48 42 L108 36" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </g>

      <path
        d="M42 60 C58 48 90 46 114 52 C122 56 124 68 120 78
           C116 88 96 92 72 92 C52 92 40 84 36 74 C34 66 36 62 42 60 Z"
        fill="url(#mb-deep)"
        stroke="#3d2410"
        stroke-width="1.3"
      />

      <!-- 电源：拨杆位置随状态变化 -->
      <g class="power-switch">
        <rect x="68" y="62" width="28" height="14" rx="4" fill="rgba(12,18,24,0.55)" stroke="#3d2410" stroke-width="1" />
        <rect class="switch-ring" x="68" y="62" width="28" height="14" rx="4" stroke="currentColor" stroke-width="1.2" fill="none" />
        <circle class="led" cx="74" cy="69" r="2.4" filter="url(#mb-glow)" />
        <rect class="toggle" x="80" y="65" width="12" height="8" rx="2.5" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="0.8" />
      </g>

      <g class="legs front">
        <ellipse cx="56" cy="80" rx="9" ry="4.5" fill="#7a4a22" stroke="#3d2410" stroke-width="1" />
        <path class="leg l1" d="M50 80 L44 100 L54 102 L60 82 Z" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="1.1" />
        <path class="leg l1b" d="M46 100 L40 114 L52 116 L56 102 Z" fill="url(#mb-deep)" stroke="#3d2410" stroke-width="1.1" />
        <ellipse cx="46" cy="116" rx="6" ry="2.6" fill="#2a1a08" />
        <circle class="joint" cx="54" cy="88" r="1.7" />
      </g>
      <g class="legs front b">
        <ellipse cx="72" cy="82" rx="8" ry="4" fill="#7a4a22" stroke="#3d2410" stroke-width="1" />
        <path class="leg l2" d="M66 82 L64 102 L74 104 L78 84 Z" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="1.1" />
        <path class="leg l2b" d="M66 102 L68 116 L80 116 L76 104 Z" fill="url(#mb-deep)" stroke="#3d2410" stroke-width="1.1" />
        <ellipse cx="74" cy="117" rx="6" ry="2.6" fill="#2a1a08" />
        <circle class="joint" cx="70" cy="90" r="1.7" />
      </g>

      <g class="head">
        <path
          d="M42 62 C28 58 16 64 12 76 C10 86 18 92 30 90 L44 84 Z"
          fill="url(#mb-wood)"
          stroke="#3d2410"
          stroke-width="1.2"
        />
        <ellipse cx="20" cy="72" rx="14" ry="11" fill="url(#mb-wood)" stroke="#3d2410" stroke-width="1.25" />
        <ellipse cx="14" cy="62" rx="4.5" ry="3" fill="#8a5530" stroke="#3d2410" stroke-width="0.8" />
        <ellipse cx="28" cy="60" rx="4.5" ry="3" fill="#8a5530" stroke="#3d2410" stroke-width="0.8" />
        <path
          class="horn"
          d="M13 61 C8 50 4 40 8 30 C11 24 16 26 17 32 C18 42 18 52 18 60 Z"
          fill="url(#mb-horn)"
          stroke="#3d2410"
          stroke-width="1"
        />
        <path
          class="horn"
          d="M29 59 C36 48 46 38 56 32 C62 28 66 34 62 40 C54 50 40 56 32 60 Z"
          fill="url(#mb-horn)"
          stroke="#3d2410"
          stroke-width="1"
        />
        <circle class="horn-tip" cx="10" cy="32" r="1.8" filter="url(#mb-glow)" />
        <circle class="horn-tip" cx="60" cy="34" r="1.8" filter="url(#mb-glow)" />

        <ellipse cx="11" cy="80" rx="6" ry="3.8" fill="#a87038" stroke="#3d2410" stroke-width="0.85" />
        <circle cx="9" cy="80" r="0.85" fill="#1a1208" />
        <circle cx="13.5" cy="80" r="0.85" fill="#1a1208" />

        <ellipse class="eye-white" cx="18" cy="68" rx="3" ry="3.3" fill="#f7efe3" />
        <ellipse class="eye-white" cx="28" cy="67" rx="2.8" ry="3.1" fill="#f7efe3" />
        <circle class="pupil" :cx="18 + pupilX" :cy="68 + pupilY" r="1.2" fill="#1a1208" />
        <circle class="pupil" :cx="28 + pupilX" :cy="67 + pupilY" r="1.15" fill="#1a1208" />
        <circle class="eye-glow" cx="18" cy="68" r="4.5" />
        <circle class="eye-glow" cx="28" cy="67" r="4.2" />
        <path class="lid" d="M15 68h6M25 67h6" stroke="#5c3416" stroke-width="2.2" stroke-linecap="round" />

        <path class="mouth idle" d="M14 86c1.6 1.2 5 1.2 6.5 0" stroke="#3d2410" stroke-width="1" fill="none" stroke-linecap="round" />
        <path class="mouth working" d="M15 86h6" stroke="#3d2410" stroke-width="1.1" fill="none" stroke-linecap="round" />
        <path class="mouth success" d="M13 85c2 2.4 7.5 2.4 9.5 0" stroke="#3d2410" stroke-width="1.1" fill="none" stroke-linecap="round" />
        <path class="mouth error" d="M15 88c1.8-1.8 5.5-1.8 7.5 0" stroke="#3d2410" stroke-width="1.1" fill="none" stroke-linecap="round" />
        <circle class="mouth curious" cx="18" cy="86.5" r="1.2" fill="#3d2410" />
      </g>

      <!-- 状态粒子（无文字） -->
      <g class="fx working-fx">
        <circle cx="120" cy="28" r="1.6" />
        <circle cx="128" cy="40" r="1.1" />
        <circle cx="116" cy="44" r="0.9" />
      </g>
      <g class="fx success-fx">
        <path d="M118 30l3 6 6.5 1-5 4.2 1.4 6.5-5.9-3.4-5.9 3.4 1.4-6.5-5-4.2 6.5-1z" />
      </g>
      <g class="fx error-fx">
        <path d="M118 28v12M124 34h-12" stroke-width="2.2" stroke-linecap="round" />
      </g>
    </svg>
  </aside>
</template>

<style scoped>
.muni {
  --mood: rgb(var(--accent-rgb));
  --mood-soft: rgba(var(--accent-rgb), 0.35);
  position: fixed;
  right: 16px;
  bottom: 12px;
  z-index: 40;
  width: 118px;
  color: var(--mood);
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.16));
  animation: stroll 5.2s ease-in-out infinite;
}
.muni .ox {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: auto;
  transform-origin: 50% 85%;
  animation: body-bob 0.72s ease-in-out infinite;
  /* pointer-events 在 aside 上是 none；svg 按 visiblePainted 只命中画出来的形状，留白处可穿透点击 */
  pointer-events: visiblePainted;
  cursor: grab;
}
.muni.dragging {
  animation-play-state: paused;
}
.muni.dragging .ox {
  cursor: grabbing;
}
.muni .aura {
  position: absolute;
  left: 18%;
  right: 18%;
  bottom: 8px;
  height: 18px;
  border-radius: 50%;
  background: radial-gradient(ellipse, var(--mood-soft), transparent 70%);
  filter: blur(6px);
  animation: aura 2.4s ease-in-out infinite;
}
.muni .dust {
  position: absolute;
  bottom: 14px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--mood) 35%, #8a6238);
  filter: blur(1px);
  opacity: 0;
}
.muni .dust.d1 {
  right: 26px;
  animation: dust 0.72s ease-out infinite;
}
.muni .dust.d2 {
  right: 38px;
  animation: dust 0.72s ease-out infinite 0.36s;
}

.led,
.joint,
.horn-tip,
.rim,
.switch-ring {
  fill: var(--mood);
  stroke: var(--mood);
  color: var(--mood);
}
.rim,
.switch-ring {
  fill: none;
}
.working-fx circle,
.success-fx path {
  fill: var(--mood);
}
.error-fx path {
  stroke: var(--mood);
  fill: none;
}
.eye-glow {
  fill: var(--mood);
  opacity: 0;
}

/* —— 各状态色相 / 形态 —— */
.mood-idle {
  --mood: #c9a06a;
  --mood-soft: rgba(201, 160, 106, 0.32);
}
.mood-working {
  --mood: rgb(var(--accent-rgb));
  --mood-soft: rgba(var(--accent-rgb), 0.4);
  animation-duration: 3.2s;
}
.mood-success {
  --mood: #d4a84b;
  --mood-soft: rgba(212, 168, 75, 0.42);
}
.mood-success .wood-a {
  stop-color: #ffe7b0;
}
.mood-success .wood-b {
  stop-color: #e0b45a;
}
.mood-error {
  --mood: #e25555;
  --mood-soft: rgba(226, 85, 85, 0.4);
}
.mood-error .toggle {
  transform: translateX(-8px);
}
.mood-curious {
  --mood: #5ec4c0;
  --mood-soft: rgba(94, 196, 192, 0.4);
}
.mood-curious .eye-glow {
  opacity: 0.28;
  animation: eye-pulse 1.4s ease-in-out infinite;
}
.mood-curious .pupil {
  fill: #0a3d3c;
}

.lid {
  opacity: 0;
}
.muni.wink .lid {
  opacity: 1;
}
.muni.wink .pupil,
.muni.wink .eye-glow {
  opacity: 0;
}
.mouth {
  opacity: 0;
}
.mood-idle .mouth.idle,
.mood-curious .mouth.curious,
.mood-working .mouth.working,
.mood-success .mouth.success,
.mood-error .mouth.error {
  opacity: 1;
}
.fx {
  opacity: 0;
}
.mood-working .working-fx {
  opacity: 1;
  animation: mote 0.9s ease-in-out infinite;
}
.mood-success .success-fx {
  opacity: 1;
  animation: mote 1.2s ease-out infinite;
}
.mood-error .error-fx {
  opacity: 1;
  animation: mote 0.7s ease-in-out infinite;
}

.muni .leg,
.muni .l1,
.muni .l1b,
.muni .l2,
.muni .l2b {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 0.72s ease-in-out infinite alternate;
}
.muni .l2,
.muni .l2b,
.muni .legs.back.b .leg {
  animation-delay: 0.36s;
}
.muni .crate {
  animation: sway 0.72s ease-in-out infinite alternate;
  transform-origin: 80px 58px;
}
.muni .head {
  animation: head-bob 0.72s ease-in-out infinite;
  transform-origin: 30px 70px;
}
.power-switch .led {
  animation: led-pulse 1.8s ease-in-out infinite;
}
.mood-working .ox,
.mood-working .leg,
.mood-working .l1,
.mood-working .l1b,
.mood-working .l2,
.mood-working .l2b,
.mood-working .crate,
.mood-working .head,
.mood-working .dust.d1,
.mood-working .dust.d2 {
  animation-duration: 0.46s;
}
.mood-working .l2,
.mood-working .l2b,
.mood-working .legs.back.b .leg,
.mood-working .dust.d2 {
  animation-delay: 0.23s;
}
.mood-working .led {
  animation-duration: 0.55s;
}
.mood-error .led {
  animation: led-alarm 0.45s steps(2) infinite;
}
.mood-error .head {
  animation: shake 0.45s ease-in-out infinite;
}
.mood-error {
  animation: stroll 7s ease-in-out infinite;
}
.mood-success .head {
  animation: nod 0.7s ease-in-out 3;
}
.mood-success .horn-tip {
  animation: mote 1.1s ease-in-out infinite;
}

@keyframes stroll {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(-22px);
  }
}
@keyframes body-bob {
  0%,
  100% {
    transform: translateY(0) rotate(-1.2deg);
  }
  50% {
    transform: translateY(-3px) rotate(1.2deg);
  }
}
@keyframes step {
  from {
    transform: rotate(-10deg);
  }
  to {
    transform: rotate(10deg);
  }
}
@keyframes sway {
  from {
    transform: rotate(-3deg) translateY(0);
  }
  to {
    transform: rotate(3deg) translateY(-1px);
  }
}
@keyframes head-bob {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  50% {
    transform: translateY(1px) rotate(-2deg);
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
@keyframes mote {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  50% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
@keyframes led-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}
@keyframes led-alarm {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.15;
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
@keyframes eye-pulse {
  0%,
  100% {
    opacity: 0.18;
  }
  50% {
    opacity: 0.42;
  }
}
@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-2px);
  }
  75% {
    transform: translateX(2px);
  }
}
@keyframes nod {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(2px);
  }
}

@media (max-width: 720px) {
  .muni {
    width: 90px;
    right: 10px;
    bottom: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .muni,
  .muni .ox,
  .muni .leg,
  .muni .l1,
  .muni .l1b,
  .muni .l2,
  .muni .l2b,
  .muni .crate,
  .muni .head,
  .muni .dust,
  .muni .aura,
  .fx,
  .power-switch .led,
  .horn-tip,
  .eye-glow {
    animation: none !important;
  }
}
</style>
