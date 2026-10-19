// wps-env-gate.test.ts：会话失效识别与警告噪音清洗（纯函数；不执行环境脚本本身）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-wpsgate-test-"));

const { isWpsSessionError, stripWarningNoise } = await import("./wps-env-gate.js");
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// 同事 mac 上的原始报错：urllib3 警告 + 网关 401（msg 自带拼写错误 "not fount"）
const MAC_401 = [
  "/Users/tao/Library/Python/3.9/lib/python/site-packages/urllib3/__init__.py:35: NotOpenSSLWarning: urllib3 v2 only supports OpenSSL 1.1.1+, currently the 'ssl' module is compiled with 'LibreSSL 2.8.3'",
  '## 错误 url:http://docmini-dc-gateway/accounts/u/v1/session/info; status_code: 401; response_body: {"code":401001003,"msg":"not fount session {sid:V01***...585}"}',
].join("\n");

describe("isWpsSessionError", () => {
  it("识别网关 401 会话失效报错", () => {
    assert.ok(isWpsSessionError(MAC_401));
  });

  it("识别 403、401001003 与 found 变体", () => {
    assert.ok(isWpsSessionError("status_code: 403"));
    assert.ok(isWpsSessionError("响应 code=401001003"));
    assert.ok(isWpsSessionError('msg: "not found session"'));
  });

  it("普通错误不误判", () => {
    assert.ok(!isWpsSessionError("脚本执行超时（>30s）"));
    assert.ok(!isWpsSessionError("get-root-dept 未返回根部门 id"));
  });
});

describe("stripWarningNoise", () => {
  it("剥掉 urllib3 警告行，保留错误正文", () => {
    const out = stripWarningNoise(MAC_401);
    assert.ok(!out.includes("NotOpenSSLWarning"));
    assert.ok(out.startsWith("## 错误"));
  });

  it("无警告时原样返回", () => {
    assert.equal(stripWarningNoise("## 错误\n\nboom"), "## 错误\n\nboom");
  });
});
