import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** 中文应用菜单（Electron 默认菜单在 Windows 上是英文） */
function buildChineseMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [{ label: "退出", accelerator: "CmdOrCtrl+Q", role: "quit" }],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "重做", accelerator: "CmdOrCtrl+Shift+Z", role: "redo" },
        { type: "separator" },
        { label: "剪切", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "复制", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "粘贴", accelerator: "CmdOrCtrl+V", role: "paste" },
        { label: "全选", accelerator: "CmdOrCtrl+A", role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", role: "reload" },
        { label: "强制重新加载", accelerator: "CmdOrCtrl+Shift+R", role: "forceReload" },
        { label: "开发者工具", accelerator: "Alt+CmdOrCtrl+I", role: "toggleDevTools" },
        { type: "separator" },
        { label: "重置缩放", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
        { label: "放大", accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
        { label: "缩小", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { type: "separator" },
        { label: "全屏切换", role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", accelerator: "CmdOrCtrl+M", role: "minimize" },
        { label: "关闭窗口", accelerator: "CmdOrCtrl+W", role: "close" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 Agent Office",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: "Agent Office",
              detail: "AI 数字员工办公室 · 把工作交给 Agent",
              buttons: ["好的"],
              noLink: true,
            });
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    title: "Agent Office",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  // 开发时由 electron-vite 注入渲染器 dev server 地址；打包后加载产物
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  buildChineseMenu();

  // 渲染器选择任务工作目录（原生目录选择框）
  ipcMain.handle("agent-office:pick-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: "选择工作目录",
      buttonLabel: "使用此目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0]!;
  });

  // 在系统文件管理器中打开目录，或用系统默认程序打开本地文件（如用 WPS 打开 .docx/.xlsx）
  ipcMain.handle("agent-office:open-path", async (_event, target: unknown) => {
    if (typeof target !== "string" || !path.isAbsolute(target)) return { ok: false, message: "路径无效" };
    try {
      if (!fs.existsSync(target)) return { ok: false, message: "路径不存在" };
    } catch {
      return { ok: false, message: "路径不可访问" };
    }
    const err = await shell.openPath(target);
    return err ? { ok: false, message: err } : { ok: true };
  });

  // 在系统文件管理器中定位并高亮指定文件
  ipcMain.handle("agent-office:show-item-in-folder", async (_event, target: unknown) => {
    if (typeof target !== "string" || !path.isAbsolute(target)) return { ok: false, message: "路径无效" };
    try {
      if (!fs.existsSync(target)) return { ok: false, message: "文件不存在" };
      shell.showItemInFolder(target);
      return { ok: true };
    } catch {
      return { ok: false, message: "无法在文件夹中显示" };
    }
  });

  // 发送桌面原生系统通知（后台任务完成/待人工确认时提醒用户）
  ipcMain.handle("agent-office:notify", async (event, payload: unknown) => {
    if (!Notification.isSupported() || !payload || typeof payload !== "object") return { ok: false };
    const { title, body } = payload as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || !title.trim()) return { ok: false };
    const n = new Notification({
      title: title.trim(),
      body: typeof body === "string" ? body : "",
    });
    n.on("click", () => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    n.show();
    return { ok: true };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
