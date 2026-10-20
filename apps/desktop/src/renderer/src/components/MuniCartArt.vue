<script setup lang="ts">
/**
 * 木牛流马 · 机甲能量牛（SVG+CSS3 角色，登录页主视觉与右下角桌宠共用）。
 * 设计语言：钛灰棱角装甲 + 冰蓝能量流线 + 发光护目镜 + 分节牛角 + 后驱能量轮 +
 * 背负货舱 / 天线 / 全息「流马」旗；胸前挂「木牛」核心徽记。
 * 状态（mood）只改变能量色：idle 冰蓝 · working 主题色 · success 金 · error 赤 · curious 青。
 */
import { computed } from "vue";

const props = defineProps<{
  /** 同页多处使用时区分 SVG defs id 前缀，避免引用串扰 */
  idPrefix: string;
  mood?: "idle" | "working" | "success" | "error" | "curious";
}>();

const uid = computed(() => props.idPrefix);
const u = (name: string) => `url(#${uid.value}-${name})`;
</script>

<template>
  <svg
    class="cart"
    :class="`mood-${mood ?? 'idle'}`"
    viewBox="0 0 220 150"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient :id="uid + '-armor'" x1="0" y1="0" x2="0" y2="1">
        <stop stop-color="#c7d3df" />
        <stop offset="0.55" stop-color="#8496aa" />
        <stop offset="1" stop-color="#42536a" />
      </linearGradient>
      <linearGradient :id="uid + '-armor-deep'" x1="0" y1="0" x2="0" y2="1">
        <stop stop-color="#71859b" />
        <stop offset="1" stop-color="#33425a" />
      </linearGradient>
      <linearGradient :id="uid + '-dark'" x1="0" y1="0" x2="0" y2="1">
        <stop stop-color="#39434f" />
        <stop offset="1" stop-color="#161d26" />
      </linearGradient>
      <linearGradient :id="uid + '-horn'" x1="0" y1="1" x2="1" y2="0">
        <stop stop-color="#5d7186" />
        <stop offset="0.55" stop-color="#aebfd2" />
        <stop offset="1" stop-color="#e6f2ff" />
      </linearGradient>
      <linearGradient :id="uid + '-cloth'" x1="0" y1="0" x2="0" y2="1">
        <stop stop-color="#3f6fd1" stop-opacity="0.92" />
        <stop offset="1" stop-color="#1f3f7a" stop-opacity="0.92" />
      </linearGradient>
      <linearGradient :id="uid + '-pod'" x1="0" y1="0" x2="0" y2="1">
        <stop stop-color="#c9955a" />
        <stop offset="1" stop-color="#6e421c" />
      </linearGradient>
      <filter :id="uid + '-glow'" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="1.6" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>

    <!-- 地面光圈与投影 -->
    <ellipse cx="115" cy="138" rx="86" ry="6.5" fill="rgba(0,0,0,0.2)" />
    <ellipse class="halo spin" cx="115" cy="136" rx="88" ry="8.5" />
    <ellipse class="halo faint" cx="112" cy="84" rx="96" ry="20" transform="rotate(-6 112 84)" />

    <!-- 远侧能量轮（剪影） -->
    <g class="wheel far">
      <circle cx="163" cy="103" r="25" fill="#1c242e" stroke="#0d1319" stroke-width="1.5" />
      <g class="spokes-far">
        <circle cx="163" cy="103" r="17" fill="#141b23" />
        <g stroke="#2c3a4a" stroke-width="2">
          <line x1="163" y1="89" x2="163" y2="117" />
          <line x1="149" y1="103" x2="177" y2="103" />
          <line x1="153.5" y1="93.5" x2="172.5" y2="112.5" />
          <line x1="172.5" y1="93.5" x2="153.5" y2="112.5" />
        </g>
        <circle class="glow-dot" cx="163" cy="103" r="2" :filter="u('glow')" />
      </g>
    </g>

    <!-- 远侧液压腿 -->
    <g class="legs far">
      <g class="leg lf1">
        <path d="M86 86 h11 a4 4 0 0 1 4 4 v34 h-19 v-34 a4 4 0 0 1 4 -4 z" fill="#2c3a4a" stroke="#141b23" stroke-width="1" />
        <rect x="83" y="124" width="21" height="8" rx="3" fill="#10161c" />
      </g>
      <g class="leg lf2">
        <path d="M108 86 h11 a4 4 0 0 1 4 4 v34 h-19 v-34 a4 4 0 0 1 4 -4 z" fill="#242f3c" stroke="#141b23" stroke-width="1" />
        <rect x="105" y="124" width="21" height="8" rx="3" fill="#10161c" />
      </g>
    </g>

    <!-- 尾巴：能量须 -->
    <g class="tail">
      <path d="M167 78 C179 81 183 91 176 97" fill="none" stroke="#5d7186" stroke-width="3.6" stroke-linecap="round" />
      <circle class="glow-dot" cx="175" cy="98" r="2.4" :filter="u('glow')" />
    </g>

    <!-- 近侧能量轮：轮胎 + 双辐 + 能量环 + 核心毂 -->
    <g class="wheel near">
      <circle cx="150" cy="106" r="29" fill="#1a222c" stroke="#0d1319" stroke-width="2" />
      <circle cx="150" cy="106" r="22" :fill="u('dark')" stroke="#0d1319" stroke-width="1" />
      <g class="spokes">
        <circle cx="150" cy="106" r="14" fill="none" class="energy-stroke" stroke-width="1.6" opacity="0.95" :filter="u('glow')" />
        <g stroke="#3a4a5c" stroke-width="2.6">
          <line x1="150" y1="88" x2="150" y2="124" />
          <line x1="132" y1="106" x2="168" y2="106" />
          <line x1="137" y1="93" x2="163" y2="119" />
          <line x1="163" y1="93" x2="137" y2="119" />
        </g>
        <g fill="#8496aa">
          <circle cx="150" cy="88" r="1.8" />
          <circle cx="150" cy="124" r="1.8" />
          <circle cx="132" cy="106" r="1.8" />
          <circle cx="168" cy="106" r="1.8" />
          <circle cx="137.3" cy="93.3" r="1.8" />
          <circle cx="162.7" cy="118.7" r="1.8" />
          <circle cx="162.7" cy="93.3" r="1.8" />
          <circle cx="137.3" cy="118.7" r="1.8" />
        </g>
      </g>
      <circle cx="150" cy="106" r="6.5" :fill="u('dark')" stroke="#0d1319" stroke-width="1" />
      <circle class="glow-dot" cx="150" cy="106" r="2.6" :filter="u('glow')" />
    </g>

    <!-- 躯干：棱角装甲（上甲板 / 能量流线 / 下底盘） -->
    <g class="torso">
      <path d="M56 88 L60 62 L84 52 L146 47 L170 57 L173 88 L170 98 L60 98 Z" :fill="u('armor')" stroke="#1c2733" stroke-width="1.3" />
      <path d="M62 60 L88 51 L146 47" fill="none" stroke="#e6f2ff" stroke-opacity="0.55" stroke-width="1.4" stroke-linecap="round" />
      <path d="M59 74 C92 68 138 68 170 75" fill="none" stroke="#1c2733" stroke-opacity="0.5" stroke-width="1.1" />
      <path class="seam" d="M58 86 C92 80 138 80 171 86" fill="none" stroke-width="1.6" opacity="0.9" :filter="u('glow')" />
      <path d="M60 92 L168 92 L164 101 L64 101 Z" :fill="u('dark')" stroke="#10161c" stroke-width="1" />
      <circle class="glow-dot" cx="74" cy="96" r="1.4" :filter="u('glow')" />
      <circle class="glow-dot" cx="100" cy="97" r="1.4" :filter="u('glow')" />
      <circle class="glow-dot" cx="128" cy="96" r="1.4" :filter="u('glow')" />
      <circle class="glow-dot" cx="152" cy="94" r="1.4" :filter="u('glow')" />
      <!-- 肩关节盘 -->
      <circle cx="70" cy="80" r="7.5" :fill="u('dark')" stroke="#10161c" stroke-width="1" />
      <circle class="energy-stroke" cx="70" cy="80" r="4.2" fill="none" stroke-width="1.5" opacity="0.9" :filter="u('glow')" />
    </g>

    <!-- 背负货舱（木纹舱 + 能量窗）与天线 -->
    <g class="cargo">
      <rect x="92" y="26" width="52" height="30" rx="3" :fill="u('pod')" stroke="#3d2410" stroke-width="1.2" />
      <path d="M92 34 h52 M92 44 h52" stroke="#3d2410" stroke-opacity="0.45" stroke-width="0.9" />
      <rect x="98" y="30" width="40" height="5" rx="2" class="energy-fill" opacity="0.9" :filter="u('glow')" />
      <rect x="104" y="26" width="5" height="30" fill="#2a3442" opacity="0.85" />
      <rect x="130" y="26" width="5" height="30" fill="#2a3442" opacity="0.85" />
      <rect x="148" y="38" width="20" height="20" rx="2" :fill="u('dark')" stroke="#10161c" stroke-width="1" />
      <path d="M150 40 h16 M150 44 h16" stroke="#5d7186" stroke-width="1" />
      <line x1="152" y1="38" x2="152" y2="8" stroke="#5d7186" stroke-width="2.2" />
      <circle class="glow-dot blink" cx="152" cy="6.5" r="2.2" :filter="u('glow')" />
    </g>

    <!-- 全息「流马」旗 -->
    <g class="banner">
      <path d="M128 8 h20 v28 l-5 -4 -5 4 -5 -4 -5 4 z" :fill="u('cloth')" stroke="#6fd8ff" stroke-width="1" :filter="u('glow')" />
      <path d="M130 14 h16 M130 30 h16" stroke="#8fe0ff" stroke-opacity="0.45" stroke-width="0.7" />
      <text class="flag-text" x="138" y="19" text-anchor="middle" font-size="10">流</text>
      <text class="flag-text" x="138" y="31.5" text-anchor="middle" font-size="10">马</text>
    </g>

    <!-- 近侧液压腿（大腿甲 + 活塞杆 + 蹄） -->
    <g class="legs near">
      <g class="leg l1">
        <path d="M72 84 L68 104 L90 106 L94 86 Z" :fill="u('armor')" stroke="#1c2733" stroke-width="1.1" />
        <path d="M69 104 L66 128 L90 130 L92 106 Z" :fill="u('plank')" stroke="#1c2733" stroke-width="1" />
        <rect x="90" y="103" width="4.5" height="24" rx="2" :fill="u('dark')" />
        <rect x="91.2" y="105" width="2.2" height="20" rx="1.1" class="energy-fill" opacity="0.85" />
        <circle class="glow-dot" cx="80" cy="114" r="1.8" :filter="u('glow')" />
        <rect x="64" y="128" width="28" height="9" rx="3" fill="#10161c" stroke="#0d1319" stroke-width="0.8" />
      </g>
      <g class="leg l2">
        <path d="M96 86 L92 106 L114 108 L118 88 Z" :fill="u('armor')" stroke="#1c2733" stroke-width="1.1" />
        <path d="M93 108 L90 130 L114 132 L116 108 Z" :fill="u('plank')" stroke="#1c2733" stroke-width="1" />
        <rect x="114" y="105" width="4.5" height="24" rx="2" :fill="u('dark')" />
        <rect x="115.2" y="107" width="2.2" height="20" rx="1.1" class="energy-fill" opacity="0.85" />
        <circle class="glow-dot" cx="104" cy="116" r="1.8" :filter="u('glow')" />
        <rect x="88" y="130" width="28" height="9" rx="3" fill="#10161c" stroke="#0d1319" stroke-width="0.8" />
      </g>
    </g>

    <!-- 颈甲与「木牛」能量核心 -->
    <g class="collar">
      <path d="M60 58 C68 63 78 65 88 64 L90 73 C78 75 66 72 58 66 Z" :fill="u('dark')" stroke="#10161c" stroke-width="1" />
      <circle class="glow-dot" cx="69" cy="64" r="1.3" :filter="u('glow')" />
      <circle class="glow-dot" cx="81" cy="67" r="1.3" :filter="u('glow')" />
      <line x1="74" y1="72" x2="74" y2="77" stroke="#8496aa" stroke-width="1.4" />
      <g class="core">
        <circle cx="74" cy="85" r="7.5" :fill="u('dark')" stroke="#8496aa" stroke-width="1.6" />
        <text class="emblem" x="74" y="89" text-anchor="middle" font-size="8">木</text>
        <circle class="energy-stroke" cx="74" cy="85" r="10.5" fill="none" stroke-width="1" opacity="0.55" :filter="u('glow')" />
      </g>
    </g>

    <!-- 颈楔：连接头部与躯干 -->
    <path class="neck" d="M54 46 L88 56 L86 74 L52 62 Z" :fill="u('armor-deep')" stroke="#1c2733" stroke-width="1" />

    <!-- 头部（棱甲 + 护目镜 + 粗壮分节牛角） -->
    <g class="head">
      <!-- 远角（后，粗壮上弯） -->
      <path d="M50 26 C56 16 62 8 70 3 L75 9 C70 17 63 25 56 31 Z" :fill="u('horn')" stroke="#33425a" stroke-width="1" />
      <path d="M62 12 C60 16 57 20 54 24 M67 10 C65 14 62 18 59 22" fill="none" stroke="#33425a" stroke-opacity="0.5" stroke-width="0.9" />
      <circle class="glow-dot" cx="72.5" cy="6.5" r="1.4" :filter="u('glow')" />
      <!-- 耳鳍 -->
      <path d="M62 34 l12 -4 3 9 -11 4 z" :fill="u('armor-deep')" stroke="#1c2733" stroke-width="0.9" />
      <!-- 头甲（宽颅 + 斜面口鼻） -->
      <path d="M16 40 L22 26 L44 18 L66 22 L76 36 L76 54 L66 66 L34 66 L16 58 Z" :fill="u('armor')" stroke="#1c2733" stroke-width="1.3" />
      <path d="M24 30 L46 24 L62 26" fill="none" stroke="#e6f2ff" stroke-opacity="0.5" stroke-width="1.3" stroke-linecap="round" />
      <path d="M16 52 L34 50" stroke="#1c2733" stroke-opacity="0.4" stroke-width="1" />
      <!-- 口鼻部 -->
      <path d="M12 46 L32 44 L34 62 L24 68 L12 62 Z" :fill="u('armor-deep')" stroke="#1c2733" stroke-width="1.1" />
      <path d="M13 60 L28 62" stroke="#10161c" stroke-width="2.4" stroke-linecap="round" />
      <circle cx="18" cy="52" r="1.6" fill="#5d7186" />
      <!-- 护目镜（能量眼） -->
      <g class="eye">
        <rect x="26" y="42" width="30" height="12" rx="6" :fill="u('dark')" stroke="#10161c" stroke-width="1" />
        <rect class="visor" x="28.5" y="44.5" width="25" height="7" rx="3.5" :filter="u('glow')" />
        <rect class="visor-core" x="37" y="45.9" width="9" height="4.2" rx="2.1" />
        <rect class="lid" x="25" y="41" width="32" height="14" rx="6" />
      </g>
      <!-- 近角（前，粗壮新月） -->
      <path d="M32 26 C25 19 16 13 7 10 L11 3 C21 7 32 15 41 24 Z" :fill="u('horn')" stroke="#33425a" stroke-width="1" />
      <path d="M25 17 C21 14 17 11 13 9 M30 21 C26 18 23 16 19 13" fill="none" stroke="#33425a" stroke-opacity="0.5" stroke-width="0.9" />
      <circle class="glow-dot" cx="9.5" cy="6.5" r="1.4" :filter="u('glow')" />
      <!-- 额甲「牛」 -->
      <path d="M36 16 h18 l3.4 6.5 -3.4 6.5 h-18 l-3.4 -6.5 z" :fill="u('cloth')" stroke="#6fd8ff" stroke-width="0.9" />
      <text class="emblem" x="45" y="28" text-anchor="middle" font-size="8.5">牛</text>
    </g>

    <!-- 状态粒子（无文字） -->
    <g class="fx working-fx">
      <circle cx="176" cy="16" r="1.7" />
      <circle cx="184" cy="26" r="1.1" />
      <circle cx="172" cy="30" r="0.9" />
    </g>
    <g class="fx success-fx">
      <path d="M174 14 l3 6 6.5 1 -5 4.2 1.4 6.5 -5.9 -3.4 -5.9 3.4 1.4 -6.5 -5 -4.2 6.5 -1 z" />
    </g>
    <g class="fx error-fx">
      <path d="M174 12 v12 M180 18 h-12" stroke-width="2.2" stroke-linecap="round" />
    </g>
  </svg>
