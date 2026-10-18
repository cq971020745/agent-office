export const MAX_OCR_BYTES = 20 * 1024 * 1024;
export const OCR_TIMEOUT_MS = 180_000;
export const DEFAULT_TESSERACT_MODEL = "chi_sim+eng";
export const DEFAULT_TESSDATA_BASE_URL = "https://github.com/tesseract-ocr/tessdata_fast/raw/main";

export const OCR_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".bmp",
  ".webp",
  ".gif",
]);

export type OcrEngine = "tesseract" | "vision" | "textin";

export interface OcrVisionSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OcrTextInSettings {
  baseUrl: string;
  apiKey: string;
}

export interface OcrConfig {
  engine: OcrEngine;
  /** Tesseract 语言包（如 chi_sim+eng）或视觉模型 ID */
  model: string;
  tessdataDir: string;
  tessdataBaseUrl: string;
  vision?: OcrVisionSettings;
  textin?: OcrTextInSettings;
}

export interface OcrResult {
  markdown: string;
  pageCount: number;
  engine: OcrEngine;
  model: string;
}

export interface OcrParseDeps {
  tesseract?: (bytes: Uint8Array, fileName: string, cfg: OcrConfig) => Promise<OcrResult>;
  vision?: (bytes: Uint8Array, fileName: string, cfg: OcrConfig) => Promise<OcrResult>;
  textin?: (bytes: Uint8Array, fileName: string, cfg: OcrConfig) => Promise<OcrResult>;
}
