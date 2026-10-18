import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTextInOcrModel, TEXT_IN_MODEL_ID } from "@office/shared";
import { db, now, uuid } from "./db.js";

export const TEXT_IN_PROVIDER_NAME = "TextIn OCR";
export const DEFAULT_TEXT_IN_BASE_URL = "http://10.50.11.17";

function parseModels(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

export function defaultTextInBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TEXT_IN_BASE_URL?.trim() || DEFAULT_TEXT_IN_BASE_URL).replace(/\/+$/, "");
}

export function readTextInApiKey(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  const fromEnv = env.TEXT_IN_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path.join(homedir, ".agents", "key", "TEXT_IN_API_KEY"), "utf8").trim();
  } catch {
    return "";
  }
}

export function isTextInProvider(row: {
  name?: string;
  ocr_model?: string;
  models?: string;
  enabled_models?: string;
}): boolean {
  if (isTextInOcrModel(row.ocr_model ?? "")) return true;
  if (parseModels(row.models).some(isTextInOcrModel)) return true;
  if (parseModels(row.enabled_models).some(isTextInOcrModel)) return true;
  return /textin/i.test(row.name ?? "");
}

/** 给当前用户种入 TextIn OCR 供应商（已有则跳过，不覆盖用户改过的地址或密钥）。 */
export function ensureTextInProvider(userId: string): string | undefined {
  if (!userId) return undefined;
  const existing = db
    .prepare(
      "SELECT id, name, models, enabled_models, ocr_model FROM model_providers WHERE user_id = ?",
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    models: string;
    enabled_models: string;
    ocr_model: string;
  }>;
  const found = existing.find((row) => isTextInProvider(row));
  if (found) return found.id;

  const id = uuid();
  const models = JSON.stringify([TEXT_IN_MODEL_ID]);
  db.prepare(
    `INSERT INTO model_providers
      (id, name, base_url, api_key, enabled, user_id, created_at, models, enabled_models, models_touched, models_fetched_at, ocr_model)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    TEXT_IN_PROVIDER_NAME,
    defaultTextInBaseUrl(),
    readTextInApiKey(),
    userId,
    now(),
    models,
    models,
    now(),
    TEXT_IN_MODEL_ID,
  );
  return id;
}
