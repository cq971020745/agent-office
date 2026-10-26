import path from "node:path";
import fs from "node:fs";

export const config = {
  port: Number(process.env.PORT ?? 38617),
  // 默认只听本机回环（桌面与同机浏览器足够）；容器/LAN 部署显式设 HOST=0.0.0.0
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-do-not-use-in-production",
  // 多用户共享的服务端部署（docker/容器）：皮肤这类全局外观资源的写操作只允许管理员
  multiUser: process.env.SERVER_MULTI_USER === "1",
};

export const paths = {
  db: path.join(config.dataDir, "app.db"),
  sessions: path.join(config.dataDir, "sessions"),
  workspaces: path.join(config.dataDir, "workspaces"),
  // 每位专家的常驻文件夹（WorkBuddy 式：专家的文件、产出都在自己的目录里，可从卡片直接打开）
  agentFolders: path.join(config.dataDir, "agents"),
  // pi 的 agentDir（扩展/技能/设置发现根）。指向数据目录内，避免读到操作者本机的 ~/.pi。
  agentDir: path.join(config.dataDir, "agent"),
  // 桌面皮肤包根：每个子目录一个皮肤包（skin.json + skin.css + assets/）。
  skins: path.join(config.dataDir, "skins"),
};

// pi-web-access 默认读 ~/.pi/agent/web-search.json；未显式指定时绑到平台 agentDir。
if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = paths.agentDir;
}

export function ensureDirs(): void {
  for (const dir of [config.dataDir, paths.sessions, paths.workspaces, paths.agentFolders, paths.agentDir, paths.skins]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 是否为平台按任务隔离的工作区（data/workspaces/...）。专家常驻目录与用户自选目录都不算。 */
export function isPlatformWorkspace(workspacePath: string): boolean {
  const root = path.resolve(paths.workspaces);
  const dir = path.resolve(workspacePath);
  return dir === root || dir.startsWith(root + path.sep);
}
