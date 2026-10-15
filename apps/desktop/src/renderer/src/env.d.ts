/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

/** preload 通过 contextBridge 暴露的桥接 API（全局合并进 Window） */
interface AgentOfficeBridge {
  versions: NodeJS.ProcessVersions;
  /** 打开原生目录选择框；取消时返回 null */
  pickDirectory: () => Promise<string | null>;
  /** 在系统文件管理器中打开本地目录或用默认程序打开文件 */
  openPath: (target: string) => Promise<{ ok: boolean; message?: string }>;
  /** 在系统文件管理器中定位并选中指定文件 */
  showItemInFolder: (target: string) => Promise<{ ok: boolean; message?: string }>;
  /** 发送系统原生桌面通知 */
  notify: (title: string, body?: string) => Promise<{ ok: boolean }>;
}

interface Window {
  agentOffice: AgentOfficeBridge;
}
