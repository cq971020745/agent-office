import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// DATA_DIR 必须在动态导入 db/config 之前就绪：config 在模块加载即解析数据目录
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-p2-"));
process.env.DATA_DIR = dataDir;

const { migrate } = await import("./db.js");
migrate();
const { parseModelOverrides, sanitizeModelOverrides, resolveModelCaps, MODEL_DEFAULTS } = await import("./model-caps.js");
const { parseToolPolicy, sanitizeToolPolicy, policyFor, toolNeedsApproval } = await import("./tool-policy.js");
const { readAgentsMd, writeAgentsMd, AGENTS_MD_MAX_CHARS } = await import("./instructions.js");
const { McpHttpClient, expandHeaderEnv } = await import("./mcp.js");
const { installSkillFromSource, syncSkill, getSourceInfo, listSkillUpdates, removeSkillSource } = await import("./skill-install.js");
const { readSkillTool, expandSkillSlash, getSkillUsageMap, createSkill, deleteSkill } = await import("./skills.js");
const { getSkillUsageMap: usageMap } = await import("./skills.js");

after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 上偶发句柄未释放，忽略
  }
});

describe("P2-5 模型能力元数据", () => {
  it("parseModelOverrides：坏 JSON / 非对象条目回退空，不抛错", () => {
    assert.deepEqual(parseModelOverrides(null), {});
    assert.deepEqual(parseModelOverrides("{bad json"), {});
    assert.deepEqual(parseModelOverrides('{"m": "not-an-object"}'), {});
    assert.deepEqual(parseModelOverrides('{"m": {"contextWindow": 0}}'), {}); // 非正数丢弃
    assert.deepEqual(parseModelOverrides('{"m": {"contextWindow": 200000.7}}'), { m: { contextWindow: 200000 } });
  });

  it("sanitizeModelOverrides：只保留合法字段", () => {
    const out = sanitizeModelOverrides({
      "gpt-x": { contextWindow: 400_000, maxTokens: 65_536, reasoning: true, junk: "ignore" },
      "": { contextWindow: 1 },
      bad: "nope",
    });
    assert.deepEqual(out, { "gpt-x": { contextWindow: 400_000, maxTokens: 65_536, reasoning: true } });
  });

  it("resolveModelCaps：覆盖值压在兜底默认之上，未配置的模型用默认", () => {
    const overrides = sanitizeModelOverrides({ "glm-5": { contextWindow: 200_000, reasoning: true } });
    const caps = resolveModelCaps("glm-5", overrides);
    assert.equal(caps.contextWindow, 200_000);
    assert.equal(caps.reasoning, true);
    assert.equal(caps.maxTokens, MODEL_DEFAULTS.maxTokens);
    const dflt = resolveModelCaps("other-model", overrides);
    assert.deepEqual(dflt, { contextWindow: MODEL_DEFAULTS.contextWindow, maxTokens: MODEL_DEFAULTS.maxTokens, reasoning: false });
  });
});

describe("P2-2 工具策略", () => {
  it("parse/sanitize：非法值丢弃，ask/deny 保留", () => {
    assert.deepEqual(parseToolPolicy(null), {});
    assert.deepEqual(parseToolPolicy("not json"), {});
    assert.deepEqual(parseToolPolicy('{"workspace_write":"ask","run_code":"DENY","x":"allow"}'), { workspace_write: "ask" });
    assert.deepEqual(sanitizeToolPolicy({ "mcp:*": "deny", "": "ask", ok: "deny" }), { "mcp:*": "deny", ok: "deny" });
  });

  it("policyFor：精确名 > 连接器通配 > mcp:* > 默认放行", () => {
    const policy = sanitizeToolPolicy({
      workspace_write: "deny",
      "mcp:GitHub桥:*": "ask",
      "mcp:*": "deny",
      run_code: "ask",
    });
    assert.equal(policyFor(policy, "workspace_write"), "deny");
    assert.equal(policyFor(policy, "run_code"), "ask");
    assert.equal(policyFor(policy, "workspace_read"), undefined); // 未提及 = 放行
    // 连接器通配：注入的工具名把连接器名按 toolSafe 归一（非 \w 字符折叠成 _）
    assert.equal(policyFor(policy, "mcp_GitHub__create_issue"), "ask");
    assert.equal(policyFor(policy, "mcp_other_tool"), "deny"); // 全局 MCP 通配
    assert.equal(policyFor(policy, "read_skill"), undefined); // 非 MCP 工具不吃 mcp:* 通配
  });

  it("toolNeedsApproval：专家 deny 优先，会话授权跳过 ask，terminal 默认询问", () => {
    const policy = sanitizeToolPolicy({ workspace_write: "ask", terminal: "deny", fetch_url: "ask" });
    assert.equal(toolNeedsApproval(policy, "terminal", false), false);
    assert.equal(toolNeedsApproval(policy, "workspace_write", false), true);
    assert.equal(toolNeedsApproval(policy, "workspace_write", true), false);
    assert.equal(toolNeedsApproval({}, "terminal", false), true);
    assert.equal(toolNeedsApproval({}, "terminal", true), false);
    assert.equal(toolNeedsApproval({}, "workspace_read", false), false);
  });
});

