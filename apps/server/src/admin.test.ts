// admin.test.ts：parseGenerated（AI 生成专家配置的容错解析）。导入前隔离 DATA_DIR（模块链上有 db.js）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-admin-test-"));

const { parseGenerated } = await import("./routes/admin.js");
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("parseGenerated", () => {
  it("解析干净 JSON", () => {
    const out = parseGenerated(JSON.stringify({ name: "内容写手", description: "写作", systemPrompt: "你是写手", tags: ["写作"] }));
    assert.equal(out?.name, "内容写手");
    assert.equal(out?.systemPrompt, "你是写手");
    assert.deepEqual(out?.tags, ["写作"]);
  });

  it("剥掉 markdown 代码围栏", () => {
    const raw = "```json\n" + JSON.stringify({ name: "翻译", systemPrompt: "你是翻译", tags: [] }) + "\n```";
    assert.equal(parseGenerated(raw)?.name, "翻译");
  });

  it("从夹杂文字中截取 JSON 对象", () => {
    const raw = '好的，配置如下：{"name":"分析师","systemPrompt":"你是分析师"} 以上。';
    assert.equal(parseGenerated(raw)?.name, "分析师");
  });

  it("缺 name 或 systemPrompt 返回 null", () => {
    assert.equal(parseGenerated('{"name":"","systemPrompt":"x"}'), null);
    assert.equal(parseGenerated('{"name":"x"}'), null);
    assert.equal(parseGenerated("not json at all"), null);
  });

  it("字段超长被截断、tags 上限 8 个", () => {
    const raw = JSON.stringify({
      name: "n".repeat(50),
      description: "d".repeat(200),
      systemPrompt: "s".repeat(10_000),
      tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
    });
    const out = parseGenerated(raw)!;
    assert.equal(out.name.length, 30);
    assert.equal(out.description.length, 80);
    assert.equal(out.systemPrompt.length, 4000);
    assert.equal(out.tags.length, 8);
  });
});
