import { contextBridge, ipcRenderer } from "electron";

// 渲染器通过 HTTP(S) 直连后端；此处仅暴露版本信息与原生目录能力
contextBridge.exposeInMainWorld("agentOffice", {
  versions: process.versions,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("agent-office:pick-directory"),
  openPath: (dir: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("agent-office:open-path", dir),
});
