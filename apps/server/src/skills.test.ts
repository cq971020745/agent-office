// skills.test.ts：SKILLS_DIR 在模块加载时基于 DATA_DIR 计算，先指到临时目录再动态导入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-skills-test-"));

const {
  buildSkillsPrompt,
  createSkill,
  deleteSkill,
  expandSkillArguments,
  expandSkillSlash,
  getAgentSkillBinding,
  getSkill,
  isValidSkillName,
  listSkills,
  parseSkillMd,
  readSkillResource,
  setAgentSkillBinding,
  updateSkill,
  writeSkillTool,
} = await import("./skills.js");
const { db, migrate } = await import("./db.js");
migrate();
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("parseSkillMd", () => {
  it("解析 frontmatter 与正文", () => {
    const parsed = parseSkillMd("---\nname: 周报\ndescription: 生成周报\n---\n\n# 正文\n内容");
    assert.equal(parsed.name, "周报");
    assert.equal(parsed.description, "生成周报");
    assert.ok(parsed.body.startsWith("# 正文"));
  });

  it("CRLF 换行同样可解析", () => {
    const parsed = parseSkillMd("---\r\nname: a\r\ndescription: d\r\n---\r\nbody");
    assert.equal(parsed.name, "a");
    assert.equal(parsed.description, "d");
    assert.equal(parsed.body, "body");
  });

  it("无 frontmatter 时整篇视为正文", () => {
    const parsed = parseSkillMd("# 纯正文");
    assert.equal(parsed.name, "");
    assert.equal(parsed.description, "");
    assert.equal(parsed.body, "# 纯正文");
  });

  it("frontmatter 值剥掉包裹引号", () => {
    const parsed = parseSkillMd('---\nname: "quoted"\ndescription: \'single\'\n---\nx');
    assert.equal(parsed.name, "quoted");
    assert.equal(parsed.description, "single");
  });

  it("解析 description: > / >- 多行块标量，而不是留下裸的 >", () => {
    const folded = parseSkillMd(
      "---\nname: agent-reach\ndescription: >\n  MUST USE when researching\n  on the internet.\n\n  Also for URLs.\nmetadata:\n  homepage: https://example.com\n---\n# body\n"
    );
    assert.equal(folded.description, "MUST USE when researching on the internet. Also for URLs.");
    assert.match(folded.body, /^# body/);

    const strip = parseSkillMd(
      "---\nname: skill-creator\ndescription: >-\n  对话创建技能。\n  先确认用途再落盘。\nargument-hint: [用途]\n---\nbody"
    );
    assert.equal(strip.description, "对话创建技能。 先确认用途再落盘。");
    assert.equal(strip.argumentHint, "[用途]");
  });

  it("解析扩展字段：argument-hint / user-invocable / alias / metadata / allowed-tools", () => {
    const parsed = parseSkillMd(
      "---\nname: 技能X\ndescription: d\nargument-hint: <主题>\nuser-invocable: true\nalias: xj, quick\nallowed-tools: read, write\nmetadata: { author: 张三, version: 2 }\n---\nbody"
    );
    assert.equal(parsed.argumentHint, "<主题>");
    assert.equal(parsed.userInvocable, true);
    assert.equal(parsed.alias, "xj, quick");
    assert.deepEqual(parsed.allowedTools, ["read", "write"]);
    assert.deepEqual(parsed.metadata, { author: "张三", version: "2" });
  });

  it("argument-hint 或 alias 存在时推断 user-invocable", () => {
    createSkill("隐式可调用", "d", "body", { argumentHint: "<参数>" });
    assert.equal(listSkills().find((s) => s.name === "隐式可调用")?.userInvocable, true);
    deleteSkill("隐式可调用");
  });
});

describe("isValidSkillName", () => {
  it("接受中文/字母/数字/中划线/下划线", () => {
    for (const ok of ["周报生成", "weekly-report", "skill_2", "Meeting纪要"]) {
      assert.equal(isValidSkillName(ok), true, ok);
    }
  });

  it("拒绝路径逃逸与非法字符", () => {
    for (const bad of ["../escape", "a/b", "a b", ".", "..", "a\\b", ""]) {
      assert.equal(isValidSkillName(bad), false, bad);
    }
  });
});

describe("技能 CRUD", () => {
  const NAME = `测试技能-${Date.now()}`;

  it("创建 → 列表 → 读取 → 更新 → 删除 全链路", () => {
    createSkill(NAME, "一句话描述", "# 正文\n第一步");
    assert.equal(listSkills().some((s) => s.name === NAME), true);

    const got = getSkill(NAME)!;
    assert.equal(got.description, "一句话描述");
    assert.ok(got.content.includes("第一步"));

    updateSkill(NAME, "更新后的描述", "# 新正文");
    assert.equal(getSkill(NAME)!.description, "更新后的描述");
    assert.ok(getSkill(NAME)!.content.includes("新正文"));

    assert.equal(deleteSkill(NAME), true);
    assert.equal(getSkill(NAME), undefined);
  });

  it("重名创建被拒绝", () => {
    createSkill("重名技能", "", "x");
    assert.throws(() => createSkill("重名技能", "", "y"), /同名/);
    deleteSkill("重名技能");
  });

  it("非法名创建被拒绝", () => {
    assert.throws(() => createSkill("../evil", "", "x"), /技能名/);
  });

  it("扩展 frontmatter 写入并保留：argument-hint/metadata/allowed-tools/alias", () => {
    createSkill("扩展字段技能", "d", "body", {
      argumentHint: "<输入>",
      alias: "kz",
      metadata: { author: "测试" },
      allowedTools: ["read"],
    });
    const got = getSkill("扩展字段技能")!;
    assert.equal(got.argumentHint, "<输入>");
    assert.equal(got.alias, "kz");
    assert.deepEqual(got.metadata, { author: "测试" });
    assert.deepEqual(got.allowedTools, ["read"]);
    assert.equal(got.userInvocable, true);

    // 更新不传 extras 时保留原扩展字段
    updateSkill("扩展字段技能", "d2", "body2");
    const kept = getSkill("扩展字段技能")!;
    assert.equal(kept.argumentHint, "<输入>");
    assert.deepEqual(kept.metadata, { author: "测试" });
    deleteSkill("扩展字段技能");
  });

  it("buildSkillsPrompt 只注入元数据清单（渐进披露，不含正文）", () => {
    createSkill("提示词技能", "一句话说明", "技能正文ABC", { argumentHint: "<输入>" });
    const prompt = buildSkillsPrompt();
    assert.ok(prompt.includes("提示词技能"), "清单应含技能名");
    assert.ok(prompt.includes("一句话说明"), "清单应含描述");
    assert.ok(prompt.includes("参数：<输入>"), "清单应含参数提示");
    assert.ok(prompt.includes("read_skill"), "清单应引导模型调用 read_skill");
    assert.ok(!prompt.includes("技能正文ABC"), "正文不进系统提示词");
    deleteSkill("提示词技能");
  });
});

describe("readSkillResource", () => {
  it("读取技能正文与目录内资源文件", () => {
    createSkill("资源技能", "d", "正文内容");
    fs.mkdirSync(path.join(process.env.DATA_DIR!, "agent", "skills", "资源技能", "references"), { recursive: true });
    fs.writeFileSync(path.join(process.env.DATA_DIR!, "agent", "skills", "资源技能", "references", "api.md"), "接口说明");
    assert.ok(readSkillResource("资源技能").includes("正文内容"));
    assert.equal(readSkillResource("资源技能", "references/api.md"), "接口说明");
    deleteSkill("资源技能");
  });

  it("越界路径被拒绝", () => {
    createSkill("越界技能", "d", "x");
    assert.throws(() => readSkillResource("越界技能", "../其他技能/SKILL.md"), /escapes/);
    assert.throws(() => readSkillResource("越界技能", "..\\..\\secrets.txt"), /escapes/);
    deleteSkill("越界技能");
  });

  it("不存在的资源文件报错", () => {
    createSkill("缺文件技能", "d", "x");
    assert.throws(() => readSkillResource("缺文件技能", "nope.md"), /file not found/);
    deleteSkill("缺文件技能");
  });
});

describe("expandSkillArguments / expandSkillSlash", () => {
  it("${1:-默认值} 与 $ARGUMENTS 替换", () => {
    assert.equal(expandSkillArguments("写${1:-周报}，要点：$ARGUMENTS", "销售条线"), "写销售条线，要点：销售条线");
    assert.equal(expandSkillArguments("写${1:-周报}", ""), "写周报");
  });

  it("斜杠命中：精确名 > 别名 > 唯一前缀；未命中返回原文", () => {
    createSkill("周报生成", "d", "本周重点：$ARGUMENTS", { argumentHint: "<主题>" });
    createSkill("数据解读", "d", "数据：$ARGUMENTS");

    assert.equal(expandSkillSlash("/周报生成 销售条线"), "本周重点：销售条线");
    assert.equal(expandSkillSlash("/周报生成"), "本周重点：");
    // 唯一前缀
    assert.equal(expandSkillSlash("/数据 人数"), "数据：人数");
    // 未命中（歧义前缀或不存在）
    assert.equal(expandSkillSlash("/不存在技能 x"), "/不存在技能 x");
    assert.equal(expandSkillSlash("普通提问"), "普通提问");
    assert.equal(expandSkillSlash("/每周5很多技能待定 x"), "/每周5很多技能待定 x");

    deleteSkill("周报生成");
    deleteSkill("数据解读");
  });

  it("正文无占位符时参数追加到末尾", () => {
    createSkill("无占位技能", "d", "直接照做");
    assert.equal(expandSkillSlash("/无占位技能 附加要求"), "直接照做\n\n用户参数：附加要求");
    deleteSkill("无占位技能");
  });
});

describe("专家技能绑定（agent_skills）", () => {
  it("绑定读写：无行 = undefined（用全部），有行 = 清单，空数组回到 undefined", () => {
    createSkill("绑定技能A", "d", "a");
    createSkill("绑定技能B", "d", "b");

    // agent_skills.agent_id 外键指向 agents(id)，先落一个真实专家
    const agentId = "agent-bind-test";
    db.prepare(
      "INSERT OR IGNORE INTO agents (id, name, description, system_prompt, provider_id, model_id, created_at) VALUES (?, ?, '', '', NULL, '', '2026-01-01')"
    ).run(agentId, "绑定测试专家");

    assert.equal(getAgentSkillBinding(agentId), undefined, "未配置 = undefined");

    setAgentSkillBinding(agentId, ["绑定技能A", "绑定技能A", "绑定技能B"]);
    assert.deepEqual(getAgentSkillBinding(agentId), ["绑定技能A", "绑定技能B"]);

    // 空数组 = 清空绑定行 = 回到「使用全部」
    setAgentSkillBinding(agentId, []);
    assert.equal(getAgentSkillBinding(agentId), undefined);

    // 不存在的技能名被过滤
    setAgentSkillBinding(agentId, ["绑定技能A", "不存在技能"]);
    assert.deepEqual(getAgentSkillBinding(agentId), ["绑定技能A"]);

    // 绑定后 buildSkillsPrompt 只含绑定的技能
    setAgentSkillBinding(agentId, ["绑定技能A"]);
    const prompt = buildSkillsPrompt(agentId);
    assert.ok(prompt.includes("绑定技能A"));
    assert.ok(!prompt.includes("绑定技能B"));
    // 其他专家（无绑定）仍能看到全部
    assert.ok(buildSkillsPrompt("other-agent").includes("绑定技能B"));

    deleteSkill("绑定技能A");
    deleteSkill("绑定技能B");
  });
});

describe("write_skill 工具", () => {
  const run = (params: Record<string, unknown>) => {
    const tool = writeSkillTool();
    const execute = tool.execute as (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    return execute("t", params);
  };

  it("写入技能库并支持附属文件；同名默认拒绝", async () => {
    const res = await run({
      name: "对话技能",
      description: "用对话写入的技能，用户提到对话创建时使用",
      content: "# 对话技能\n\n按步骤做。",
      files: [{ path: "references/note.md", content: "附注" }],
    });
    assert.match(res.content[0]?.text ?? "", /created skill 对话技能/);
    assert.ok(getSkill("对话技能")?.content.includes("按步骤做"));
    assert.match(
      fs.readFileSync(path.join(process.env.DATA_DIR!, "agent", "skills", "对话技能", "references", "note.md"), "utf8"),
      /附注/,
    );
    await assert.rejects(
      () => run({ name: "对话技能", description: "d", content: "x" }),
      /已存在/,
    );
    await run({
      name: "对话技能",
      description: "覆盖后的描述，用户提到覆盖时使用",
      content: "新正文",
      overwrite: true,
    });
    assert.match(getSkill("对话技能")!.content, /新正文/);
    deleteSkill("对话技能");
  });

  it("拒绝逃出技能目录的附属路径", async () => {
    await assert.rejects(
      () =>
        run({
          name: "坏路径技能",
          description: "d 用于测试路径",
          content: "body",
          files: [{ path: "../evil.md", content: "x" }],
        }),
      /escapes|附属文件/,
    );
    assert.equal(getSkill("坏路径技能"), undefined);
  });
});
