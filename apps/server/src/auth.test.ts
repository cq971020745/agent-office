// auth.test.ts 在导入 auth.js（连带 db.js 打开 SQLite）前，把 DATA_DIR 指到临时目录，
// 避免测试污染开发数据卷。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-auth-test-"));

const { hashPassword, verifyPassword } = await import("./auth.js");
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("密码哈希", () => {
  it("正确密码校验通过", () => {
    const stored = hashPassword("s3cret-密码");
    assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
    assert.equal(verifyPassword("s3cret-密码", stored), true);
  });

  it("错误密码校验失败", () => {
    const stored = hashPassword("correct");
    assert.equal(verifyPassword("wrong", stored), false);
  });

  it("同密码两次加盐产生不同哈希", () => {
    assert.notEqual(hashPassword("same"), hashPassword("same"));
  });

  it("畸形存储串安全返回 false 而不是抛错", () => {
    assert.equal(verifyPassword("x", ""), false);
    assert.equal(verifyPassword("x", "no-colon"), false);
    assert.equal(verifyPassword("x", "salt:not-hex!"), false);
  });
});
