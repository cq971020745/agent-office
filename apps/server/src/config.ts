import path from "node:path";
import fs from "node:fs";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-do-not-use-in-production",
};

export const paths = {
  db: path.join(config.dataDir, "app.db"),
  sessions: path.join(config.dataDir, "sessions"),
  workspaces: path.join(config.dataDir, "workspaces"),
  // 每位专家的常驻文件夹（WorkBuddy 式：专家的文件、产出都在自己的目录里，可从卡片直接打开）
  agentFolders: path.join(config.dataDir, "agents"),
  // pi 的 agentDir（扩展/技能/设置发现根）。指向数据目录内，避免读到操作者本机的 ~/.pi。
  agentDir: path.join(config.dataDir, "agent"),
};

export function ensureDirs(): void {
  for (const dir of [config.dataDir, paths.sessions, paths.workspaces, paths.agentFolders, paths.agentDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
