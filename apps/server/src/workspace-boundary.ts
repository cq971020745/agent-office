import fs from "node:fs";
import path from "node:path";
import { config, paths } from "./config.js";

/**
 * 用户显式选择工作目录的边界校验（评审 P0-1）。
 *
 * 用户自选目录会获得读写/预览/删除联动等能力，必须挡住指向应用自身的路径：
 * DATA_DIR 里有 app.db（模型密钥、MCP 凭证明文）、会话 JSONL、其他任务的平台工作区
 * 与 pi agentDir；指向平台工作区根本身的任务在删除时会 rmSync 整个工作区根。
 * 专家常驻目录（data/agents）由平台自管，不经过这里。
 */
export function resolveUserWorkspaceDir(raw: string): { ok: true; dir: string } | { ok: false; error: string } {
  const dir = path.resolve(raw);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return { ok: false, error: "工作目录不存在或不可访问" };
  if (stat.isSymbolicLink()) return { ok: false, error: "工作目录不能是符号链接" };
  if (!stat.isDirectory()) return { ok: false, error: "工作目录必须是目录" };
  const dataDir = path.resolve(config.dataDir);
  if (dir === dataDir || dir.startsWith(dataDir + path.sep)) {
    return { ok: false, error: "工作目录不能在应用数据目录内" };
  }
  const workspacesRoot = path.resolve(paths.workspaces);
  if (dir === workspacesRoot || dir.startsWith(workspacesRoot + path.sep)) {
    return { ok: false, error: "工作目录不能在平台隔离工作区内" };
  }
  return { ok: true, dir };
}

/**
 * 严格位于平台工作区根「之内」（不含根本身）。删除任务时只对这类目录 rmSync——
 * isPlatformWorkspace 对根本身也返回 true，直接用它做删除依据曾有过整库误删风险。
 */
export function isStrictlyInsidePlatformWorkspace(workspacePath: string): boolean {
  const root = path.resolve(paths.workspaces);
  const dir = path.resolve(workspacePath);
  return dir.startsWith(root + path.sep);
}
