import fs from "node:fs";
import { isTextInOcrModel } from "@office/shared";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { ensureTextInProvider, readTextInApiKey } from "./textin-provider.js";

export interface OcrBinding {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  engine: "textin" | "vision";
}

/** @deprecated 使用 OcrBinding；保留给旧测试名 */
export type OcrVisionCandidate = OcrBinding;

interface ProviderOcrRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  ocr_model?: string;
}

/** 只采用供应商上显式绑定的 ocr_model；textin 走合合解析，其余走视觉模型。 */
export function pickOcrBinding(rows: ProviderOcrRow[]): OcrBinding | undefined {
  for (const row of rows) {
    const model = row.ocr_model?.trim();
    if (!model || !row.base_url) continue;
    if (isTextInOcrModel(model)) {
      return {
        providerId: row.id,
        providerName: row.name,
        baseUrl: row.base_url.replace(/\/+$/, ""),
        apiKey: row.api_key,
        model,
        engine: "textin",
      };
    }
    if (!row.api_key) continue;
    return {
      providerId: row.id,
      providerName: row.name,
      baseUrl: row.base_url.replace(/\/+$/, ""),
      apiKey: row.api_key,
      model,
      engine: "vision",
    };
  }
  return undefined;
}

/** 兼容旧测试：视觉候选不返回 TextIn。 */
export function pickOcrVisionCandidate(rows: ProviderOcrRow[]): OcrBinding | undefined {
  const picked = pickOcrBinding(rows);
  return picked?.engine === "vision" ? picked : undefined;
}

export function loadOcrBinding(userId?: string): OcrBinding | undefined {
  if (!userId) return undefined;
  try {
    ensureTextInProvider(userId);
    const rows = db
      .prepare(
        "SELECT id, name, base_url, api_key, ocr_model FROM model_providers WHERE enabled = 1 AND user_id = ? ORDER BY created_at",
      )
      .all(userId) as ProviderOcrRow[];
    return pickOcrBinding(rows);
  } catch {
    return undefined;
  }
}

export function loadOcrVisionCandidate(userId?: string): OcrBinding | undefined {
  const picked = loadOcrBinding(userId);
  return picked?.engine === "vision" ? picked : undefined;
}

/** 任务开始时写入工作区外的 OCR 运行时配置，Pi 插件按任务目录读取。 */
export function writeTaskOcrRuntime(taskId: string, userId: string): void {
  const binding = loadOcrBinding(userId);
  const payload: Record<string, unknown> = {};
  if (binding && !process.env.OCR_ENGINE?.trim()) {
    if (binding.engine === "textin") {
      const apiKey = binding.apiKey.trim() || readTextInApiKey();
      if (apiKey) {
        payload.engine = "textin";
        payload.model = binding.model;
        payload.textin = { baseUrl: binding.baseUrl, apiKey };
      }
    } else {
      payload.engine = "vision";
      payload.model = binding.model;
      payload.vision = { baseUrl: binding.baseUrl, apiKey: binding.apiKey, model: binding.model };
    }
  }
  const dir = path.join(config.dataDir, "ocr-runtime");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}.json`), `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
}
