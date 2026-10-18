import fs from "node:fs";
import path from "node:path";

/** 依赖目录和缓存不进文件夹树，避免一次展开成千上万条。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  ".next",
  "coverage",
  ".parsed",
]);

export const WORKSPACE_LIST_LIMIT = 400;

export interface WorkspaceEntry {
  name: string;
  relPath: string;
  folder: boolean;
  size: number;
}

/** 把相对路径解析到工作区内部。空字符串表示工作区根；越界、空段和 .. 都拒绝。 */
export function resolveInsideWorkspace(root: string, rel: string): string | undefined {
  const rootAbs = path.resolve(root);
  const trimmed = rel.replace(/\\/g, "/").trim();
  if (!trimmed) return rootAbs;
  if (trimmed.includes("\0")) return undefined;
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return undefined;
  const abs = path.resolve(rootAbs, ...parts);
  const out = path.relative(rootAbs, abs);
  if (!out || out.startsWith("..") || path.isAbsolute(out)) return undefined;
  return abs;
}

function insideRoot(rootAbs: string, abs: string): boolean {
  const out = path.relative(rootAbs, abs);
  return !!out && !out.startsWith("..") && !path.isAbsolute(out);
}

/** 列出工作区里的一层目录。符号链接和逃出根目录的项不返回。 */
export function listWorkspaceEntries(root: string, rel = ""): { entries: WorkspaceEntry[]; truncated: boolean } {
  const rootAbs = path.resolve(root);
  const dir = resolveInsideWorkspace(rootAbs, rel);
  if (!dir) return { entries: [], truncated: false };
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { entries: [], truncated: false };
  const prefix = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const entries: WorkspaceEntry[] = [];
  let truncated = false;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
    if (entries.length >= WORKSPACE_LIST_LIMIT) {
      truncated = true;
      break;
    }
    const abs = path.join(dir, item.name);
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      continue;
    }
    if (!insideRoot(rootAbs, real)) continue;
    const relPath = prefix ? `${prefix}/${item.name}` : item.name;
    let size = 0;
    if (item.isFile()) {
      try {
        size = fs.statSync(abs).size;
      } catch {
        size = 0;
      }
    }
    entries.push({
      name: item.name,
      relPath,
      folder: item.isDirectory(),
      size,
    });
  }
  entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, "zh"));
  return { entries, truncated };
}
