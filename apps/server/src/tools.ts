import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// 截断常量与 pi 官方约定一致（2000 行 / 50KB）
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from("%PDF");
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".xlsm", ".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif"]);

export type BinaryKind = "text" | "ole" | "ooxml" | "pdf" | "binary";

/** 用魔数和 NUL 判断文件能不能当 UTF-8 文本读。只看文件头，避免把整份合同当字符串扫一遍。 */
export function detectBinaryKind(buf: Buffer): BinaryKind {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(OLE2_MAGIC)) return "ole";
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) return "ooxml";
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return "pdf";
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return "binary";
  return "text";
}

/**
 * 二进制附件的可读说明。OLE2 内容配了 .docx 这类后缀时，复制一份隐藏的 .doc
 * 给 doc_to_md，原文件不动。产物目录 .parsed 以点开头，不会被记成成果物。
 * 扫描件 / 图片走 ocr_to_md（默认开源 Tesseract.js，可配置 OCR 模型）。
 */
export function prepareDocumentHint(root: string, rel: string, kind: BinaryKind): string {
  const ext = path.extname(rel).toLowerCase();
  const stem = path.basename(rel, path.extname(rel)).replace(/[^\w.\u4e00-\u9fff-]+/g, "_") || "document";
  const outputDir = `.parsed/${stem}`;
  let toolPath = rel.replace(/\\/g, "/");
  if (kind === "ole" && ext !== ".doc") {
    const copyRel = `.parsed/${stem}.doc`;
    const src = assertInWorkspace(root, rel);
    const dest = assertInWorkspace(root, copyRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    toolPath = copyRel;
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return [
      `「${rel}」是图片，不能用 workspace_read 直接读取。`,
      `请调用 ocr_to_md：path="${toolPath}"，outputDir="${outputDir}"。`,
      "然后用 workspace_read 读取返回结果里的 Saved-To Markdown。不要安装系统 Tesseract，也不要把附件上传到云盘只为提取正文。",
    ].join("\n");
  }
  const convertible =
    kind === "ole" || kind === "pdf" || ((kind === "ooxml" || kind === "binary") && OFFICE_EXTENSIONS.has(ext));
  if (!convertible) {
    return `「${rel}」是二进制文件，workspace_read 不会把它当成文本返回。`;
  }
  const mismatch =
    kind === "ole" && ext !== ".doc" ? "文件头是旧版 OLE2 Word，和当前扩展名不一致，已生成不改原件的 .doc 副本。" : "";
  const ocrHint =
    kind === "pdf" || ext === ".pdf"
      ? "如果 Saved-To Markdown 几乎没有正文（扫描件、图片型 PDF），再调用 ocr_to_md，path 和 outputDir 相同。不要安装系统 Tesseract。"
      : "";
  return [
    `「${rel}」是二进制文档，不能用 workspace_read 直接读取。${mismatch}`,
    `请调用 doc_to_md：path="${toolPath}"，outputDir="${outputDir}"。`,
    ocrHint,
    "然后用 workspace_read 读取返回结果里的 Saved-To Markdown。不要为了提取正文把本地附件上传到云盘。",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateForContext(text: string): string {
  const lines = text.split("\n");
  const kept = lines.slice(0, MAX_LINES).join("\n").slice(0, MAX_BYTES);
  if (kept.length === text.length) return kept;
  const notice =
    lines.length > MAX_LINES
      ? `[truncated: showing first ${MAX_LINES} of ${lines.length} lines]`
      : "[truncated: output exceeds 50KB]";
  return `${kept}\n${notice}`;
}
// 导出仅为测试使用
export { truncateForContext };

/** 把工作区相对路径解析为绝对路径；越出工作区即抛错（便利级 jail，非安全边界）。 */
export function assertInWorkspace(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path escapes the task workspace: ${rel}`);
  }
  return target;
}

const ListParams = Type.Object({});
const ReadParams = Type.Object({
  path: Type.String({ description: "File path relative to the workspace root" }),
});
const WriteParams = Type.Object({
  path: Type.String({ description: "File path relative to the workspace root" }),
  content: Type.String({ description: "Full file content to write" }),
});
const EditParams = Type.Object({
  path: Type.String({ description: "File path relative to the workspace root" }),
  oldText: Type.String({ description: "Exact text segment to find and replace" }),
  newText: Type.String({ description: "Replacement text" }),
});
const TranscribeParams = Type.Object({
  path: Type.String({ description: "Audio file path relative to the workspace root (.wav/.mp3/.m4a/.webm/.ogg)" }),
  saveTo: Type.Optional(
    Type.String({ description: "Optional workspace-relative path to save the transcribed text (e.g. transcript.md)" })
  ),
});
const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL" }),
});

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

/** 每个任务一组：读写都发生在该任务专属目录内；工具失败按 pi 约定直接抛错。 */
export function workspaceTools(root: string, userId?: string): ToolDefinition[] {
  const list: ToolDefinition<typeof ListParams> = {
    name: "workspace_list",
    label: "列出工作区文件",
    description: "List files and directories in the task workspace (up to 3 levels deep).",
    parameters: ListParams,
    execute: async () => {
      const entries: string[] = [];
      const walk = (dir: string, relPrefix: string, depth: number): void => {
        if (depth > 3 || entries.length >= 200) return;
        const items = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules");
        for (const e of items) {
          if (entries.length >= 200) break;
          const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            entries.push(`${rel}/`);
            walk(path.join(dir, e.name), rel, depth + 1);
          } else {
            entries.push(rel);
          }
        }
      };
      walk(root, "", 1);
      return { content: [{ type: "text", text: entries.length ? entries.join("\n") : "(empty workspace)" }], details: undefined };
    },
  };

  const read: ToolDefinition<typeof ReadParams> = {
    name: "workspace_read",
    label: "读取工作区文件",
    description:
      "Read a UTF-8 text file from the task workspace. Path is workspace-relative. Binary Office/PDF files are refused; call doc_to_md (or ocr_to_md for scans/images) and read the markdown it writes under .parsed/.",
    parameters: ReadParams,
    execute: async (_id, params) => {
      const file = assertInWorkspace(root, params.path);
      if (!fs.existsSync(file)) throw new Error(`file not found: ${params.path}`);
      const buf = fs.readFileSync(file);
      const ext = path.extname(params.path).toLowerCase();
      const kind = detectBinaryKind(buf);
      if (kind !== "text" || IMAGE_EXTENSIONS.has(ext)) {
        const hintKind = IMAGE_EXTENSIONS.has(ext) && kind === "text" ? "binary" : kind;
        return { content: [{ type: "text", text: prepareDocumentHint(root, params.path, hintKind) }], details: undefined };
      }
      return { content: [{ type: "text", text: truncateForContext(buf.toString("utf8")) }], details: undefined };
    },
  };

  const write: ToolDefinition<typeof WriteParams> = {
    name: "workspace_write",
    label: "写入工作区文件",
    description:
      "Write (create or overwrite) a UTF-8 text file in the task workspace. Parent directories are created automatically. Path is workspace-relative.",
    parameters: WriteParams,
    execute: async (_id, params) => {
      const file = assertInWorkspace(root, params.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, params.content, "utf8");
      return { content: [{ type: "text", text: `wrote ${params.path} (${params.content.length} bytes)` }], details: undefined };
    },
  };

  const edit: ToolDefinition<typeof EditParams> = {
    name: "workspace_edit",
    label: "局部编辑工作区文件",
    description:
      "Replace an exact text segment (oldText -> newText) in an existing UTF-8 file in the task workspace without rewriting the whole file.",
    parameters: EditParams,
    execute: async (_id, params) => {
      const file = assertInWorkspace(root, params.path);
      if (!fs.existsSync(file)) throw new Error(`file not found: ${params.path}`);
      const src = fs.readFileSync(file, "utf8");
      if (!params.oldText || !src.includes(params.oldText)) {
        throw new Error(`oldText not found in ${params.path}`);
      }
      const next = src.replace(params.oldText, params.newText);
      fs.writeFileSync(file, next, "utf8");
      return { content: [{ type: "text", text: `edited ${params.path}` }], details: undefined };
    },
  };

  const transcribeAudio: ToolDefinition<typeof TranscribeParams> = {
    name: "transcribe_audio",
    label: "音频转写",
    description:
      "Transcribe an audio file (.wav, .mp3, .m4a, .webm, .ogg, .flac) in the task workspace into text using the platform ASR model. Optionally saves the transcript to saveTo.",
    parameters: TranscribeParams,
    execute: async (_id, params) => {
      const file = assertInWorkspace(root, params.path);
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = AUDIO_MIME_BY_EXT[ext];
      if (!mime) {
        throw new Error(
          `unsupported audio extension ".${ext}" (expected one of: ${Object.keys(AUDIO_MIME_BY_EXT).join(", ")})`
        );
      }
      if (!fs.existsSync(file)) throw new Error(`audio file not found: ${params.path}`);
      const audio = fs.readFileSync(file);
      if (!audio.length) throw new Error(`audio file is empty: ${params.path}`);
      const { transcribeAudioBuffer } = await import("./routes/voice.js");
      const res = await transcribeAudioBuffer(audio, path.basename(file), mime, userId);
      if (params.saveTo?.trim()) {
        const dest = assertInWorkspace(root, params.saveTo.trim());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, res.text, "utf8");
      }
      return {
        content: [
          {
            type: "text",
            text: truncateForContext(
              `[转写模型: ${res.provider}/${res.model}${params.saveTo ? ` | 已保存至 ${params.saveTo}` : ""}]\n\n${res.text}`
            ),
          },
        ],
        details: undefined,
      };
    },
  };

  const fetchUrl: ToolDefinition<typeof FetchParams> = {
    name: "fetch_url",
    label: "抓取网页",
    description:
      "Fetch a URL over HTTP(S) and return the response body as text (HTML tags stripped, truncated).",
    parameters: FetchParams,
    execute: async (_id, params, signal) => {
      // 仅允许 http(s)：防 file:/ftp:/data: 等协议被当作网页抓取
      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        throw new Error(`invalid url: ${params.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`only http(s) URLs are allowed, got: ${parsed.protocol}`);
      }
      const res = await fetch(parsed, { signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${params.url}`);
      const text = await res.text();
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { content: [{ type: "text", text: truncateForContext(stripped) }], details: undefined };
    },
  };

  return [list, read, write, edit, transcribeAudio, fetchUrl];
}
