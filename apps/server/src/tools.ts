import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// 截断常量与 pi 官方约定一致（2000 行 / 50KB）
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

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
const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL" }),
});

/** 每个任务一组：读写都发生在该任务专属目录内；工具失败按 pi 约定直接抛错。 */
export function workspaceTools(root: string): ToolDefinition[] {
  const list: ToolDefinition<typeof ListParams> = {
    name: "workspace_list",
    label: "列出工作区文件",
    description: "List files in the task workspace (top level).",
    parameters: ListParams,
    execute: async () => {
      const entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { content: [{ type: "text", text: entries.length ? entries.join("\n") : "(empty workspace)" }], details: undefined };
    },
  };

  const read: ToolDefinition<typeof ReadParams> = {
    name: "workspace_read",
    label: "读取工作区文件",
    description: "Read a UTF-8 text file from the task workspace. Path is workspace-relative.",
    parameters: ReadParams,
    execute: async (_id, params) => {
      const file = assertInWorkspace(root, params.path);
      return { content: [{ type: "text", text: truncateForContext(fs.readFileSync(file, "utf8")) }], details: undefined };
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

  return [list, read, write, fetchUrl];
}
