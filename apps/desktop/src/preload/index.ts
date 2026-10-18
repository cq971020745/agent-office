import { contextBridge, ipcRenderer } from "electron";

// 渲染器通过 HTTP(S) 直连后端；此处仅暴露版本信息与原生目录能力
contextBridge.exposeInMainWorld("agentOffice", {
  versions: process.versions,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("agent-office:pick-directory"),
  openPath: (target: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("agent-office:open-path", target),
  showItemInFolder: (target: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("agent-office:show-item-in-folder", target),
  notify: (title: string, body?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("agent-office:notify", { title, body }),
  /** 主进程截取指定 webContents（webview）为 PNG */
  captureWebContents: (
    webContentsId: number
  ): Promise<{ ok: boolean; png?: Uint8Array; message?: string }> =>
    ipcRenderer.invoke("agent-office:capture-webcontents", webContentsId),
});
