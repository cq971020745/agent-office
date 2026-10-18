import { parseWithTesseract } from "./tesseract.ts";
import { parseWithTextIn } from "./textin.ts";
import type { OcrConfig, OcrParseDeps, OcrResult } from "./types.ts";
import { parseWithVision } from "./vision.ts";

export async function parseDocument(
  bytes: Uint8Array,
  fileName: string,
  cfg: OcrConfig,
  deps: OcrParseDeps = {},
): Promise<OcrResult> {
  if (cfg.engine === "vision") {
    return (deps.vision ?? parseWithVision)(bytes, fileName, cfg);
  }
  if (cfg.engine === "textin") {
    return (deps.textin ?? parseWithTextIn)(bytes, fileName, cfg);
  }
  return (deps.tesseract ?? parseWithTesseract)(bytes, fileName, cfg);
}
