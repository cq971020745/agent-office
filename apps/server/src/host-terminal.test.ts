import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-terminal-test-"));

const { buildTerminalEnv, createHostTerminalTool, dangerousCommandReason } = await import("./host-terminal.js");
const { buildPreamble } = await import("./runner.js");

describe("buildTerminalEnv", () => {
  it("保留 PATH 和用户目录，去掉服务端秘密", () => {
    const env = buildTerminalEnv({
      PATH: "C:\\Windows\\System32",
      Path: "C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
      TEMP: "C:\\Temp",
      JWT_SECRET: "super-secret",
      WPS_SID: "wps-session",
      OPENAI_API_KEY: "sk-test",
      DATA_DIR: "D:\\secret-data",
    });
    assert.equal(env.PATH, "C:\\Windows\\System32");
    assert.equal(env.USERPROFILE, "C:\\Users\\me");
    assert.equal(env.TEMP, "C:\\Temp");
    assert.equal(env.JWT_SECRET, undefined);
    assert.equal(env.WPS_SID, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.DATA_DIR, undefined);
  });
});

describe("dangerousCommandReason", () => {
  it("拦截格式化磁盘和递归删除盘根，放行普通目录命令", () => {
    assert.equal(dangerousCommandReason("Get-ChildItem ."), undefined);
    assert.equal(dangerousCommandReason("format C: /y"), "格式化磁盘");
    assert.match(dangerousCommandReason("rm -rf /") ?? "", /递归删除/);
    assert.equal(dangerousCommandReason("shutdown /s /t 0"), "关机/重启");
  });
});

describe("buildPreamble", () => {
  it("说明宿主终端和文档解析，并在有 Docker 时保留沙箱计算", () => {
    const withDocker = buildPreamble(false, true, true, false);
    assert.match(withDocker, /terminal tool/);
    assert.match(withDocker, /doc_to_md/);
    assert.match(withDocker, /ocr_to_md/);
    assert.match(withDocker, /web_search/);
    assert.match(withDocker, /fetch_content/);
    assert.match(withDocker, /run_code tool/);
    assert.doesNotMatch(withDocker, /no shell access/);
    assert.match(withDocker, /uploaded attachments/);

    const withoutDocker = buildPreamble(true, false, false, false);
    assert.match(withoutDocker, /terminal tool/);
    assert.doesNotMatch(withoutDocker, /run_code tool/);
  });
});

describe("createHostTerminalTool", () => {
  it("工具名固定为 terminal，并在工作区执行无副作用命令", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-terminal-cwd-"));
    const tool = createHostTerminalTool(root);
    assert.equal(tool.name, "terminal");
    const command = process.platform === "win32" ? "Write-Output 'terminal-ok'" : "printf 'terminal-ok\\n'";
    const res = await tool.execute!("test-id", { command }, undefined, undefined, undefined as never);
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /terminal-ok/);
  });

  it("执行前拦截格式化磁盘", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-terminal-guard-"));
    const tool = createHostTerminalTool(root);
    await assert.rejects(
      () => tool.execute!("test-id", { command: "format C: /y" }, undefined, undefined, undefined as never),
      /格式化磁盘/
    );
  });
});
