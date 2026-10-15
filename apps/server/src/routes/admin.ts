import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { isChatModel, type GeneratedAgent } from "@office/shared";
import { db, now, uuid } from "../db.js";
import { paths } from "../config.js";
import { getUserById, requireAdmin, updatePassword } from "../auth.js";
import {
  createSkill,
  deleteAgentSkillBinding,
  deleteSkill,
  getAgentSkillBinding,
  getSkill,
  isValidSkillName,
  listSkills,
  setAgentSkillBinding,
  skillExists,
  updateSkill,
} from "../skills.js";
import {
  getSourceInfo,
  installSkillFromSource,
  listBuiltinSkills,
  removeSkillSource,
  syncSkill,
} from "../skill-install.js";
import {
  buildAgentPackage,
  installPackageSkills,
  listBuiltinPacks,
  normalizeAgentPackage,
  readBuiltinPack,
  type AgentPackage,
} from "../agent-packs.js";
import { clampTimeout, closeMcpClient, invalidateMcpClient, probeMcpTools, toMcpDto } from "../mcp.js";
import { AGENTS_MD_MAX_CHARS, readAgentsMd, writeAgentsMd } from "../instructions.js";
import { parseModelOverrides, sanitizeModelOverrides } from "../model-caps.js";
import { parseToolPolicy, sanitizeToolPolicy } from "../tool-policy.js";
import { getSkillUsageMap } from "../skills.js";
import { listSkillUpdates, syncAllSkills } from "../skill-install.js";

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  enabled: number;
  models: string;
  enabled_models: string;
  models_fetched_at: string | null;
  model_overrides: string;
  asr_model: string;
}

function parseModels(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

function toProviderDto(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: !!row.enabled,
    hasKey: row.api_key.length > 0,
    models: parseModels(row.models),
    enabledModels: parseModels(row.enabled_models),
    modelsFetchedAt: row.models_fetched_at,
    modelOverrides: parseModelOverrides(row.model_overrides),
    asrModel: row.asr_model ?? "",
  };
}

/**
 * 从 OpenAI 兼容供应商拉取模型列表（GET {baseUrl}/models），缓存进库后返回。
 * baseUrl 已含 /v1 前缀（如 http://host:8080/v1）。
 */
async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] } | unknown[];
  const list = Array.isArray(body) ? body : (body.data ?? []);
  const ids = list
    .map((m) => (typeof m === "string" ? m : (m as { id?: unknown })?.id))
    .filter((m): m is string => typeof m === "string" && m.length > 0)
    .sort((a, b) => a.localeCompare(b));
  if (!ids.length) throw new Error("供应商返回了空模型列表");
  return ids;
}

// ---------- AI 一句话生成专家配置（WorkBuddy expert-manager 式） ----------

const GEN_SYSTEM_PROMPT = `你是资深 AI 产品专家，为智能体办公平台设计「专家」配置。用户会用一句自然语言描述需求，请据此生成专家配置，严格输出 JSON，不要输出任何其他文字。字段：
- name：专家名称，4~10 个字，简洁有专业感
- description：一句话说明，不超过 40 字
- systemPrompt：该专家的完整系统提示词（200~500 字，中文，用第二人称），包含：角色定位与职责、工作方法与流程、产出与质量要求、边界（不做什么）
- tags：3~5 个能力标签，每个 2~6 个字`;

interface AgentTemplate {
  kw: RegExp;
  name: string;
  desc: string;
  tags: string[];
  prompt: (need: string) => string;
}

