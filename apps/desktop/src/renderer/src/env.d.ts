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
  /** 主进程截取 webview 页面为 PNG（避免渲染进程 capturePage 白屏） */
  captureWebContents: (
    webContentsId: number
  ) => Promise<{ ok: boolean; png?: Uint8Array; message?: string }>;
  /** 中心服务端地址（userData/server-config.json）；远程模式不再启动本机服务端 */
  getServerConfig: () => Promise<{ baseUrl: string | null }>;
  setServerConfig: (baseUrl: string) => Promise<{ ok: boolean; message?: string }>;
}

interface Window {
  agentOffice: AgentOfficeBridge;
}
