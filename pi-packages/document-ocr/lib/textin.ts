import path from "node:path";
import { OCR_TIMEOUT_MS, type OcrConfig, type OcrResult } from "./types.ts";

export function textInParseUrl(fileName: string, baseUrl: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const parseMode = ext === ".pdf" ? "auto" : "scan";
  const query = new URLSearchParams({
    parse_type: "document",
    parse_mode: parseMode,
    markdown_details: "1",
    table_flavor: "md",
    get_image: "none",
    char_details: "0",
  });
  return `${baseUrl.replace(/\/+$/, "")}/api/contracts/v3/parser/external/engine?${query.toString()}`;
}

export function extractMarkdown(payload: unknown): { markdown: string; pageCount: number } {
  if (!payload || typeof payload !== "object") {
    throw new Error("TextIn 返回不是 JSON 对象");
  }
  const obj = payload as Record<string, unknown>;
  const code = obj.code;
  if (code !== undefined && code !== 200 && code !== "200") {
    const msg = typeof obj.msg === "string" ? obj.msg : typeof obj.message === "string" ? obj.message : "未知错误";
    throw new Error(`TextIn 解析失败（${code}）：${msg}`);
  }
  const data = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : undefined;
  const result = data?.result && typeof data.result === "object" ? (data.result as Record<string, unknown>) : undefined;
  const markdown =
    (typeof result?.markdown === "string" && result.markdown) ||
    (typeof data?.markdown === "string" && data.markdown) ||
    (typeof obj.markdown === "string" && obj.markdown) ||
    "";
  if (!markdown.trim()) {
    throw new Error("TextIn 未返回 Markdown 正文（扫描件可能无法识别，或文件不是文档图片/PDF）");
  }
  const pageCountRaw = result?.total_page_number ?? result?.page_number;
  const pages = Array.isArray(result?.pages) ? result.pages.length : 0;
  const metrics = Array.isArray(data?.metrics) ? data.metrics.length : 0;
  const pageCount =
    typeof pageCountRaw === "number" && pageCountRaw > 0 ? pageCountRaw : pages || metrics || 1;
  return { markdown, pageCount };
}

function mimeFor(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".bmp":
      return "image/bmp";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

export async function parseWithTextIn(
  bytes: Uint8Array,
  fileName: string,
  cfg: OcrConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OcrResult> {
  const textin = cfg.textin;
  if (!textin?.baseUrl || !textin.apiKey) {
    throw new Error("TextIn 未配置服务地址或密钥");
  }
  const form = new FormData();
  form.append("document", new Blob([bytes], { type: mimeFor(fileName) }), fileName);
  const res = await fetchImpl(textInParseUrl(fileName, textin.baseUrl), {
    method: "POST",
    headers: { "x-api-key": textin.apiKey },
    body: form,
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  const raw = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`TextIn 返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}`);
  }
  if (!res.ok && !(payload && typeof payload === "object" && "code" in payload)) {
    throw new Error(`TextIn HTTP ${res.status}：${raw.slice(0, 200)}`);
  }
  const parsed = extractMarkdown(payload);
  return { ...parsed, engine: "textin", model: cfg.model || textin.baseUrl };
}
