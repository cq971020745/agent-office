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
  /** 在系统文件管理器中打开本地目录 */
  openPath: (dir: string) => Promise<{ ok: boolean; message?: string }>;
}

interface Window {
  agentOffice: AgentOfficeBridge;
}
