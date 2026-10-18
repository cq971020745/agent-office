/**
 * 任务工作区 Git 只读/受控写操作。全部走 execFile 固定参数，禁止 shell 拼接。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskGitBranch, TaskGitCommit, TaskGitStatus } from "@office/shared";
import { paths } from "./config.js";

/** 平台数据目录内的工作区（隔离区 / 专家常驻）：禁止向上穿透到宿主 monorepo 的 .git */
function isManagedDataWorkspace(workspacePath: string): boolean {
  const dir = path.resolve(workspacePath);
  for (const root of [paths.workspaces, paths.agentFolders]) {
    const r = path.resolve(root);
    if (dir === r || dir.startsWith(r + path.sep)) return true;
  }
  return false;
}

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 20_000;
/** 分支名：字母数字、点、下划线、斜杠、连字符；禁止以 - 开头（防参数注入） */
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
  };
  return env;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (e.code === "ENOENT") throw new Error("未找到 git 命令，请先安装 Git");
    const detail = (e.stderr || e.stdout || e.message || "git 执行失败").trim();
    throw new Error(detail.slice(0, 500));
  }
}

export function assertSafeBranchName(name: string): string {
  const trimmed = name.trim();
  if (!BRANCH_RE.test(trimmed) || trimmed.includes("..")) {
    throw new Error("分支名无效");
  }
  return trimmed;
}

async function resolveGitRoot(workspacePath: string): Promise<string | null> {
  const workspace = path.resolve(workspacePath);
  if (!fs.existsSync(workspace)) return null;
  // 平台隔离区 / 专家常驻目录落在宿主 monorepo 内时，禁止向上穿透（否则每个任务都显示宿主 Git）
  if (isManagedDataWorkspace(workspace)) {
    if (!fs.existsSync(path.join(workspace, ".git"))) return null;
  }
  try {
    const { stdout } = await runGit(workspace, ["rev-parse", "--show-toplevel"]);
    const root = path.resolve(stdout.trim());
    if (!root) return null;
    if (workspace !== root && !workspace.startsWith(root + path.sep)) return null;
    return root;
  } catch {
    return null;
  }
}

function parseNumstat(text: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [a, b] = line.split("\t");
    if (a && a !== "-" && /^\d+$/.test(a)) insertions += Number(a);
    if (b && b !== "-" && /^\d+$/.test(b)) deletions += Number(b);
  }
  return { insertions, deletions };
}

export async function getGitStatus(workspacePath: string): Promise<TaskGitStatus> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) return { repo: false };

  const branchOut = await runGit(root, ["branch", "--show-current"]);
  const branch = branchOut.stdout.trim() || "HEAD";

  const porcelain = await runGit(root, ["status", "--porcelain"]);
  const dirtyFiles = porcelain.stdout.split(/\r?\n/).filter((l) => l.trim()).length;

  const unstaged = parseNumstat((await runGit(root, ["diff", "--numstat"])).stdout);
  const staged = parseNumstat((await runGit(root, ["diff", "--cached", "--numstat"])).stdout);
  const insertions = unstaged.insertions + staged.insertions;
  const deletions = unstaged.deletions + staged.deletions;

  let ahead = 0;
  let behind = 0;
  try {
    const ab = await runGit(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const parts = ab.stdout.trim().split(/\s+/);
    if (parts.length >= 2) {
      behind = Number(parts[0]) || 0;
      ahead = Number(parts[1]) || 0;
    }
  } catch {
    // 无 upstream 时忽略
  }

  return { repo: true, branch, dirtyFiles, insertions, deletions, ahead, behind };
}

