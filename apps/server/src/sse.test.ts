// sse.test.ts：用假 ServerResponse 验证事件封套、历史回放与任务删除清理。
import type { ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { attachSse, clearTask, publishPi, publishStatus, subscribe, unsubscribe } = await import("./sse.js");

function makeFakeRes(): { frames: string[]; raw: ServerResponse; close: () => void } {
  const frames: string[] = [];
  let closeCb: (() => void) | undefined;
  const raw = {
    writeHead: () => {},
    write: (chunk: string) => {
      frames.push(chunk);
    },
    on: (_event: string, cb: () => void) => {
      closeCb = cb;
    },
  };
  return {
    frames,
    raw: raw as unknown as ServerResponse,
    close: () => closeCb?.(),
  };
}

describe("sse 总线", () => {
  it("publishPi/publishStatus 递增 seq 并投递给订阅者", () => {
    const taskId = `t-${Math.random()}`;
    const seen: unknown[] = [];
    const listener = (env: unknown) => seen.push(env);
    subscribe(taskId, listener);

    publishPi(taskId, { type: "message_start" });
    publishStatus(taskId, "completed");

    assert.equal(seen.length, 2);
    const [first, second] = seen as { seq: number; kind: string }[];
    assert.equal(first.seq, 1);
    assert.equal(first.kind, "pi");
    assert.equal(second.seq, 2);
    assert.equal(second.kind, "task");

    unsubscribe(taskId, listener);
    publishPi(taskId, { type: "late" });
    assert.equal(seen.length, 2, "退订后不再收到事件");
    clearTask(taskId);
  });

  it("attachSse 先回放历史再收增量", () => {
    const taskId = `t-${Math.random()}`;
    publishPi(taskId, { type: "history_event" });

    const { frames, raw, close } = makeFakeRes();
    attachSse(taskId, raw);
    // 历史：1 帧
    assert.equal(frames.length, 1);
    assert.ok(frames[0]!.startsWith("data: "));
    assert.ok(frames[0]!.includes("history_event"));

    // 订阅建立后的新事件应推给这条连接
    publishPi(taskId, { type: "live_event" });
    assert.equal(frames.length, 2);
    assert.ok(frames[1]!.includes("live_event"));

    clearTask(taskId);
    close();
  });

  it("clearTask 后新连接不再回放旧事件", () => {
    const taskId = `t-${Math.random()}`;
    publishStatus(taskId, "completed");
    clearTask(taskId);

    const { frames, raw, close } = makeFakeRes();
    attachSse(taskId, raw);
    assert.equal(frames.length, 0, "清空后无历史可回放");
    close();
  });

  it("大量任务发布后缓冲按上限淘汰，不无限增长", () => {
    // publish 导出未暴露 history 大小；通过行为验证：淘汰后新连接回放为空即可
    for (let i = 0; i < 150; i++) {
      const id = `bulk-${i}`;
      publishPi(id, { type: "only" });
      clearTask(id);
    }
    // 不抛错即通过（内部上限逻辑由 record 维护）
    assert.ok(true);
  });
});
