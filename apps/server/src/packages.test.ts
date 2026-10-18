// packages.ts 在模块加载时固化 config.paths，必须先设 DATA_DIR 再动态导入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-packages-test-"));
process.env.PI_OFFLINE = "1";

const {
  declarePiPackage,
  ensureWebSearchConfig,
  findPackageSourceDir,
  installPiPackages,
  isPackageSynced,
} = await import("./packages.js");
const { paths } = await import("./config.js");
const { DefaultResourceLoader, SessionManager, createAgentSession } = await import("@earendil-works/pi-coding-agent");

describe("findPackageSourceDir", () => {
  it("按 cwd 探测到仓库内的 office-suite 包", () => {
    const found = findPackageSourceDir("office-suite", process.cwd());
    assert.ok(found, "应能定位 pi-packages/office-suite");
    assert.ok(fs.existsSync(path.join(found, "package.json")));
  });

  it("按 cwd 探测到仓库内的 document-ocr 包", () => {
    const found = findPackageSourceDir("document-ocr", process.cwd());
    assert.ok(found, "应能定位 pi-packages/document-ocr");
    assert.ok(fs.existsSync(path.join(found, "extensions", "ocr-to-md.ts")));
  });

  it("环境变量目录缺包时回退到 cwd 探测", () => {
    process.env.PI_PACKAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-pkg-empty-"));
    try {
      const found = findPackageSourceDir("office-suite", process.cwd());
      assert.ok(found, "回退后仍应定位到包");
      assert.ok(!found.startsWith(process.env.PI_PACKAGES_DIR));
    } finally {
      delete process.env.PI_PACKAGES_DIR;
    }
  });
});

describe("declarePiPackage", () => {
  it("写入声明且幂等，保留其它字段", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-pkg-settings-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: [{ source: "./packages/other" }] }));
    declarePiPackage(settingsPath, "./packages/office-suite");
    declarePiPackage(settingsPath, "./packages/office-suite");
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.packages.length, 2);
    assert.deepEqual(parsed.packages.map((p: { source: string }) => p.source).sort(), ["./packages/office-suite", "./packages/other"]);
  });

  it("容忍损坏的 settings.json 并重建", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-pkg-settings-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, "{ not json");
    declarePiPackage(settingsPath, "./packages/office-suite");
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(parsed.packages, [{ source: "./packages/office-suite" }]);
  });
});

describe("ensureWebSearchConfig", () => {
  it("缺省时写入 eager，已有文件不覆盖", () => {
    const configPath = path.join(paths.agentDir, "web-search.json");
    fs.rmSync(configPath, { force: true });
    ensureWebSearchConfig();
    const first = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(first.toolActivation, "eager");
    fs.writeFileSync(configPath, `${JSON.stringify({ toolActivation: "dynamic", braveApiKey: "keep" }, null, 2)}\n`);
    ensureWebSearchConfig();
    const second = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(second.toolActivation, "dynamic");
    assert.equal(second.braveApiKey, "keep");
  });
});

