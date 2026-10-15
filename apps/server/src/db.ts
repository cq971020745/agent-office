import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";

// db.ts 在模块加载即打开连接，目录必须先于任何导入方就绪
fs.mkdirSync(path.dirname(paths.db), { recursive: true });

export const db = new Database(paths.db);
db.pragma("journal_mode = WAL");

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  workspace_path TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  filename TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function migrate(): void {
  db.exec(SCHEMA_V1);
  // V2：供应商模型缓存 + 专家标签。列已存在时忽略。
  for (const sql of [
    "ALTER TABLE model_providers ADD COLUMN models TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE model_providers ADD COLUMN models_fetched_at TEXT",
    "ALTER TABLE agents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
    // V3：供应商下勾选启用的模型（专家只能选用已启用的模型）；models_touched 标记是否人工整理过
    "ALTER TABLE model_providers ADD COLUMN enabled_models TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE model_providers ADD COLUMN models_touched INTEGER NOT NULL DEFAULT 0",
    // V4：任务级模型选择（专家与模型解耦；空值表示用专家默认模型）
    "ALTER TABLE tasks ADD COLUMN provider_id TEXT",
    "ALTER TABLE tasks ADD COLUMN model_id TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // duplicate column name
    }
  }
  // V4b：agents.provider_id/model_id 放宽为可空（专家可不绑定默认模型，派发时再选）。
  // better-sqlite3 默认开启外键，'' 不指向任何供应商会违反约束，须存 NULL —— 只能重建表。
  const providerNotnull = db
    .prepare("SELECT \"notnull\" AS n FROM pragma_table_info('agents') WHERE name = 'provider_id'")
    .get() as { n: number } | undefined;
  if (providerNotnull?.n) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE agents_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL,
        provider_id TEXT REFERENCES model_providers(id),
        model_id TEXT,
        created_at TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO agents_new (id, name, description, system_prompt, provider_id, model_id, created_at, tags)
        SELECT id, name, description, system_prompt, provider_id, model_id, created_at, tags FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_new RENAME TO agents;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  // V5：专家软删除（有历史任务时 DELETE 走软删，历史仍可查）
  try {
    db.exec("ALTER TABLE agents ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  } catch {
    // duplicate column name
  }
  // V5：用户自选工作目录的任务（0 = 平台隔离工作区，1 = 用户选择的目录）
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN custom_workspace INTEGER NOT NULL DEFAULT 0");
  } catch {
    // duplicate column name
  }
  // V6：高风险专家（派发任务先出执行清单，用户逐项确认后才继续执行）
  try {
    db.exec("ALTER TABLE agents ADD COLUMN high_risk INTEGER NOT NULL DEFAULT 0");
  } catch {
    // duplicate column name
  }
  // V5：MCP 连接器（stdio 服务器）
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      tools TEXT NOT NULL DEFAULT '[]',
      tools_checked_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  // 兼容旧数据：已有模型缓存但从未人工整理过的供应商，视为全部可用
  db.prepare(
    "UPDATE model_providers SET enabled_models = models, models_touched = 1 WHERE models_touched = 0 AND enabled_models = '[]' AND models != '[]'"
  ).run();

  // V6：专家常驻文件夹（WorkBuddy 式，卡片可直接打开；任务默认跑在该目录）
  try {
    db.exec("ALTER TABLE agents ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
  } catch {
    // duplicate column name
  }
  const noFolder = db.prepare("SELECT id FROM agents WHERE folder = ''").all() as { id: string }[];
  if (noFolder.length) {
    fs.mkdirSync(paths.agentFolders, { recursive: true });
    const fix = db.prepare("UPDATE agents SET folder = ? WHERE id = ?");
    for (const a of noFolder) {
      const dir = path.join(paths.agentFolders, a.id);
      fs.mkdirSync(dir, { recursive: true });
      fix.run(dir, a.id);
    }
  }

  // V7：任务派发时上传的附件（rel_path 相对任务工作区）。上传件是任务的输入而非成果，
  // 成果物扫描时要排除。
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_uploads (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      rel_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, rel_path)
    );
  `);

  // V8：技能安装来源登记（可安装/可同步）。name 即技能目录名；kind: builtin/url/git/local。
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_sources (
      name TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL
    );
  `);

  // V9：MCP 连接器超时可配 + per-tool 禁用（对标 Codex startup/tool_timeout_sec 与工具筛选）
  for (const sql of [
    "ALTER TABLE mcp_servers ADD COLUMN startup_timeout_sec INTEGER NOT NULL DEFAULT 10",
    "ALTER TABLE mcp_servers ADD COLUMN tool_timeout_sec INTEGER NOT NULL DEFAULT 60",
    "ALTER TABLE mcp_servers ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]'",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // duplicate column name
    }
  }

  // V9：专家↔技能绑定。无行 = 未显式绑定 = 自动使用全部平台技能（v1 兼容语义）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      skill_name TEXT NOT NULL,
      PRIMARY KEY (agent_id, skill_name)
    );
  `);

  // V10：P2 批次——远程 MCP（type/url/headers）、专家级工具策略、模型能力元数据
  for (const sql of [
    "ALTER TABLE mcp_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'stdio'",
    "ALTER TABLE mcp_servers ADD COLUMN url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE agents ADD COLUMN tool_policy TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE model_providers ADD COLUMN model_overrides TEXT NOT NULL DEFAULT '{}'",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // duplicate column name
    }
  }

  // V10：技能激活计数（read_skill / 斜杠调用埋点），反哺市场精选与闲置清理决策
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      name TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT
    );
  `);

  // V11：WPS 365 当前账号缓存（设置页「同步」按钮写入，@ 弹层与任务注入读取）
  db.exec(`
    CREATE TABLE IF NOT EXISTS wps_profile (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      profile TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
  `);

  // V12：任务上下文附注列——附件清单与 @ 引用只注入模型首轮，不再拼进展示用 prompt。
  // 顺带清洗本批之前已把 <wps_mentions> 块写进 prompt / 首条用户消息的历史任务。
  {
    const stripMentions = (text: string): string =>
      text.replace(/\n*<wps_mentions>[\s\S]*?<\/wps_mentions>\n*/g, "\n").trim();
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "context_note")) {
      db.exec("ALTER TABLE tasks ADD COLUMN context_note TEXT NOT NULL DEFAULT ''");
    }
    const dirtyTasks = db
      .prepare("SELECT id, prompt FROM tasks WHERE prompt LIKE '%<wps_mentions>%'")
      .all() as { id: string; prompt: string }[];
    for (const t of dirtyTasks) {
      const cleaned = stripMentions(t.prompt);
      db.prepare("UPDATE tasks SET prompt = ? WHERE id = ?").run(cleaned, t.id);
      db.prepare(
        "UPDATE task_messages SET content = ? WHERE task_id = ? AND role = 'user' AND content LIKE '%<wps_mentions>%'"
      ).run(cleaned, t.id);
    }
  }
}

