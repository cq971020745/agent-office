import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-runtime-test-"));

const { pickOcrBinding, pickOcrVisionCandidate } = await import("./ocr-runtime.js");

describe("pickOcrVisionCandidate", () => {
  it("未显式绑定 ocr_model 的供应商绝不盲选", () => {
    assert.equal(
      pickOcrVisionCandidate([
        { id: "p1", name: "A", base_url: "http://a.test/v1", api_key: "k", ocr_model: "" },
        { id: "p2", name: "B", base_url: "http://b.test/v1", api_key: "k" },
      ]),
      undefined,
    );
  });

  it("只返回显式绑定了 ocr_model 且有地址和密钥的供应商", () => {
    const picked = pickOcrVisionCandidate([
      { id: "p1", name: "A", base_url: "http://a.test/v1", api_key: "k", ocr_model: "" },
      { id: "p2", name: "B", base_url: "http://b.test/v1/", api_key: "k2", ocr_model: "qwen-vl-max" },
    ]);
    assert.equal(picked?.providerId, "p2");
    assert.equal(picked?.model, "qwen-vl-max");
    assert.equal(picked?.baseUrl, "http://b.test/v1");
    assert.equal(picked?.engine, "vision");
  });

  it("textin 绑定不走视觉候选", () => {
    assert.equal(
      pickOcrVisionCandidate([
        { id: "p1", name: "TextIn OCR", base_url: "http://10.50.11.17", api_key: "k", ocr_model: "textin" },
      ]),
      undefined,
    );
  });
});

describe("pickOcrBinding", () => {
  it("ocr_model=textin 走 TextIn 引擎", () => {
    const picked = pickOcrBinding([
      { id: "p1", name: "TextIn OCR", base_url: "http://10.50.11.17/", api_key: "k", ocr_model: "textin" },
    ]);
    assert.equal(picked?.engine, "textin");
    assert.equal(picked?.model, "textin");
    assert.equal(picked?.baseUrl, "http://10.50.11.17");
  });
});
