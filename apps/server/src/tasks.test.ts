// tasks.test.ts 在导入 routes/tasks.js（连带 db.js 打开 SQLite）前，把 DATA_DIR 指到临时目录。
// 附件相关的纯函数测试在 uploads.test.ts（无需 DATA_DIR）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-tasks-test-"));

const { parseListParams, buildTaskListWhere } = await import("./routes/tasks.js");
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("parseListParams", () => {
  it("缺省值：limit=50 offset=0 无 status/q", () => {
    assert.deepEqual(parseListParams({}), { limit: 50, offset: 0, status: undefined, q: undefined });
  });

  it("limit 夹在 1..200，非法数字回退默认", () => {
    assert.equal(parseListParams({ limit: "0" }).limit, 1);
    assert.equal(parseListParams({ limit: "999" }).limit, 200);
    assert.equal(parseListParams({ limit: "abc" }).limit, 50);
    assert.equal(parseListParams({ limit: "10" }).limit, 10);
  });

  it("offset 非负，负数归零", () => {
    assert.equal(parseListParams({ offset: "-5" }).offset, 0);
    assert.equal(parseListParams({ offset: "120" }).offset, 120);
  });

  it("非法 status 与空 q 被忽略", () => {
    const p = parseListParams({ status: "hacked", q: "   " });
    assert.equal(p.status, undefined);
    assert.equal(p.q, undefined);
    assert.equal(parseListParams({ status: "completed", q: " 周报 " }).status, "completed");
    assert.equal(parseListParams({ status: "completed", q: " 周报 " }).q, "周报");
  });
});

describe("buildTaskListWhere", () => {
  it("成员始终带 user_id 范围", () => {
    const { whereSql, args } = buildTaskListWhere("u1", false, {});
    assert.equal(whereSql, "WHERE t.user_id = ?");
    assert.deepEqual(args, ["u1"]);
  });

  it("管理员无范围", () => {
    assert.equal(buildTaskListWhere("u1", true, {}).whereSql, "");
  });

  it("running 桶覆盖 pending+running", () => {
    const { whereSql, args } = buildTaskListWhere("u1", true, { status: "running" });
    assert.match(whereSql, /t\.status IN \(\?, \?\)/);
    assert.deepEqual(args, ["pending", "running"]);
  });

  it("关键词对 title 和 prompt 做 LIKE（转义 % 与 _）", () => {
    const { whereSql, args } = buildTaskListWhere("u1", true, { q: "50%_off" });
    assert.match(whereSql, /t\.title LIKE \? ESCAPE/);
    assert.match(whereSql, /t\.prompt LIKE \? ESCAPE/);
    assert.deepEqual(args, ["%50\\%\\_off%", "%50\\%\\_off%"]);
  });

  it("组合条件 AND 连接", () => {
    const { whereSql, args } = buildTaskListWhere("u1", false, { status: "completed", q: "周报" });
    assert.match(whereSql, /^WHERE t\.user_id = \? AND t\.status IN/);
    assert.equal(args.length, 4);
  });
});
