import { app, dialog } from "electron";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const DEFAULT_PORT = 38617;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 500;

/** 解压完成后必须齐套的包（中断解压时常见「有 fastify 没 typebox」） */
const REQUIRED_PKGS = ["fastify", "typebox", "@earendil-works/pi-coding-agent", "better-sqlite3"] as const;

let serverProc: ChildProcess | null = null;

export type ServerBootProgress = (msg: string) => void;

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

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "1");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function pkgPath(nmDir: string, name: string): string {
  return name.startsWith("@")
    ? path.join(nmDir, ...name.split("/"))
    : path.join(nmDir, name);
}

function depsComplete(root: string, wantVer: string): boolean {
  const stamp = path.join(root, ".deps-ready");
  const nm = path.join(root, "node_modules");
  const cur = fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf8").trim() : "";
  if (cur !== wantVer) return false;
  for (const name of REQUIRED_PKGS) {
    if (!fs.existsSync(pkgPath(nm, name))) return false;
  }
  return true;
}

function extractDepsTgz(tgz: string, root: string, onProgress?: ServerBootProgress): void {
  const nmDir = path.join(root, "node_modules");
  onProgress?.("正在清理旧依赖…");
  if (fs.existsSync(nmDir)) {
    fs.rmSync(nmDir, { recursive: true, force: true });
  }
  fs.mkdirSync(nmDir, { recursive: true });
  onProgress?.("正在解压内嵌依赖（首次约 1～3 分钟，请稍候）…");
  execFileSync("tar", ["-xzf", tgz, "-C", nmDir], {
    stdio: "ignore",
    windowsHide: true,
  });
  const missing = REQUIRED_PKGS.filter((name) => !fs.existsSync(pkgPath(nmDir, name)));
  if (missing.length) {
    throw new Error(`解压 deps.tgz 不完整，缺少：${missing.join(", ")}`);
  }
}

/**
 * 准备可运行的服务端根目录。
 * Node ESM 按入口真实路径找 node_modules，因此 dist 与依赖必须同树。
 */
function ensureServerRuntime(
  serverRoot: string,
  userData: string,
  onProgress?: ServerBootProgress
): string {
  const tgz = path.join(serverRoot, "deps.tgz");
  const versionFile = path.join(serverRoot, "deps.version");
  const wantVer = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "0";

  if (depsComplete(serverRoot, wantVer)) {
    onProgress?.("依赖已就绪");
    return serverRoot;
  }

  if (!fs.existsSync(tgz)) {
    throw new Error(`找不到内嵌依赖：既无完整 node_modules 也无 deps.tgz（${serverRoot}）`);
  }

  if (canWriteDir(serverRoot)) {
    extractDepsTgz(tgz, serverRoot, onProgress);
    fs.writeFileSync(path.join(serverRoot, ".deps-ready"), `${wantVer}\n`, "utf8");
    onProgress?.("依赖解压完成");
    return serverRoot;
  }

  const runtime = path.join(userData, "server-runtime");
  if (depsComplete(runtime, wantVer) && fs.existsSync(path.join(runtime, "dist", "index.js"))) {
    onProgress?.("依赖已就绪");
    return runtime;
  }

  onProgress?.("安装目录只读，改解压到用户目录…");
  fs.mkdirSync(runtime, { recursive: true });
  extractDepsTgz(tgz, runtime, onProgress);

  const distSrc = path.join(serverRoot, "dist");
  const distDst = path.join(runtime, "dist");
  if (fs.existsSync(distDst)) fs.rmSync(distDst, { recursive: true, force: true });
  fs.cpSync(distSrc, distDst, { recursive: true });

  const vendorSrc = path.join(serverRoot, "vendor");
  if (fs.existsSync(vendorSrc)) {
    const vendorDst = path.join(runtime, "vendor");
    if (fs.existsSync(vendorDst)) fs.rmSync(vendorDst, { recursive: true, force: true });
    fs.cpSync(vendorSrc, vendorDst, { recursive: true });
  }

  fs.copyFileSync(path.join(serverRoot, "package.json"), path.join(runtime, "package.json"));
  fs.writeFileSync(path.join(runtime, ".deps-ready"), `${wantVer}\n`, "utf8");
  onProgress?.("依赖解压完成");
  return runtime;
}

function tailLog(logPath: string, maxLines = 30): string {
  try {
    if (!fs.existsSync(logPath)) return "";
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.trimEnd().split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/** 打包后拉起内嵌服务端；开发模式直接跳过（由 pnpm dev:server 提供）。 */
export async function startBundledServer(onProgress?: ServerBootProgress): Promise<void> {
  if (!app.isPackaged) return;

  const root = resourcesRoot();
  const serverRoot = path.join(root, "server");
  const nodeBin = bundledNodePath();
  if (!fs.existsSync(path.join(serverRoot, "dist", "index.js"))) {
    throw new Error(`找不到内嵌服务端入口：${path.join(serverRoot, "dist", "index.js")}`);
  }
  if (!fs.existsSync(nodeBin)) {
    throw new Error(`找不到捆绑的 Node 运行时：${nodeBin}`);
  }

  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const jwtSecret = ensureJwtSecret(userData);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const logPath = path.join(userData, "server.log");

  let runtimeRoot: string;
  try {
    runtimeRoot = ensureServerRuntime(serverRoot, userData, onProgress);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`准备内嵌依赖失败：${detail}`);
  }

  const entry = path.join(runtimeRoot, "dist", "index.js");
  onProgress?.("正在启动内嵌服务…");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    JWT_SECRET: jwtSecret,
    PI_PACKAGES_DIR: path.join(root, "pi-packages"),
    SKILLS_CATALOG_DIR: path.join(root, "skills-catalog"),
    AGENT_PACKS_DIR: path.join(root, "agent-packs"),
    SKIN_PACKS_DIR: path.join(root, "skin-packs"),
  };
  // wps365-env 闸门与 wps365-skill 脚本的内置 Python（stage 时已预装 requests/pycryptodome）
  const bundledPython = path.join(
    root,
    "python",
    process.platform === "win32" ? "python.exe" : path.join("bin", "python3")
  );
  if (fs.existsSync(bundledPython)) env.WPS_PYTHON = bundledPython;
  delete env.ELECTRON_RUN_AS_NODE;

  const logFd = fs.openSync(logPath, "a");
  fs.writeSync(logFd, `\n---- start ${new Date().toISOString()} entry=${entry} cwd=${runtimeRoot} ----\n`);
  serverProc = spawn(nodeBin, [entry], {
    cwd: runtimeRoot,
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
    onProgress?.("服务已就绪");
  } catch (err) {
    stopBundledServer();
    const tail = tailLog(logPath);
    if (exitedEarly) {
      throw new Error(`内嵌服务端启动后立即退出（${exitInfo}）\n\n--- server.log ---\n${tail || "(空)"}`);
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
    title: "木牛流马启动失败",
    message: "无法启动内嵌服务端",
    detail: message.slice(0, 4000),
    buttons: ["退出"],
    noLink: true,
  });
}