</template>

<style scoped>
.cart {
  --mood: #57c8ff;
  --mood-soft: rgba(87, 200, 255, 0.35);
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
}
.glow-dot,
.energy-fill,
.energy-stroke,
.visor {
  fill: var(--mood);
  color: var(--mood);
}
.energy-stroke {
  stroke: var(--mood);
}
.visor-core {
  fill: #ffffff;
  opacity: 0.95;
}
.lid {
  fill: #8fa2b6;
  stroke: #1c2733;
  stroke-width: 1;
  opacity: 0;
}
.halo {
  fill: none;
  stroke: var(--mood-soft);
  stroke-width: 2;
}
.halo.faint {
  stroke-width: 1.4;
  opacity: 0.4;
}
.halo.spin {
  stroke-dasharray: 10 7;
  animation: halo-spin 6s linear infinite;
  transform-origin: 115px 136px;
}
.seam {
  stroke-dasharray: 6 5;
  animation: seam-dash 2.2s linear infinite;
}
.emblem,
.flag-text {
  font-family: "Muni Brush", "STKaiti", "KaiTi", serif;
  font-weight: 700;
  fill: #eaf6ff;
  paint-order: stroke;
  stroke: rgba(16, 42, 66, 0.55);
  stroke-width: 1.6;
}
.fx {
  opacity: 0;
}
.mood-working .fx.working-fx {
  opacity: 1;
  animation: mote 0.9s ease-in-out infinite;
}
.mood-working .fx.working-fx circle {
  fill: var(--mood);
}
.mood-success .fx.success-fx {
  opacity: 1;
  animation: mote 1.2s ease-out infinite;
}
.mood-success .fx.success-fx path {
  fill: var(--mood);
}
.mood-error .fx.error-fx {
  opacity: 1;
  animation: mote 0.7s ease-in-out infinite;
}
.mood-error .fx.error-fx path {
  stroke: var(--mood);
  fill: none;
}
.mood-curious .visor {
  animation: eye-pulse 1.4s ease-in-out infinite;
}

