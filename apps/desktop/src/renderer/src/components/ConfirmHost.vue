<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { settleConfirm, useConfirmState } from "../composables/confirm";

const state = useConfirmState();

function onKey(e: KeyboardEvent): void {
  if (!state.value) return;
  if (e.key === "Escape") settleConfirm(false);
  if (e.key === "Enter") settleConfirm(true);
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="state" class="overlay" @click.self="settleConfirm(false)">
        <div class="dialog" role="alertdialog" :aria-label="state.title">
          <h3>{{ state.title }}</h3>
          <p v-if="state.message">{{ state.message }}</p>
          <div class="actions">
            <button type="button" @click="settleConfirm(false)">取消</button>
            <button type="button" :class="state.danger ? 'danger' : 'primary'" @click="settleConfirm(true)">
              {{ state.confirmText || "确定" }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 17, 21, 0.42);
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
}
.dialog {
  width: 380px;
  max-width: 100%;
  background: var(--surface);
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 22px 22px 18px;
}
.dialog h3 {
  margin: 0 0 8px;
  font-size: 15.5px;
}
.dialog p {
  margin: 0;
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.6;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
.actions button {
  width: auto;
  min-width: 76px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
