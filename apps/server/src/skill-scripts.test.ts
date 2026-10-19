// skill-scripts.test.ts：run_skill_script 的路径越狱防护、扩展名限制与环境注入。
// SKILLS_DIR 在模块加载时基于 DATA_DIR 计算，先指到临时目录再动态导入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skillscripts-test-"));
process.env.DATA_DIR = tmp;
delete process.env.WPS_SID;
delete process.env.WPS_PYTHON;

// 造一个假技能：脚本打印收到的 WPS_SID 环境值，用于验证 env 注入
const skillDir = path.join(tmp, "agent", "skills", "demo-skill");
fs.mkdirSync(path.join(skillDir, "skills", "demo"), { recursive: true });
fs.writeFileSync(
  path.join(skillDir, "skills", "demo", "run.py"),
  ["import os, sys", "print('SID=' + os.environ.get('WPS_SID', ''))", "print('ARG=' + sys.argv[1] if len(sys.argv) > 1 else 'ARG=')"].join("\n")
);
// 隐藏目录越界脚本（skills.ts 的 readSkillResource 不拦目录符号链接之类，这里只测工具自身约束）
fs.writeFileSync(path.join(skillDir, "evil.txt"), "print('nope')");

const { extractLastJsonBlock, runSkillScript, skillScriptTool } = await import("./skill-scripts.js");
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("extractLastJsonBlock", () => {
  it("取最后一个 ```json 围栏块并解析", () => {
    const md = '说明文字\n```json\n{"a":1}\n```\n结尾\n```json\n{"b":[2]}\n```';
    assert.deepEqual(extractLastJsonBlock(md), { b: [2] });
  });

  it("无围栏或坏 JSON 返回 null", () => {
    assert.equal(extractLastJsonBlock("没有任何围栏"), null);
    assert.equal(extractLastJsonBlock("```json\n{broken\n```"), null);
  });
});

describe("runSkillScript", () => {
  it("执行技能内脚本并注入 WPS 环境变量", async () => {
    process.env.WPS_SID = "test-sid-not-a-secret-marker";
    try {
      const res = await runSkillScript("demo-skill", "skills/demo/run.py", ["hello"], 30_000);
      assert.ok(res.stdout.includes("SID=test-sid-not-a-secret-marker"));
      assert.ok(res.stdout.includes("ARG=hello"));
    } finally {
      delete process.env.WPS_SID;
    }
  });

  it("拒绝路径越狱", async () => {
    await assert.rejects(() => runSkillScript("demo-skill", "../../etc/passwd.py"), /技能目录|脚本不存在/);
    await assert.rejects(() => runSkillScript("demo-skill", "..\\..\\x.py"), /技能目录|脚本不存在/);
  });

  it("拒绝非 .py 文件与非法技能名", async () => {
    await assert.rejects(() => runSkillScript("demo-skill", "evil.txt"), /\.py/);
    await assert.rejects(() => runSkillScript("../outside", "run.py"), /技能名不合法/);
  });

  it("脚本不存在时报可读错误", async () => {
    await assert.rejects(() => runSkillScript("demo-skill", "skills/demo/missing.py"), /脚本不存在/);
  });

  it("envOverride 压过进程环境（ensure --refresh 重导后边车优先重试的场景）", async () => {
    process.env.WPS_SID = "stale-env-sid";
    try {
      const res = await runSkillScript("demo-skill", "skills/demo/run.py", [], 30_000, undefined, {
        WPS_SID: "fresh-sidecar-sid",
      });
      assert.ok(res.stdout.includes("SID=fresh-sidecar-sid"));
    } finally {
      delete process.env.WPS_SID;
    }
  });

  it("子进程屏蔽 Python 警告噪音（macOS LibreSSL + urllib3 v2 的 NotOpenSSLWarning）", async () => {
    fs.writeFileSync(path.join(skillDir, "skills", "demo", "warn.py"), "import warnings\nwarnings.warn('noise')\nprint('done')");
    const res = await runSkillScript("demo-skill", "skills/demo/warn.py", [], 30_000);
    assert.equal(res.stderr, "");
  });
});

describe("skillScriptTool", () => {
  it("工具定义名为 run_skill_script 且带参数校验 schema", () => {
    const tool = skillScriptTool();
    assert.equal(tool.name, "run_skill_script");
    assert.ok(tool.description.includes("read_skill"));
    assert.ok(tool.parameters);
  });
});
