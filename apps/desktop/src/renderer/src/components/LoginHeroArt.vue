<script setup lang="ts">
/** 登录页主视觉：侧视机甲木牛车（与右下角桌宠同形象）——木甲拼片、后部大木轮、货箱与「流马」蓝旗、胸前「木牛」木牌 */
</script>

<template>
  <div class="hero-art" aria-hidden="true">
    <svg class="scene" viewBox="0 0 560 340" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lh2-m-wood" x1="0" y1="0" x2="0" y2="1">
          <stop class="wood-a" stop-color="#ecc894" />
          <stop class="wood-b" offset="0.55" stop-color="#c08c48" />
          <stop class="wood-c" offset="1" stop-color="#7a4a22" />
        </linearGradient>
        <linearGradient id="lh2-m-plank" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#e2b478" />
          <stop offset="1" stop-color="#9a6428" />
        </linearGradient>
        <linearGradient id="lh2-m-metal" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#4a5a6a" />
          <stop offset="1" stop-color="#1e2933" />
        </linearGradient>
        <linearGradient id="lh2-m-horn" x1="0" y1="1" x2="1" y2="0">
          <stop stop-color="#8fa3b8" />
          <stop offset="0.6" stop-color="#c3d3e2" />
          <stop offset="1" stop-color="#e9f1f8" />
        </linearGradient>
        <linearGradient id="lh2-m-cloth" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#5f92dc" />
          <stop offset="1" stop-color="#2d5c9e" />
        </linearGradient>
        <filter id="lh2-m-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <ellipse cx="280" cy="150" rx="230" ry="110" fill="rgba(var(--accent-rgb),0.10)" />
      <ellipse cx="285" cy="300" rx="215" ry="17" fill="rgba(0,0,0,0.25)" />

      <g transform="translate(60,16) scale(2)"><g class="ox-cart">


      <!-- 地面光圈与投影 -->
      <ellipse cx="115" cy="138" rx="84" ry="6.5" fill="rgba(0,0,0,0.2)" />
      <ellipse class="halo spin" cx="115" cy="136" rx="88" ry="8.5" />
      <ellipse class="halo faint" cx="112" cy="84" rx="96" ry="20" transform="rotate(-6 112 84)" />

      <!-- 远侧车轮（剪影，垫深度） -->
      <g class="wheel far">
        <circle cx="163" cy="103" r="25" fill="#2e2013" stroke="#1a1208" stroke-width="1.5" />
        <circle cx="163" cy="103" r="18" fill="#241708" />
      </g>

      <!-- 远侧前腿 -->
      <g class="legs far">
        <path d="M86 86 h11 a4 4 0 0 1 4 4 v34 h-19 v-34 a4 4 0 0 1 4 -4 z" fill="#6b4520" stroke="#3d2410" stroke-width="1" />
        <rect x="83" y="124" width="21" height="8" rx="3" fill="#14100a" />
        <path d="M108 86 h11 a4 4 0 0 1 4 4 v34 h-19 v-34 a4 4 0 0 1 4 -4 z" fill="#5e3c1b" stroke="#3d2410" stroke-width="1" />
        <rect x="105" y="124" width="21" height="8" rx="3" fill="#14100a" />
      </g>

      <!-- 尾巴 -->
      <g class="tail">
        <path d="M167 76 C178 78 182 87 176 93" fill="none" stroke="#8a5530" stroke-width="4" stroke-linecap="round" />
        <circle cx="175" cy="94" r="3" fill="#2d5c9e" stroke="#1e3a5f" stroke-width="0.8" />
      </g>

      <!-- 近侧大木轮：轮胎 + 辐条 + 铆钉 + 轮毂 -->
      <g class="wheel near">
        <circle cx="150" cy="106" r="29" fill="#5a3a1a" stroke="#241505" stroke-width="2" />
        <circle cx="150" cy="106" r="22.5" fill="#7a4a22" stroke="#3d2410" stroke-width="1.2" />
        <g class="spokes">
          <g stroke="#4e2c12" stroke-width="2.6">
            <line x1="150" y1="86" x2="150" y2="126" />
            <line x1="130" y1="106" x2="170" y2="106" />
            <line x1="136" y1="92" x2="164" y2="120" />
            <line x1="164" y1="92" x2="136" y2="120" />
          </g>
          <g fill="#c9955a">
            <circle cx="150" cy="83.5" r="1.7" />
            <circle cx="150" cy="128.5" r="1.7" />
            <circle cx="127.5" cy="106" r="1.7" />
            <circle cx="172.5" cy="106" r="1.7" />
            <circle cx="133.6" cy="89.6" r="1.7" />
            <circle cx="166.4" cy="122.4" r="1.7" />
            <circle cx="166.4" cy="89.6" r="1.7" />
            <circle cx="133.6" cy="122.4" r="1.7" />
          </g>
        </g>
        <circle cx="150" cy="106" r="6.5" fill="url(#lh2-m-metal)" stroke="#141c24" stroke-width="1.1" />
        <circle class="glow-stroke" cx="150" cy="106" r="3.4" fill="none" stroke-width="1.5" opacity="0.95" filter="url(#lh2-m-glow)" />
      </g>

      <!-- 躯干（横向拼片木甲） -->
      <g class="torso">
        <path d="M55 74 C55 64 68 58 100 57 C135 56 162 62 166 74 L168 95 C168 105 150 110 110 110 C72 110 56 105 55 95 Z" fill="url(#lh2-m-wood)" stroke="#4e2c12" stroke-width="1.4" />
        <path d="M60 63 C90 59 130 59 160 64" fill="none" stroke="#ffe9b8" stroke-opacity="0.5" stroke-width="1.6" stroke-linecap="round" />
        <path d="M57 78 C90 72 135 72 165 78" fill="none" stroke="#4e2c12" stroke-opacity="0.4" stroke-width="1.1" />
        <path class="seam" d="M56 86 C90 80 138 80 166 86" fill="none" stroke-width="1.6" opacity="0.85" filter="url(#lh2-m-glow)" />
        <path d="M56 93 C90 88 138 88 166 93" fill="none" stroke="#4e2c12" stroke-opacity="0.35" stroke-width="1.1" />
        <!-- 腹甲（金属 + 光铆钉） -->
        <path d="M58 99 C90 106 135 106 167 99 L166 104 C140 110 85 110 59 104 Z" fill="url(#lh2-m-metal)" stroke="#141c24" stroke-width="1" />
        <circle class="glow-fill" cx="72" cy="103" r="1.4" filter="url(#lh2-m-glow)" />
        <circle class="glow-fill" cx="96" cy="105" r="1.4" filter="url(#lh2-m-glow)" />
        <circle class="glow-fill" cx="121" cy="105" r="1.4" filter="url(#lh2-m-glow)" />
        <circle class="glow-fill" cx="146" cy="103" r="1.4" filter="url(#lh2-m-glow)" />
        <!-- 肩关节盘 -->
        <circle cx="72" cy="80" r="7.5" fill="url(#lh2-m-metal)" stroke="#141c24" stroke-width="1" />
        <circle class="glow-stroke" cx="72" cy="80" r="4.2" fill="none" stroke-width="1.5" opacity="0.9" filter="url(#lh2-m-glow)" />
      </g>

      <!-- 背上货箱 + 捆卷 + 绳带 -->
      <g class="cargo">
        <rect x="90" y="36" width="50" height="26" rx="3" fill="url(#lh2-m-plank)" stroke="#4e2c12" stroke-width="1.2" />
        <path d="M90 44 h50 M90 53 h50" stroke="#4e2c12" stroke-opacity="0.4" stroke-width="0.9" />
        <path d="M90 38 l6 6 M140 38 l-6 6 M90 60 l6 -6 M140 60 l-6 -6" stroke="#4a5a6a" stroke-width="1.6" />
        <rect x="103" y="36" width="5" height="26" fill="#2a3442" opacity="0.85" />
        <rect x="127" y="36" width="5" height="26" fill="#2a3442" opacity="0.85" />
        <rect x="94" y="26" width="34" height="12" rx="6" fill="url(#lh2-m-plank)" stroke="#4e2c12" stroke-width="1" />
        <circle cx="126" cy="32" r="2.6" fill="#e8c896" stroke="#4e2c12" stroke-width="0.9" />
        <circle cx="126" cy="32" r="1" fill="#8a5a26" />
        <rect x="122" y="30" width="30" height="11" rx="5.5" fill="url(#lh2-m-wood)" stroke="#4e2c12" stroke-width="1" />
        <circle cx="150" cy="35.5" r="2.4" fill="#e8c896" stroke="#4e2c12" stroke-width="0.9" />
      </g>

      <!-- 旗杆与「流马」蓝旗 -->
      <g class="flag">
        <line x1="150" y1="48" x2="150" y2="4" stroke="#8a5530" stroke-width="2.5" />
        <circle cx="150" cy="3.4" r="2.2" fill="#d8b46a" stroke="#8a5a26" stroke-width="0.8" />
        <g class="banner">
          <path d="M128 8 h20 v28 l-5 -4 -5 4 -5 -4 -5 4 z" fill="url(#lh2-m-cloth)" stroke="#1e3a5f" stroke-width="1" />
          <text class="flag-text" x="138" y="19" text-anchor="middle" font-size="10">流</text>
          <text class="flag-text" x="138" y="31.5" text-anchor="middle" font-size="10">马</text>
        </g>
      </g>

      <!-- 近侧前腿（木甲 + 膝盖光圈） -->
      <g class="legs near">
        <g class="leg l1">
          <path d="M70 86 L66 110 L82 112 L86 88 Z" fill="url(#lh2-m-wood)" stroke="#5c3416" stroke-width="1.1" />
          <circle class="glow-fill" cx="74" cy="112" r="2" filter="url(#lh2-m-glow)" />
          <path d="M67 112 L63 130 L77 132 L81 114 Z" fill="url(#lh2-m-plank)" stroke="#5c3416" stroke-width="1" />
          <rect x="60" y="130" width="20" height="8" rx="3" fill="#1a232c" stroke="#0d1319" stroke-width="0.8" />
        </g>
        <g class="leg l2">
          <path d="M92 88 L88 112 L104 114 L108 90 Z" fill="url(#lh2-m-wood)" stroke="#5c3416" stroke-width="1.1" />
          <circle class="glow-fill" cx="96" cy="114" r="2" filter="url(#lh2-m-glow)" />
          <path d="M89 114 L85 132 L99 134 L103 116 Z" fill="url(#lh2-m-plank)" stroke="#5c3416" stroke-width="1" />
          <rect x="82" y="132" width="20" height="8" rx="3" fill="#1a232c" stroke="#0d1319" stroke-width="0.8" />
        </g>
      </g>

      <!-- 颈圈与「木牛」木牌、蓝流苏 -->
      <g class="collar">
        <path d="M58 58 C64 63 72 65 80 64 L82 72 C72 74 62 71 55 66 Z" fill="#2a3442" stroke="#141c24" stroke-width="1" />
        <circle class="glow-fill" cx="64" cy="63" r="1.3" filter="url(#lh2-m-glow)" />
        <circle class="glow-fill" cx="75" cy="66" r="1.3" filter="url(#lh2-m-glow)" />
        <line x1="68" y1="70" x2="68" y2="75" stroke="#c9a06a" stroke-width="1.4" />
        <rect x="61.5" y="75" width="13" height="20" rx="2.5" fill="url(#lh2-m-plank)" stroke="#5c3416" stroke-width="1" />
        <text class="tag-text" x="68" y="83.5" text-anchor="middle" font-size="6.5">木</text>
        <text class="tag-text" x="68" y="91.5" text-anchor="middle" font-size="6.5">牛</text>
        <line x1="68" y1="95" x2="68" y2="98.5" stroke="#2d5c9e" stroke-width="1.3" />
        <circle cx="68" cy="99.8" r="1.5" fill="#2d5c9e" />
        <path d="M65.8 101 h4.4 l-0.9 5 -1.3 1.8 -1.3 -1.8 z" fill="#4a7cc0" />
      </g>

      <!-- 头部（侧视，朝左） -->
      <g class="head">
        <!-- 颈楔：补齐头颈与躯干的过渡 -->
        <path d="M52 46 L76 58 L74 70 L50 62 Z" fill="url(#lh2-m-plank)" stroke="#4e2c12" stroke-width="1" />
        <!-- 远角（粗壮上弯，带棱线） -->
        <path d="M44 27 C42 20 41 14 42 8 C42.5 4.5 48 4.5 48.5 8 C49.5 14 51 20 54 25 Z" fill="#8fa3b8" stroke="#4a5a6a" stroke-width="1" />
        <path d="M42.5 15 C43.5 12 44 9 44.2 6 M46.5 15 C47.5 12 48 9 48.2 6" fill="none" stroke="#4a5a6a" stroke-opacity="0.5" stroke-width="0.9" />
        <!-- 耳朵 -->
        <ellipse cx="58" cy="32" rx="4" ry="6" transform="rotate(38 58 32)" fill="url(#lh2-m-wood)" stroke="#5c3416" stroke-width="0.9" />
        <ellipse cx="58.5" cy="32.5" rx="1.7" ry="3.2" transform="rotate(38 58.5 32.5)" fill="#f7ecd8" />
        <!-- 头甲与口鼻 -->
        <rect x="22" y="26" width="42" height="36" rx="13" fill="url(#lh2-m-wood)" stroke="#4e2c12" stroke-width="1.3" />
        <path d="M26 32 C32 28 44 27 54 29" fill="none" stroke="#4e2c12" stroke-opacity="0.35" stroke-width="1" />
        <rect x="14" y="43" width="26" height="19" rx="7" fill="url(#lh2-m-plank)" stroke="#4e2c12" stroke-width="1.1" />
        <rect x="15" y="58" width="22" height="6" rx="3" fill="url(#lh2-m-metal)" stroke="#141c24" stroke-width="0.9" />
        <circle cx="19.5" cy="51" r="1.6" fill="#8a5a26" />
        <path class="mouth-line" d="M17 56.5 h9" stroke="#5c3416" stroke-width="1.1" stroke-linecap="round" />
        <!-- 近角（粗壮上弯，带棱线与光尖） -->
        <path d="M27 28 C22 23 20 17 21 11 C21.5 7.5 27 7.5 27.5 11 C28.5 17 31 22 36 27 Z" fill="url(#lh2-m-horn)" stroke="#4a5a6a" stroke-width="1" />
        <path d="M23.5 16 C23 13 23 10 23.5 7 M28 16 C27.5 13 27 10 27 7" fill="none" stroke="#4a5a6a" stroke-opacity="0.45" stroke-width="0.9" />
        <circle class="glow-fill" cx="22" cy="9.5" r="1.1" filter="url(#lh2-m-glow)" />
        <!-- 护额「牛」纹 -->
        <path d="M33 24 h15 l2.8 5.5 -2.8 5.5 h-15 l-2.8 -5.5 z" fill="url(#lh2-m-cloth)" stroke="#1e3a5f" stroke-width="0.9" />
        <text class="emblem" x="41" y="34" text-anchor="middle" font-size="8">牛</text>
        <!-- 发光眼（瞳孔跟随 + 眨眼） -->
        <g class="eye">
          <circle cx="40" cy="43" r="6.8" fill="url(#lh2-m-metal)" stroke="#141c24" stroke-width="1" />
          <g class="iris" transform="translate(0.6 -0.3)">
            <circle class="eye-orb" cx="40" cy="43" r="4.4" filter="url(#lh2-m-glow)" />
            <circle class="eye-core" cx="40" cy="43" r="1.7" />
          </g>
          <rect class="lid" x="32" y="35" width="16" height="16" rx="5" />
        </g>
      </g>

      <!-- 状态粒子（无文字） -->
      </g></g>

      <g class="chip a">
        <rect x="36" y="70" width="92" height="58" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.22)" />
        <rect x="50" y="86" width="44" height="3.5" rx="1.75" fill="rgba(255,255,255,0.5)" />
        <rect x="50" y="98" width="58" height="3" rx="1.5" fill="rgba(255,255,255,0.22)" />
        <rect x="50" y="108" width="40" height="3" rx="1.5" fill="rgba(255,255,255,0.14)" />
      </g>

      <g class="chip c">
        <rect x="436" y="64" width="96" height="70" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.22)" />
        <rect x="450" y="80" width="28" height="28" rx="8" fill="rgba(var(--accent-rgb),0.35)" />
        <path d="M457 90 h14 a3 3 0 0 1 3 3 v6 a3 3 0 0 1 -3 3 h-6 l-4 4 v-4 h-4 a3 3 0 0 1 -3 -3 v-6 a3 3 0 0 1 3 -3 z" fill="#eaf3ff" opacity="0.9" />
        <rect x="482" y="84" width="30" height="3" rx="1.5" fill="rgba(255,255,255,0.45)" />
        <rect x="482" y="94" width="24" height="3" rx="1.5" fill="rgba(255,255,255,0.22)" />
        <rect x="450" y="118" width="66" height="3" rx="1.5" fill="rgba(255,255,255,0.14)" />
      </g>

      <g fill="rgba(255,255,255,0.55)" font-size="11" font-family="ui-sans-serif,system-ui,sans-serif" letter-spacing="0.14em">
        <text x="190" y="326" text-anchor="middle">任务</text>
        <text x="285" y="326" text-anchor="middle" fill="rgba(255,255,255,0.9)">驮运</text>
        <text x="380" y="326" text-anchor="middle">交付</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.hero-art {
  width: 100%;
  max-width: 560px;
  margin: 6px 0 2px;
  aspect-ratio: 560 / 340;
}
.scene {
  width: 100%;
  height: 100%;
  display: block;
}
.ox-cart {
  --mood: rgb(var(--accent-rgb));
  --mood-soft: rgba(var(--accent-rgb), 0.35);
  animation: haul 4.8s ease-in-out infinite;
}
.glow-fill,
.glow-stroke,
.seam,
.eye-orb {
  fill: var(--mood);
  color: var(--mood);
}
.glow-stroke,
.seam {
  stroke: var(--mood);
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
  animation: dash-ring 7s linear infinite;
  transform-origin: 115px 136px;
}
.emblem,
.flag-text,
.tag-text {
  font-family: "Muni Brush", "STKaiti", "KaiTi", serif;
  font-weight: 700;
  fill: #f2f9ff;
  paint-order: stroke;
  stroke: rgba(16, 42, 66, 0.55);
  stroke-width: 1.6;
}
.tag-text {
  fill: #4e2c12;
  stroke: none;
}
.eye-core {
  fill: #ffffff;
  opacity: 0.95;
}
.lid {
  opacity: 0;
}
.chip {
  animation: bob 6s ease-in-out infinite;
}
.chip.c {
  animation-delay: -2.4s;
}
.spokes {
  transform-origin: 150px 106px;
  animation: wheel-spin 12s linear infinite;
}
.legs.near .leg {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 1.15s ease-in-out infinite alternate;
}
.legs.near .l2 {
  animation-delay: 0.55s;
}
.head {
  animation: head-bob 1.15s ease-in-out infinite;
  transform-origin: 50px 60px;
}
.banner {
  animation: sway 3s ease-in-out infinite alternate;
  transform-origin: 148px 8px;
}
.tail {
  animation: sway 1.6s ease-in-out infinite alternate;
  transform-origin: 167px 76px;
}

@keyframes haul {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-3px);
  }
}
@keyframes step {
  from {
    transform: rotate(-4.5deg);
  }
  to {
    transform: rotate(4.5deg);
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
@keyframes head-bob {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  50% {
    transform: translateY(0.8px) rotate(-0.8deg);
  }
}
@keyframes dash-ring {
  to {
    stroke-dashoffset: -34;
  }
}
@keyframes wheel-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

:root[data-fx="off"] .ox-cart,
:root[data-fx="off"] .spokes,
:root[data-fx="off"] .legs.near .leg,
:root[data-fx="off"] .head,
:root[data-fx="off"] .banner,
:root[data-fx="off"] .tail,
:root[data-fx="off"] .halo.spin,
:root[data-fx="off"] .chip {
  animation: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .ox-cart,
  .spokes,
  .legs.near .leg,
  .head,
  .banner,
  .tail,
  .halo.spin,
  .chip {
    animation: none !important;
  }
}
</style>
