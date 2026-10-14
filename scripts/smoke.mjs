// 端到端冒烟测试：对一个已启动的服务端跑通「注册 → 配供应商 → 建专家 → 派发任务 →
// 围观完成 → 成果物/消息校验 → 删除任务 → 清理校验」，最后验证登录限流。
// 用法：先启动 scripts/mock-openai.mjs 与服务端（全新 DATA_DIR），再 node scripts/smoke.mjs
// 环境变量：SMOKE_BASE（默认 http://127.0.0.1:8787）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const DATA_DIR = process.env.SMOKE_DATA_DIR ?? "";

async function api(method, pathName, { token, body } = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: {
      // 无 body 的请求（如 DELETE）不能带 JSON content-type：Fastify 会拒绝空 JSON body
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应（如 SPA fallback 的 HTML）
  }
  return { status: res.status, json, text };
}

async function waitForTask(token, id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, json } = await api("GET", `/tasks/${id}`, { token });
    assert.equal(status, 200, `GET /tasks/${id} → ${status}`);
    if (json.status !== "pending" && json.status !== "running") return json;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("任务 90 秒内未结束");
}

const uniq = Date.now();
const username = `smoke-admin-${uniq}`;

// 1. 注册管理员
const reg = await api("POST", "/auth/register", { body: { username, password: "smoke-pass-123" } });
assert.equal(reg.status, 200, `注册失败：${reg.text}`);
const token = reg.json.token;
console.log("✓ 注册管理员", username);

// 2. 登录（同时验证登录可用）
const login = await api("POST", "/auth/login", { body: { username, password: "smoke-pass-123" } });
assert.equal(login.status, 200, "登录失败");
console.log("✓ 登录");

// 3. 配置 mock 供应商并拉取模型列表
const provider = await api("POST", "/admin/providers", {
  token,
  body: { name: "mock", baseUrl: "http://127.0.0.1:9990/v1", apiKey: "mock-key" },
});
assert.equal(provider.status, 201, `建供应商失败：${provider.text}`);
const providerId = provider.json.id;
const models = await api("GET", `/admin/providers/${providerId}/models`, { token });
assert.equal(models.status, 200, `拉模型失败：${models.text}`);
assert.ok(models.json.models.includes("mock-model"), "模型列表应含 mock-model");
console.log("✓ 供应商 + 模型缓存", models.json.models.join(","));

// 4. 建专家（绑定 mock-model）
const agent = await api("POST", "/admin/agents", {
  token,
  body: { name: "冒烟专家", description: "e2e", systemPrompt: "你是冒烟测试专家。", providerId, modelId: "mock-model" },
});
assert.equal(agent.status, 201, `建专家失败：${agent.text}`);
console.log("✓ 专家");

// 5. 派发任务（提示词带 html，mock 会写 hello.html）
const task = await api("POST", "/tasks", {
  token,
  body: { agentId: agent.json.id, prompt: "请生成一个 hello.html 网页", title: "冒烟任务" },
});
assert.equal(task.status, 201, `派发失败：${task.text}`);
const taskId = task.json.id;
console.log("✓ 派发任务", taskId);

// 6. 等待完成并校验状态
const done = await waitForTask(token, taskId);
assert.equal(done.status, "completed", `任务应以 completed 收尾，实际 ${done.status}（${done.error ?? ""}）`);
console.log("✓ 任务完成");

// 7. 成果物校验
const dels = await api("GET", `/tasks/${taskId}/deliverables`, { token });
assert.equal(dels.status, 200);
assert.ok(dels.json.some((d) => d.relPath === "hello.html"), "成果物应含 hello.html");
const dl = await api("GET", `/tasks/${taskId}/deliverables/${dels.json[0].id}/download`, { token });
assert.equal(dl.status, 200, "成果物下载应 200");
console.log("✓ 成果物扫描与下载");

