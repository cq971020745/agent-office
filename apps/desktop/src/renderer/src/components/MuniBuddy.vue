<script setup lang="ts">
/**
 * 木牛流马桌宠：机甲木牛（参考品牌主视觉——蓝光牛角、「牛」纹护额与胸牌、背上货箱蓝旗）。
 * 无文字气泡，用光色 / 形态表达状态：
 * idle 暖金待命 · working 主题色疾走 · success 金辉 · error 赤闪 · curious 瞳孔亮起。
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
  const w = root.value?.offsetWidth ?? 126;
  const h = root.value?.offsetHeight ?? 112;
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
  // 瞳孔朝向以头部中心（画布 80/160, 42/142）为基准
  const cx = r.left + r.width * 0.5;
  const cy = r.top + r.height * 0.3;
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
      viewBox="0 0 160 142"
      xmlns="http://www.w3.org/2000/svg"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <defs>
        <linearGradient id="mb-wood" x1="0" y1="0" x2="0" y2="1">
          <stop class="wood-a" stop-color="#f4dca8" />
          <stop class="wood-b" offset="0.52" stop-color="#dcab60" />
          <stop class="wood-c" offset="1" stop-color="#9a6428" />
        </linearGradient>
        <linearGradient id="mb-wood-deep" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#d9a95e" />
          <stop offset="1" stop-color="#6e421c" />
        </linearGradient>
        <linearGradient id="mb-metal" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#48586a" />
          <stop offset="1" stop-color="#1e2933" />
        </linearGradient>
        <linearGradient id="mb-horn" x1="0" y1="1" x2="1" y2="0">
          <stop stop-color="#7f95ab" />
          <stop offset="0.55" stop-color="#c3d3e2" />
          <stop offset="1" stop-color="#e9f1f8" />
        </linearGradient>
        <linearGradient id="mb-cloth" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#5f92dc" />
          <stop offset="1" stop-color="#2d5c9e" />
        </linearGradient>
        <radialGradient id="mb-iris" cx="0.5" cy="0.42" r="0.6">
          <stop stop-color="#c8ecff" />
          <stop offset="0.55" stop-color="#6fb9f2" />
          <stop offset="1" stop-color="#2f6ea8" />
        </radialGradient>
        <filter id="mb-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- 地面与光环 -->
      <ellipse class="ground" cx="80" cy="133" rx="46" ry="5.5" fill="rgba(0,0,0,0.18)" />
      <ellipse class="halo spin" cx="80" cy="130" rx="54" ry="8" />
      <ellipse class="halo faint" cx="80" cy="70" rx="68" ry="17" transform="rotate(-9 80 70)" />

      <!-- 尾巴（短尾 + 绒球） -->
      <g class="tail">
        <path d="M126 82 C138 85 141 93 135 98" fill="none" stroke="#8a5a26" stroke-width="4.5" stroke-linecap="round" />
        <circle cx="134" cy="99" r="3.4" fill="#2d5c9e" stroke="#1e3a5f" stroke-width="0.9" />
      </g>

      <!-- 后腿（深色金属） -->
      <g class="legs back">
        <path class="leg" d="M42 100 h14 a5 5 0 0 1 5 5 v14 h-24 v-14 a5 5 0 0 1 5 -5 z" fill="url(#mb-metal)" stroke="#141c24" stroke-width="1" />
        <rect x="38" y="123" width="22" height="9" rx="3.5" fill="#10161c" />
      </g>
      <g class="legs back b">
        <path class="leg" d="M104 100 h14 a5 5 0 0 1 5 5 v14 h-24 v-14 a5 5 0 0 1 5 -5 z" fill="url(#mb-metal)" stroke="#141c24" stroke-width="1" />
        <rect x="100" y="123" width="22" height="9" rx="3.5" fill="#10161c" />
      </g>

      <!-- 背上货箱（两根原木 + 木箱），位于躯干右后上方 -->
      <g class="cargo">
        <rect x="96" y="26" width="40" height="11" rx="5.5" fill="url(#mb-wood-deep)" stroke="#4e2c12" stroke-width="1" />
        <ellipse cx="136" cy="31.5" rx="3.2" ry="5" fill="#e8c896" stroke="#4e2c12" stroke-width="0.8" />
        <ellipse cx="136" cy="31.5" rx="1.4" ry="2.4" fill="none" stroke="#8a5a26" stroke-width="0.8" />
        <rect x="92" y="38" width="44" height="11" rx="5.5" fill="url(#mb-wood)" stroke="#4e2c12" stroke-width="1" />
        <ellipse cx="136" cy="43.5" rx="3.2" ry="5" fill="#f0d9b0" stroke="#4e2c12" stroke-width="0.8" />
        <ellipse cx="136" cy="43.5" rx="1.4" ry="2.4" fill="none" stroke="#8a5a26" stroke-width="0.8" />
        <rect x="102" y="48" width="36" height="26" rx="3" fill="url(#mb-wood)" stroke="#4e2c12" stroke-width="1.1" />
        <path d="M102 56 h36 M102 65 h36" stroke="#4e2c12" stroke-opacity="0.4" stroke-width="0.9" />
      </g>

      <!-- 躯干（拼接木甲） -->
      <g class="torso">
        <path d="M32 82 C32 67 46 60 80 60 C114 60 128 67 128 82 L128 95 C128 104 114 108 80 108 C46 108 32 104 32 95 Z" fill="url(#mb-wood)" stroke="#5c3416" stroke-width="1.3" />
        <path d="M36 76 C50 70 66 68 80 68 M124 76 C112 70 98 68 84 68" fill="none" stroke="#5c3416" stroke-opacity="0.35" stroke-width="1" />
        <path d="M40 96 C56 100 70 101 80 101 C90 101 104 100 120 96" fill="none" stroke="#5c3416" stroke-opacity="0.3" stroke-width="1" />
        <!-- 肩/髋关节光圈 -->
        <circle cx="43" cy="87" r="7" fill="url(#mb-metal)" stroke="#141c24" stroke-width="1" />
        <circle class="glow-stroke" cx="43" cy="87" r="4" fill="none" stroke-width="1.6" opacity="0.9" filter="url(#mb-glow)" />
        <circle cx="117" cy="87" r="7" fill="url(#mb-metal)" stroke="#141c24" stroke-width="1" />
        <circle class="glow-stroke" cx="117" cy="87" r="4" fill="none" stroke-width="1.6" opacity="0.9" filter="url(#mb-glow)" />
      </g>

      <!-- 蓝旗（牛），垂在躯干右侧 -->
      <g class="banner">
        <path d="M126 46 h20 v32 l-5 -4 -5 4 -5 -4 -5 4 z" fill="url(#mb-cloth)" stroke="#1e3a5f" stroke-width="1" />
        <text class="emblem" x="136" y="66" text-anchor="middle" font-size="14">牛</text>
      </g>

      <!-- 前腿（木甲 + 膝盖光点） -->
      <g class="legs front">
        <path class="leg l1" d="M54 102 h16 a6 6 0 0 1 6 6 v14 h-28 v-14 a6 6 0 0 1 6 -6 z" fill="url(#mb-wood)" stroke="#5c3416" stroke-width="1.1" />
        <circle class="glow-fill" cx="62" cy="111" r="2.2" filter="url(#mb-glow)" />
        <rect x="49" y="122" width="26" height="10" rx="4" fill="#1a232c" stroke="#0d1319" stroke-width="0.9" />
      </g>
      <g class="legs front b">
        <path class="leg l2" d="M90 102 h16 a6 6 0 0 1 6 6 v14 h-28 v-14 a6 6 0 0 1 6 -6 z" fill="url(#mb-wood)" stroke="#5c3416" stroke-width="1.1" />
        <circle class="glow-fill" cx="98" cy="111" r="2.2" filter="url(#mb-glow)" />
        <rect x="85" y="122" width="26" height="10" rx="4" fill="#1a232c" stroke="#0d1319" stroke-width="0.9" />
      </g>

      <!-- 颈圈（蓝甲 + 光钉）与胸牌 -->
      <g class="collar">
        <path d="M54 66 C61 71 70 73 80 73 C90 73 99 71 106 66 L106 75 C99 80 90 82 80 82 C70 82 61 80 54 75 Z" fill="url(#mb-cloth)" stroke="#1e3a5f" stroke-width="1" />
        <circle class="glow-fill" cx="64" cy="75" r="1.5" filter="url(#mb-glow)" />
        <circle class="glow-fill" cx="96" cy="75" r="1.5" filter="url(#mb-glow)" />
        <line x1="80" y1="82" x2="80" y2="87" stroke="#c9955a" stroke-width="1.6" />
        <circle cx="80" cy="93" r="8" fill="url(#mb-cloth)" stroke="#c9955a" stroke-width="1.8" />
        <text class="emblem" x="80" y="97" text-anchor="middle" font-size="10">牛</text>
      </g>

      <!-- 头部 -->
      <g class="head">
        <!-- 耳朵（角 base 下方，向外） -->
        <ellipse cx="42" cy="45" rx="6.5" ry="9.5" transform="rotate(-24 42 45)" fill="url(#mb-wood)" stroke="#5c3416" stroke-width="1" />
        <ellipse cx="118" cy="45" rx="6.5" ry="9.5" transform="rotate(24 118 45)" fill="url(#mb-wood)" stroke="#5c3416" stroke-width="1" />
        <ellipse cx="42.5" cy="46" rx="2.8" ry="5" transform="rotate(-24 42.5 46)" fill="#f7ecd8" />
        <ellipse cx="117.5" cy="46" rx="2.8" ry="5" transform="rotate(24 117.5 46)" fill="#f7ecd8" />

        <!-- 牛角（粗弯角 + 棱线 + 光刃） -->
        <path d="M62 29 C48 26 34 19 26 8 C22 2 13 4 15 11 C20 24 38 34 60 37 Z" fill="url(#mb-horn)" stroke="#4a5a6a" stroke-width="1.1" />
        <path d="M58 31 C46 28 34 22 27 13" fill="none" stroke="#4a5a6a" stroke-opacity="0.5" stroke-width="1" />
        <path d="M52 33 C42 29 34 24 29 18" fill="none" stroke="#4a5a6a" stroke-opacity="0.5" stroke-width="1" />
        <path d="M60 33 C46 30 33 23 25 11" fill="none" class="glow-stroke" stroke-width="1.4" opacity="0.7" filter="url(#mb-glow)" />
        <path d="M98 29 C112 26 126 19 134 8 C138 2 147 4 145 11 C140 24 122 34 100 37 Z" fill="url(#mb-horn)" stroke="#4a5a6a" stroke-width="1.1" />
        <path d="M102 31 C114 28 126 22 133 13" fill="none" stroke="#4a5a6a" stroke-opacity="0.5" stroke-width="1" />
        <path d="M108 33 C118 29 126 24 131 18" fill="none" stroke="#4a5a6a" stroke-opacity="0.5" stroke-width="1" />
        <path d="M100 33 C114 30 127 23 135 11" fill="none" class="glow-stroke" stroke-width="1.4" opacity="0.7" filter="url(#mb-glow)" />

        <!-- 头甲 -->
        <path d="M44 52 C44 31 58 20 80 20 C102 20 116 31 116 52 C116 64 104 71 80 71 C56 71 44 64 44 52 Z" fill="url(#mb-wood)" stroke="#5c3416" stroke-width="1.3" />
        <path d="M50 44 C54 33 63 26 72 25 M110 44 C106 33 97 26 88 25" fill="none" stroke="#5c3416" stroke-opacity="0.3" stroke-width="1" />

        <!-- 护额「牛」纹 -->
        <path d="M69 22 h22 l4 7 -4 7 h-22 l-4 -7 z" fill="url(#mb-cloth)" stroke="#1e3a5f" stroke-width="1" />
        <text class="emblem" x="80" y="34" text-anchor="middle" font-size="10">牛</text>

        <!-- 口鼻 -->
        <path d="M58 48 C58 43 66 41 80 41 C94 41 102 43 102 48 L102 58 C102 66 92 70 80 70 C68 70 58 66 58 58 Z" fill="#f7ecd8" stroke="#c9a06a" stroke-width="1" />
        <ellipse cx="69" cy="55" rx="2.6" ry="3.4" fill="#c9a06a" />
        <ellipse cx="91" cy="55" rx="2.6" ry="3.4" fill="#c9a06a" />

        <!-- 眼睛（大眼 + 瞳孔跟随） -->
        <g class="eye">
          <ellipse cx="60" cy="38" rx="8.5" ry="9.5" fill="#fdf9f0" stroke="#5c3416" stroke-width="1.1" />
          <g class="iris" :transform="`translate(${pupilX} ${pupilY})`">
            <circle cx="60" cy="38" r="5.4" fill="url(#mb-iris)" />
            <circle cx="60" cy="38" r="2.5" fill="#12283c" />
            <circle cx="58.2" cy="35.8" r="1.3" fill="#eaf6ff" />
          </g>
          <circle class="eye-glow" cx="60" cy="38" r="10.5" />
          <rect class="lid" x="50" y="27" width="20" height="22" rx="8" />
        </g>
        <g class="eye">
          <ellipse cx="100" cy="38" rx="8.5" ry="9.5" fill="#fdf9f0" stroke="#5c3416" stroke-width="1.1" />
          <g class="iris" :transform="`translate(${pupilX} ${pupilY})`">
            <circle cx="100" cy="38" r="5.4" fill="url(#mb-iris)" />
            <circle cx="100" cy="38" r="2.5" fill="#12283c" />
            <circle cx="98.2" cy="35.8" r="1.3" fill="#eaf6ff" />
          </g>
          <circle class="eye-glow" cx="100" cy="38" r="10.5" />
          <rect class="lid" x="90" y="27" width="20" height="22" rx="8" />
        </g>

        <!-- 嘴（按状态切换） -->
        <path class="mouth idle" d="M72 63 c2 1.6 6 1.6 8 0" stroke="#5c3416" stroke-width="1.1" fill="none" stroke-linecap="round" />
        <path class="mouth working" d="M72 63 h8" stroke="#5c3416" stroke-width="1.2" fill="none" stroke-linecap="round" />
        <path class="mouth success" d="M70 62 c2.6 3 9.4 3 12 0" stroke="#5c3416" stroke-width="1.2" fill="none" stroke-linecap="round" />
        <path class="mouth error" d="M72 65 c2 -2 6 -2 8 0" stroke="#5c3416" stroke-width="1.2" fill="none" stroke-linecap="round" />
        <circle class="mouth curious" cx="73" cy="63" r="1.4" fill="#5c3416" />
      </g>

      <!-- 状态粒子（无文字） -->
      <g class="fx working-fx">
        <circle cx="140" cy="16" r="1.7" />
        <circle cx="148" cy="28" r="1.1" />
        <circle cx="136" cy="32" r="0.9" />
      </g>
      <g class="fx success-fx">
        <path d="M138 18 l3 6 6.5 1 -5 4.2 1.4 6.5 -5.9 -3.4 -5.9 3.4 1.4 -6.5 -5 -4.2 6.5 -1 z" />
      </g>
      <g class="fx error-fx">
        <path d="M138 16 v12 M144 22 h-12" stroke-width="2.2" stroke-linecap="round" />
      </g>
    </svg>
  </aside>
</template>

<style scoped>
.muni {
  --mood: #e8c47c;
  --mood-soft: rgba(232, 196, 124, 0.35);
  position: fixed;
  right: 16px;
  bottom: 12px;
  z-index: 40;
  width: 126px;
  color: var(--mood);
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.18));
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
  left: 16%;
  right: 16%;
  bottom: 4px;
  height: 16px;
  border-radius: 50%;
  background: radial-gradient(ellipse, var(--mood-soft), transparent 70%);
  filter: blur(6px);
  animation: aura 2.4s ease-in-out infinite;
}
.muni .dust {
  position: absolute;
  bottom: 12px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--mood) 35%, #8a6238);
  filter: blur(1px);
  opacity: 0;
}
.muni .dust.d1 {
  right: 24px;
  animation: dust 0.72s ease-out infinite;
}
.muni .dust.d2 {
  right: 36px;
  animation: dust 0.72s ease-out infinite 0.36s;
}

/* —— 发光元素统一走 --mood —— */
.glow-fill,
.glow-stroke,
.led {
  fill: var(--mood);
  color: var(--mood);
}
.glow-stroke,
.led {
  stroke: var(--mood);
}
.emblem {
  font-family: "Muni Brush", "STKaiti", "KaiTi", serif;
  font-weight: 700;
  fill: #f2f9ff;
  paint-order: stroke;
  stroke: rgba(16, 42, 66, 0.55);
  stroke-width: 2;
}
.halo {
  fill: none;
  stroke: var(--mood-soft);
  stroke-width: 2;
}
.halo.faint {
  stroke-width: 1.4;
  opacity: 0.55;
}
.halo.spin {
  stroke-dasharray: 10 7;
  animation: halo-spin 6s linear infinite;
  transform-origin: 80px 130px;
}
.eye-glow {
  fill: var(--mood);
  opacity: 0;
}
.lid {
  fill: #dcab60;
  stroke: #5c3416;
  stroke-width: 1.1;
  opacity: 0;
}

