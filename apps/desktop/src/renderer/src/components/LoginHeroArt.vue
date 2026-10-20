<script setup lang="ts">
/** 登录页主视觉：机甲能量牛（SVG+CSS3 角色，与右下角桌宠同源）+ 悬浮信息卡与 任务/驮运/交付 */
import MuniCartArt from "./MuniCartArt.vue";
</script>

<template>
  <div class="hero-art" aria-hidden="true">
    <span class="glow" />
    <div class="cart-wrap">
      <MuniCartArt id-prefix="lh" />
    </div>

    <div class="chip a">
      <i class="line w-44" />
      <i class="line w-58 dim" />
      <i class="line w-40 dim2" />
    </div>

    <div class="chip c">
      <span class="bubble">
        <svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="currentColor" /></svg>
      </span>
      <i class="line w-30" />
      <i class="line w-24 dim" />
    </div>

    <div class="steps">
      <span>任务</span>
      <span class="on">驮运</span>
      <span>交付</span>
    </div>
  </div>
</template>

<style scoped>
.hero-art {
  position: relative;
  width: 100%;
  max-width: 560px;
  margin: 6px 0 2px;
  aspect-ratio: 440 / 300;
}
.glow {
  position: absolute;
  inset: 10% 6% 14%;
  border-radius: 50%;
  background: radial-gradient(ellipse at 48% 58%, rgba(var(--accent-rgb), 0.22), transparent 65%);
  filter: blur(10px);
}
.cart-wrap {
  position: absolute;
  inset: 0 0 6%;
  --mood: rgb(var(--accent-rgb));
  --mood-soft: rgba(var(--accent-rgb), 0.35);
}
.cart-wrap :deep(.cart) {
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 16px 26px rgba(0, 0, 0, 0.32));
  animation: bob 5.2s ease-in-out infinite;
}
.chip {
  position: absolute;
  display: grid;
  gap: 7px;
  padding: 13px 15px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.22);
  backdrop-filter: blur(6px);
  animation: chip-bob 6s ease-in-out infinite;
}
.chip.a {
  right: 0.5%;
  top: 24%;
}
.chip.c {
  right: 1.5%;
  top: 5%;
  grid-template-columns: auto 1fr;
  align-items: center;
  column-gap: 10px;
  animation-delay: -2.4s;
}
.line {
  display: block;
  height: 3.5px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.5);
}
.line.dim {
  background: rgba(255, 255, 255, 0.22);
}
.line.dim2 {
  background: rgba(255, 255, 255, 0.14);
}
.w-44 { width: 44px; }
.w-58 { width: 58px; }
.w-40 { width: 40px; }
.w-30 { width: 30px; }
.w-24 { width: 24px; }
.bubble {
  grid-row: span 3;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: rgba(var(--accent-rgb), 0.4);
  color: #eaf3ff;
}
.bubble svg {
  width: 18px;
  height: 18px;
}
.steps {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -4px;
  display: flex;
  justify-content: center;
  gap: 96px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: rgba(255, 255, 255, 0.55);
}
.steps .on {
  color: rgba(255, 255, 255, 0.92);
  font-weight: 600;
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
@keyframes chip-bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}

:root[data-fx="off"] .cart-wrap :deep(.cart),
:root[data-fx="off"] .chip {
  animation: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .cart-wrap :deep(.cart),
  .chip {
    animation: none !important;
  }
}
</style>