describe("installPiPackages", () => {
  it("端到端：复制包到 agentDir 并写入声明，重复调用幂等", async () => {
    const result = installPiPackages();
    assert.deepEqual(result.skipped, []);
    assert.equal(result.installed.length, 2);
    const suite = result.installed.find((pkg) => pkg.id === "office-suite")!;
    const ocr = result.installed.find((pkg) => pkg.id === "document-ocr")!;
    assert.ok(suite, "应安装 office-suite");
    assert.ok(ocr, "应安装 document-ocr");
    assert.equal(suite.alreadySynced, false);
    assert.equal(ocr.alreadySynced, false);

    const dest = path.join(paths.agentDir, "packages", "office-suite");
    assert.ok(fs.existsSync(path.join(dest, "package.json")));
    assert.ok(fs.existsSync(path.join(dest, "extensions", "todo-list.ts")));
    assert.ok(fs.existsSync(path.join(paths.agentDir, "packages", "document-ocr", "extensions", "ocr-to-md.ts")));
    // prompts 已迁移为平台技能（skills.ts 播种），包内不应再有 prompts
    assert.ok(!fs.existsSync(path.join(dest, "prompts")));
    assert.equal(isPackageSynced(findPackageSourceDir("office-suite", process.cwd())!, dest), true);

    const settings = JSON.parse(fs.readFileSync(path.join(paths.agentDir, "settings.json"), "utf8"));
    const sources = settings.packages.map((pkg: { source: string }) => pkg.source).sort();
    assert.deepEqual(sources, [
      "./packages/document-ocr",
      "./packages/office-suite",
      "npm:pi-quiver@6.13.2",
      "npm:pi-web-access@0.42.0",
    ]);
    const quiver = settings.packages.find((pkg: { source: string }) => pkg.source.startsWith("npm:pi-quiver"));
    assert.deepEqual(quiver.extensions, ["extensions/doc_to_md.ts"]);
    assert.deepEqual(quiver.skills, []);
    assert.deepEqual(quiver.prompts, []);
    assert.deepEqual(quiver.themes, []);
    const webAccess = settings.packages.find((pkg: { source: string }) => pkg.source.startsWith("npm:pi-web-access"));
    assert.ok(webAccess, "应声明 pi-web-access");
    assert.equal(webAccess.source, "npm:pi-web-access@0.42.0");
    assert.equal(webAccess.extensions, undefined);

    const again = installPiPackages();
    assert.ok(again.installed.every((pkg) => pkg.alreadySynced));
    const settingsAgain = JSON.parse(fs.readFileSync(path.join(paths.agentDir, "settings.json"), "utf8"));
    assert.equal(settingsAgain.packages.length, 4, "重复安装不应产生重复声明");
  });

  it("目标被篡改后重装可修复", () => {
    const dest = path.join(paths.agentDir, "packages", "office-suite");
    fs.writeFileSync(path.join(dest, "extensions", "todo-list.ts"), "// corrupted");
    const result = installPiPackages();
    assert.equal(result.installed[0]!.alreadySynced, false);
    assert.ok(fs.readFileSync(path.join(dest, "extensions", "todo-list.ts"), "utf8").includes("registerTool"));
  });

  it("DefaultResourceLoader 按声明加载插件扩展（prompts 已迁移为平台技能）", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "office-pkg-cwd-"));
    const loader = new DefaultResourceLoader({ cwd, agentDir: paths.agentDir });
    await loader.reload();

    const extensions = loader.getExtensions();
    assert.equal(extensions.errors.length, 0, `扩展加载报错: ${JSON.stringify(extensions.errors)}`);
    const names = extensions.extensions.map((e) => path.basename(e.path)).sort();
    assert.deepEqual(names, ["ocr-to-md.ts", "todo-list.ts", "write-guard.ts"]);
    const todo = extensions.extensions.find((e) => e.path.endsWith("todo-list.ts"))!;
    assert.ok(todo.tools.has("todo"), "todo 扩展应注册 todo 工具");
    const ocrExt = extensions.extensions.find((e) => e.path.endsWith("ocr-to-md.ts"))!;
    assert.ok(ocrExt.tools.has("ocr_to_md"), "document-ocr 扩展应注册 ocr_to_md 工具");

    assert.equal(loader.getPrompts().prompts.length, 0, "包不应再声明提示词模板");
  });

  it("会话（noTools: builtin + customTools）中扩展注册的 todo 工具处于激活态", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "office-pkg-session-"));
    const loader = new DefaultResourceLoader({ cwd, agentDir: paths.agentDir });
    await loader.reload();

    const EmptyParams = Type.Object({});
    const dummy: ToolDefinition<typeof EmptyParams> = {
      name: "workspace_list",
      label: "x",
      description: "d",
      parameters: EmptyParams,
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    };
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      customTools: [dummy],
      resourceLoader: loader,
    });
    try {
      const active = session.getActiveToolNames();
      assert.ok(active.includes("todo"), `todo 应在激活工具中，实际: ${JSON.stringify(active)}`);
      assert.ok(active.includes("ocr_to_md"), `ocr_to_md 应在激活工具中，实际: ${JSON.stringify(active)}`);
      assert.ok(active.includes("workspace_list"));
      assert.equal(active.length, 3, `内置工具不应被激活，实际: ${JSON.stringify(active)}`);
    } finally {
      session.dispose();
    }
  });
});