/** 无可用模型或模型调用失败时的内置模板兜底 */
const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    kw: /写|文案|内容|文章|公众号|小红书|编辑|脚本/,
    name: "内容写手",
    desc: "高质量中文内容创作、改写与润色",
    tags: ["写作", "文案", "润色"],
    prompt: (need) =>
      `你是一名资深内容写手。用户需求：${need}\n\n职责：根据主题产出结构清晰、有吸引力的中文内容；可改写与润色既有文稿。\n工作方式：先明确受众与发布渠道，拟定大纲再成文；写完自查语病、事实与重复用词。\n风格：文字干净、有节奏感，拒绝空话套话。\n产出：默认 Markdown；成稿写入工作区文件，并在回复中给出要点摘要。`,
  },
  {
    kw: /研究|调研|分析|洞察|行业|报告|竞品/,
    name: "行业研究员",
    desc: "结构化的行业研究与竞品分析",
    tags: ["研究", "分析", "报告"],
    prompt: (need) =>
      `你是一名严谨的行业研究员。用户需求：${need}\n\n职责：围绕主题做结构化研究，覆盖市场规模、格局、趋势与风险。\n工作方式：先拆解研究问题，再逐项收集与交叉验证信息，区分事实与推断并标注不确定性。\n产出：结构化研究报告（Markdown）写入工作区文件，结论先行、证据在后。`,
  },
  {
    kw: /翻译|本地化|多语言/,
    name: "翻译专家",
    desc: "忠实流畅的中外互译与本地化",
    tags: ["翻译", "本地化"],
    prompt: (need) =>
      `你是一名专业翻译。用户需求：${need}\n\n原则：忠实原意、表达地道，术语全篇一致；专业内容保留原文关键术语并括注。\n工作方式：先通读理解语境，再翻译，最后通读润色；对含糊处给出多种译法并说明取舍。\n产出：译文写入工作区文件，必要时附术语表。`,
  },
  {
    kw: /代码|开发|程序|工程|前端|后端|bug|测试/,
    name: "开发工程师",
    desc: "编码、排查与工程化实现",
    tags: ["编程", "调试", "工程化"],
    prompt: (need) =>
      `你是一名务实的开发工程师。用户需求：${need}\n\n职责：编写、审查与修复代码，产出可直接使用的文件。\n工作方式：先理解需求与现有目录结构，设计最小可行方案；实现后自测关键路径，说明已知限制。\n产出：代码文件写入工作区，回复中给出运行方式与变更清单。`,
  },
  {
    kw: /数据|报表|统计|excel|清洗|图表/,
    name: "数据分析师",
    desc: "数据清洗、统计与可视化结论",
    tags: ["数据", "统计", "报表"],
    prompt: (need) =>
      `你是一名细心的数据分析师。用户需求：${need}\n\n职责：完成数据清洗、统计分析与结论提炼。\n工作方式：先确认数据口径与字段含义，清洗异常值并记录处理规则；分析时区分相关与因果，给出口径一致的数字。\n产出：结论先行，附计算脚本与结果文件写入工作区。`,
  },
  {
    kw: /运营|增长|营销|投放|活动/,
    name: "增长运营",
    desc: "增长策略、活动与内容运营",
    tags: ["运营", "增长", "策划"],
    prompt: (need) =>
      `你是一名数据驱动的增长运营。用户需求：${need}\n\n职责：设计获客、留存与转化策略，策划可落地的活动。\n工作方式：先明确目标人群与北极星指标，给出可量化目标的方案，并说明预算、渠道与排期。\n产出：方案文档写入工作区，含指标基线与复盘口径。`,
  },
  {
    kw: /法务|法律|合同|合规|条款/,
    name: "法务顾问",
    desc: "合同审查与合规风险提示",
    tags: ["法务", "合规", "风险"],
    prompt: (need) =>
      `你是一名严谨的法务顾问。用户需求：${need}\n\n职责：审查文件、识别风险并给出修改建议。\n工作方式：逐条标注风险等级与依据，给出可直接使用的修改条款；不虚构法条，引用需注明来源。\n边界：仅提供分析建议，不构成正式法律意见，重大事项建议咨询执业律师。\n产出：审查意见写入工作区文件。`,
  },
  {
    kw: /财务|预算|会计|成本|报销/,
    name: "财务分析师",
    desc: "预算、成本与财务分析",
    tags: ["财务", "预算", "分析"],
    prompt: (need) =>
      `你是一名专业的财务分析师。用户需求：${need}\n\n职责：完成预算测算、成本分析与财务评估。\n工作方式：先确认口径与假设，测算过程给出公式与敏感性说明；数字需可复核。\n产出：分析结论写入工作区文件，附假设清单与计算表。`,
  },
  {
    kw: /设计|海报|视觉|logo|配图/,
    name: "视觉设计师",
    desc: "视觉方案与设计规范建议",
    tags: ["设计", "视觉", "规范"],
    prompt: (need) =>
      `你是一名审美在线的视觉设计师。用户需求：${need}\n\n职责：提出视觉方案与规范（配色、字体、版式、组件样式），用 HTML/CSS 等方式交付可预览稿。\n工作方式：先明确场景与受众，给出 1 个主方案与设计说明，避免堆砌装饰。\n产出：可预览的 HTML/样式文件写入工作区。`,
  },
  {
    kw: /客服|答疑|支持|工单|faq/,
    name: "客服专员",
    desc: "耐心准确的用户答疑与工单处理",
    tags: ["客服", "答疑"],
    prompt: (need) =>
      `你是一名耐心细致的客服专员。用户需求：${need}\n\n职责：解答产品与流程问题，整理工单与 FAQ。\n工作方式：先复述确认问题，再给出分步骤的解决办法；无法确定的信息明确告知并给出升级路径，不随意承诺。\n产出：简洁的回复话术与 FAQ 文档写入工作区。`,
  },
];

const GENERIC_TEMPLATE: AgentTemplate = {
  kw: /.*/,
  name: "智能助理",
  desc: "通用任务的智能助理",
  tags: ["通用", "助理"],
  prompt: (need) =>
    `你是一名高效的智能助理。用户需求：${need}\n\n职责：理解并拆解需求，逐步完成并汇报进展。\n工作方式：先确认目标与预期产出，再执行；遇到不确定处给出假设并继续，不中途停顿。\n产出：结果写入工作区文件，回复中给出结论与文件位置。`,
};

