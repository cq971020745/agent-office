/**
 * ocr_to_md：扫描件 / 图片 OCR，Markdown 写到工作区 .parsed/。
 * 默认开源 Tesseract.js（官方 tessdata，OCR_MODEL 配语言包）。
 * 供应商绑定 ocr_model=textin 时走合合 TextIn；也可绑定视觉模型，或显式 OCR_ENGINE。
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { loadTaskOcrRuntime, resolveOcrConfig } from "../lib/config.ts";
import { parseDocument } from "../lib/parse.ts";
import { MAX_OCR_BYTES, OCR_EXTENSIONS } from "../lib/types.ts";

const OcrParams = Type.Object({
  path: Type.String({ description: "Workspace-relative path to a scanned PDF or image" }),
  outputDir: Type.String({
    description: "Workspace-relative directory for the Markdown, usually .parsed/<stem>",
  }),
});

function assertInWorkspace(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path escapes the task workspace: ${rel}`);
  }
  return target;
}

function stemOf(rel: string): string {
  return path.basename(rel, path.extname(rel)).replace(/[^\w.\u4e00-\u9fff-]+/g, "_") || "document";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ocr_to_md",
    label: "扫描件 OCR",
    description:
      "OCR a scanned PDF or image in the task workspace and write Markdown under outputDir (use a hidden .parsed/ folder). Default engine is open-source Tesseract.js (OCR_MODEL language packs such as chi_sim+eng). If the user bound an OCR vision model, that model is used instead. Call this when doc_to_md returns empty/garbled text, or for png/jpg/tif/bmp/webp. Do not install system Tesseract. Do not upload the file to cloud storage just to extract text.",
    parameters: OcrParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = (ctx as ExtensionToolContext | undefined)?.cwd ?? process.cwd();
      const rel = String(params.path ?? "").trim();
      const outRel = String(params.outputDir ?? "").trim();
      if (!rel) {
        return { content: [{ type: "text", text: "错误：path 不能为空" }], details: { error: "missing path" } };
      }
      const ext = path.extname(rel).toLowerCase();
      if (!OCR_EXTENSIONS.has(ext)) {
        return {
          content: [
            {
              type: "text",
              text: `错误：ocr_to_md 只处理 PDF 与图片（${[...OCR_EXTENSIONS].join("、")}），当前是 ${ext || "无扩展名"}。数字版 Office 请用 doc_to_md。`,
            },
          ],
          details: { error: "unsupported extension" },
        };
      }
      const src = assertInWorkspace(root, rel);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        return { content: [{ type: "text", text: `错误：找不到文件 ${rel}` }], details: { error: "not found" } };
      }
      const size = fs.statSync(src).size;
      if (size > MAX_OCR_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `错误：文件 ${rel} 超过 ${Math.round(MAX_OCR_BYTES / 1024 / 1024)}MB，无法 OCR。`,
            },
          ],
          details: { error: "too large" },
        };
      }
      const destDirRel = (outRel || `.parsed/${stemOf(rel)}`).replace(/\\/g, "/");
      const destDir = assertInWorkspace(root, destDirRel);
      const mdRel = `${destDirRel.replace(/\/+$/, "")}/${stemOf(rel)}.md`;
      const mdAbs = assertInWorkspace(root, mdRel);
      try {
        const cfg = resolveOcrConfig({ runtime: loadTaskOcrRuntime(root) });
        const parsed = await parseDocument(fs.readFileSync(src), path.basename(rel), cfg);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(mdAbs, parsed.markdown, "utf8");
        return {
          content: [
            {
              type: "text",
              text: [
                `OCR 完成（引擎 ${parsed.engine}，模型 ${parsed.model}，约 ${parsed.pageCount} 页）。`,
                `Saved-To: ${mdRel.replace(/\\/g, "/")}`,
                "用 workspace_read 读取该 Markdown。",
              ].join("\n"),
            },
          ],
          details: {
            savedTo: mdRel.replace(/\\/g, "/"),
            pageCount: parsed.pageCount,
            engine: parsed.engine,
            model: parsed.model,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `OCR 失败：${message}` }], details: { error: message } };
      }
    },
  });
}