/* —— 各状态色相 / 形态 —— */
.mood-idle {
  --mood: #e8c47c;
  --mood-soft: rgba(232, 196, 124, 0.35);
}
.mood-working {
  --mood: rgb(var(--accent-rgb));
  --mood-soft: rgba(var(--accent-rgb), 0.4);
  animation-duration: 3.2s;
}
.mood-success {
  --mood: #ffd873;
  --mood-soft: rgba(255, 216, 115, 0.42);
}
.mood-success .wood-a {
  stop-color: #ffe9b8;
}
.mood-success .wood-b {
  stop-color: #eec06a;
}
.mood-error {
  --mood: #ff6b6b;
  --mood-soft: rgba(255, 107, 107, 0.4);
}
.mood-curious {
  --mood: #5ec4c0;
  --mood-soft: rgba(94, 196, 192, 0.4);
}
.mood-curious .eye-glow {
  opacity: 0.3;
  animation: eye-pulse 1.4s ease-in-out infinite;
}
.mood-curious .iris circle:nth-of-type(2) {
  fill: #0a3d3c;
}

.muni.wink .lid {
  opacity: 1;
}
.muni.wink .iris,
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
.mood-working .working-fx circle {
  fill: var(--mood);
}
.mood-success .success-fx {
  opacity: 1;
  animation: mote 1.2s ease-out infinite;
}
.mood-success .success-fx path {
  fill: var(--mood);
}
.mood-error .error-fx {
  opacity: 1;
  animation: mote 0.7s ease-in-out infinite;
}
.mood-error .error-fx path {
  stroke: var(--mood);
  fill: none;
}