.mood-idle {
  --mood: #57c8ff;
  --mood-soft: rgba(87, 200, 255, 0.35);
}
.mood-working {
  --mood: rgb(var(--accent-rgb));
  --mood-soft: rgba(var(--accent-rgb), 0.4);
}
.mood-success {
  --mood: #ffd873;
  --mood-soft: rgba(255, 216, 115, 0.45);
}
.mood-error {
  --mood: #ff6b6b;
  --mood-soft: rgba(255, 107, 107, 0.42);
}
.mood-curious {
  --mood: #7ef3ff;
  --mood-soft: rgba(126, 243, 255, 0.4);
}

.legs.near .leg {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 0.9s ease-in-out infinite alternate;
}
.legs.near .l2 {
  animation-delay: -0.45s;
}
.legs.far .leg {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 0.9s ease-in-out infinite alternate;
}
.legs.far .lf1 {
  animation-delay: -0.22s;
}
.legs.far .lf2 {
  animation-delay: 0.23s;
}
.spokes {
  transform-origin: 150px 106px;
  animation: wheel-spin 8s linear infinite;
}
.spokes-far {
  transform-origin: 163px 103px;
  animation: wheel-spin 10.5s linear infinite;
}
.head {
  animation: head-bob 0.9s ease-in-out infinite;
  transform-origin: 50px 62px;
}
.banner {
  animation: sway 2.6s ease-in-out infinite alternate;
  transform-origin: 148px 8px;
}
.tail {
  animation: sway 1.4s ease-in-out infinite alternate;
  transform-origin: 167px 78px;
}
.blink {
  animation: led-blink 1.6s ease-in-out infinite;
}

@keyframes step {
  from {
    transform: rotate(-4.5deg);
  }
  to {
    transform: rotate(4.5deg);
  }
}
@keyframes wheel-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes head-bob {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  50% {
    transform: translateY(1px) rotate(-1deg);
  }
}
@keyframes sway {
  from {
    transform: rotate(-2.5deg);
  }
  to {
    transform: rotate(2.5deg);
  }
}
@keyframes halo-spin {
  to {
    stroke-dashoffset: -34;
  }
}
@keyframes seam-dash {
  to {
    stroke-dashoffset: -22;
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
@keyframes eye-pulse {
  0%,
  100% {
    opacity: 0.6;
  }
  50% {
    opacity: 1;
  }
}
@keyframes led-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

@media (prefers-reduced-motion: reduce) {
  .legs.near .leg,
  .legs.far .leg,
  .spokes,
  .spokes-far,
  .head,
  .banner,
  .tail,
  .halo.spin,
  .seam,
  .fx,
  .blink {
    animation: none !important;
  }
}
</style>
