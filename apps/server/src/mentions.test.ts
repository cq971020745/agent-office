// mentions.test.ts：@ 引用的净化与提示词注入（纯函数，无 DB 依赖）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildMentionsNote, parseMentionsField, sanitizeMentions } = await import("./mentions.js");

describe("sanitizeMentions", () => {
  it("保留合法条目并剥掉多余字段", () => {
    const out = sanitizeMentions([{ type: "contact", id: "1721", name: "李旭", extra: "x" }]);
    assert.deepEqual(out, [{ type: "contact", id: "1721", name: "李旭" }]);
  });

  it("拒绝未知类型与空 id/名称", () => {
    assert.deepEqual(sanitizeMentions([{ type: "bogus", id: "1", name: "a" }]), []);
    assert.deepEqual(sanitizeMentions([{ type: "chat", id: "", name: "a" }]), []);
    assert.deepEqual(sanitizeMentions([{ type: "chat", id: "1", name: "  " }]), []);
    assert.deepEqual(sanitizeMentions(["x", null, 42]), []);
  });

  it("按 type:id 去重并截断到 20 条", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ type: "chat", id: String(i), name: `群${i}` }));
    items.push({ type: "chat", id: "1", name: "重复" });
    const out = sanitizeMentions(items);
    assert.equal(out.length, 20);
    assert.equal(out.filter((m) => m.id === "1").length, 1);
  });
});

describe("parseMentionsField", () => {
  it("解析 multipart JSON 字符串字段", () => {
    assert.deepEqual(parseMentionsField('[{"type":"chat","id":"294899","name":"AI小组测试群"}]'), [
      { type: "chat", id: "294899", name: "AI小组测试群" },
    ]);
  });

  it("空值与坏 JSON 按空处理", () => {
    assert.deepEqual(parseMentionsField(undefined), []);
    assert.deepEqual(parseMentionsField(""), []);
    assert.deepEqual(parseMentionsField("not json"), []);
  });
});

describe("buildMentionsNote", () => {
  it("空列表返回空串（不污染无 @ 的任务）", () => {
    assert.equal(buildMentionsNote([]), "");
  });

  it("按类型标注 id 字段名并给出 skill 用法指引", () => {
    const note = buildMentionsNote([
      { type: "contact", id: "1721", name: "李旭" },
      { type: "chat", id: "294899", name: "AI小组测试群" },
      { type: "doc", id: "388007051984896", name: "创投尽调.docx" },
    ]);
    assert.ok(note.includes("<wps_mentions>"));
    assert.ok(note.includes("[联系人] 李旭（user_id: 1721）"));
    assert.ok(note.includes("[群聊] AI小组测试群（chat_id: 294899）"));
    assert.ok(note.includes("[云文档] 创投尽调.docx（file_id: 388007051984896）"));
    assert.ok(note.includes("read_skill 加载 wps365-skill"));
    assert.ok(note.includes("run_skill_script"));
  });

  it("知识库引用补充召回动线（space_id 即 drive_id），无知识库时不追加", () => {
    const withKb = buildMentionsNote([{ type: "kb", id: "164011", name: "陈强的团队" }]);
    assert.ok(withKb.includes("[知识库] 陈强的团队（space_id: 164011）"));
    assert.ok(withKb.includes("ai-docs recall"));
    assert.ok(withKb.includes("--drive-id <space_id>"));
    const noKb = buildMentionsNote([{ type: "doc", id: "1", name: "a.docx" }]);
    assert.ok(!noKb.includes("ai-docs recall"));
  });
});
