import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "pi-packages", "document-ocr");
assert.ok(fs.existsSync(path.join(srcDir, "lib", "config.ts")), "应能定位 pi-packages/document-ocr/lib/config.ts");

const lib = (name: string) => pathToFileURL(path.join(srcDir, "lib", name)).href;
const { extractMarkdown, parseWithTextIn, textInParseUrl } = await import(lib("textin.ts"));
const { normalizeOcrEngine, resolveOcrConfig, loadTaskOcrRuntime } = await import(lib("config.ts"));
const { parseDocument } = await import(lib("parse.ts"));

describe("OCR 配置", () => {
  it("默认开源 Tesseract，语言包 chi_sim+eng", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-cfg-"));
    const cfg = resolveOcrConfig({ env: { DATA_DIR: dir }, dataDir: dir, homedir: dir });
    assert.equal(cfg.engine, "tesseract");
    assert.equal(cfg.model, "chi_sim+eng");
  });

  it("OCR_MODEL 覆盖 Tesseract 语言包，ocr.json 可配引擎", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-file-"));
    fs.writeFileSync(path.join(dir, "ocr.json"), JSON.stringify({ engine: "tesseract", model: "eng" }));
    const cfg = resolveOcrConfig({
      env: { DATA_DIR: dir, OCR_MODEL: "chi_sim" },
      dataDir: dir,
      homedir: dir,
    });
    assert.equal(cfg.engine, "tesseract");
    assert.equal(cfg.model, "chi_sim");
  });

  it("环境变量 OCR_ENGINE 优先于运行时视觉绑定", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-env-"));
    const cfg = resolveOcrConfig({
      env: { DATA_DIR: dir, OCR_ENGINE: "tesseract", OCR_MODEL: "eng" },
      dataDir: dir,
      homedir: dir,
      runtime: {
        engine: "vision",
        model: "qwen-vl-max",
        vision: { baseUrl: "http://v.test", apiKey: "k", model: "qwen-vl-max" },
      },
    });
    assert.equal(cfg.engine, "tesseract");
    assert.equal(cfg.model, "eng");
  });

  it("vision 缺模型或地址时报错，不回落到内网 TextIn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-vis-"));
    assert.throws(
      () => resolveOcrConfig({ env: { DATA_DIR: dir, OCR_ENGINE: "vision" }, dataDir: dir, homedir: dir }),
      /视觉模型/,
    );
  });

  it("textin 必须显式给地址，不再默认内网 10.50.11.17", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-ti-"));
    fs.mkdirSync(path.join(dir, ".agents", "key"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agents", "key", "TEXT_IN_API_KEY"), "k");
    assert.throws(
      () => resolveOcrConfig({ env: { DATA_DIR: dir, OCR_ENGINE: "textin" }, dataDir: dir, homedir: dir }),
      /TEXT_IN_BASE_URL/,
    );
    const cfg = resolveOcrConfig({
      env: { DATA_DIR: dir, OCR_ENGINE: "textin", TEXT_IN_BASE_URL: "http://textin.test" },
      dataDir: dir,
      homedir: dir,
    });
    assert.equal(cfg.engine, "textin");
    assert.equal(cfg.textin?.baseUrl, "http://textin.test");
    assert.equal(cfg.textin?.apiKey, "k");
  });

  it("normalizeOcrEngine 拒绝未知引擎", () => {
    assert.equal(normalizeOcrEngine("auto"), undefined);
    assert.equal(normalizeOcrEngine("tesseract.js"), "tesseract");
    assert.throws(() => normalizeOcrEngine("paddle"), /不支持的 OCR_ENGINE/);
  });

  it("从任务工作区旁读取运行时配置", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-rt-"));
    const workspace = path.join(dataDir, "workspaces", "task-1");
    fs.mkdirSync(path.join(dataDir, "ocr-runtime"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "ocr-runtime", "task-1.json"), JSON.stringify({ engine: "tesseract", model: "eng" }));
    const runtime = loadTaskOcrRuntime(workspace);
    assert.equal(runtime?.engine, "tesseract");
    assert.equal(runtime?.model, "eng");
  });
});

describe("OCR 调度", () => {
  it("默认走 tesseract 依赖注入，不碰 TextIn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-parse-"));
    const cfg = resolveOcrConfig({ env: { DATA_DIR: dir }, dataDir: dir, homedir: dir });
    const parsed = await parseDocument(new Uint8Array([1]), "a.pdf", cfg, {
      tesseract: async () => ({ markdown: "开源正文", pageCount: 1, engine: "tesseract", model: "chi_sim+eng" }),
      textin: async () => {
        throw new Error("不应调用 TextIn");
      },
    });
    assert.equal(parsed.engine, "tesseract");
    assert.equal(parsed.markdown, "开源正文");
  });
});

describe("TextIn 可选后端", () => {
  it("PDF 用 auto，图片用 scan", () => {
    assert.match(textInParseUrl("a.pdf", "http://textin.test"), /parse_mode=auto/);
    assert.match(textInParseUrl("a.png", "http://textin.test"), /parse_mode=scan/);
  });

  it("从成功响应取出 Markdown", () => {
    const parsed = extractMarkdown({
      code: 200,
      data: { result: { markdown: "# 审计报告\n\n正文", total_page_number: 15 } },
    });
    assert.equal(parsed.markdown, "# 审计报告\n\n正文");
    assert.equal(parsed.pageCount, 15);
  });

  it("parseWithTextIn 走 multipart", async () => {
    let seenUrl = "";
    const parsed = await parseWithTextIn(new Uint8Array([1, 2, 3]), "扫描.pdf", {
      engine: "textin",
      model: "",
      tessdataDir: os.tmpdir(),
      tessdataBaseUrl: "",
      textin: { baseUrl: "http://textin.test", apiKey: "k" },
    }, async (url, init) => {
      seenUrl = String(url);
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({ code: 200, data: { result: { markdown: "OCR 正文", total_page_number: 2 } } }),
        { status: 200 },
      );
    });
    assert.match(seenUrl, /^http:\/\/textin\.test\/api\/contracts\/v3\/parser\/external\/engine\?/);
    assert.equal(parsed.markdown, "OCR 正文");
  });
});