// 8. 消息校验（用户 + assistant）
const msgs = await api("GET", `/tasks/${taskId}/messages`, { token });
assert.equal(msgs.status, 200);
assert.equal(msgs.json.length, 2, `应有 2 条消息，实际 ${msgs.json.length}`);
assert.equal(msgs.json[0].role, "user");
assert.equal(msgs.json[1].role, "assistant");
console.log("✓ 会话消息落库");

// 8.5 任务列表分页（当前共 1 个已完成任务）
{
  const p1 = await api("GET", "/tasks?limit=1", { token });
  assert.equal(p1.status, 200);
  assert.ok(Array.isArray(p1.json.items), "分页响应应含 items");
  assert.equal(p1.json.items.length, 1);
  assert.equal(p1.json.total, 1);
  assert.equal(p1.json.counts.all, 1);
  assert.equal(p1.json.counts.completed, 1);
  const p2 = await api("GET", "/tasks?status=failed", { token });
  assert.equal(p2.json.total, 0, "failed 筛选应为 0");
  const p3 = await api("GET", "/tasks?q=冒烟", { token });
  assert.equal(p3.json.total, 1, "关键词「冒烟」应命中 1 条");
  const p4 = await api("GET", "/tasks?q=不存在的关键词xyz", { token });
  assert.equal(p3.status, 200);
  assert.equal(p4.json.total, 0, "无关关键词应为 0");
  const legacy = await api("GET", "/tasks", { token });
  assert.ok(Array.isArray(legacy.json), "无参数时保持旧数组格式");
  console.log("✓ 任务列表分页（items/total/counts + 状态/关键词筛选 + 旧格式兼容）");
}

// 8.6 附件任务：multipart 派发 → 附件落工作区但不计成果物
{
  const form = new FormData();
  form.set("agentId", agent.json.id);
  form.set("prompt", "请根据附件生成 hello.html 网页");
  form.set("providerId", providerId);
  form.set("modelId", "mock-model");
  form.append("files", new Blob(["要点：这是一份冒烟测试附件"], { type: "text/plain" }), "notes.txt");
  const up = await fetch(`${BASE}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const upJson = await up.json().catch(() => ({}));
  assert.equal(up.status, 201, `附件任务派发失败：${upJson.error ?? up.status}`);
  const upTaskId = upJson.id;
  const upDone = await waitForTask(token, upTaskId);
  assert.equal(upDone.status, "completed", `附件任务应以 completed 收尾（${upDone.error ?? ""}）`);
  if (DATA_DIR) {
    // 工作区可能是专家常驻文件夹（agents/<id>）而非平台工作区，以任务 DTO 的 workspacePath 为准
    const uploaded = path.join(upDone.workspacePath, "notes.txt");
    assert.equal(fs.existsSync(uploaded), true, `附件应落进任务工作区 ${upDone.workspacePath}`);
    assert.equal(fs.readFileSync(uploaded, "utf8"), "要点：这是一份冒烟测试附件", "附件内容应完整");
  }
  const upDels = await api("GET", `/tasks/${upTaskId}/deliverables`, { token });
  assert.ok(upDels.json.some((d) => d.relPath === "hello.html"), "附件任务的成果物应含 hello.html");
  assert.ok(!upDels.json.some((d) => d.relPath === "notes.txt"), "上传附件不得计入成果物");

  // 8.7 多轮追问带附件：multipart 追问 → 附件落工作区、不计成果物、消息含附件清单
  const msgForm = new FormData();
  msgForm.set("prompt", "请结合新增附件再核对一次并更新 hello.html");
  msgForm.append("files", new Blob(["第二轮冒烟附件"], { type: "text/plain" }), "extra.txt");
  const msg = await fetch(`${BASE}/tasks/${upTaskId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: msgForm,
  });
  assert.equal(msg.status, 202, `追问失败：${await msg.text()}`);
  const upDone2 = await waitForTask(token, upTaskId);
  assert.equal(upDone2.status, "completed", `追问轮应以 completed 收尾（${upDone2.error ?? ""}）`);
  const upMsgs = await api("GET", `/tasks/${upTaskId}/messages`, { token });
  assert.equal(upMsgs.json.length, 4, `两轮对话应有 4 条消息，实际 ${upMsgs.json.length}`);
  assert.ok(upMsgs.json[2].content.includes("extra.txt"), "第二轮用户消息应包含附件清单");
  if (DATA_DIR) {
    const extra = path.join(upDone2.workspacePath, "extra.txt");
    assert.equal(fs.existsSync(extra), true, `追问附件应落进任务工作区 ${upDone2.workspacePath}`);
    assert.equal(fs.readFileSync(extra, "utf8"), "第二轮冒烟附件", "追问附件内容应完整");
  }
  const upDels2 = await api("GET", `/tasks/${upTaskId}/deliverables`, { token });
  assert.ok(!upDels2.json.some((d) => d.relPath === "extra.txt"), "追问附件不得计入成果物");
  assert.ok(upDels2.json.some((d) => d.relPath === "hello.html"), "追问后成果物仍应含 hello.html");
  console.log("✓ 多轮追问带附件（multipart 追问 → 落工作区 → 不计成果物 → 消息含清单）");

  const page2 = await api("GET", "/tasks?limit=50", { token });
  assert.equal(page2.json.total, 2, "删除前应有 2 个任务");
  assert.equal(page2.json.counts.completed, 2);
  const rmUp = await api("DELETE", `/tasks/${upTaskId}`, { token });
  assert.equal(rmUp.status, 200, "删除附件任务失败");
  const afterList = await api("GET", "/tasks?limit=50", { token });
  assert.equal(afterList.json.total, 1, "删除附件任务后应剩 1 个");
  console.log("✓ 附件任务（multipart 派发 → 落工作区 → 不计成果物 → 级联删除）");
}

