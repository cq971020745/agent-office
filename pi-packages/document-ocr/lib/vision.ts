import { documentToPngPages } from "./pdf-pages.ts";
import { OCR_TIMEOUT_MS, type OcrConfig, type OcrResult } from "./types.ts";

const OCR_PROMPT =
  "提取图片中的全部文字，保留原有段落、标题和表格结构，只输出 Markdown。不要解释，不要翻译，不要添加原文没有的内容。";

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

async function ocrPng(png: Buffer, cfg: OcrConfig, fetchImpl: typeof fetch): Promise<string> {
  const vision = cfg.vision!;
  const res = await fetchImpl(completionsUrl(vision.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${vision.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: vision.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`视觉 OCR HTTP ${res.status}：${raw.slice(0, 200)}`);
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`视觉 OCR 返回非 JSON：${raw.slice(0, 200)}`);
  }
  const obj = payload as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
  if (obj.error?.message) throw new Error(`视觉 OCR 失败：${obj.error.message}`);
  const content = obj.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new Error("视觉 OCR 未返回正文");
  return text;
}

export async function parseWithVision(
  bytes: Uint8Array,
  fileName: string,
  cfg: OcrConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OcrResult> {
  if (!cfg.vision) throw new Error("视觉 OCR 未配置模型");
  const pages = await documentToPngPages(bytes, fileName);
  const parts: string[] = [];
  for (const page of pages) parts.push(await ocrPng(page, cfg, fetchImpl));
  return {
    markdown: parts.join("\n\n---\n\n").trim(),
    pageCount: pages.length,
    engine: "vision",
    model: cfg.vision.model,
  };
}
