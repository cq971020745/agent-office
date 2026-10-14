<script setup lang="ts">
import { dismiss, useToasts } from "../composables/toast";

const toasts = useToasts();
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" @click="dismiss(t.id)">
          <svg v-if="t.kind === 'success'" class="icon" viewBox="0 0 24 24"><path d="M22 11.1V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" /></svg>
          <svg v-else-if="t.kind === 'error'" class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
          <svg v-else class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
          <span>{{ t.text }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1b1d22;
  color: #f4f5f7;
  font-size: 13px;
  font-weight: 500;
  padding: 10px 16px;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  max-width: 460px;
}
.toast .icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.toast.success .icon {
  color: #34d399;
}
.toast.error .icon {
  color: #f87171;
}
.toast.info .icon {
  color: #93c5fd;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