// 8.8 技能安装/同步 + 专家包安装/导出/导入 roundtrip
{
  // 技能市场：内置目录可见、一键安装、来源登记、可同步
  const catalog = await api("GET", "/admin/skills/catalog", { token });
  assert.equal(catalog.status, 200);
  assert.ok(catalog.json.catalog.length >= 4, "内置技能目录应有 4+ 项");
  const mail = catalog.json.catalog.find((c) => c.id === "邮件回复");
  assert.ok(mail && !mail.installed, "邮件回复初始应未安装");
  const inst = await api("POST", "/admin/skills/install", { token, body: { source: "邮件回复" } });
  assert.equal(inst.status, 201, `内置技能安装失败：${inst.text}`);
  assert.deepEqual(inst.json.names, ["邮件回复"]);
  const inst2 = await api("POST", "/admin/skills/install", { token, body: { source: "邮件回复" } });
  assert.equal(inst2.status, 400, "重复安装未开覆盖应 400");
  const skills = await api("GET", "/admin/skills", { token });
  assert.ok(skills.json.some((s) => s.name === "邮件回复"));
  const catalog2 = await api("GET", "/admin/skills/catalog", { token });
  assert.equal(catalog2.json.sources["邮件回复"]?.kind, "builtin", "安装后应登记 builtin 来源");
  const sync = await api("POST", `/admin/skills/${encodeURIComponent("邮件回复")}/sync`, { token });
  assert.equal(sync.status, 200, `同步失败：${sync.text}`);
  assert.ok(sync.json.updated.includes("邮件回复"), "同步应覆盖刷新");
  const syncPlain = await api("POST", `/admin/skills/${encodeURIComponent("周报生成")}/sync`, { token });
  assert.equal(syncPlain.status, 400, "未安装来源的技能同步应 400");
  console.log("✓ 技能安装/同步（内置市场 → 来源登记 → 同步刷新）");

  // 专家包：市场 → 安装（带模型）→ 导出 → 导入 roundtrip
  const packs = await api("GET", "/admin/agents/catalog", { token });
  assert.equal(packs.status, 200);
  assert.ok(packs.json.some((p) => p.id === "深度研究员"), "内置专家包应含 深度研究员");
  const packInst = await api("POST", "/admin/agents/install", {
    token,
    body: { packId: "深度研究员", providerId, modelId: "mock-model" },
  });
  assert.equal(packInst.status, 201, `专家包安装失败：${packInst.text}`);
  assert.ok(packInst.json.skills.some((s) => s.finalName === "资料调研"), "包内技能应随装落库");
  const packAgentId = packInst.json.id;
  const agentsAfter = await api("GET", "/admin/agents", { token });
  const packAgent = agentsAfter.json.find((a) => a.id === packAgentId);
  assert.equal(packAgent?.modelId, "mock-model", "安装时选择的模型应生效");

  const exp = await api("GET", `/admin/agents/${packAgentId}/export?skills=${encodeURIComponent("资料调研")}`, { token });
  assert.equal(exp.status, 200, `导出失败：${exp.text}`);
  assert.equal(exp.json.format, "office-agent-package", "导出应为 office-agent-package 格式");
  assert.equal(exp.json.name, "深度研究员");
  assert.ok(exp.json.skills["资料调研"]?.content, "导出应携带勾选的技能内容");

  const impForm = new FormData();
  impForm.append("file", new Blob([JSON.stringify(exp.json)], { type: "application/json" }), "深度研究员.json");
  const imp = await fetch(`${BASE}/admin/agents/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: impForm,
  });
  const impJson = await imp.json().catch(() => ({}));
  assert.equal(imp.status, 201, `导入失败：${impJson.error ?? imp.status}`);
  assert.ok(impJson.skills?.some((s) => s.finalName === "资料调研-2"), "重名技能导入应自动改名 -2");
  const importedAgentId = impJson.id;
  const agentsAfter2 = await api("GET", "/admin/agents", { token });
  const imported = agentsAfter2.json.find((a) => a.id === importedAgentId);
  assert.equal(imported?.name, "深度研究员", "导入的专家应出现在列表且名字不变");
  assert.equal(imported?.modelId, "", "导入未选模型时不应绑定模型");

  const badImp = await fetch(`${BASE}/admin/agents/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(badImp.status, 400, "非专家包导入应 400");
  console.log("✓ 专家包安装/导出/导入 roundtrip（重名技能自动改名）");

  // 清理：删除两位导入专家与随包技能（不覆盖 smoke 其余步骤）
  for (const id of [packAgentId, importedAgentId]) {
    const rm = await api("DELETE", `/admin/agents/${id}`, { token });
    assert.equal(rm.status, 200, "删除导入专家失败");
  }
  for (const name of ["资料调研", "资料调研-2", "邮件回复"]) {
    const rm = await api("DELETE", `/admin/skills/${encodeURIComponent(name)}`, { token });
    assert.equal(rm.status, 200, `清理技能 ${name} 失败`);
  }
}

// 9. 删除任务 + 清理校验
const del = await api("DELETE", `/tasks/${taskId}`, { token });
assert.equal(del.status, 200, `删除失败：${del.text}`);
const after = await api("GET", `/tasks/${taskId}`, { token });
assert.equal(after.status, 404, "删除后任务应 404");
if (DATA_DIR) {
  const wsDir = path.join(DATA_DIR, "workspaces", taskId);
  assert.equal(fs.existsSync(wsDir), false, "平台工作区目录应被删除");
  const sessionsDir = path.join(DATA_DIR, "sessions");
  const hit = (function find(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = find(p);
        if (r) return r;
      } else if (p.endsWith(".jsonl")) return p;
    }
    return null;
  })(sessionsDir);
  assert.equal(hit, null, "会话 JSONL 应被删除");
}
const list = await api("GET", "/tasks", { token });
assert.equal(list.json.length, 0, "任务列表应为空");
console.log("✓ 任务删除与级联清理");

// 10. 登录限流：连错 10 次后 429
let limited = false;
for (let i = 0; i < 12; i++) {
  const r = await api("POST", "/auth/login", { body: { username, password: "wrong-pass" } });
  if (r.status === 429) {
    limited = true;
    break;
  }
  assert.equal(r.status, 401, `第 ${i + 1} 次失败登录应 401`);
}
assert.equal(limited, true, "连续失败后应触发 429 限流");
console.log("✓ 登录限流");

console.log("\nSMOKE OK — 全部通过");
