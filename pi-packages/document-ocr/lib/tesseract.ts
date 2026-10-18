import fs from "node:fs";
import path from "node:path";
import { documentToPngPages } from "./pdf-pages.ts";
import { DEFAULT_TESSDATA_BASE_URL, type OcrConfig, type OcrResult } from "./types.ts";

function langList(model: string): string[] {
  return model
    .split(/[+,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function ensureTraineddata(lang: string, cfg: OcrConfig): Promise<void> {
  fs.mkdirSync(cfg.tessdataDir, { recursive: true });
  const dest = path.join(cfg.tessdataDir, `${lang}.traineddata`);
  try {
    if (fs.statSync(dest).size > 10_000) return;
  } catch {
    // 未缓存
  }
  const bases = [cfg.tessdataBaseUrl, DEFAULT_TESSDATA_BASE_URL, "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main"];
  const unique = [...new Set(bases.map((u) => u.replace(/\/+$/, "")))];
  let lastError = "";
  for (const base of unique) {
    const url = `${base}/${lang}.traineddata`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) {
        lastError = `HTTP ${res.status} ${url}`;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 10_000) {
        lastError = `${url} 文件过小`;
        continue;
      }
      fs.writeFileSync(dest, buf);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(
    `无法下载 Tesseract 官方语言包「${lang}」。请设置 OCR_TESSDATA_DIR 指向已放好 ${lang}.traineddata 的目录，或设置 OCR_TESSDATA_BASE_URL。最后错误：${lastError}`,
  );
}

export async function parseWithTesseract(bytes: Uint8Array, fileName: string, cfg: OcrConfig): Promise<OcrResult> {
  const langs = langList(cfg.model);
  if (!langs.length) throw new Error("OCR_MODEL 不能为空，Tesseract 语言包示例：chi_sim+eng");
  for (const lang of langs) await ensureTraineddata(lang, cfg);

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(langs.join("+"), 1, {
    langPath: cfg.tessdataDir,
    cachePath: cfg.tessdataDir,
    gzip: false,
    cacheMethod: "none",
  });
  try {
    const pages = await documentToPngPages(bytes, fileName);
    const texts: string[] = [];
    for (const page of pages) {
      const { data } = await worker.recognize(page);
      const text = data.text?.trim() ?? "";
      if (text) texts.push(text);
    }
    const markdown = texts.join("\n\n---\n\n").trim();
    if (!markdown) {
      throw new Error("Tesseract 未识别到文字。可把 OCR_ENGINE 设为 vision 并绑定多模态 OCR 模型，或更换 OCR_MODEL 语言包");
    }
    return { markdown, pageCount: pages.length, engine: "tesseract", model: langs.join("+") };
  } finally {
    await worker.terminate();
  }
}