interface ChatCandidate {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

async function callChatCompletion(c: ChatCandidate, userPrompt: string): Promise<string> {
  const res = await fetch(`${c.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({
      model: c.modelId,
      stream: false,
      temperature: 0.6,
      max_tokens: 4000,
      messages: [
        { role: "system", content: GEN_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型返回为空");
  return content;
}

/** 容错解析模型输出：剥围栏、截取第一个 JSON 对象（导出仅为测试）。 */
export function parseGenerated(content: string): Pick<GeneratedAgent, "name" | "description" | "systemPrompt" | "tags"> | null {
  const stripped = content.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt.trim() : "";
    if (!name || !systemPrompt) return null;
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
      : [];
    return {
      name: name.slice(0, 30),
      description: typeof raw.description === "string" ? raw.description.trim().slice(0, 80) : "",
      systemPrompt: systemPrompt.slice(0, 4000),
      tags,
    };
  } catch {
    return null;
  }
}

interface AgentInput {
  name: string;
  description?: string;
  systemPrompt: string;
  providerId?: string;
  modelId?: string;
  tags?: string[];
  highRisk?: boolean;
  /** 显式绑定的技能名；缺省 = 不绑定行 = 使用全部平台技能（v1 兼容语义） */
  skills?: string[];
  /** 工具策略（P2-2）：工具名 → ask/deny；缺省/空 = 全部默认放行 */
  toolPolicy?: Record<string, "ask" | "deny"> | null;
}

/** 校验并落库一个专家（手动创建、专家包安装、专家包导入共用）。返回新专家 id。 */
function insertAgent(body: AgentInput): string {
  if (!body.name || !body.systemPrompt) throw new Error("name 和 systemPrompt 必填");
  // 默认模型可选（专家与模型解耦）；提供则必须成对且在供应商可用列表里
  const providerId = body.providerId?.trim() ?? "";
  const modelId = body.modelId?.trim() ?? "";
  if (!!providerId !== !!modelId) throw new Error("providerId 与 modelId 需同时提供（或不提供）");
  if (providerId) {
    const p = db.prepare("SELECT enabled_models FROM model_providers WHERE id = ?").get(providerId) as
      | { enabled_models: string }
      | undefined;
    if (!p) throw new Error("unknown providerId");
    if (!parseModels(p.enabled_models).includes(modelId)) throw new Error("模型不在该供应商的可用列表中");
  }
  const tags = (body.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  const toolPolicy = JSON.stringify(sanitizeToolPolicy(body.toolPolicy));
  const id = uuid();
  // 每位专家一个常驻文件夹（可从专家卡片打开），任务默认跑在这里
  const folder = path.join(paths.agentFolders, id);
  fs.mkdirSync(folder, { recursive: true });
  db.prepare(
    "INSERT INTO agents (id, name, description, system_prompt, provider_id, model_id, tags, folder, high_risk, tool_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, body.name, body.description ?? "", body.systemPrompt, providerId || null, modelId || null, JSON.stringify(tags), folder, body.highRisk ? 1 : 0, toolPolicy, now());
  if (Array.isArray(body.skills)) setAgentSkillBinding(id, body.skills);
  return id;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get("/admin/providers", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        "SELECT id, name, base_url, api_key, enabled, models, enabled_models, models_fetched_at, model_overrides, asr_model FROM model_providers ORDER BY created_at"
      )
      .all() as unknown as ProviderRow[];
    return rows.map(toProviderDto);
  });

  // 拉取供应商模型列表：实时请求 + 缓存
  app.get(
    "/admin/providers/:id/models",
    { onRequest: [app.authenticate], preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = db
        .prepare("SELECT id, base_url, api_key FROM model_providers WHERE id = ?")
        .get(id) as { id: string; base_url: string; api_key: string } | undefined;
      if (!row) return reply.code(404).send({ error: "provider not found" });
      try {
        const models = await fetchProviderModels(row.base_url, row.api_key);
        const fetchedAt = now();
        // 从未人工整理过启用列表时全部设为可用；已有勾选则保留
        const current = db.prepare("SELECT enabled_models, models_touched FROM model_providers WHERE id = ?").get(id) as
          | { enabled_models: string; models_touched: number }
          | undefined;
        const enabledModels =
          current && current.models_touched ? parseModels(current.enabled_models) : models;
        db.prepare(
          "UPDATE model_providers SET models = ?, models_fetched_at = ?, enabled_models = ?, models_touched = 1 WHERE id = ?"
        ).run(JSON.stringify(models), fetchedAt, JSON.stringify(enabledModels), id);
        return { models, enabledModels, fetchedAt };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: `获取模型列表失败：${reason}` });
      }
    }
  );

  app.post("/admin/providers", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { name?: string; baseUrl?: string; apiKey?: string };
    if (!body.name || !body.baseUrl || !body.apiKey) {
      return reply.code(400).send({ error: "name, baseUrl and apiKey are required" });
    }
    const id = uuid();
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(id, body.name, body.baseUrl, body.apiKey, now());
    return reply.code(201).send({ id });
  });

  app.patch("/admin/providers/:id", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      enabled?: boolean;
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      modelOverrides?: unknown;
      asrModel?: string;
    };
    const row = db.prepare("SELECT id FROM model_providers WHERE id = ?").get(id);
    if (!row) return reply.code(404).send({ error: "provider not found" });
    if (typeof body.enabled === "boolean") {
      db.prepare("UPDATE model_providers SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, id);
    }
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return reply.code(400).send({ error: "name cannot be empty" });
      db.prepare("UPDATE model_providers SET name = ? WHERE id = ?").run(name, id);
    }
    if (body.baseUrl !== undefined) {
      const baseUrl = body.baseUrl.trim();
      if (!baseUrl) return reply.code(400).send({ error: "baseUrl cannot be empty" });
      db.prepare("UPDATE model_providers SET base_url = ? WHERE id = ?").run(baseUrl, id);
    }
    if (body.apiKey !== undefined && body.apiKey.length > 0) {
      db.prepare("UPDATE model_providers SET api_key = ? WHERE id = ?").run(body.apiKey, id);
    }
    // 模型能力覆盖（contextWindow/maxTokens/reasoning），整段覆写；传空对象 = 清空覆盖
    if (body.modelOverrides !== undefined) {
      db.prepare("UPDATE model_providers SET model_overrides = ? WHERE id = ?").run(
        JSON.stringify(sanitizeModelOverrides(body.modelOverrides)),
        id
      );
    }
    // 显式指定语音识别（ASR）模型（传空字符串则清除显式绑定）
    if (body.asrModel !== undefined) {
      db.prepare("UPDATE model_providers SET asr_model = ? WHERE id = ?").run(body.asrModel.trim(), id);
    }
    return reply.send({ ok: true });
  });

  app.delete("/admin/providers/:id", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id FROM model_providers WHERE id = ?").get(id);
    if (!row) return reply.code(404).send({ error: "provider not found" });
    const used = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE provider_id = ? AND deleted = 0").get(id) as { n: number };
    if (used.n > 0) return reply.code(409).send({ error: "仍有专家使用该供应商，请先删除或改绑专家" });
    db.prepare("DELETE FROM model_providers WHERE id = ?").run(id);
    return reply.send({ ok: true });
  });

  // 手动维护模型：直接添加为可用模型（候选与启用列表都写入）
  app.post(
    "/admin/providers/:id/models",
    { onRequest: [app.authenticate], preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { model?: string };
      const model = body.model?.trim();
      if (!model) return reply.code(400).send({ error: "model is required" });
      const row = db.prepare("SELECT models, enabled_models FROM model_providers WHERE id = ?").get(id) as
        | { models: string; enabled_models: string }
        | undefined;
      if (!row) return reply.code(404).send({ error: "provider not found" });
      const models = parseModels(row.models);
      if (!models.includes(model)) models.push(model);
      models.sort((a, b) => a.localeCompare(b));
      const enabledModels = parseModels(row.enabled_models);
      if (!enabledModels.includes(model)) enabledModels.push(model);
      enabledModels.sort((a, b) => a.localeCompare(b));
      db.prepare("UPDATE model_providers SET models = ?, enabled_models = ?, models_fetched_at = ?, models_touched = 1 WHERE id = ?").run(
        JSON.stringify(models),
        JSON.stringify(enabledModels),
        now(),
        id
      );
      return { models, enabledModels };
    }
  );

  // 把候选模型启用为可用模型（不在线上列表里时一并补进缓存）
  app.post(
    "/admin/providers/:id/models/enable",
    { onRequest: [app.authenticate], preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { model?: string };
      const model = body.model?.trim();
      if (!model) return reply.code(400).send({ error: "model is required" });
      const row = db.prepare("SELECT models, enabled_models FROM model_providers WHERE id = ?").get(id) as
        | { models: string; enabled_models: string }
        | undefined;
      if (!row) return reply.code(404).send({ error: "provider not found" });
      const models = parseModels(row.models);
      if (!models.includes(model)) models.push(model);
      models.sort((a, b) => a.localeCompare(b));
      const enabledModels = parseModels(row.enabled_models);
      if (!enabledModels.includes(model)) enabledModels.push(model);
      enabledModels.sort((a, b) => a.localeCompare(b));
      db.prepare("UPDATE model_providers SET models = ?, enabled_models = ?, models_touched = 1 WHERE id = ?").run(
        JSON.stringify(models),
        JSON.stringify(enabledModels),
        id
      );
      return { models, enabledModels };
    }
  );

  // 取消启用：从可用列表移除，但保留在供应商候选列表里
  app.post(
    "/admin/providers/:id/models/disable",
    { onRequest: [app.authenticate], preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { model?: string };
      const model = body.model?.trim();
      if (!model) return reply.code(400).send({ error: "model is required" });
      const row = db.prepare("SELECT models, enabled_models FROM model_providers WHERE id = ?").get(id) as
        | { models: string; enabled_models: string }
        | undefined;
      if (!row) return reply.code(404).send({ error: "provider not found" });
      const enabledModels = parseModels(row.enabled_models).filter((m) => m !== model);
      db.prepare("UPDATE model_providers SET enabled_models = ?, models_touched = 1 WHERE id = ?").run(JSON.stringify(enabledModels), id);
      return { models: parseModels(row.models), enabledModels };
    }
  );

  // 从供应商模型列表中彻底移除（可用列表同步移除）
  app.delete(
    "/admin/providers/:id/models",
    { onRequest: [app.authenticate], preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = req.query as { model?: string };
      const model = query.model?.trim();
      if (!model) return reply.code(400).send({ error: "model query param is required" });
      const row = db.prepare("SELECT models, enabled_models FROM model_providers WHERE id = ?").get(id) as
        | { models: string; enabled_models: string }
        | undefined;
      if (!row) return reply.code(404).send({ error: "provider not found" });
      const models = parseModels(row.models).filter((m) => m !== model);
      const enabledModels = parseModels(row.enabled_models).filter((m) => m !== model);
      db.prepare("UPDATE model_providers SET models = ?, enabled_models = ?, models_fetched_at = ?, models_touched = 1 WHERE id = ?").run(
        JSON.stringify(models),
        JSON.stringify(enabledModels),
        now(),
        id
      );
      return { models, enabledModels };
    }
  );

  app.get("/admin/users", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    return db
      .prepare("SELECT id, username, role, created_at AS createdAt FROM users ORDER BY created_at")
      .all();
  });

  // 管理员重置任意用户密码：不需要旧密码，用于忘记密码的自救场景
  app.patch("/admin/users/:id/password", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { password?: string };
    if (!body.password || body.password.length < 6) {
      return reply.code(400).send({ error: "password must be at least 6 characters" });
    }
    if (!getUserById(id)) return reply.code(404).send({ error: "user not found" });
    updatePassword(id, body.password);
    return reply.send({ ok: true });
  });

  app.get("/admin/agents", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    return db
      .prepare(
        `SELECT a.id, a.name, a.description, a.system_prompt AS systemPrompt, a.provider_id AS providerId,
                a.model_id AS modelId, a.tags, a.folder, a.high_risk AS highRisk, a.tool_policy AS toolPolicy,
                p.name AS providerName
         FROM agents a LEFT JOIN model_providers p ON p.id = a.provider_id
         WHERE a.deleted = 0
         ORDER BY a.created_at`
      )
      .all()
      .map((row) => {
        const r = row as {
          id: string;
          name: string;
          description: string;
          systemPrompt: string;
          tags?: string;
          folder?: string;
          providerId?: string | null;
          modelId?: string | null;
          providerName?: string | null;
          highRisk?: number;
          toolPolicy?: string | null;
        };
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          systemPrompt: r.systemPrompt,
          providerId: r.providerId ?? "",
          modelId: r.modelId ?? "",
          providerName: r.providerName ?? "",
          folderPath: r.folder ?? path.join(paths.agentFolders, r.id),
          tags: parseModels(r.tags),
          highRisk: !!r.highRisk,
          // null = 未显式绑定（使用全部平台技能）；数组 = 显式绑定的技能名
          skills: getAgentSkillBinding(r.id) ?? null,
          // 工具策略：{} = 全部默认放行；键为工具名，mcp:* 通配单个连接器的全部工具
          toolPolicy: parseToolPolicy(r.toolPolicy),
        };
      });
  });

  app.post("/admin/agents", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as AgentInput;
    try {
      const id = insertAgent(body);
      return reply.code(201).send({ id });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // AI 一句话生成专家配置：真实模型优先（可用供应商逐个尝试），失败/无供应商时内置模板兜底
  app.post("/admin/agents/generate", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { prompt?: string; providerId?: string; modelId?: string };
    const prompt = body.prompt?.trim() ?? "";
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    if (prompt.length > 500) return reply.code(400).send({ error: "描述请控制在 500 字以内" });

    const enabled = db
      .prepare("SELECT id, base_url, api_key, enabled_models FROM model_providers WHERE enabled = 1 ORDER BY created_at")
      .all() as unknown as { id: string; base_url: string; api_key: string; enabled_models: string }[];
    const candidates: ChatCandidate[] = [];
    const providerId = body.providerId?.trim() ?? "";
    const modelId = body.modelId?.trim() ?? "";
    if (providerId && modelId) {
      const p = enabled.find((x) => x.id === providerId);
      if (p && parseModels(p.enabled_models).includes(modelId)) {
        candidates.push({ providerId: p.id, modelId, baseUrl: p.base_url, apiKey: p.api_key });
      }
    } else {
      for (const p of enabled) {
        const models = parseModels(p.enabled_models).filter(isChatModel);
        if (models.length) candidates.push({ providerId: p.id, modelId: models[0], baseUrl: p.base_url, apiKey: p.api_key });
      }
    }

    const failures: string[] = [];
    for (const c of candidates) {
      try {
        const parsed = parseGenerated(await callChatCompletion(c, prompt));
        if (!parsed) {
          failures.push(`${c.modelId}: 返回内容无法解析为配置`);
          continue;
        }
        return { ...parsed, source: "llm" } satisfies GeneratedAgent;
      } catch (err) {
        failures.push(`${c.modelId}: ${err instanceof Error ? err.message : "调用失败"}`);
      }
    }

    // 兜底：关键词匹配内置模板，并把原始需求写进系统提示词
    const tpl = AGENT_TEMPLATES.find((t) => t.kw.test(prompt)) ?? GENERIC_TEMPLATE;
    const note = candidates.length
      ? `模型生成不可用，已用内置模板兜底（${failures.join("；")}）`
      : "平台还没有启用任何对话模型，已用内置模板生成基础配置";
    return {
      name: tpl.name,
      description: tpl.desc,
      systemPrompt: tpl.prompt(prompt),
      tags: tpl.tags,
      source: "fallback",
      note,
    } satisfies GeneratedAgent;
  });

  // 编辑专家（卡片菜单「修改专家」）；常驻文件夹不随编辑变化
  app.put("/admin/agents/:id", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id, deleted FROM agents WHERE id = ?").get(id) as
      | { id: string; deleted: number }
      | undefined;
    if (!row || row.deleted) return reply.code(404).send({ error: "agent not found" });
    const body = req.body as {
      name?: string;
      description?: string;
      systemPrompt?: string;
      providerId?: string;
      modelId?: string;
      tags?: string[];
      highRisk?: boolean;
      skills?: string[];
      toolPolicy?: Record<string, "ask" | "deny"> | null;
    };
    if (!body.name || !body.systemPrompt) {
      return reply.code(400).send({ error: "name and systemPrompt are required" });
    }
    const providerId = body.providerId?.trim() ?? "";
    const modelId = body.modelId?.trim() ?? "";
    if (!!providerId !== !!modelId) {
      return reply.code(400).send({ error: "providerId 与 modelId 需同时提供（或不提供）" });
    }
    if (providerId) {
      const p = db.prepare("SELECT enabled_models FROM model_providers WHERE id = ?").get(providerId) as
        | { enabled_models: string }
        | undefined;
      if (!p) return reply.code(400).send({ error: "unknown providerId" });
      if (!parseModels(p.enabled_models).includes(modelId)) {
        return reply.code(400).send({ error: "模型不在该供应商的可用列表中" });
      }
    }
    const tags = (body.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
    db.prepare(
      "UPDATE agents SET name = ?, description = ?, system_prompt = ?, provider_id = ?, model_id = ?, tags = ?, high_risk = ?, tool_policy = ? WHERE id = ?"
    ).run(body.name, body.description ?? "", body.systemPrompt, providerId || null, modelId || null, JSON.stringify(tags), body.highRisk ? 1 : 0, JSON.stringify(sanitizeToolPolicy(body.toolPolicy)), id);
    // skills 字段出现即覆写绑定（空数组 = 不绑任何技能；不传 = 保持原绑定不变）
    if (Array.isArray(body.skills)) setAgentSkillBinding(id, body.skills);
    return reply.send({ ok: true });
  });

  // ---------- 平台级全局指令（AGENTS.md 分层指令，P2-3）：注入所有专家，专家提示词叠加其上 ----------

  app.get("/admin/instructions", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    return { content: readAgentsMd() };
  });

  app.put("/admin/instructions", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { content?: string };
    const content = typeof body.content === "string" ? body.content : "";
    if (content.length > AGENTS_MD_MAX_CHARS) {
      return reply.code(400).send({ error: `全局指令过长（上限 ${AGENTS_MD_MAX_CHARS} 字符）` });
    }
    writeAgentsMd(content);
    return reply.send({ ok: true });
  });

  // 删除专家：有历史任务时软删除（专家从列表消失，历史任务仍可查），否则物理删除
  app.delete("/admin/agents/:id", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id, deleted FROM agents WHERE id = ?").get(id) as
      | { id: string; deleted: number }
      | undefined;
    if (!row || row.deleted) return reply.code(404).send({ error: "agent not found" });
    const used = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ?").get(id) as { n: number };
    if (used.n > 0) {
      db.prepare("UPDATE agents SET deleted = 1 WHERE id = ?").run(id);
      return reply.send({ ok: true, mode: "soft" });
    }
    // agent_skills 外键指向 agents(id)：先清绑定行再删专家行，否则 FK 约束 500
    deleteAgentSkillBinding(id);
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return reply.send({ ok: true, mode: "hard" });
  });

  // ---------- 专家包（office-agent-package：可安装、可导入、可导出的插件化专家） ----------

  app.get("/admin/agents/catalog", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    return listBuiltinPacks();
  });

  // 从内置目录安装专家包：模型供应商安装时现场选择（包里不带模型环境属性）
  app.post("/admin/agents/install", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { packId?: string; providerId?: string; modelId?: string };
    const pkg = readBuiltinPack(body.packId ?? "");
    if (!pkg) return reply.code(404).send({ error: "expert pack not found" });
    try {
      const id = insertAgent({ ...pkg, providerId: body.providerId, modelId: body.modelId, skills: Object.keys(pkg.skills) });
      const skills = installPackageSkills(pkg);
      return reply.code(201).send({ id, skills: skills.installed, warnings: pkg.warnings ?? [] });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 导入专家包文件：multipart（file 字段）或直接 JSON body（包对象本身，或 { package, providerId, modelId }）
  app.post("/admin/agents/import", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    let raw: string;
    let providerId = "";
    let modelId = "";
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType.startsWith("multipart/")) {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "缺少专家包文件" });
      const chunks: Buffer[] = [];
      for await (const chunk of file.file) chunks.push(chunk as Buffer);
      raw = Buffer.concat(chunks).toString("utf8");
      providerId = String((file.fields.providerId as { value?: unknown } | undefined)?.value ?? "").trim();
      modelId = String((file.fields.modelId as { value?: unknown } | undefined)?.value ?? "").trim();
    } else {
      const body = req.body as (AgentInput & { package?: unknown }) | undefined;
      if (body && typeof body === "object" && "package" in body && body.package) {
        raw = JSON.stringify(body.package);
        providerId = body.providerId?.trim() ?? "";
        modelId = body.modelId?.trim() ?? "";
      } else if (body && typeof body === "object" && "format" in body) {
        raw = JSON.stringify(body);
      } else {
        return reply.code(400).send({ error: "请求体不是有效的专家包" });
      }
    }
    let pkg: AgentPackage;
    try {
      pkg = normalizeAgentPackage(JSON.parse(raw));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const id = insertAgent({ ...pkg, providerId, modelId, skills: Object.keys(pkg.skills) });
      const skills = installPackageSkills(pkg);
      return reply.code(201).send({ id, skills: skills.installed, warnings: pkg.warnings ?? [] });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 导出专家包：?skills=a,b 追加勾选的技能；skills=all 打包全部平台技能
  app.get("/admin/agents/:id/export", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare(
        "SELECT name, description, system_prompt AS systemPrompt, tags, high_risk AS highRisk FROM agents WHERE id = ? AND deleted = 0"
      )
      .get(id) as { name: string; description: string; systemPrompt: string; tags: string; high_risk: number } | undefined;
    if (!row) return reply.code(404).send({ error: "agent not found" });
    const requested = String((req.query as { skills?: string }).skills ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const wanted = requested.includes("all") ? listSkills().map((s) => s.name) : requested;
    const skills = wanted
      .map((n) => getSkill(n))
      .filter((s): s is NonNullable<ReturnType<typeof getSkill>> => !!s);
    const pkg = buildAgentPackage(
      { name: row.name, description: row.description, systemPrompt: row.systemPrompt, tags: parseModels(row.tags), highRisk: !!row.high_risk },
      skills
    );
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${pkg.name}.json`)}`);
    return JSON.stringify(pkg, null, 2);
  });

  // ---------- 技能（{agentDir}/skills/<name>/SKILL.md，所有专家共享） ----------

  app.get("/admin/skills", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    const usage = getSkillUsageMap();
    return listSkills().map((s) => ({ ...s, usageCount: usage[s.name]?.count ?? 0, lastUsedAt: usage[s.name]?.lastUsedAt ?? null }));
  });

  app.get("/admin/skills/:name", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const skill = getSkill(name);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    return skill;
  });

  app.post("/admin/skills", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { name?: string; description?: string; content?: string; argumentHint?: string; alias?: string };
    const name = body.name?.trim() ?? "";
    if (!name || !body.content?.trim()) return reply.code(400).send({ error: "name 和 content 必填" });
    try {
      createSkill(name, body.description?.trim() ?? "", body.content, {
        argumentHint: body.argumentHint?.trim() || undefined,
        alias: body.alias?.trim() || undefined,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return reply.code(201).send({ ok: true });
  });

  app.put("/admin/skills/:name", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!skillExists(name)) return reply.code(404).send({ error: "skill not found" });
    const body = req.body as { description?: string; content?: string; argumentHint?: string; alias?: string };
    if (!body.content?.trim()) return reply.code(400).send({ error: "content 必填" });
    try {
      const current = getSkill(name)!;
      // 参数提示/别名未提供时保留原值（与 updateSkill 的 frontmatter 合并语义一致）
      updateSkill(name, body.description?.trim() ?? current.description, body.content, {
        argumentHint: body.argumentHint?.trim() ?? current.argumentHint,
        alias: body.alias?.trim() ?? current.alias,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return reply.send({ ok: true });
  });

  app.delete("/admin/skills/:name", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name) || !skillExists(name)) return reply.code(404).send({ error: "skill not found" });
    deleteSkill(name);
    removeSkillSource(name);
    return reply.send({ ok: true });
  });

  // ---------- 技能安装与同步（skill_sources 登记，支持安装后一键同步更新） ----------

  // 技能市场：内置目录 + 已安装技能的来源登记（有登记的技能可同步）
  app.get("/admin/skills/catalog", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    const sources: Record<
      string,
      { source: string; kind: string; revision: string; syncedAt: string; hasUpdate?: boolean; note?: string }
    > = {};
    // 漂移检测需要访问源（网络/磁盘），失败只降级为「未知」，不影响市场列表本身
    let updates: Awaited<ReturnType<typeof listSkillUpdates>> = [];
    try {
      updates = await listSkillUpdates();
    } catch {
      // 检测失败按无信息处理
    }
    for (const s of listSkills()) {
      const info = getSourceInfo(s.name);
      if (info) {
        const upd = updates.find((u) => u.source === info.source);
        sources[s.name] = {
          source: info.source,
          kind: info.kind,
          revision: info.revision,
          syncedAt: info.syncedAt,
          hasUpdate: upd?.hasUpdate,
          note: upd?.note || undefined,
        };
      }
    }
    return { catalog: listBuiltinSkills(), sources };
  });

  // 漂移检测（P2-4）：按来源分组比对登记修订与源端最新指纹（git sha / 内容哈希）
  app.get("/admin/skills/updates", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return { updates: await listSkillUpdates() };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 批量同步：按登记来源逐个重拉（源里删掉的移除、新增的补装、已有的一律覆盖）
  app.post("/admin/skills/sync-all", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return await syncAllSkills();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 安装：来源可以是内置目录名、https:// 的 Markdown 直链或仓库地址、git: 仓库、本机路径
  app.post("/admin/skills/install", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { source?: string; overwrite?: boolean };
    if (!body.source?.trim()) return reply.code(400).send({ error: "source is required" });
    try {
      const outcome = await installSkillFromSource(body.source, { overwrite: body.overwrite === true });
      return reply.code(201).send(outcome);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 同步：按登记来源重拉该来源下全部技能（源里删掉的本地移除，新增的补装）
  app.post("/admin/skills/:name/sync", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!getSourceInfo(name)) return reply.code(400).send({ error: "该技能不是通过安装获得的，无法同步" });
    try {
      return await syncSkill(name);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 连接器（MCP stdio / streamable HTTP 服务器） ----------

  app.get("/admin/mcp", { onRequest: [app.authenticate], preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        "SELECT id, name, command, args, env, enabled, type, url, headers, tools, tools_checked_at, startup_timeout_sec, tool_timeout_sec, disabled_tools, created_at FROM mcp_servers ORDER BY created_at"
      )
      .all() as unknown as Parameters<typeof toMcpDto>[0][];
    return rows.map(toMcpDto);
  });

  app.post("/admin/mcp", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name?: string;
      type?: string;
      command?: string;
      args?: unknown;
      env?: unknown;
      url?: string;
      headers?: unknown;
      disabledTools?: unknown;
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    };
    const name = body.name?.trim() ?? "";
    const type = body.type === "http" ? "http" : "stdio";
    const command = body.command?.trim() ?? "";
    const url = body.url?.trim() ?? "";
    if (!name) return reply.code(400).send({ error: "name 必填" });
    if (type === "http") {
      if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: "HTTP 连接器需要 http(s) 的 url" });
    } else if (!command) {
      return reply.code(400).send({ error: "stdio 连接器需要 command" });
    }
    const args = Array.isArray(body.args) ? body.args.map((a) => String(a)) : [];
    const env = sanitizeEnv(body.env);
    const headers = sanitizeHeaders(body.headers);
    const disabledTools = sanitizeStringList(body.disabledTools);
    const startupTimeoutSec = clampTimeout(body.startupTimeoutSec, 10);
    const toolTimeoutSec = clampTimeout(body.toolTimeoutSec, 60);
    const id = uuid();
    db.prepare(
      "INSERT INTO mcp_servers (id, name, command, args, env, enabled, tools, type, url, headers, startup_timeout_sec, tool_timeout_sec, disabled_tools, created_at) VALUES (?, ?, ?, ?, ?, 1, '[]', ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, name, command, JSON.stringify(args), JSON.stringify(env), type, url, JSON.stringify(headers), startupTimeoutSec, toolTimeoutSec, JSON.stringify(disabledTools), now());
    return reply.code(201).send({ id });
  });

  // 编辑连接器：命令/参数/环境/URL/头部/超时变化后丢弃缓存的客户端，下次调用按新配置重连
  app.patch("/admin/mcp/:id", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id, type FROM mcp_servers WHERE id = ?").get(id) as
      | { id: string; type: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "connector not found" });
    const body = req.body as {
      name?: string;
      command?: string;
      args?: unknown;
      env?: unknown;
      enabled?: boolean;
      url?: string;
      headers?: unknown;
      disabledTools?: unknown;
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    };
    let reconnect = false;
    if (typeof body.enabled === "boolean") {
      db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, id);
      if (!body.enabled) closeMcpClient(id);
    }
    if (body.name !== undefined && body.name.trim()) {
      db.prepare("UPDATE mcp_servers SET name = ? WHERE id = ?").run(body.name.trim(), id);
    }
    if (body.command !== undefined && body.command.trim()) {
      db.prepare("UPDATE mcp_servers SET command = ? WHERE id = ?").run(body.command.trim(), id);
      reconnect = true;
    }
    if (Array.isArray(body.args)) {
      db.prepare("UPDATE mcp_servers SET args = ? WHERE id = ?").run(JSON.stringify(body.args.map((a) => String(a))), id);
      reconnect = true;
    }
    if (body.env !== undefined) {
      db.prepare("UPDATE mcp_servers SET env = ? WHERE id = ?").run(JSON.stringify(sanitizeEnv(body.env)), id);
      reconnect = true;
    }
    // 远程连接器（P2-1）：url / headers 变化同样需要重连
    if (body.url !== undefined) {
      const url = body.url.trim();
      if (url && !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: "url 需为 http(s) 地址" });
      db.prepare("UPDATE mcp_servers SET url = ? WHERE id = ?").run(url, id);
      reconnect = true;
    }
    if (body.headers !== undefined) {
      db.prepare("UPDATE mcp_servers SET headers = ? WHERE id = ?").run(JSON.stringify(sanitizeHeaders(body.headers)), id);
      reconnect = true;
    }
    if (body.startupTimeoutSec !== undefined) {
      db.prepare("UPDATE mcp_servers SET startup_timeout_sec = ? WHERE id = ?").run(clampTimeout(body.startupTimeoutSec, 10), id);
      reconnect = true;
    }
    if (body.toolTimeoutSec !== undefined) {
      db.prepare("UPDATE mcp_servers SET tool_timeout_sec = ? WHERE id = ?").run(clampTimeout(body.toolTimeoutSec, 60), id);
      reconnect = true;
    }
    // 禁用工具只影响注入时的过滤，不用重连
    if (body.disabledTools !== undefined) {
      db.prepare("UPDATE mcp_servers SET disabled_tools = ? WHERE id = ?").run(JSON.stringify(sanitizeStringList(body.disabledTools)), id);
    }
    if (reconnect) invalidateMcpClient(id);
    return reply.send({ ok: true });
  });

  // 导入 .mcp.json（Claude/Codex 互操作格式）：stdio 与远程 HTTP 服务器，按 name upsert
  app.post("/admin/mcp/import", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { mcpServers?: unknown };
    const servers = body?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return reply.code(400).send({ error: "请求体需为 { mcpServers: { 名称: { command, args?, env? } 或 { type: \"http\", url, headers? } } }" });
    }
    const imported: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const [name, rawCfg] of Object.entries(servers as Record<string, unknown>)) {
      const cfg = (rawCfg ?? {}) as { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown };
      const type = cfg.type === "http" || cfg.type === "sse" ? "http" : "stdio";
      if (type === "http") {
        const url = typeof cfg.url === "string" ? cfg.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          skipped.push({ name, reason: "缺少有效的 url（远程服务器需 http(s) 地址）" });
          continue;
        }
        const headers = sanitizeHeaders(cfg.headers);
        const existing = db.prepare("SELECT id FROM mcp_servers WHERE name = ?").get(name) as { id: string } | undefined;
        if (existing) {
          db.prepare("UPDATE mcp_servers SET type = 'http', url = ?, headers = ?, command = '', args = '[]', env = '{}' WHERE id = ?").run(
            url,
            JSON.stringify(headers),
            existing.id
          );
          invalidateMcpClient(existing.id);
        } else {
          db.prepare(
            "INSERT INTO mcp_servers (id, name, command, args, env, enabled, tools, type, url, headers, created_at) VALUES (?, ?, '', '[]', '{}', 1, '[]', 'http', ?, ?, ?)"
          ).run(uuid(), name, url, JSON.stringify(headers), now());
        }
        imported.push(name);
        continue;
      }
      const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
      if (!command) {
        skipped.push({ name, reason: "缺少 command（stdio 服务器必填）" });
        continue;
      }
      const args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
      const env = sanitizeEnv(cfg.env);
      const existing = db.prepare("SELECT id FROM mcp_servers WHERE name = ?").get(name) as { id: string } | undefined;
      if (existing) {
        db.prepare("UPDATE mcp_servers SET type = 'stdio', command = ?, args = ?, env = ?, url = '', headers = '{}' WHERE id = ?").run(
          command,
          JSON.stringify(args),
          JSON.stringify(env),
          existing.id
        );
        invalidateMcpClient(existing.id);
      } else {
        db.prepare(
          "INSERT INTO mcp_servers (id, name, command, args, env, enabled, tools, type, created_at) VALUES (?, ?, ?, ?, ?, 1, '[]', 'stdio', ?)"
        ).run(uuid(), name, command, JSON.stringify(args), JSON.stringify(env), now());
      }
      imported.push(name);
    }
    return { imported, skipped };
  });

  // 导出为 .mcp.json 互操作格式（仅启用的服务器；env/headers 原样导出，注意密钥）
  app.get("/admin/mcp/export", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (_req, reply) => {
    const rows = db
      .prepare("SELECT name, command, args, env, type, url, headers FROM mcp_servers WHERE enabled = 1 ORDER BY created_at")
      .all() as unknown as Array<{ name: string; command: string; args: string; env: string; type: string; url: string; headers: string }>;
    const mcpServers: Record<string, unknown> = {};
    for (const r of rows) {
      if (r.type === "http") {
        mcpServers[r.name] = {
          type: "http",
          url: r.url,
          headers: JSON.parse(r.headers || "{}") as Record<string, string>,
        };
      } else {
        mcpServers[r.name] = {
          command: r.command,
          args: JSON.parse(r.args || "[]") as string[],
          env: JSON.parse(r.env || "{}") as Record<string, string>,
        };
      }
    }
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="mcp.json"');
    return JSON.stringify({ mcpServers }, null, 2);
  });

  app.delete("/admin/mcp/:id", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id FROM mcp_servers WHERE id = ?").get(id);
    if (!row) return reply.code(404).send({ error: "connector not found" });
    closeMcpClient(id);
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return reply.send({ ok: true });
  });

  // 测试连接：握手 + 拉取工具列表并缓存（返回全量列表，注入时才按 disabledTools 过滤）
  app.post("/admin/mcp/:id/test", { onRequest: [app.authenticate], preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare(
        "SELECT id, name, command, args, env, enabled, type, url, headers, startup_timeout_sec, tool_timeout_sec, disabled_tools FROM mcp_servers WHERE id = ?"
      )
      .get(id) as unknown as Parameters<typeof probeMcpTools>[0] | undefined;
    if (!row) return reply.code(404).send({ error: "connector not found" });
    try {
      const tools = await probeMcpTools(row);
      db.prepare("UPDATE mcp_servers SET tools = ?, tools_checked_at = ? WHERE id = ?").run(
        JSON.stringify(tools),
        now(),
        id
      );
      return { ok: true, tools };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `连接失败：${reason}` });
    }
  });
}

/** HTTP 连接器请求头归一化：字符串键值对；${ENV} 引用保留原样（发送时才展开，令牌不落库）。 */
function sanitizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && k.trim() && typeof v === "string") out[k.trim()] = v;
  }
  return out;
}

function sanitizeEnv(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}
