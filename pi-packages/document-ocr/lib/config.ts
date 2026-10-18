import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TESSDATA_BASE_URL,
  DEFAULT_TESSERACT_MODEL,
  type OcrConfig,
  type OcrEngine,
  type OcrTextInSettings,
  type OcrVisionSettings,
} from "./types.ts";

export interface ResolveOcrOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  dataDir?: string;
  runtime?: Partial<OcrConfig> | null;
}

interface OcrFileShape {
  engine?: string;
  model?: string;
  tessdataDir?: string;
  tessdataBaseUrl?: string;
  vision?: Partial<OcrVisionSettings>;
  textin?: Partial<OcrTextInSettings>;
}

export function normalizeOcrEngine(raw: string | undefined): OcrEngine | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "auto") return undefined;
  if (value === "tesseract" || value === "tess" || value === "tesseract.js") return "tesseract";
  if (value === "vision" || value === "vl" || value === "vlm") return "vision";
  if (value === "textin") return "textin";
  throw new Error(`不支持的 OCR_ENGINE「${raw}」。可用：tesseract（默认开源）、vision（可配置多模态模型）、textin`);
}

function readJsonFile(file: string): OcrFileShape | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as OcrFileShape;
  } catch {
    return undefined;
  }
}

export function readOcrConfigFile(dataDir: string, env: NodeJS.ProcessEnv = process.env): OcrFileShape | undefined {
  const configured = env.OCR_CONFIG?.trim();
  const candidates = [configured, path.join(dataDir, "ocr.json"), path.join(dataDir, "agent", "ocr.json")].filter(
    (p): p is string => !!p,
  );
  for (const file of candidates) {
    if (fs.existsSync(file)) return readJsonFile(file);
  }
  return undefined;
}

function readKeyFile(homedir: string, name: string): string {
  try {
    return fs.readFileSync(path.join(homedir, ".agents", "key", name), "utf8").trim();
  } catch {
    return "";
  }
}

export function loadTaskOcrRuntime(workspaceRoot: string): Partial<OcrConfig> | undefined {
  const taskId = path.basename(path.resolve(workspaceRoot));
  const file = path.join(path.dirname(path.resolve(workspaceRoot)), "..", "ocr-runtime", `${taskId}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as Partial<OcrConfig>;
  } catch {
    return undefined;
  }
}

export function resolveOcrConfig(opts: ResolveOcrOptions = {}): OcrConfig {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? os.homedir();
  const dataDir = path.resolve(opts.dataDir ?? env.DATA_DIR ?? "data");
  const file = readOcrConfigFile(dataDir, env);
  const runtime = opts.runtime ?? undefined;

  const engine =
    normalizeOcrEngine(env.OCR_ENGINE) ??
    normalizeOcrEngine(runtime?.engine) ??
    normalizeOcrEngine(file?.engine) ??
    "tesseract";

  const tessdataDir =
    env.OCR_TESSDATA_DIR?.trim() ||
    runtime?.tessdataDir ||
    file?.tessdataDir ||
    path.join(dataDir, "models", "tessdata");
  const tessdataBaseUrl = (
    env.OCR_TESSDATA_BASE_URL?.trim() ||
    runtime?.tessdataBaseUrl ||
    file?.tessdataBaseUrl ||
    DEFAULT_TESSDATA_BASE_URL
  ).replace(/\/+$/, "");

  const model =
    env.OCR_MODEL?.trim() ||
    runtime?.model?.trim() ||
    file?.model?.trim() ||
    (engine === "tesseract" ? DEFAULT_TESSERACT_MODEL : "");

  const cfg: OcrConfig = {
    engine,
    model,
    tessdataDir,
    tessdataBaseUrl,
  };

  if (engine === "vision") {
    const vision: OcrVisionSettings = {
      baseUrl: (env.OCR_VISION_BASE_URL?.trim() || runtime?.vision?.baseUrl || file?.vision?.baseUrl || "").replace(
        /\/+$/,
        "",
      ),
      apiKey: env.OCR_VISION_API_KEY?.trim() || runtime?.vision?.apiKey || file?.vision?.apiKey || "",
      model: model || runtime?.vision?.model || file?.vision?.model || "",
    };
    if (!vision.baseUrl || !vision.apiKey || !vision.model) {
      throw new Error(
        "OCR_ENGINE=vision 时需要配置视觉模型。请在供应商里绑定 OCR 模型，或设置 OCR_MODEL、OCR_VISION_BASE_URL、OCR_VISION_API_KEY",
      );
    }
    cfg.model = vision.model;
    cfg.vision = vision;
  }

  if (engine === "textin") {
    const textin: OcrTextInSettings = {
      baseUrl: (
        env.TEXT_IN_BASE_URL?.trim() ||
        runtime?.textin?.baseUrl ||
        file?.textin?.baseUrl ||
        ""
      ).replace(/\/+$/, ""),
      apiKey:
        env.TEXT_IN_API_KEY?.trim() ||
        runtime?.textin?.apiKey ||
        file?.textin?.apiKey ||
        readKeyFile(homedir, "TEXT_IN_API_KEY"),
    };
    if (!textin.baseUrl || !textin.apiKey) {
      throw new Error(
        "OCR_ENGINE=textin 时需要 TEXT_IN_BASE_URL 与 TEXT_IN_API_KEY（或 ~/.agents/key/TEXT_IN_API_KEY）。未配置时请改用默认开源 Tesseract.js",
      );
    }
    cfg.textin = textin;
  }

  if (engine === "tesseract" && !cfg.model) cfg.model = DEFAULT_TESSERACT_MODEL;
  return cfg;
}
