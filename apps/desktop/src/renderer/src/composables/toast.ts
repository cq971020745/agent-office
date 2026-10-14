// 轻量 toast 通知中心：任何组件 import toast() 即可触发，由 Toasts.vue 渲染。
import { ref } from "vue";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const toasts = ref<ToastItem[]>([]);
let nextId = 1;

export function useToasts(): typeof toasts {
  return toasts;
}

export function toast(kind: ToastKind, text: string, duration = 3200): void {
  const id = nextId++;
  toasts.value.push({ id, kind, text });
  if (toasts.value.length > 4) toasts.value.shift();
  window.setTimeout(() => dismiss(id), duration);
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function toastError(err: unknown, fallback = "操作失败"): void {
  toast("error", err instanceof Error ? err.message : fallback);
}
