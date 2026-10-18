<script setup lang="ts">
import { useTheme } from "../composables/useTheme";

const { fxEnabled, mode } = useTheme();
</script>

<template>
  <div
    v-show="fxEnabled"
    class="fx-layer"
    :class="{ glass: mode === 'glass' }"
    aria-hidden="true"
  >
    <span class="fx-orb o1" />
    <span class="fx-orb o2" />
    <span class="fx-orb o3" />
    <span class="fx-sparkle s1" />
    <span class="fx-sparkle s2" />
  </div>
</template>

<style scoped>
.fx-layer {
  pointer-events: none;
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
}
.fx-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(48px);
  opacity: 0.35;
  will-change: transform;
}
.fx-layer.glass .fx-orb {
  opacity: 0.45;
}
.o1 {
  width: 280px;
  height: 280px;
  left: 8%;
  top: 12%;
  background: radial-gradient(circle, rgba(var(--accent-rgb), 0.55), transparent 70%);
}
.o2 {
  width: 220px;
  height: 220px;
  right: 12%;
  top: 28%;
  background: radial-gradient(circle, rgba(var(--accent-rgb), 0.35), transparent 70%);
}
.o3 {
  width: 320px;
  height: 320px;
  left: 40%;
  bottom: -8%;
  background: radial-gradient(circle, rgba(90, 140, 220, 0.28), transparent 70%);
}
.fx-sparkle {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.7);
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.8);
  opacity: 0;
}
:root[data-fx="on"] .fx-sparkle {
  animation: spark 4.5s ease-in-out infinite;
}
.s1 {
  left: 22%;
  top: 36%;
  animation-delay: 0.4s;
}
.s2 {
  right: 24%;
  top: 58%;
  animation-delay: 1.8s;
}
@keyframes spark {
  0%,
  100% {
    opacity: 0;
    transform: scale(0.4);
  }
  40%,
  55% {
    opacity: 0.85;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fx-layer {
    display: none;
  }
}
</style>