.muni .leg {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 0.72s ease-in-out infinite alternate;
}
.muni .legs.back.b .leg,
.muni .legs.front.b .leg {
  animation-delay: 0.36s;
}
.muni .head {
  animation: head-bob 0.72s ease-in-out infinite;
  transform-origin: 80px 66px;
}
.muni .banner {
  animation: sway 0.72s ease-in-out infinite alternate;
  transform-origin: 136px 48px;
}
.muni .tail {
  animation: sway 1.1s ease-in-out infinite alternate;
  transform-origin: 126px 82px;
}
.mood-working .ox,
.mood-working .leg,
.mood-working .head,
.mood-working .banner,
.mood-working .dust.d1,
.mood-working .dust.d2 {
  animation-duration: 0.46s;
}
.mood-working .legs.back.b .leg,
.mood-working .legs.front.b .leg,
.mood-working .dust.d2 {
  animation-delay: 0.23s;
}
.mood-error .halo.spin {
  animation: halo-spin 1.2s linear infinite;
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
    transform: translateY(0) rotate(-0.8deg);
  }
  50% {
    transform: translateY(-3px) rotate(0.8deg);
  }
}
@keyframes step {
  from {
    transform: rotate(-7deg);
  }
  to {
    transform: rotate(7deg);
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
    transform: translateY(1px) rotate(-1.6deg);
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
@keyframes halo-spin {
  to {
    stroke-dashoffset: -34;
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
    width: 96px;
    right: 10px;
    bottom: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .muni,
  .muni .ox,
  .muni .leg,
  .muni .head,
  .muni .banner,
  .muni .tail,
  .muni .dust,
  .muni .aura,
  .halo.spin,
  .fx,
  .eye-glow {
    animation: none !important;
  }
}
</style>