// 内置默认专家「通用助手」：专家非必选——派发任务时未指定专家则落到这里。
// 模型默认取最早创建的可用供应商的可用模型；没有可用供应商时留空，
// 由「创建任务须显式选模型」的既有校验兜底提示。
export function ensureDefaultAgent(): void {
  const DEFAULT_ID = "builtin-general-assistant";
  const exists = db.prepare("SELECT id FROM agents WHERE id = ?").get(DEFAULT_ID);
  if (exists) return;
  const provider = db
    .prepare(
      "SELECT p.id AS provider_id, p.enabled_models FROM model_providers p WHERE p.enabled = 1 ORDER BY p.created_at DESC LIMIT 1"
    )
    .get() as { provider_id: string; enabled_models: string } | undefined;
  const modelId = provider ? (parseFirstModel(provider.enabled_models) ?? "") : "";
  db.prepare(
    "INSERT INTO agents (id, name, description, system_prompt, provider_id, model_id, tags, folder, high_risk, tool_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?)"
  ).run(
    DEFAULT_ID,
    "通用助手",
    "内置默认专家：未选择专家时的兜底，可处理日常问答、写作、查询等通用办公任务",
    [
      "你是「通用助手」，Agent Office 的内置默认专家。",
      "职责：在用户没有指定专家时承接任务，覆盖日常办公问答、文案撰写、资料整理、信息查询等通用场景。",
      "行为准则：直接解决问题，不推荐其他专家；任务超出能力或需要 WPS 365 数据时，按技能说明加载并使用对应技能。",
    ].join("\n"),
    provider?.provider_id ?? null,
    modelId || null,
    JSON.stringify(["内置"]),
    "{}",
    now()
  );
  console.log(`[agents] 已创建内置默认专家「通用助手」`);
}

function parseFirstModel(enabledModels: string): string | undefined {
  try {
    const arr: unknown = JSON.parse(enabledModels);
    if (Array.isArray(arr) && typeof arr[0] === "string") return arr[0];
  } catch {
    // 非法 JSON 视为未配置
  }
  return undefined;
}

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
