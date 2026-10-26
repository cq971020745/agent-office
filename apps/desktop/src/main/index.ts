import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, webContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { showServerStartError, startBundledServer, stopBundledServer } from "./server-host.js";
import { APP_NAME, APP_SLOGAN, APP_TAGLINE } from "../brand.js";

// scoped 包名 @office/desktop 会让 userData 变成 Roaming\@office/desktop（含 /），Windows 上写数据会失败
// 目录名保留历史 "Agent Office"，避免升级后丢失本机数据
if (app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "Agent Office"));
}

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
          label: `关于 ${APP_NAME}`,
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: APP_NAME,
              detail: `${APP_TAGLINE} · ${APP_SLOGAN}`,
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
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 任务预览区内嵌浏览器（网页标注）依赖 <webview>
      webviewTag: true,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  // 开发时由 electron-vite 注入渲染器 dev server 地址；打包后加载产物
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // 禁止主窗口被外链/about:blank 顶掉（表现为整窗只剩菜单的白屏）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    try {
      const cur = win.webContents.getURL();
      if (!cur || cur === "about:blank") return;
      if (new URL(cur).origin === new URL(url).origin) return;
    } catch {
      return;
    }
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

// 方案 B：中心服务端地址持久化（userData/server-config.json）；远程模式重启后不再拉本机服务端
function serverConfigFile(): string {
  return path.join(app.getPath("userData"), "server-config.json");
}
function readServerConfig(): { baseUrl: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(serverConfigFile(), "utf8")) as { baseUrl?: unknown };
    return typeof raw.baseUrl === "string" && /^https?:\/\//i.test(raw.baseUrl)
      ? { baseUrl: raw.baseUrl }
      : { baseUrl: null };
  } catch {
    return { baseUrl: null };
  }
}

function registerIpc(): void {
  ipcMain.handle("agent-office:get-server-config", () => readServerConfig());
  ipcMain.handle("agent-office:set-server-config", (_event: unknown, baseUrl: unknown) => {
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
      return { ok: false, message: "地址无效（需 http(s)://主机:端口）" };
    }
    try {
      fs.mkdirSync(path.dirname(serverConfigFile()), { recursive: true });
      fs.writeFileSync(serverConfigFile(), `${JSON.stringify({ baseUrl }, null, 2)}\n`, "utf8");
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

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

  /** 在主进程截取 webview 页面，避免渲染进程 capturePage 把窗口打成白屏 */
  ipcMain.handle("agent-office:capture-webcontents", async (_event, webContentsId: unknown) => {
    if (typeof webContentsId !== "number" || !Number.isFinite(webContentsId)) {
      return { ok: false as const, message: "invalid id" };
    }
    try {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) return { ok: false as const, message: "webview gone" };
      const img = await wc.capturePage();
      return { ok: true as const, png: img.toPNG() };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : "capture failed" };
    }
  });
}

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    alwaysOnTop: true,
    show: true,
    title: APP_NAME,
    backgroundColor: "#12161c",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
  html,body{margin:0;height:100%;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#12161c;color:#e8eef5}
  .box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
  .mark{width:52px;height:52px;border-radius:14px;background:#c4a574;display:grid;place-items:center;font-size:26px;font-weight:800;color:#1a1208}
  h1{margin:0;font-size:20px;font-weight:700}
  p{margin:0;font-size:13px;color:#9aa7b5;line-height:1.5;max-width:320px}
  .bar{width:220px;height:4px;border-radius:99px;background:#2a3340;overflow:hidden}
  .bar>i{display:block;height:100%;width:35%;border-radius:99px;background:#c4a574;animation:slide 1.1s ease-in-out infinite}
  @keyframes slide{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
  </style></head><body><div class="box">
  <div class="mark">牛</div>
  <h1>${APP_NAME}</h1>
  <p id="msg">正在启动…</p>
  <div class="bar"><i></i></div>
  </div><script>
  window.setStatus=function(t){var el=document.getElementById('msg');if(el)el.textContent=t||'正在启动…';};
  </script></body></html>`;
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return splash;
}

function setSplashStatus(splash: BrowserWindow | null, msg: string): void {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(
    `window.setStatus(${JSON.stringify(msg)})`,
    true
  ).catch(() => undefined);
}

app.whenReady().then(async () => {
  buildChineseMenu();
  registerIpc();

  // 先出启动画面，再解压依赖 / 起服务——否则用户会以为卡死
  const splash = app.isPackaged ? createSplash() : null;

  // 方案 B：配置了中心服务端时是远程模式——不再启动本机服务端，直连远程
  const remoteServer = readServerConfig().baseUrl;
  if (remoteServer) {
    if (splash && !splash.isDestroyed()) splash.close();
    console.log(`[server] 远程模式：${remoteServer}（跳过本机服务端）`);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    return;
  }

  try {
    await startBundledServer((msg) => setSplashStatus(splash, msg));
  } catch (err) {
    if (splash && !splash.isDestroyed()) splash.close();
    await showServerStartError(err);
    app.quit();
    return;
  }

  createWindow();
  if (splash && !splash.isDestroyed()) splash.close();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  stopBundledServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
