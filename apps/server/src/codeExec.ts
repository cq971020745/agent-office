import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { truncateForContext } from "./tools.js";

const execFileAsync = promisify(execFile);

export interface CodeLanguageSpec {
  image: string;
  bin: string;
  ext: string;
}

const LANGUAGES: Record<"javascript" | "python", CodeLanguageSpec> = {
  javascript: { image: "node:22-alpine", bin: "node", ext: "js" },
  python: { image: "python:3.12-alpine", bin: "python3", ext: "py" },
};

const CODE_DIR = ".run";
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

/** 探测 Docker 守护进程可用性（结果缓存在进程生命周期内）；失败视为不可用。 */
let dockerAvailable: boolean | null = null;
export async function detectDocker(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8_000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/** 测试用：清空探测缓存 */
export function resetDockerDetection(): void {
  dockerAvailable = null;
}

/**
 * 构建 `docker run` 参数（纯函数，供单测校验隔离约束）：
 * 无网络、限内存/CPU/进程数，工作区只读挂载在 /workspace，代码文件在镜像内执行。
 */
export function buildCodeRunArgs(language: "javascript" | "python", root: string, codeRelFile: string): string[] {
  const spec = LANGUAGES[language];
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${root}:/workspace:ro`,
    "-w",
    "/workspace",
    spec.image,
    spec.bin,
    codeRelFile,
  ];
}

/** 把代码写入工作区隐藏目录（点目录不进成果物扫描），返回容器内的相对路径。 */
function writeCodeFile(root: string, language: "javascript" | "python", code: string): string {
  const spec = LANGUAGES[language];
  const dir = path.join(root, CODE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const rel = `${CODE_DIR}/main.${spec.ext}`;
  fs.writeFileSync(path.join(root, rel), code, "utf8");
  return rel;
}

function combinedTail(stdout: string, stderr: string, max = 8000): string {
  const text = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`.trim();
  return text.length > max ? `${text.slice(0, max)}\n[output truncated]` : text;
}

const RunParams = Type.Object({
  language: Type.Union([Type.Literal("javascript"), Type.Literal("python")], {
    description: "Runtime for the script: javascript (Node 22) or python (CPython 3.12)",
  }),
  code: Type.String({ description: "Complete script source code to execute" }),
});

function codeExecTool(root: string): ToolDefinition<typeof RunParams> {
  return {
    name: "run_code",
    label: "运行代码（容器隔离）",
    description:
      "Execute a JavaScript (Node 22) or Python (3.12) script inside an isolated Docker container " +
      "with the task workspace mounted read-only at /workspace. No network access. " +
      "Use it for computations, data parsing, format conversion, or verifying generated code. " +
      "Files the script must produce belong in the workspace — compute content here, then write it with workspace_write. " +
      "Returns the script's stdout/stderr.",
    parameters: RunParams,
    execute: async (_id, params) => {
      const codeRel = writeCodeFile(root, params.language, params.code);
      try {
        const res = await execFileAsync("docker", buildCodeRunArgs(params.language, root, codeRel), {
          timeout: MAX_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BUFFER,
        });
        const text = combinedTail(res.stdout, res.stderr) || "(script finished with no output)";
        return { content: [{ type: "text", text: truncateForContext(text) }], details: undefined };
      } catch (err) {
        const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
        if (e.killed) {
          throw new Error(`脚本执行超时（>${MAX_TIMEOUT_MS / 1000}s），已被强制终止`);
        }
        // 非零退出码：把容器输出带回给模型，便于自修正
        const output = combinedTail(e.stdout ?? "", e.stderr ?? "");
        throw new Error(`script exited with an error:\n${output || e.message || "unknown error"}`);
      }
    },
  };
}

/** Docker 守护进程可用时返回 run_code 工具，否则返回空数组（调用方无需关心降级）。 */
export async function codeExecToolIfAvailable(root: string): Promise<ToolDefinition[]> {
  if (!(await detectDocker())) return [];
  return [codeExecTool(root)];
}

/** 供 system prompt 说明 run_code 是否可用（决定提示词里是否提到它）。 */
export async function hasCodeExec(): Promise<boolean> {
  return detectDocker();
}
