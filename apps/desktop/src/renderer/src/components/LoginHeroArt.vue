<script setup lang="ts">
/** 登录页左侧插画：任务流 → 智能体 → 成果物，纯 SVG，跟随 --accent-rgb */
</script>

<template>
  <div class="hero-art" aria-hidden="true">
    <svg class="scene" viewBox="0 0 520 360" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lh-desk" x1="60" y1="40" x2="460" y2="320" gradientUnits="userSpaceOnUse">
          <stop stop-color="rgb(var(--accent-rgb))" stop-opacity="0.55" />
          <stop offset="1" stop-color="#7eb6ff" stop-opacity="0.25" />
        </linearGradient>
        <linearGradient id="lh-panel" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#fff" stop-opacity="0.22" />
          <stop offset="1" stop-color="#fff" stop-opacity="0.06" />
        </linearGradient>
        <linearGradient id="lh-glow" x1="260" y1="40" x2="260" y2="300" gradientUnits="userSpaceOnUse">
          <stop stop-color="rgb(var(--accent-rgb))" stop-opacity="0.35" />
          <stop offset="1" stop-color="rgb(var(--accent-rgb))" stop-opacity="0" />
        </linearGradient>
        <filter id="lh-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      <!-- 氛围光 -->
      <ellipse cx="270" cy="200" rx="200" ry="120" fill="url(#lh-glow)" filter="url(#lh-soft)" />

      <!-- 远景网格台面 -->
      <g opacity="0.35" stroke="rgba(255,255,255,0.22)" stroke-width="1">
        <path d="M40 250 L260 160 L480 250 L260 340 Z" fill="url(#lh-panel)" />
        <path d="M100 275 L260 205 L420 275" />
        <path d="M160 298 L260 252 L360 298" />
        <path d="M150 220 L260 175 L370 220" />
        <path d="M120 200 L120 280 M200 168 L200 305 M320 168 L320 305 M400 200 L400 280" />
      </g>

      <!-- 左侧：任务卡片栈 -->
      <g class="float a">
        <rect x="56" y="92" width="132" height="88" rx="14" fill="url(#lh-panel)" stroke="rgba(255,255,255,0.28)" />
        <rect x="72" y="112" width="72" height="8" rx="4" fill="rgba(255,255,255,0.55)" />
        <rect x="72" y="128" width="100" height="6" rx="3" fill="rgba(255,255,255,0.28)" />
        <rect x="72" y="142" width="88" height="6" rx="3" fill="rgba(255,255,255,0.2)" />
        <circle cx="160" cy="156" r="10" fill="rgb(var(--accent-rgb))" opacity="0.85" />
        <path d="M155 156h10M160 151v10" stroke="#fff" stroke-width="1.6" stroke-linecap="round" />
      </g>
      <g class="float b" opacity="0.7">
        <rect x="72" y="72" width="118" height="28" rx="10" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.18)" />
        <rect x="86" y="82" width="54" height="6" rx="3" fill="rgba(255,255,255,0.35)" />
      </g>

      <!-- 中枢：智能体核心 -->
      <g class="core">
        <circle cx="260" cy="168" r="54" fill="url(#lh-desk)" opacity="0.35" />
        <circle cx="260" cy="168" r="38" fill="rgba(10,16,24,0.45)" stroke="rgba(255,255,255,0.35)" stroke-width="1.5" />
        <circle cx="260" cy="168" r="24" fill="rgb(var(--accent-rgb))" opacity="0.9" />
        <!-- 抽象「澄」字形节点 -->
        <path
          d="M248 158h24M252 168h16M256 178h8"
          stroke="#fff"
          stroke-width="2.4"
          stroke-linecap="round"
          opacity="0.95"
        />
        <circle cx="260" cy="168" r="46" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4 6" class="orbit" />
        <circle cx="304" cy="150" r="5" fill="#fff" opacity="0.85" class="sat" />
        <circle cx="222" cy="190" r="4" fill="rgb(var(--accent-rgb))" class="sat2" />
      </g>

      <!-- 连接弧线 -->
      <path
        class="flow"
        d="M188 130 C210 120, 230 130, 236 150"
        stroke="rgba(255,255,255,0.45)"
        stroke-width="1.5"
        stroke-dasharray="3 5"
      />
      <path
        class="flow delay"
        d="M284 150 C310 120, 340 125, 368 138"
        stroke="rgba(255,255,255,0.45)"
        stroke-width="1.5"
        stroke-dasharray="3 5"
      />

      <!-- 右侧：成果物面板 -->
      <g class="float c">
        <rect x="340" y="88" width="128" height="108" rx="14" fill="url(#lh-panel)" stroke="rgba(255,255,255,0.28)" />
        <rect x="356" y="108" width="48" height="48" rx="10" fill="rgba(var(--accent-rgb), 0.45)" />
        <path d="M368 132h24M368 140h16" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity="0.8" />
        <rect x="414" y="112" width="38" height="7" rx="3.5" fill="rgba(255,255,255,0.5)" />
        <rect x="414" y="126" width="32" height="6" rx="3" fill="rgba(255,255,255,0.28)" />
        <rect x="356" y="168" width="96" height="8" rx="4" fill="rgba(255,255,255,0.16)" />
        <rect x="356" y="182" width="72" height="6" rx="3" fill="rgba(255,255,255,0.12)" />
      </g>

      <!-- 底部小标签条 -->
      <g opacity="0.85">
        <rect x="148" y="268" width="72" height="26" rx="13" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)" />
        <text x="184" y="285" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="11" font-family="system-ui,sans-serif">任务</text>
        <rect x="228" y="268" width="72" height="26" rx="13" fill="rgba(var(--accent-rgb), 0.35)" stroke="rgba(255,255,255,0.25)" />
        <text x="264" y="285" text-anchor="middle" fill="#fff" font-size="11" font-family="system-ui,sans-serif">智能体</text>
        <rect x="308" y="268" width="72" height="26" rx="13" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)" />
        <text x="344" y="285" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="11" font-family="system-ui,sans-serif">成果物</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.hero-art {
  position: relative;
  width: 100%;
  max-width: 520px;
  margin: 8px 0 4px;
  aspect-ratio: 520 / 360;
}
.scene {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}
.float {
  transform-origin: center;
  animation: bob 5.5s ease-in-out infinite;
}
.float.b {
  animation-duration: 6.5s;
  animation-delay: -1.2s;
}
.float.c {
  animation-duration: 7s;
  animation-delay: -2.4s;
}
.orbit {
  transform-origin: 260px 168px;
  animation: spin 18s linear infinite;
}
.sat {
  transform-origin: 260px 168px;
  animation: spin 12s linear infinite;
}
.sat2 {
  transform-origin: 260px 168px;
  animation: spin 9s linear reverse infinite;
}
.flow {
  stroke-dashoffset: 0;
  animation: dash 2.8s linear infinite;
}
.flow.delay {
  animation-delay: -1.4s;
}

@keyframes bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-7px);
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes dash {
  to {
    stroke-dashoffset: -32;
  }
}

:root[data-fx="off"] .float,
:root[data-fx="off"] .orbit,
:root[data-fx="off"] .sat,
:root[data-fx="off"] .sat2,
:root[data-fx="off"] .flow {
  animation-play-state: paused;
}

/* 未开微特效时仍保留极轻浮动，避免完全死板；减弱即可 */
:root[data-fx="off"] .float {
  animation: bob 8s ease-in-out infinite;
}
:root[data-fx="off"] .orbit,
:root[data-fx="off"] .sat,
:root[data-fx="off"] .sat2 {
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  .float,
  .orbit,
  .sat,
  .sat2,
  .flow {
    animation: none !important;
  }
}
</style>
