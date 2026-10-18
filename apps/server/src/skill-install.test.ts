import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// DATA_DIR 必须在动态导入 db/config 之前就绪：db.ts 模块加载即打开数据库文件
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-skill-install-"));
process.env.DATA_DIR = dataDir;

const { installSkillFromSource, installSkillFromZipBuffer, syncSkill, getSourceInfo, listBuiltinSkills, removeSkillSource, syncHomeAgentsSkills } = await import("./skill-install.js");
const { zipFiles } = await import("./zip-pack.js");
const { listSkills, getSkill, skillExists, deleteSkill, buildSkillsPrompt, setAgentSkillBinding, readSkillResource } = await import("./skills.js");
const { listBuiltinPacks, normalizeAgentPackage, readBuiltinPack, buildAgentPackage, installPackageSkills, installExpertSkills } = await import("./agent-packs.js");
const { db, uuid, now } = await import("./db.js");
const { migrate } = await import("./db.js");
migrate();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// 各测试共用的来源临时目录（describe 内也会用到）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-skill-src-"));

function makeSkillDir(root: string, name: string, content: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}的描述\n---\n\n${content}\n`,
    "utf8",
  );
  return dir;
}

describe("skill-install：技能安装与同步", () => {
  it("内置目录安装：登记来源为 builtin:<id>，可从市场列表看到", async () => {
    process.env.SKILLS_CATALOG_DIR = path.join(repoRoot, "skills-catalog");
    const out = await installSkillFromSource("邮件回复");
    assert.deepEqual(out.names, ["邮件回复"]);
    assert.equal(out.kind, "builtin");
    assert.equal(out.source, "builtin:邮件回复");
    assert.ok(skillExists("邮件回复"));
    const info = getSourceInfo("邮件回复");
    assert.equal(info?.kind, "builtin");
    assert.ok(info?.syncedAt);
    const catalog = listBuiltinSkills();
    const entry = catalog.find((c) => c.id === "邮件回复");
    assert.ok(entry?.installed);
    assert.ok(catalog.length >= 4);

    // 同步：登记来源 builtin:<id> 带前缀也能重拉
    const out2 = await syncSkill("邮件回复");
    assert.equal(out2.kind, "builtin");
    assert.ok(out2.updated.includes("邮件回复"));
  });

  it("本机目录安装：单技能（frontmatter 命名）+ 多技能合集（子目录扫描）", async () => {
    const single = makeSkillDir(tmp, "本地单技能", "内容");
    const out1 = await installSkillFromSource(single);
    assert.deepEqual(out1.names, ["本地单技能"]);
    assert.equal(out1.kind, "local");

    const multi = path.join(tmp, "技能合集");
    makeSkillDir(multi, "技能甲", "甲的内容");
    makeSkillDir(multi, "技能乙", "乙的内容");
    const out2 = await installSkillFromSource(multi);
    assert.deepEqual([...out2.names].sort(), ["技能乙", "技能甲"]);
    assert.equal(getSkill("技能甲")?.description, "技能甲的描述");
  });

  it("同名冲突默认拒绝；overwrite 覆盖后内容更新", async () => {
    const dir = makeSkillDir(path.join(tmp, "conflict-src"), "冲突技能", "版本一");
    await installSkillFromSource(dir);
    await assert.rejects(() => installSkillFromSource(dir), /已存在/);
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: 冲突技能\ndescription: 冲突技能\n---\n\n版本二\n",
      "utf8",
    );
    const out = await installSkillFromSource(dir, { overwrite: true });
    assert.deepEqual(out.names, ["冲突技能"]);
    assert.match(getSkill("冲突技能")!.content, /版本二/);
  });

  it("URL 直链安装：拉取 Markdown 并以文件名/ frontmatter 命名", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("---\nname: 远程技能\ndescription: 来自 URL\n---\n\n正文", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      })) as typeof fetch;
    try {
      const out = await installSkillFromSource("https://example.com/skills/远程技能.md");
      assert.deepEqual(out.names, ["远程技能"]);
      assert.equal(out.kind, "url");
      assert.equal(getSkill("远程技能")?.description, "来自 URL");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("git 仓库安装：浅克隆本机仓库，登记修订号", async () => {
    const repoDir = path.join(tmp, "git-repo");
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    makeSkillDir(repoDir, "仓库技能", "仓库内容");
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", ["-C", repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    const out = await installSkillFromSource(`git:file:///${repoDir.replace(/\\/g, "/").replace(/^\/+/, "")}`);
    assert.deepEqual(out.names, ["仓库技能"]);
    assert.equal(out.kind, "git");
    assert.match(out.revision, /^[0-9a-f]{7,}$/);
    assert.equal(getSourceInfo("仓库技能")?.kind, "git");
    assert.ok(getSourceInfo("仓库技能")!.source.startsWith("git:file:///"));
  });

  it("同步：源里更新/删除/新增分别落为覆盖、移除、补装", async () => {
    const src = path.join(tmp, "sync-src");
    makeSkillDir(src, "同步保留", "v1");
    makeSkillDir(src, "同步移除", "将被删除");
    await installSkillFromSource(src);
    assert.ok(skillExists("同步保留") && skillExists("同步移除"));

    // 源变化：更新保留项、删除移除项、新增补充项
    makeSkillDir(src, "同步保留", "v2 内容");
    fs.rmSync(path.join(src, "同步移除"), { recursive: true, force: true });
    makeSkillDir(src, "同步新增", "新技能");

    const out = await syncSkill("同步保留");
    assert.deepEqual(out.updated, ["同步保留"]);
    assert.deepEqual(out.added, ["同步新增"]);
    assert.deepEqual(out.removed, ["同步移除"]);
    assert.match(getSkill("同步保留")!.content, /v2 内容/);
    assert.ok(!skillExists("同步移除"));
    assert.equal(getSourceInfo("同步移除"), undefined);
    assert.ok(skillExists("同步新增"));
  });

  it("非安装来源的技能无法同步；未登记来源报错", async () => {
    await assert.rejects(() => syncSkill("周报生成"), /无法同步/);
    await assert.rejects(() => syncSkill("不存在的技能"), /无法同步/);
  });

  it("删除技能后来源登记一并清除（removeSkillSource）", async () => {
    const dir = makeSkillDir(path.join(tmp, "cleanup-src"), "清理技能", "内容");
    await installSkillFromSource(dir);
    assert.ok(getSourceInfo("清理技能"));
    deleteSkill("清理技能");
    removeSkillSource("清理技能");
    assert.equal(getSourceInfo("清理技能"), undefined);
  });

  it("本机 zip 技能包安装：根下 SKILL.md 或子目录均可", async () => {
    const zipPath = path.join(tmp, "pack-skill.zip");
    fs.writeFileSync(
      zipPath,
      zipFiles([
        {
          name: "zip技能/SKILL.md",
          data: Buffer.from("---\nname: zip技能\ndescription: 来自压缩包\n---\n\n压缩包正文\n", "utf8"),
        },
        { name: "zip技能/references/note.md", data: Buffer.from("附注\n", "utf8") },
      ]),
    );
    const out = await installSkillFromSource(zipPath);
    assert.deepEqual(out.names, ["zip技能"]);
    assert.equal(out.kind, "zip");
    assert.match(getSkill("zip技能")!.content, /压缩包正文/);
    assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, "agent", "skills", "zip技能", "references", "note.md")));
  });

  it("上传 zip 字节安装；含 pack.json 的专家包被拒绝", async () => {
    const buf = zipFiles([
      {
        name: "上传技能/SKILL.md",
        data: Buffer.from("---\nname: 上传技能\ndescription: 上传\n---\n\n上传正文\n", "utf8"),
      },
    ]);
    const out = await installSkillFromZipBuffer(buf, { label: "demo.zip" });
    assert.deepEqual(out.names, ["上传技能"]);
    assert.equal(out.kind, "zip");
    assert.equal(out.source, "zip:demo.zip");

    const expert = zipFiles([
      { name: "pack.json", data: Buffer.from('{"format":"office-agent-package","version":2,"name":"x"}', "utf8") },
      { name: "skills/a/SKILL.md", data: Buffer.from("---\nname: a\ndescription: d\n---\n\nbody\n", "utf8") },
    ]);
    await assert.rejects(() => installSkillFromZipBuffer(expert, { label: "expert.zip" }), /专家包/);
  });

  it("GitHub 仓库地址：zipball 成功时不必走 git clone", async () => {
    const zipBuf = zipFiles([
      {
        name: "demo-main/gh技能/SKILL.md",
        data: Buffer.from("---\nname: gh技能\ndescription: 来自 GitHub zip\n---\n\nzipball 正文\n", "utf8"),
      },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("codeload.github.com") && url.includes("demo-skill")) {
        return new Response(zipBuf, { status: 200, headers: { "content-type": "application/zip" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const out = await installSkillFromSource("https://github.com/acme/demo-skill");
      assert.deepEqual(out.names, ["gh技能"]);
      assert.equal(out.kind, "git");
      assert.match(getSkill("gh技能")!.content, /zipball 正文/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("同步 ~/.agents/skills：新技能装入，其它来源重名跳过", async () => {
    const other = makeSkillDir(path.join(tmp, "other-home-src"), "外来技能", "外来正文");
    await installSkillFromSource(other);
    const home = path.join(tmp, "fake-agents-skills");
    makeSkillDir(home, "home技能甲", "甲内容");
    makeSkillDir(home, "外来技能", "不应覆盖外来");
    process.env.AGENTS_SKILLS_DIR = home;
    const out = syncHomeAgentsSkills();
    assert.equal(out.missing, false);
    assert.ok(out.added.includes("home技能甲") || out.updated.includes("home技能甲"));
    assert.ok(skillExists("home技能甲"));
    assert.equal(getSourceInfo("home技能甲")?.kind, "local");
    assert.ok(out.skipped.includes("外来技能"));
    assert.match(getSkill("外来技能")!.content, /外来正文/);
  });
});

describe("agent-packs：专家包", () => {
  it("内置专家包可以被规范化读取（仓库 agent-packs/*.json 有效）", () => {
    process.env.AGENT_PACKS_DIR = path.join(repoRoot, "agent-packs");
    const packs = listBuiltinPacks();
    assert.ok(packs.length >= 2, "至少有 2 个内置专家包");
    const names = packs.map((p) => p.name);
    assert.ok(names.includes("深度研究员"));
    assert.ok(names.includes("公文写作助手"));
    const pkg = readBuiltinPack("深度研究员");
    assert.equal(pkg?.name, "深度研究员");
    assert.ok(pkg?.systemPrompt.includes("研究员"));
    assert.ok(Object.keys(pkg?.skills ?? {}).includes("资料调研"));
  });

  it("normalizeAgentPackage：缺 format 报错、坏技能跳过", () => {
    assert.throws(() => normalizeAgentPackage({ name: "x", systemPrompt: "y" }), /format/);
    assert.throws(() => normalizeAgentPackage({ format: "office-agent-package", version: 99 }), /版本/);
    const pkg = normalizeAgentPackage({
      format: "office-agent-package",
      version: 1,
      name: "测试包",
      description: "描述",
      tags: ["a", 3, "b"],
      highRisk: true,
      systemPrompt: "提示词",
      skills: { "合法技能": { description: "d", content: "c" }, "坏名字!!": { content: "x" }, "空内容": { content: "  " } },
    });
    assert.equal(pkg.name, "测试包");
    assert.equal(pkg.highRisk, true);
    assert.deepEqual(Object.keys(pkg.skills), ["合法技能"]);
  });

  it("安装专家包：包内技能落库；重名技能自动改名不覆盖", () => {
    const pkg = normalizeAgentPackage({
      format: "office-agent-package",
      version: 1,
      name: "打包专家",
      systemPrompt: "你是打包专家",
      tags: ["测试"],
      skills: {
        "打包技能A": { description: "A", content: "内容A" },
      },
    });
    const r1 = installPackageSkills(pkg);
    assert.deepEqual(r1.installed, [{ requested: "打包技能A", finalName: "打包技能A" }]);
    const r2 = installPackageSkills(pkg);
    assert.equal(r2.installed[0]!.finalName, "打包技能A-2");
    assert.equal(getSkill("打包技能A")!.content, "内容A");
    assert.ok(skillExists("打包技能A-2"));
  });

  it("导出/导入 roundtrip：buildAgentPackage → normalize → 技能一致", async () => {
    const original = buildAgentPackage(
      { name: "往返专家", description: "往返", systemPrompt: "你是往返专家", tags: ["测试"], highRisk: false },
      [{ name: "往返技能", description: "往返技能描述", content: "往返内容" }],
    );
    const text = JSON.stringify(original);
    const restored = normalizeAgentPackage(JSON.parse(text));
    assert.equal(restored.name, "往返专家");
    assert.equal(restored.systemPrompt, "你是往返专家");
    assert.equal(restored.skills["往返技能"]?.content, "往返内容");
    const res = installPackageSkills(restored);
    assert.equal(res.installed[0]!.finalName, "往返技能");
    assert.equal(getSkill("往返技能")!.content, "往返内容");
  });

  it("目录专家包的技能只属于该专家，不进入平台技能库", () => {
    process.env.AGENT_PACKS_DIR = path.join(repoRoot, "agent-packs");
    process.env.SKILLS_CATALOG_DIR = path.join(tmp, "empty-catalog");
    const pkg = readBuiltinPack("紫金个人知识库助手");
    assert.ok(pkg);
    assert.equal(pkg!.version, 2);
    const source = pkg!.skills["enterprise-knowledge"]?.sourceDir ?? "";
    assert.ok(source.includes(`${path.sep}紫金个人知识库助手${path.sep}skills${path.sep}`));
    assert.ok(fs.existsSync(path.join(source, "references", "kb-qa.md")));
    assert.equal(fs.existsSync(path.join(repoRoot, "skills-catalog", "enterprise-knowledge")), false);
    const agentId = uuid();
    const folder = path.join(dataDir, "agents", agentId);
    fs.mkdirSync(folder, { recursive: true });
    db.prepare(
      "INSERT INTO agents (id, name, description, system_prompt, tags, folder, high_risk, tool_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(agentId, "隔离专家", "", "提示", "[]", folder, 0, "{}", now());
    const installed = installExpertSkills(agentId, pkg!);
    assert.deepEqual(
      installed.installed.map((item) => item.finalName).sort(),
      ["enterprise-knowledge", "pitfalls-and-experience", "wps365-env", "wps365-skill"],
    );
    setAgentSkillBinding(agentId, installed.installed.map((item) => item.finalName));
    assert.equal(skillExists("enterprise-knowledge"), false);
    assert.match(buildSkillsPrompt(agentId), /enterprise-knowledge/);
    assert.doesNotMatch(buildSkillsPrompt("other-agent"), /enterprise-knowledge/);
    assert.match(readSkillResource("enterprise-knowledge", "references/kb-qa.md", agentId), /./);
    assert.throws(() => readSkillResource("enterprise-knowledge", "references/kb-qa.md", "other-agent"), /not available/);
  });
});

after(async () => {
  // 先关数据库连接再删目录：Windows 下打开中的 sqlite 文件会 EBUSY
  const { db } = await import("./db.js");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});
