// uploads.ts 是纯文件/字符串操作模块（不依赖 db），测试无需 DATA_DIR。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, sanitizeUploadName, uniqueTargetPath, withAttachmentNote } from "./uploads.js";

describe("sanitizeUploadName", () => {
  it("保留普通文件名", () => {
    assert.equal(sanitizeUploadName("周报数据.xlsx"), "周报数据.xlsx");
  });

  it("剥离路径部分（含 Windows 反斜杠）", () => {
    assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeUploadName("C:\\Users\\x\\a.txt"), "a.txt");
  });

  it("去掉前导点与控制字符", () => {
    assert.equal(sanitizeUploadName("..hidden"), "hidden");
    assert.equal(sanitizeUploadName("a\u0000b\u001f.txt"), "ab.txt");
  });

  it("空名/全点名回退默认", () => {
    assert.equal(sanitizeUploadName(""), "附件");
    assert.equal(sanitizeUploadName("..."), "附件");
    assert.equal(sanitizeUploadName("  "), "附件");
  });

  it("超长名截到 120 字符", () => {
    const long = `${"很".repeat(200)}.txt`;
    assert.ok(sanitizeUploadName(long).length <= 120);
  });
});

describe("uniqueTargetPath", () => {
  it("目录里没有同名文件时原样返回", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-upload-test-"));
    try {
      assert.equal(path.basename(uniqueTargetPath(dir, "a.txt")), "a.txt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重名自动追加序号不覆盖", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-upload-test-"));
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      assert.equal(path.basename(uniqueTargetPath(dir, "a.txt")), "a-1.txt");
      fs.writeFileSync(path.join(dir, "a-1.txt"), "2");
      assert.equal(path.basename(uniqueTargetPath(dir, "a.txt")), "a-2.txt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无扩展名文件同样适用", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-upload-test-"));
    try {
      fs.writeFileSync(path.join(dir, "Makefile"), "1");
      assert.equal(path.basename(uniqueTargetPath(dir, "Makefile")), "Makefile-1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withAttachmentNote", () => {
  it("无附件时原样返回", () => {
    assert.equal(withAttachmentNote("帮我写周报", []), "帮我写周报");
  });

  it("有附件时在原文后追加清单（含数量与大小）", () => {
    const out = withAttachmentNote("分析这份数据", [
      { filename: "data.csv", size: 2048 },
      { filename: "说明.md", size: 300 },
    ]);
    assert.ok(out.startsWith("分析这份数据"), "应以用户原文开头");
    assert.match(out, /附带 2 个附件/);
    assert.match(out, /- data\.csv（2KB）/);
    assert.match(out, /- 说明\.md（300B）/);
    assert.match(out, /workspace_read/);
  });
});

describe("formatBytes", () => {
  it("按量级选择单位", () => {
    assert.equal(formatBytes(0), "0B");
    assert.equal(formatBytes(512), "512B");
    assert.equal(formatBytes(2048), "2KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0MB");
  });
});