describe("P2-3 AGENTS.md 平台指令", () => {
  it("未配置时读出空串；写入后可读回", () => {
    assert.equal(readAgentsMd(), "");
    writeAgentsMd("# 平台规范\n\n所有产出用中文。");
    assert.equal(readAgentsMd(), "# 平台规范\n\n所有产出用中文。");
    writeAgentsMd("");
    assert.equal(readAgentsMd(), "");
    assert.ok(AGENTS_MD_MAX_CHARS > 0);
  });
});

describe("P2-1 远程 MCP（streamable HTTP）", () => {
  it("expandHeaderEnv：${ENV} 展开为环境变量，未设置为空", () => {
    process.env.P2_TOKEN_TEST = "secret-123";
    assert.equal(expandHeaderEnv("Bearer ${P2_TOKEN_TEST}"), "Bearer secret-123");
    assert.equal(expandHeaderEnv("x${P2_TOKEN_MISSING}y"), "xy");
    assert.equal(expandHeaderEnv("no-ref"), "no-ref");
  });

  it("McpHttpClient：握手建会话、SSE 响应解析、工具调用", async () => {
    const seen: { auth?: string; sessionId?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const msg = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
        if (req.headers.authorization !== "Bearer secret-123") {
          res.writeHead(401).end();
          return;
        }
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-42" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "mock", version: "0" } } }));
          return;
        }
        if (msg.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        if (req.headers["mcp-session-id"] !== "sess-42") {
          res.writeHead(400).end("missing session");
          return;
        }
        if (msg.method === "tools/list") {
          // 用 SSE 事件流返回响应：验证 data: 行解析
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            `: ping\n\nevent: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "echo",
                    description: "回显工具",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } },
                  },
                ],
              },
            })}\n\n`
          );
          return;
        }
        if (msg.method === "tools/call") {
          seen.sessionId = req.headers["mcp-session-id"];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { content: [{ type: "text", text: `echo:${msg.params?.arguments?.text ?? ""}` }] },
            })
          );
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const client = new McpHttpClient(`http://127.0.0.1:${addr.port}/mcp`, { authorization: "Bearer ${P2_TOKEN_TEST}" }, 5, 5);
    try {
      const tools = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "echo");
      assert.equal(tools[0].description, "回显工具");
      assert.deepEqual(tools[0].inputSchema, { type: "object", properties: { text: { type: "string" } } });
      const res = (await client.callTool("echo", { text: "你好" })) as { content: { text: string }[] };
      assert.equal(res.content[0].text, "echo:你好");
      assert.equal(seen.sessionId, "sess-42"); // 会话头在后续请求中自动携带
    } finally {
      client.close();
      server.close();
    }
  });
});

describe("P2-4 技能演进闭环", () => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-p2-src-"));
  const skillName = "漂移检测技能";

  before(async () => {
    const dir = path.join(srcDir, skillName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: 漂移检测用\n---\n\nv1 内容\n`,
      "utf8"
    );
    await installSkillFromSource(srcDir);
  });

  after(() => {
    try {
      removeSkillSource(skillName);
      deleteSkill(skillName);
      fs.rmSync(srcDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论
    }
  });

  it("安装即建立指纹基线；源未变时报「无更新」", async () => {
    const info = getSourceInfo(skillName);
    assert.ok(info, "local 安装应登记来源");
    assert.ok(info.revision, "local 安装应记录内容指纹作为基线");
    const { listSkillUpdates } = await import("./skill-install.js");
    const updates = await listSkillUpdates();
    const row = updates.find((u) => u.source === info.source);
    assert.ok(row);
    assert.equal(row.hasUpdate, false);
  });

  it("源内容变化后检出「有更新」，同步后基线刷新", async () => {
    const { listSkillUpdates } = await import("./skill-install.js");
    fs.appendFileSync(path.join(srcDir, skillName, "SKILL.md"), "\n变更内容 v2\n", "utf8");
    let updates = await listSkillUpdates();
    let row = updates.find((u) => u.skills.includes(skillName));
    assert.equal(row?.hasUpdate, true, "源内容变化应检出有更新");
    const before = getSourceInfo(skillName)!.revision;
    const outcome = await syncSkill(skillName);
    assert.deepEqual(outcome.updated, [skillName]);
    const after = getSourceInfo(skillName)!;
    assert.notEqual(after.revision, before, "同步后基线应刷新");
    updates = await listSkillUpdates();
    row = updates.find((u) => u.source === after.source);
    assert.equal(row?.hasUpdate, false, "同步后应不再报告有更新");
  });

  it("read_skill 与斜杠调用都计入激活次数", async () => {
    const tool = readSkillTool();
    const execute = tool.execute as (id: string, params: unknown) => Promise<unknown>;
    await execute("t1", { name: skillName });
    assert.ok((usageMap()[skillName]?.count ?? 0) >= 1);
    expandSkillSlash(`/${skillName} 再来一次`);
    const usage = usageMap()[skillName];
    assert.ok(usage && usage.count >= 2, `斜杠展开后计数应递增，实际 ${usage?.count}`);
    assert.ok(usage.lastUsedAt);
  });
});
