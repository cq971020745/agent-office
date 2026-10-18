import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const { assertInWorkspace, truncateForContext, workspaceTools } = await import("./tools.js");

describe("truncateForContext", () => {
  it("短文本原样返回", () => {
    assert.equal(truncateForContext("hello"), "hello");
  });

  it("超过 2000 行时截断并附说明", () => {
    const text = Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n");
    const out = truncateForContext(text);
    assert.ok(out.includes("[truncated: showing first 2000 of 2500 lines]"));
    assert.ok(out.startsWith("line-0"));
  });

  it("超过 50KB 时截断", () => {
    const out = truncateForContext("x".repeat(60_000));
    assert.ok(out.includes("[truncated: output exceeds 50KB]"));
    assert.ok(out.length < 60_000);
  });
});

describe("assertInWorkspace", () => {
  const root = path.join(os.tmpdir(), "office-jail-root");

  it("工作区内相对路径正常解析", () => {
    assert.equal(assertInWorkspace(root, "a/b.txt"), path.resolve(root, "a/b.txt"));
  });

  it("../ 逃逸被拒绝", () => {
    assert.throws(() => assertInWorkspace(root, "../escape.txt"), /escapes the task workspace/);
  });

  it("前缀相似但越界的目录被拒绝（root vs root2）", () => {
    assert.throws(() => assertInWorkspace(root, path.join("..", `${path.basename(root)}2`, "f.txt")), /escapes/);
  });

  it("路径恰好等于工作区根时允许", () => {
    assert.equal(assertInWorkspace(root, "."), path.resolve(root));
  });
});

describe("workspaceTools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-test-"));
  const tools = new Map(workspaceTools(root).map((t) => [t.name, t]));

  // pi 的 execute 签名为 (id, params, signal, onUpdate, ctx)；单测只关心前两个
  const call = (name: string, params: unknown) => {
    const tool = tools.get(name)!;
    return tool.execute!("test-id", params as never, undefined, undefined, undefined as never);
  };

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("workspace_write 写入并自动建父目录", async () => {
    const res = await call("workspace_write", { path: "sub/dir/a.txt", content: "内容A" });
    assert.match((res.content[0] as { text: string }).text, /wrote sub\/dir\/a\.txt/);
    assert.equal(fs.readFileSync(path.join(root, "sub/dir/a.txt"), "utf8"), "内容A");
  });

  it("workspace_list 列出文件并隐藏点文件", async () => {
    fs.writeFileSync(path.join(root, ".hidden"), "x");
    fs.mkdirSync(path.join(root, "folder"), { recursive: true });
    const res = await call("workspace_list", {});
    const text = (res.content[0] as { text: string }).text;
    assert.ok(text.includes("sub/"), `实际输出：${text}`);
    assert.ok(text.includes("folder/"));
    assert.ok(!text.includes(".hidden"));
  });

  it("workspace_read 读取文件内容", async () => {
    const res = await call("workspace_read", { path: "sub/dir/a.txt" });
    assert.equal((res.content[0] as { text: string }).text, "内容A");
  });

  it("workspace_read 拒绝越界路径", async () => {
    await assert.rejects(() => call("workspace_read", { path: "../../etc/passwd" }), /escapes/);
  });

  it("workspace_read 拒绝二进制并把 OLE2 伪 docx 复制成隐藏 doc", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    fs.writeFileSync(path.join(root, "合同.docx"), ole);
    const res = await call("workspace_read", { path: "合同.docx" });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /doc_to_md/);
    assert.match(text, /\.parsed\/合同\.doc/);
    assert.ok(fs.existsSync(path.join(root, ".parsed", "合同.doc")));
    assert.ok(!text.includes("\uFFFD") && !text.includes("D0CF"), "不应把二进制当文本吐出");
    assert.equal(fs.readFileSync(path.join(root, "合同.docx")).equals(ole), true);
  });

  it("workspace_read 对图片指向 ocr_to_md，对 PDF 同时提示扫描件走 OCR", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(path.join(root, "扫描.png"), png);
    const image = await call("workspace_read", { path: "扫描.png" });
    const imageText = (image.content[0] as { text: string }).text;
    assert.match(imageText, /ocr_to_md/);
    assert.doesNotMatch(imageText, /doc_to_md/);

    fs.writeFileSync(path.join(root, "报告.pdf"), Buffer.from("%PDF-1.4 mock"));
    const pdf = await call("workspace_read", { path: "报告.pdf" });
    const pdfText = (pdf.content[0] as { text: string }).text;
    assert.match(pdfText, /doc_to_md/);
    assert.match(pdfText, /ocr_to_md/);
  });

  it("workspace_edit 精确局部替换并拒绝未命中的 oldText", async () => {
    await call("workspace_write", { path: "doc.md", content: "第一段\n旧内容\n第三段" });
    const res = await call("workspace_edit", { path: "doc.md", oldText: "旧内容", newText: "新内容" });
    assert.match((res.content[0] as { text: string }).text, /edited doc\.md/);
    assert.equal(fs.readFileSync(path.join(root, "doc.md"), "utf8"), "第一段\n新内容\n第三段");
    await assert.rejects(
      () => call("workspace_edit", { path: "doc.md", oldText: "不存在的片段", newText: "x" }),
      /oldText not found/
    );
  });

  it("transcribe_audio 拒绝非音频后缀文件", async () => {
    await assert.rejects(() => call("transcribe_audio", { path: "doc.md" }), /unsupported audio extension/);
  });

  it("fetch_url 拒绝非 http(s) 协议", async () => {
    await assert.rejects(() => call("fetch_url", { url: "file:///etc/passwd" }), /only http\(s\) URLs are allowed/);
    await assert.rejects(() => call("fetch_url", { url: "ftp://example.com/x" }), /only http\(s\) URLs are allowed/);
  });

  it("fetch_url 拒绝无法解析的 URL", async () => {
    await assert.rejects(() => call("fetch_url", { url: "not-a-url" }), /invalid url/);
  });

  it("fetch_url 抓取 http 服务并剥离 HTML 标签", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.end("<html><body><h1>你好</h1><script>alert(1)</script></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await call("fetch_url", { url: `http://127.0.0.1:${port}/` });
      const text = (res.content[0] as { text: string }).text;
      assert.ok(text.includes("你好"));
      assert.ok(!text.includes("alert(1)"), "script 内容应被剥离");
      assert.ok(!text.includes("<h1>"), "HTML 标签应被剥离");
    } finally {
      server.close();
    }
  });
});
