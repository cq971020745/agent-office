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

  /** 支持 Ctrl+V 直接粘贴剪贴板中的截图或文件作为任务附件 */
  function onPaste(e: ClipboardEvent): void {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (!f) continue;
      // 剪贴板直接截图通常命名为 image.png，附加上时间戳避免多次截图同名去重被跳过
      if (/^image\.(png|jpe?g|webp|gif)$/i.test(f.name)) {
        const ext = f.name.split(".").pop() || "png";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19);
        files.push(new File([f], `screenshot-${stamp}.${ext}`, { type: f.type }));
      } else {
        files.push(f);
      }
    }
    if (files.length) {
      addFiles(files);
      toast("success", `已从剪贴板添加 ${files.length} 个附件`);
    }
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
    onPaste,
  };
}