export async function listGitBranches(workspacePath: string): Promise<TaskGitBranch[]> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) return [];

  const cur = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  const { stdout } = await runGit(root, [
    "for-each-ref",
    "--format=%(refname)\t%(refname:short)\t%(HEAD)",
    "refs/heads",
    "refs/remotes",
  ]);
  const seen = new Set<string>();
  const out: TaskGitBranch[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, nameRaw, head] = line.split("\t");
    const name = (nameRaw ?? "").trim();
    if (!name || name.endsWith("/HEAD") || (ref ?? "").endsWith("/HEAD")) continue;
    const remote = (ref ?? "").startsWith("refs/remotes/");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      current: head === "*" || (!remote && name === cur),
      remote,
    });
  }
  // 本地分支排前，当前分支置顶
  out.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.remote !== b.remote) return a.remote ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function listGitLog(workspacePath: string, limit = 40): Promise<TaskGitCommit[]> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) return [];
  const n = Math.min(Math.max(1, limit), 100);
  // %x1f 作字段分隔，避免 subject 含 | 时拆错
  const { stdout } = await runGit(root, [
    "log",
    `--max-count=${n}`,
    "--date=relative",
    "--pretty=format:%h%x1f%H%x1f%s%x1f%an%x1f%ad%x1f%D",
  ]);
  const commits: TaskGitCommit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [shortHash, hash, subject, author, relativeTime] = line.split("\x1f");
    if (!shortHash || !hash) continue;
    commits.push({
      shortHash,
      hash,
      subject: subject || "(无标题)",
      author: author || "",
      relativeTime: relativeTime || "",
      graph: "●",
    });
  }

  // 另取 graph 行，与 commit 列表按短 hash 对齐（best-effort）
  try {
    const graphOut = await runGit(root, ["log", `--max-count=${n}`, "--graph", "--pretty=format:%h"]);
    const graphs = new Map<string, string>();
    for (const line of graphOut.stdout.split(/\r?\n/)) {
      const m = line.match(/^(.*?)([0-9a-f]{7,40})\s*$/);
      if (!m) continue;
      const g = m[1]!.replace(/\s+$/, "").replace(/[^\s*|/\\-]/g, "").trimEnd();
      graphs.set(m[2]!, g || "*");
    }
    for (const c of commits) {
      c.graph = graphs.get(c.shortHash) || graphs.get(c.hash) || "●";
    }
  } catch {
    // graph 失败不影响主列表
  }
  return commits;
}

export async function checkoutBranch(workspacePath: string, branch: string): Promise<TaskGitStatus> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) throw new Error("当前工作区不是 Git 仓库");
  const name = assertSafeBranchName(branch);
  // 远程分支 refs：origin/foo → 检出本地 foo 或直接 checkout
  if (name.includes("/") && !name.startsWith("refs/")) {
    const local = name.includes("/") ? name.split("/").slice(1).join("/") : name;
    if (BRANCH_RE.test(local)) {
      try {
        await runGit(root, ["checkout", local]);
        return getGitStatus(root);
      } catch {
        await runGit(root, ["checkout", "-B", local, "--track", name]);
        return getGitStatus(root);
      }
    }
  }
  await runGit(root, ["checkout", name]);
  return getGitStatus(root);
}

export async function createAndCheckoutBranch(workspacePath: string, branch: string): Promise<TaskGitStatus> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) throw new Error("当前工作区不是 Git 仓库");
  const name = assertSafeBranchName(branch);
  if (name.includes("/")) {
    // 允许 feature/foo，但不允许误传 origin/foo 当新分支名却指向远程
    if (name.startsWith("origin/") || name.startsWith("remotes/")) {
      throw new Error("请输入本地新分支名，不要用远程前缀");
    }
  }
  await runGit(root, ["checkout", "-b", name]);
  return getGitStatus(root);
}

export async function commitAll(workspacePath: string, message: string): Promise<TaskGitStatus> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) throw new Error("当前工作区不是 Git 仓库");
  const msg = message.trim();
  if (!msg || msg.length > 2000) throw new Error("请填写有效的提交说明");
  await runGit(root, ["add", "-A"]);
  const staged = (await runGit(root, ["diff", "--cached", "--name-only"])).stdout.trim();
  if (!staged) throw new Error("没有可提交的更改");
  await runGit(root, ["commit", "-m", msg]);
  return getGitStatus(root);
}

export async function pushCurrent(workspacePath: string): Promise<TaskGitStatus> {
  const root = await resolveGitRoot(workspacePath);
  if (!root) throw new Error("当前工作区不是 Git 仓库");
  await runGit(root, ["push", "-u", "origin", "HEAD"]);
  return getGitStatus(root);
}
