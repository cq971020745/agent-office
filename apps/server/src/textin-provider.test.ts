import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "textin-provider-test-"));

const { db, migrate } = await import("./db.js");
const { DEFAULT_TEXT_IN_BASE_URL, ensureTextInProvider, isTextInProvider, TEXT_IN_PROVIDER_NAME } = await import(
  "./textin-provider.js"
);

migrate();

describe("ensureTextInProvider", () => {
  it("为用户种入 TextIn OCR 供应商并绑定 textin", () => {
    const id1 = ensureTextInProvider("user-a");
    const id2 = ensureTextInProvider("user-a");
    assert.equal(id1, id2);
    const row = db
      .prepare("SELECT name, base_url, ocr_model, models, enabled_models FROM model_providers WHERE id = ?")
      .get(id1) as {
      name: string;
      base_url: string;
      ocr_model: string;
      models: string;
      enabled_models: string;
    };
    assert.equal(row.name, TEXT_IN_PROVIDER_NAME);
    assert.equal(row.base_url, DEFAULT_TEXT_IN_BASE_URL);
    assert.equal(row.ocr_model, "textin");
    assert.deepEqual(JSON.parse(row.models), ["textin"]);
    assert.deepEqual(JSON.parse(row.enabled_models), ["textin"]);
  });

  it("已有 TextIn 供应商时不覆盖用户改过的地址", () => {
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key, enabled, user_id, created_at, models, enabled_models, ocr_model) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
    ).run("p-ti", "TextIn OCR", "http://textin.local", "secret", "user-b", "2026-01-01", '["textin"]', '["textin"]', "textin");
    const id = ensureTextInProvider("user-b");
    assert.equal(id, "p-ti");
    const row = db.prepare("SELECT base_url, api_key FROM model_providers WHERE id = 'p-ti'").get() as {
      base_url: string;
      api_key: string;
    };
    assert.equal(row.base_url, "http://textin.local");
    assert.equal(row.api_key, "secret");
  });

  it("isTextInProvider 识别名称、模型列表和 ocr_model", () => {
    assert.equal(isTextInProvider({ name: "TextIn OCR", ocr_model: "", models: "[]" }), true);
    assert.equal(isTextInProvider({ name: "DeepSeek", ocr_model: "textin", models: "[]" }), true);
    assert.equal(isTextInProvider({ name: "A", ocr_model: "", models: '["textin"]' }), true);
    assert.equal(isTextInProvider({ name: "A", ocr_model: "qwen-vl-max", models: '["qwen-vl-max"]' }), false);
  });
});

describe("isChatModel 不把 textin 当对话模型", () => {
  it("textin 与视觉 OCR 不进派发列表", async () => {
    const { isChatModel, isOcrModel, isTextInOcrModel } = await import("@office/shared");
    assert.equal(isChatModel("textin"), false);
    assert.equal(isTextInOcrModel("textin"), true);
    assert.equal(isOcrModel("textin"), true);
    assert.equal(isOcrModel("qwen-vl-max"), true);
  });
});
