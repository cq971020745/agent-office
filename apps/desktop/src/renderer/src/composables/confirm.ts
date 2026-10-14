// 确认对话框：confirmDialog() 返回 Promise<boolean>，由 ConfirmHost.vue 渲染。
import { ref } from "vue";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const current = ref<PendingConfirm | null>(null);

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    current.value = { ...options, resolve };
  });
}

export function useConfirmState(): typeof current {
  return current;
}

export function settleConfirm(ok: boolean): void {
  if (!current.value) return;
  current.value.resolve(ok);
  current.value = null;
}
