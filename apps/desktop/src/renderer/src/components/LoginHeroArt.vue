<script setup lang="ts">
/** 登录页主视觉：四足木牛 + 衔接头骨的弯角 + 侧腹电源开关 */
</script>

<template>
  <div class="hero-art" aria-hidden="true">
    <svg class="scene" viewBox="0 0 560 340" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lh-wood" x1="100" y1="80" x2="420" y2="280" gradientUnits="userSpaceOnUse">
          <stop stop-color="#f0d9b0" />
          <stop offset="0.45" stop-color="#c9955a" />
          <stop offset="1" stop-color="#7a4a22" />
        </linearGradient>
        <linearGradient id="lh-wood-deep" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#c9955a" />
          <stop offset="1" stop-color="#4e2c12" />
        </linearGradient>
        <linearGradient id="lh-horn" x1="0" y1="1" x2="1" y2="0">
          <stop stop-color="#e8c896" />
          <stop offset="0.55" stop-color="#a87438" />
          <stop offset="1" stop-color="#5c3416" />
        </linearGradient>
        <linearGradient id="lh-tech" x1="140" y1="100" x2="400" y2="240" gradientUnits="userSpaceOnUse">
          <stop stop-color="rgb(var(--accent-rgb))" stop-opacity="0.95" />
          <stop offset="1" stop-color="#f2d8a0" stop-opacity="0.4" />
        </linearGradient>
        <radialGradient id="lh-glow" cx="48%" cy="42%" r="48%">
          <stop stop-color="rgb(var(--accent-rgb))" stop-opacity="0.26" />
          <stop offset="1" stop-color="rgb(var(--accent-rgb))" stop-opacity="0" />
        </radialGradient>
        <filter id="lh-soft"><feGaussianBlur stdDeviation="10" /></filter>
        <pattern id="lh-plank" width="14" height="14" patternUnits="userSpaceOnUse">
          <path d="M0 7h14" stroke="#4a2a12" stroke-opacity="0.14" stroke-width="0.8" />
        </pattern>
      </defs>

      <ellipse cx="280" cy="160" rx="200" ry="100" fill="url(#lh-glow)" filter="url(#lh-soft)" />
      <ellipse cx="280" cy="296" rx="210" ry="20" fill="rgba(0,0,0,0.22)" />
      <path d="M70 290 Q280 314 490 290" stroke="rgba(255,255,255,0.1)" stroke-width="12" stroke-linecap="round" />

      <g class="chip a">
        <rect x="36" y="78" width="92" height="58" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.22)" />
        <rect x="50" y="94" width="44" height="3.5" rx="1.75" fill="rgba(255,255,255,0.5)" />
        <rect x="50" y="106" width="58" height="3" rx="1.5" fill="rgba(255,255,255,0.22)" />
        <rect x="50" y="116" width="40" height="3" rx="1.5" fill="rgba(255,255,255,0.14)" />
      </g>

      <g class="ox">
        <!-- 后腿：髋板插入腹底 -->
        <g class="leg far">
          <ellipse cx="324" cy="198" rx="16" ry="8" fill="#6a3d18" stroke="#3d2410" stroke-width="1.2" />
          <path class="thigh" d="M312 198 L306 236 L318 238 L328 200 Z" fill="url(#lh-wood-deep)" stroke="#3d2410" stroke-width="1.2" />
          <path class="shank" d="M308 236 L302 274 L314 276 L320 238 Z" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1.2" />
          <ellipse cx="308" cy="278" rx="9" ry="4" fill="#2a1a08" />
          <circle cx="314" cy="216" r="2.2" fill="rgb(var(--accent-rgb))" />
          <circle cx="310" cy="248" r="1.8" fill="rgb(var(--accent-rgb))" />
        </g>
        <g class="leg far b">
          <ellipse cx="352" cy="196" rx="14" ry="7" fill="#6a3d18" stroke="#3d2410" stroke-width="1.2" />
          <path class="thigh" d="M342 196 L338 234 L350 236 L358 198 Z" fill="url(#lh-wood-deep)" stroke="#3d2410" stroke-width="1.2" />
          <path class="shank" d="M340 234 L346 272 L358 274 L352 236 Z" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1.2" />
          <ellipse cx="352" cy="276" rx="9" ry="4" fill="#2a1a08" />
          <circle cx="348" cy="214" r="2.2" fill="rgb(var(--accent-rgb))" />
        </g>

        <!-- 粮箱 -->
        <g class="crate">
          <path d="M186 124 L372 114 L382 186 L194 198 Z" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1.8" />
          <path d="M186 124 L372 114 L372 134 L186 144 Z" fill="#e8c896" opacity="0.55" />
          <rect x="198" y="128" width="164" height="58" fill="url(#lh-plank)" opacity="0.65" />
          <path d="M208 146 H354 M216 166 H344" stroke="#3d2410" stroke-opacity="0.28" stroke-width="1.1" />
          <path d="M188 124 L370 114" stroke="url(#lh-tech)" stroke-width="2" stroke-linecap="round" />
        </g>

        <!-- 躯干：下沿覆盖髋肩，保证腿「长进去」 -->
        <path
          class="torso"
          d="M168 164
             C202 142 268 134 338 140
             C368 144 386 164 384 188
             C382 206 350 214 300 216
             C240 218 190 212 172 198
             C160 186 158 174 168 164 Z"
          fill="url(#lh-wood-deep)"
          stroke="#3d2410"
          stroke-width="1.7"
        />
        <path d="M184 176 H360" stroke="#3d2410" stroke-opacity="0.22" stroke-width="1" />
        <path class="circuit" d="M188 184 C246 174 310 172 366 182" stroke="url(#lh-tech)" stroke-width="1.35" fill="none" />

        <!-- 侧腹电源开关 -->
        <g class="power-switch">
          <rect x="248" y="168" width="52" height="28" rx="7" fill="rgba(12,18,24,0.55)" stroke="#3d2410" stroke-width="1.4" />
          <rect x="248" y="168" width="52" height="28" rx="7" stroke="url(#lh-tech)" stroke-width="1.2" fill="none" />
          <!-- 拨杆：ON -->
          <rect class="toggle" x="274" y="174" width="20" height="16" rx="4" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1" />
          <circle class="led" cx="260" cy="182" r="3.5" fill="rgb(var(--accent-rgb))" />
          <text x="286" y="186" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="8" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="700">ON</text>
        </g>

        <!-- 前腿：肩胛板咬合躯干 -->
        <g class="leg near">
          <ellipse cx="208" cy="200" rx="18" ry="9" fill="#7a4a22" stroke="#3d2410" stroke-width="1.3" />
          <path class="l1 thigh" d="M196 200 L186 240 L202 244 L216 204 Z" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1.3" />
          <path class="l1 shank" d="M188 240 L178 280 L196 284 L204 244 Z" fill="url(#lh-wood-deep)" stroke="#3d2410" stroke-width="1.3" />
          <ellipse cx="186" cy="284" rx="11" ry="5" fill="#2a1a08" />
          <circle cx="202" cy="218" r="2.6" fill="rgb(var(--accent-rgb))" />
          <circle cx="192" cy="252" r="2.2" fill="rgb(var(--accent-rgb))" />
        </g>
        <g class="leg near b">
          <ellipse cx="238" cy="202" rx="16" ry="8" fill="#7a4a22" stroke="#3d2410" stroke-width="1.3" />
          <path class="l2 thigh" d="M226 202 L222 242 L238 246 L248 206 Z" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1.3" />
          <path class="l2 shank" d="M224 242 L228 282 L246 284 L240 246 Z" fill="url(#lh-wood-deep)" stroke="#3d2410" stroke-width="1.3" />
          <ellipse cx="236" cy="286" rx="11" ry="5" fill="#2a1a08" />
          <circle cx="234" cy="220" r="2.6" fill="rgb(var(--accent-rgb))" />
          <circle cx="232" cy="254" r="2.2" fill="rgb(var(--accent-rgb))" />
        </g>
        <!-- 连杆把两前腿连成机构 -->
        <path d="M202 218 L234 220" stroke="rgba(var(--accent-rgb),0.5)" stroke-width="1.3" stroke-dasharray="2 3" />

        <!-- 牛头：弯角从颅顶长出 -->
        <g class="head">
          <path
            d="M168 170 C146 166 130 176 122 194 C118 208 128 218 148 216 L170 206 Z"
            fill="url(#lh-wood)"
            stroke="#3d2410"
            stroke-width="1.5"
          />
          <ellipse cx="110" cy="188" rx="34" ry="28" fill="url(#lh-wood)" stroke="#3d2410" stroke-width="1.8" />
          <!-- 角根座，保证角「长在头上」 -->
          <ellipse cx="98" cy="166" rx="10" ry="6" fill="#8a5530" stroke="#3d2410" stroke-width="1" />
          <ellipse cx="128" cy="164" rx="10" ry="6" fill="#8a5530" stroke="#3d2410" stroke-width="1" />

          <!-- 新月弯角（非两块木板） -->
          <path
            d="M96 164
               C86 150 74 132 70 114
               C68 102 78 98 86 106
               C94 118 100 140 102 160 Z"
            fill="url(#lh-horn)"
            stroke="#3d2410"
            stroke-width="1.35"
          />
          <path
            d="M130 162
               C142 146 160 128 176 118
               C186 112 192 120 186 130
               C176 146 156 156 140 162 Z"
            fill="url(#lh-horn)"
            stroke="#3d2410"
            stroke-width="1.35"
          />
          <!-- 角脊高光 -->
          <path d="M88 150 C80 132 76 118 80 110" stroke="#fff" stroke-opacity="0.22" stroke-width="2" fill="none" stroke-linecap="round" />
          <path d="M148 148 C160 134 172 124 180 122" stroke="#fff" stroke-opacity="0.22" stroke-width="2" fill="none" stroke-linecap="round" />

          <ellipse cx="102" cy="182" rx="5.5" ry="6" fill="#f7efe3" />
          <circle cx="103" cy="183" r="2.4" fill="#1a1208" />
          <circle cx="104.2" cy="181.6" r="0.9" fill="#fff" opacity="0.75" />
          <ellipse cx="86" cy="200" rx="14" ry="9" fill="#a87038" stroke="#3d2410" stroke-width="1.2" />
          <circle cx="81" cy="200" r="1.5" fill="#1a1208" />
          <circle cx="91" cy="200" r="1.5" fill="#1a1208" />
          <path d="M146 180 h26" stroke="#3d2410" stroke-width="3" stroke-linecap="round" />
          <circle cx="172" cy="180" r="3.5" stroke="rgb(var(--accent-rgb))" stroke-width="1.4" fill="rgba(10,16,22,0.4)" />
          <circle cx="172" cy="180" r="1.4" fill="rgb(var(--accent-rgb))" />
        </g>
      </g>

      <g class="chip c">
        <rect x="432" y="72" width="96" height="70" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.22)" />
        <rect x="446" y="88" width="28" height="28" rx="8" fill="rgba(var(--accent-rgb),0.35)" />
        <ellipse cx="460" cy="100" rx="7" ry="5" fill="#e8c896" />
        <path d="M454 106v6M458 107v6M462 107v6M466 106v6" stroke="#5c3416" stroke-width="1.4" stroke-linecap="round" />
        <rect x="482" y="92" width="30" height="3" rx="1.5" fill="rgba(255,255,255,0.45)" />
        <rect x="482" y="102" width="24" height="3" rx="1.5" fill="rgba(255,255,255,0.22)" />
        <rect x="446" y="126" width="66" height="3" rx="1.5" fill="rgba(255,255,255,0.14)" />
      </g>

      <g fill="rgba(255,255,255,0.55)" font-size="11" font-family="ui-sans-serif,system-ui,sans-serif" letter-spacing="0.14em">
        <text x="190" y="324" text-anchor="middle">任务</text>
        <text x="280" y="324" text-anchor="middle" fill="rgba(255,255,255,0.9)">驮运</text>
        <text x="370" y="324" text-anchor="middle">交付</text>
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
.ox {
  transform-origin: 270px 200px;
  animation: haul 4.8s ease-in-out infinite;
}
.leg.near .l1.thigh,
.leg.near .l1.shank,
.leg.near .l2.thigh,
.leg.near .l2.shank {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 1.15s ease-in-out infinite alternate;
}
.leg.near .l2.thigh,
.leg.near .l2.shank {
  animation-delay: 0.55s;
}
.leg.far .thigh,
.leg.far .shank {
  transform-box: fill-box;
  transform-origin: top center;
  animation: step 1.15s ease-in-out infinite alternate-reverse;
}
.leg.far.b .thigh,
.leg.far.b .shank {
  animation-delay: 0.55s;
}
.circuit {
  stroke-dasharray: 5 8;
  animation: dash 2.4s linear infinite;
}
.power-switch .led {
  animation: led-pulse 1.8s ease-in-out infinite;
}
.chip {
  animation: bob 6s ease-in-out infinite;
}
.chip.c {
  animation-delay: -2s;
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
    transform: rotate(-5deg);
  }
  to {
    transform: rotate(5deg);
  }
}
@keyframes dash {
  to {
    stroke-dashoffset: -40;
  }
}
@keyframes led-pulse {
  0%,
  100% {
    opacity: 0.65;
  }
  50% {
    opacity: 1;
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

:root[data-fx="off"] .leg.near .l1.thigh,
:root[data-fx="off"] .leg.near .l1.shank,
:root[data-fx="off"] .leg.near .l2.thigh,
:root[data-fx="off"] .leg.near .l2.shank,
:root[data-fx="off"] .leg.far .thigh,
:root[data-fx="off"] .leg.far .shank,
:root[data-fx="off"] .circuit,
:root[data-fx="off"] .power-switch .led {
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  .ox,
  .leg.near .l1.thigh,
  .leg.near .l1.shank,
  .leg.near .l2.thigh,
  .leg.near .l2.shank,
  .leg.far .thigh,
  .leg.far .shank,
  .circuit,
  .power-switch .led,
  .chip {
    animation: none !important;
  }
}
</style>
