import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createdAtAfter,
  mergePartial,
  partialTranscript,
  transcriptsFromSessionEntries,
  withInterruptNote,
} from "./turn-transcript.js";

function assistant(text: string, tools: Array<{ name: string; arguments?: Record<string, unknown> }> = [], thinking = "") {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        ...(thinking ? [{ type: "thinking", thinking }] : []),
        ...(text ? [{ type: "text", text }] : []),
        ...tools.map((tool) => ({ type: "toolCall", name: tool.name, arguments: tool.arguments ?? {} })),
      ],
    },
  };
}

function user(text: string) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

describe("transcriptsFromSessionEntries", () => {
  it("同一轮里的多次工具调用并成一条回复，三轮问句不会粘在一起", () => {
    const turns = transcriptsFromSessionEntries([
      user("看下本项目，给我一个架构图"),
      assistant("", [{ name: "todo", arguments: { text: "梳理目录" } }, { name: "workspace_list" }], "先看目录"),
      assistant("主干已经清楚。", [{ name: "workspace_read", arguments: { path: "README.md" } }]),
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "忽略" }] } },
      user("看下本项目，给我一个架构图"),
      assistant("资料齐了。", [{ name: "workspace_read", arguments: { path: "frontend/package.json" } }]),
      user("看下本项目，给我一个架构图"),
      assistant("现在写架构图。", [{ name: "todo", arguments: { action: "add", text: "绘制架构图.svg" } }], "开始写文件"),
    ]);
    assert.equal(turns.length, 3);
    assert.match(turns[0]!.text, /主干已经清楚/);
    assert.equal(turns[0]!.steps[0]?.tool, "todo");
    assert.equal(turns[0]!.steps[0]?.detail, "梳理目录");
    assert.equal(turns[0]!.steps[2]?.detail, "README.md");
    assert.equal(turns[1]!.text, "资料齐了。");
    assert.equal(turns[2]!.steps[0]?.detail, "绘制架构图.svg");
    assert.match(turns[2]!.thinking, /开始写文件/);
  });

  it("本轮新增消息不含上一轮已经落库的回复", () => {
    const messages = [
      { role: "user", content: "上一问" },
      { role: "assistant", content: [{ type: "text", text: "上一答" }] },
      { role: "user", content: "这一问" },
      { role: "assistant", content: [{ type: "text", text: "写到一半" }] },
    ];
    const partial = partialTranscript(messages, 2);
    assert.equal(partial.text, "写到一半");
    assert.doesNotMatch(partial.text, /上一答/);
  });
});

describe("mergePartial / withInterruptNote", () => {
  it("思考留更长的那份，工具步骤沿用带失败状态的轨迹", () => {
    const merged = mergePartial(
      { text: "半成品", thinking: "短", steps: [{ tool: "todo", status: "done" }] },
      { thinking: "这是一段更长的实时思考", steps: [{ tool: "todo", status: "error" }] }
    );
    assert.equal(merged.thinking, "这是一段更长的实时思考");
    assert.equal(merged.steps[0]?.status, "error");
    assert.equal(withInterruptNote(merged.text, "本轮已打断。"), "半成品\n\n本轮已打断。");
    assert.equal(withInterruptNote("", "本轮已打断。"), "本轮已打断。");
  });
});

describe("createdAtAfter", () => {
  it("回补时间严格落在两条问句之间", () => {
    const prev = "2026-10-16T03:15:30.591Z";
    const next = "2026-10-16T03:20:46.798Z";
    const at = createdAtAfter(prev, next);
    assert.ok(Date.parse(at) > Date.parse(prev));
    assert.ok(Date.parse(at) < Date.parse(next));
  });

  it("没有下一问时比当前问句晚 1 毫秒", () => {
    const prev = "2026-10-16T03:26:44.004Z";
    assert.equal(createdAtAfter(prev), "2026-10-16T03:26:44.005Z");
  });
});
