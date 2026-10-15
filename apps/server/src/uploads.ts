// 附件上传的共享实现：文件名净化、multipart 暂存、提示词增强。
// 派发（POST /tasks）与多轮追问（POST /tasks/:id/messages）两条链路复用；
// 不依赖 db.js（task_uploads 的登记留在路由层），保证本模块可在无 DATA_DIR 的测试里单独加载。
import type { FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 单文件上限，与 index.ts 里 @fastify/multipart 的注册值一致
export const MAX_UPLOAD_FILES = 10; // 单条消息附件数上限

export interface StagedUpload {
  filename: string;
  tmpPath: string;
  size: number;
  truncated: boolean;
}

/** 附件文件名净化：只保留 basename、去掉控制字符/前导点、限长；空则给默认名 */
export function sanitizeUploadName(raw: string): string {
  const base = (raw || "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
  if (!cleaned) return "附件";
  return cleaned.length > 120 ? cleaned.slice(-120) : cleaned;
}

/** 同名附件不覆盖：name.ext → name-1.ext → name-2.ext … */
export function uniqueTargetPath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

/** rename 跨盘符会 EXDEV，失败时退回复制 */
export function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

/** 字节数的人类可读形式（附件提示词里展示用） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * 附件清单附注（不含消息本体）：附件虽已落进工作区，但模型不会主动知道新文件出现，
 * 必须显式列出文件名。与 @ 引用一起构成 context_note，只在首轮发给模型，不进展示文本。
 */
export function attachmentNote(files: { filename: string; size: number }[]): string {
  if (!files.length) return "";
  const lines = files.map((f) => `- ${f.filename}（${formatBytes(f.size)}）`).join("\n");
  return `[本条消息附带 ${files.length} 个附件，已存入当前工作区，可用 workspace_read 读取]\n${lines}`;
}

export function withAttachmentNote(prompt: string, files: { filename: string; size: number }[]): string {
  if (!files.length) return prompt;
  return `${prompt}\n\n${attachmentNote(files)}`;
}

/**
 * 解析 multipart 请求：文件分片暂存到 stageDir，白名单字段收进 fields。
 * 字段可能排在文件分片之后到达，所以必须先暂存，等整个请求读完才能确定附件去向。
 * 超限文件不抛错，标记 truncated 由调用方决定响应（约定 413）。
 */
export async function stageMultipartFiles(
  req: FastifyRequest,
  stageDir: string,
  fieldNames: readonly string[]
): Promise<{ fields: Record<string, string>; staged: StagedUpload[] }> {
  fs.mkdirSync(stageDir, { recursive: true });
  const fields: Record<string, string> = {};
  const staged: StagedUpload[] = [];
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const tmpPath = path.join(stageDir, randomUUID());
      const truncated = await new Promise<boolean>((resolve, reject) => {
        let over = false;
        part.file.on("limit", () => {
          over = true;
        });
        pipeline(part.file, fs.createWriteStream(tmpPath)).then(
          () => resolve(over),
          reject
        );
      });
      staged.push({
        filename: sanitizeUploadName(part.filename || "附件"),
        tmpPath,
        size: fs.statSync(tmpPath).size,
        truncated,
      });
    } else if (fieldNames.includes(part.fieldname)) {
      fields[part.fieldname] = typeof part.value === "string" ? part.value : String(part.value ?? "");
    }
  }
  return { fields, staged };
}
