import { app, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const DEFAULT_PORT = 8787;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 500;

let serverProc: ChildProcess | null = null;

function resourcesRoot(): string {
  return process.resourcesPath;
}

function bundledNodePath(): string {
  const name = process.platform === "win32" ? "node.exe" : "node";
  return path.join(resourcesRoot(), "node", name);
}

function ensureJwtSecret(userData: string): string {
  const secretFile = path.join(userData, "jwt-secret.txt");
  if (fs.existsSync(secretFile)) {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing) return existing;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(secretFile, `${secret}\n`, "utf8");
  return secret;
}

function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get(`http://127.0.0.1:${port}/auth/captcha`, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = (): void => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`服务端在 ${timeoutMs / 1000}s 内未就绪（端口 ${port}）`));
        return;
      }
      setTimeout(tick, READY_POLL_MS);
    };
    tick();
  });
}

/** 打包后拉起内嵌服务端；开发模式直接跳过（由 pnpm dev:server 提供）。 */
export async function startBundledServer(): Promise<void> {
  if (!app.isPackaged) return;

  const root = resourcesRoot();
  const serverRoot = path.join(root, "server");
  const entry = path.join(serverRoot, "dist", "index.js");
  const nm = path.join(serverRoot, "node_modules");
  const nodeBin = bundledNodePath();
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到内嵌服务端入口：${entry}`);
  }
  if (!fs.existsSync(nm)) {
    throw new Error(`找不到内嵌依赖：${nm}（打包 afterPack 是否把 deps 重命名为 node_modules？）`);
  }
  if (!fs.existsSync(nodeBin)) {
    throw new Error(`找不到捆绑的 Node 运行时：${nodeBin}`);
  }

  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const jwtSecret = ensureJwtSecret(userData);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    JWT_SECRET: jwtSecret,
    PI_PACKAGES_DIR: path.join(root, "pi-packages"),
    SKILLS_CATALOG_DIR: path.join(root, "skills-catalog"),
    AGENT_PACKS_DIR: path.join(root, "agent-packs"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  // 日志写文件，避免 pipe 缓冲区塞满后子进程（npm 安装 pi 包时很吵）阻塞
  const logPath = path.join(userData, "server.log");
  const logFd = fs.openSync(logPath, "a");
  serverProc = spawn(nodeBin, [entry], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });

  let exitedEarly = false;
  let exitInfo = "";
  serverProc.once("exit", (code, signal) => {
    exitedEarly = true;
    exitInfo = `code=${code} signal=${signal}`;
    console.error(`[server] 进程退出 ${exitInfo}（详见 ${logPath}）`);
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
  });

  try {
    await waitForReady(port, READY_TIMEOUT_MS);
  } catch (err) {
    stopBundledServer();
    if (exitedEarly) {
      throw new Error(`内嵌服务端启动后立即退出（${exitInfo}）`);
    }
    throw err;
  }
}

export function stopBundledServer(): void {
  if (!serverProc || serverProc.killed) {
    serverProc = null;
    return;
  }
  const proc = serverProc;
  serverProc = null;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000);
    }
  } catch {
    /* ignore */
  }
}

export async function showServerStartError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await dialog.showMessageBox({
    type: "error",
    title: "澄台启动失败",
    message: "无法启动内嵌服务端",
    detail: message,
    buttons: ["退出"],
    noLink: true,
  });
}
