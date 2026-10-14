// 附件选择/校验/拖拽的共享逻辑：HomeView 派发表单与 TaskDetailView 对话输入框复用。
import { ref } from "vue";
import { toast } from "./toast";

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 与服务端 @fastify/multipart 的限制一致
export const MAX_FILES = 10;

export function useAttachments() {
  const attachments = ref<File[]>([]);
  const fileInput = ref<HTMLInputElement | null>(null);
  const dragging = ref(false);
  let dragDepth = 0;

  function pickFiles(): void {
    fileInput.value?.click();
  }

  function onFilesPicked(e: Event): void {
    const input = e.target as HTMLInputElement;
    addFiles(Array.from(input.files ?? []));
    input.value = ""; // 允许再次选择同一文件
  }

  function addFiles(list: File[]): void {
    for (const f of list) {
      if (attachments.value.length >= MAX_FILES) {
        toast("error", `最多上传 ${MAX_FILES} 个附件`);
        break;
      }
      if (f.size > MAX_FILE_SIZE) {
        toast("error", `「${f.name}」超过 20MB，已跳过`);
        continue;
      }
      if (attachments.value.some((a) => a.name === f.name && a.size === f.size)) continue;
      attachments.value.push(f);
    }
  }

  function removeAttachment(index: number): void {
    attachments.value.splice(index, 1);
  }

  function reset(): void {
    attachments.value = [];
  }

  // ---------- 拖拽上传（dragenter/dragleave 在子元素间成对触发，用计数器防闪烁） ----------
  function onDragEnter(): void {
    dragDepth += 1;
    dragging.value = true;
  }

  function onDragLeave(): void {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dragging.value = false;
  }

  function onDrop(e: DragEvent): void {
    dragDepth = 0;
    dragging.value = false;
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  return {
    attachments,
    fileInput,
    dragging,
    pickFiles,
    onFilesPicked,
    addFiles,
    removeAttachment,
    reset,
    onDragEnter,
    onDragLeave,
    onDrop,
  };
}
