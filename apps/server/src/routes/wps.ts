import type { FastifyInstance } from "fastify";
import type { WpsContacts, WpsDirectoryEntry, WpsMentionItem, WpsMentionType, WpsProfile } from "@office/shared";
import { currentUser, getUserPhone } from "../auth.js";
import { db, now } from "../db.js";
import { extractLastJsonBlock, runSkillScript, wpsConfigured, wpsSidecarEnv, WPS_SKILL_NAME } from "../skill-scripts.js";
import { isWpsSessionError, runEnvGate, stripWarningNoise } from "../wps-env-gate.js";

// ---------- 各数据源脚本输出的归一化（正文 Markdown 忽略，只解析末尾 JSON 围栏） ----------

/** 剥掉搜索高亮标记 <em>x</em> → x */
const clean = (s: unknown): string => String(s ?? "").replace(/<\/?em>/g, "").trim();

/** 完整 11 位手机号才参与比对；空号或脱敏号返回空。 */
function fullPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return /^1\d{10}$/.test(digits) ? digits : "";
}

type AnyRecord = Record<string, unknown>;

function asRecords(items: unknown): AnyRecord[] {
  return Array.isArray(items) ? (items as AnyRecord[]).filter((i) => i && typeof i === "object") : [];
}

function normalizeContacts(json: unknown, q: string): WpsMentionItem[] {
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => {
      const name = clean(it.nick_name) || clean(it.name);
      return {
        type: "contact" as WpsMentionType,
        id: clean(it.id),
        name,
        subtitle: clean(it.def_dept_name),
      };
    })
    .filter((it) => it.id && (!q || it.name.toLowerCase().includes(q.toLowerCase())))
    .slice(0, 12);
}

function normalizeChats(json: unknown, q: string): WpsMentionItem[] {
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => {
      const chat = (it.chat ?? {}) as AnyRecord;
      const type = clean(chat.type);
      return {
        type: "chat" as WpsMentionType,
        id: clean(chat.id),
        name: clean(chat.name),
        subtitle: type === "p2p" ? "单聊" : type === "group" ? "群聊" : type,
      };
    })
    .filter((it) => it.id && it.name && (!q || it.name.toLowerCase().includes(q.toLowerCase())))
    .slice(0, 12);
}

function normalizeDrive(json: unknown, q: string): WpsMentionItem[] {
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => {
      const file = (it.file ?? {}) as AnyRecord;
      const size = Number(file.size);
      return {
        type: "doc" as WpsMentionType,
        id: clean(file.id),
        name: clean(file.name),
        subtitle: Number.isFinite(size) && size > 0 ? `${Math.max(1, Math.round(size / 1024))} KB` : "云文档",
      };
    })
    .filter((it) => it.id && (!q || it.name.toLowerCase().includes(q.toLowerCase())))
    .slice(0, 50);
}

/** 最近文档（drive latest）：items[].file.{id, name, size, type, mtime}，与 Comate 云文档 tab 同源 */
function normalizeLatest(json: unknown): WpsMentionItem[] {
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => {
      const file = (it.file ?? {}) as AnyRecord;
      const size = Number(file.size);
      const mtime = clean(file.mtime).slice(0, 10);
      return {
        type: "doc" as WpsMentionType,
        id: clean(file.id),
        name: clean(file.name),
        subtitle: Number.isFinite(size) && size > 0 ? `${Math.max(1, Math.round(size / 1024))} KB` : mtime || "云文档",
      };
    })
    .filter((it) => it.id && it.name)
    .slice(0, 50);
}

/** 会议记录（meeting list-records）：items[].{id, title, source_type, create_time} */
function normalizeMeetings(json: unknown, q: string): WpsMentionItem[] {
  const SOURCE_LABELS: Record<string, string> = {
    minute: "会议纪要",
    record: "会议录制",
    import: "导入录制",
  };
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => ({
      type: "meeting" as WpsMentionType,
      id: clean(it.id),
      name: clean(it.title),
      subtitle: SOURCE_LABELS[clean(it.source_type)] ?? clean(it.source_type) ?? "会议",
    }))
    .filter((it) => it.id && it.name && (!q || it.name.toLowerCase().includes(q.toLowerCase())))
    .slice(0, 30);
}

/** 知识库（drive doclibs，紫金私网列库唯一入口；ai-docs list-spaces 仅公网）：items[].{drive:{id,name}, user_role} */
const KB_ROLE_LABELS: Record<string, string> = { owner: "拥有者", admin: "管理员", normal: "成员" };

function normalizeDoclibsKb(json: unknown, q: string): WpsMentionItem[] {
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => {
      const drive = (it.drive ?? {}) as AnyRecord;
      return {
        type: "kb" as WpsMentionType,
        id: clean(drive.id),
        name: clean(drive.name),
        subtitle: KB_ROLE_LABELS[clean(it.user_role)] ?? "知识库",
      };
    })
    .filter((it) => it.id && it.name && (!q || it.name.toLowerCase().includes(q.toLowerCase())));
}

/** 部门成员列表（contacts list-dept-members）：items[].{user_id, user_info:{id, nick_name}} */
function normalizeDeptMembers(json: unknown, deptName: string): WpsMentionItem[] {
  return asRecords((json as { items?: unknown })?.items)
    .map((it) => {
      const info = (it.user_info ?? {}) as AnyRecord;
      return {
        type: "contact" as WpsMentionType,
        id: clean(info.id) || clean(it.user_id),
        name: clean(info.nick_name) || clean(info.name),
        subtitle: deptName || "同部门",
      };
    })
    .filter((it) => it.id && it.name)
    .slice(0, 12);
}

/** 云盘根目录列表（drive list，扁平结构）：items[].{id, name, type, size}，过滤文件夹 */
async function searchScript(mod: string, args: string[], timeoutMs: number): Promise<unknown> {
  const res = await runSkillScript(WPS_SKILL_NAME, `skills/${mod}/run.py`, args, timeoutMs);
  const json = extractLastJsonBlock(res.stdout);
  if (!json) throw new Error(`${mod} 输出中没有可解析的 JSON 数据块`);
  return json;
}

async function settled(fn: () => Promise<WpsMentionItem[]>): Promise<WpsMentionItem[]> {
  try {
    return await fn();
  } catch {
    // 单一数据源失败（网络抖动/私网不支持等）不拖垮整个弹层
    return [];
  }
}

/** 同步用户缓存行（wps_profile 表，user_id 即平台用户 id） */
function upsertProfile(userId: string, profile: WpsProfile): void {
  db.prepare(
    "INSERT INTO wps_profile (user_id, profile, synced_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, synced_at = excluded.synced_at"
  ).run(userId, JSON.stringify(profile), profile.syncedAt);
}

// ---------- 同步（带环境闸门自愈） ----------

/** 手机号不一致等业务性失败：直接以对应状态码返回，不再触发环境闸门 */
class WpsSyncError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

/** 跑 user-current 脚本拿当前登录账号（machine-readable 数据在末尾 JSON 围栏里） */
async function fetchMeBase(envOverride?: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await runSkillScript(WPS_SKILL_NAME, "skills/user-current/run.py", ["me_base"], 30_000, undefined, envOverride);
  const me = extractLastJsonBlock<Record<string, unknown>>(res.stdout);
  if (!me?.id) {
    const detail = stripWarningNoise((res.stderr || res.stdout || "无输出").trim()).slice(0, 300);
    throw new Error(`脚本未返回账号信息：${detail}`);
  }
  return me;
}

function profileFrom(me: Record<string, unknown>): WpsProfile {
  const depts = Array.isArray(me.depts) ? (me.depts as AnyRecord[]) : [];
  return {
    id: clean(me.id),
    name: clean(me.nick_name) || clean(me.name) || clean(me.user_name),
    defDeptId: clean(me.def_dept_id) || clean(depts[0]?.id),
    deptName: clean(depts[0]?.name),
    deptPath: clean(depts[0]?.abs_path),
    email: clean(me.email),
    phone: clean(me.phone),
    avatar: clean(me.avatar),
    syncedAt: now(),
  };
}

/** 账号落库前的校验（手机号一致性）与写缓存；失败抛 WpsSyncError */
function persistSyncedProfile(userId: string, me: Record<string, unknown>): { configured: true; profile: WpsProfile } {
  const profile = profileFrom(me);
  const kbPhone = fullPhone(getUserPhone(userId));
  const wpsPhone = fullPhone(profile.phone);
  if (kbPhone && wpsPhone && kbPhone !== wpsPhone) {
    throw new WpsSyncError(409, "紫金协作手机号与企业知识库账号不一致，未关联");
  }
  upsertProfile(userId, profile);
  return { configured: true, profile };
}

// ---------- 全量通讯录（组织结构化） ----------

const DIRECTORY_TTL_MS = 30 * 60_000;
// 组织架构目录与平台用户无关，全员共享同一份；并发请求合并为一次拉取
let directoryCache: { at: number; data: WpsContacts } | null = null;
let directoryInflight: Promise<WpsContacts> | null = null;

async function fetchDirectory(): Promise<WpsContacts> {
  const rootJson = (await searchScript("contacts", ["get-root-dept"], 30_000)) as AnyRecord;
  const rootId = clean(rootJson.id);
  const rootName = clean(rootJson.name);
  if (!rootId) throw new Error("get-root-dept 未返回根部门 id");

  // 递归拉全集团成员（技能内按 offset 自动翻页；1100+ 人约 6 秒）
  const membersJson = (await searchScript(
    "contacts",
    ["list-dept-members", rootId, "--all", "--recursive", "--max-pages", "100"],
    120_000
  )) as AnyRecord;

  // 成员条目只带 dept_id，批量补部门名与组织路径
  const deptIds = [...new Set(asRecords(membersJson.items).map((m) => clean(m.dept_id)).filter(Boolean))];
  const deptById = new Map<string, { name: string; path: string }>();
  for (let i = 0; i < deptIds.length; i += 50) {
    const chunk = deptIds.slice(i, i + 50);
    const depts = await searchScript("contacts", ["batch-get-depts", chunk.join(",")], 30_000);
    for (const d of asRecords((depts as { items?: unknown })?.items)) {
      // 组织路径剥掉集团根前缀，前端展示相对层级
      let absPath = clean(d.abs_path);
      if (absPath === rootName) absPath = "";
      else if (absPath.startsWith(`${rootName}/`)) absPath = absPath.slice(rootName.length + 1);
      deptById.set(clean(d.id), { name: clean(d.name), path: absPath });
    }
  }

  const entries: WpsDirectoryEntry[] = asRecords(membersJson.items)
    .map((m) => {
      const info = (m.user_info ?? {}) as AnyRecord;
      const dept = deptById.get(clean(m.dept_id));
      return {
        id: clean(info.id) || clean(m.user_id),
        name: clean(info.nick_name) || clean(info.name),
        deptId: clean(m.dept_id),
        deptName: dept?.name ?? "",
        deptPath: dept?.path ?? "",
        isLeader: !!m.is_leader,
      };
    })
    .filter((e) => e.id && e.name)
    .sort((a, b) => a.deptPath.localeCompare(b.deptPath, "zh-Hans-CN") || a.name.localeCompare(b.name, "zh-Hans-CN"));

  return { configured: true, total: entries.length, entries, fetchedAt: now() };
}

async function loadDirectory(): Promise<WpsContacts> {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) return directoryCache.data;
  if (!directoryInflight) {
    directoryInflight = fetchDirectory()
      .then((data) => {
        directoryCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        directoryInflight = null;
      });
  }
  return directoryInflight;
}

/** 启动预热：后台拉一次通讯录进缓存，用户打开弹层时大概率已就绪（失败静默，用时再拉） */
export function warmDirectoryCache(): void {
  if (!wpsConfigured()) return;
  void loadDirectory().catch(() => {});
  void loadDoclibs().catch(() => {});
}

// ---------- 知识库列表（drive doclibs）：库少且变化慢，短缓存让弹层即开即有 ----------

const DOCLIBS_TTL_MS = 5 * 60_000;
// 库列表与通讯录同理只跟 WPS 登录态走，全员共享一份；并发请求合并为一次拉取
let doclibsCache: { at: number; json: unknown } | null = null;
let doclibsInflight: Promise<unknown> | null = null;

async function loadDoclibs(): Promise<unknown> {
  if (doclibsCache && Date.now() - doclibsCache.at < DOCLIBS_TTL_MS) return doclibsCache.json;
  if (!doclibsInflight) {
    doclibsInflight = searchScript("drive", ["doclibs"], 30_000)
      .then((json) => {
        doclibsCache = { at: Date.now(), json };
        return json;
      })
      .finally(() => {
        doclibsInflight = null;
      });
  }
  return doclibsInflight;
}

export function registerWpsRoutes(app: FastifyInstance): void {
  // 当前账号缓存：未同步过返回 configured + profile: null（前端据此显示「同步」按钮）
  app.get("/wps/me", { onRequest: [app.authenticate] }, async (req) => {
    const user = currentUser(req);
    const row = db.prepare("SELECT profile FROM wps_profile WHERE user_id = ?").get(user.id) as
      | { profile: string }
      | undefined;
    return {
      configured: wpsConfigured(),
      profile: row ? (JSON.parse(row.profile) as WpsProfile) : null,
    };
  });

  // 设置页「同步」按钮：跑 user-current 脚本拿当前登录账号并缓存。
  // 登录态缺失/过期时走内置专家包的 wps365-env 环境闸门（ensure / ensure --refresh）
  // 从本机紫金协作客户端重新导入会话再重试一次，见 docs 里的踩坑经验。
  app.post("/wps/sync", { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = currentUser(req);
    if (!wpsConfigured()) {
      // 首次配置：直接跑 ensure，从本机已登录的紫金协作导入，免去手工脚本
      const gate = await runEnvGate(false);
      if (!gate.ready) {
        return reply.code(409).send({ error: `WPS 登录态未配置：${gate.message}` });
      }
    }
    try {
      return persistSyncedProfile(user.id, await fetchMeBase());
    } catch (firstErr) {
      if (firstErr instanceof WpsSyncError) return reply.code(firstErr.code).send({ error: firstErr.message });
      const firstMessage = stripWarningNoise(String((firstErr as Error).message ?? firstErr));
      if (!isWpsSessionError(firstMessage)) {
        return reply.code(502).send({ error: `WPS 脚本执行失败：${firstMessage}` });
      }
      // 会话失效（401/403）：ensure --refresh 从紫金协作客户端重导登录态，再重试一次
      const gate = await runEnvGate(true);
      if (!gate.ok) {
        return reply.code(502).send({ error: `WPS 登录态已失效，自动重新导入未成功：${gate.message}` });
      }
      try {
        // 重试时边车凭证优先：服务进程环境里可能还留着启动时的旧 WPS_SID
        return persistSyncedProfile(user.id, await fetchMeBase(wpsSidecarEnv()));
      } catch (retryErr) {
        if (retryErr instanceof WpsSyncError) return reply.code(retryErr.code).send({ error: retryErr.message });
        const retryMessage = stripWarningNoise(String((retryErr as Error).message ?? retryErr));
        return reply.code(502).send({ error: `WPS 登录态已更新，但同步仍失败：${retryMessage}` });
      }
    }
  });

  // @ 弹层数据源：并行跑 contacts / im / drive / meeting / doclibs（单一数据源失败静默降级）
  app.get("/wps/mentions", { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!wpsConfigured()) return { configured: false, items: [] };
    const user = currentUser(req);
    const q = String((req.query as { q?: string })?.q ?? "").trim().slice(0, 64);

    // 空关键词时联系人取「本部门成员」：需要账号缓存里的默认部门 id；
    // 旧缓存没有该字段时退回 list-user-depts 取第一个（默认）部门
    const loadDeptContacts = async (): Promise<WpsMentionItem[]> => {
      const row = db.prepare("SELECT profile FROM wps_profile WHERE user_id = ?").get(user.id) as
        | { profile: string }
        | undefined;
      const profile = row ? (JSON.parse(row.profile) as WpsProfile) : null;
      if (!profile?.id) return [];
      let deptId = profile.defDeptId;
      let deptName = profile.deptName;
      if (!deptId) {
        const depts = await searchScript("contacts", ["list-user-depts", profile.id], 20_000);
        const first = asRecords((depts as { items?: unknown })?.items)[0];
        deptId = clean(first?.id);
        deptName = clean(first?.name);
      }
      if (!deptId) return [];
      const members = await searchScript("contacts", ["list-dept-members", deptId, "--page-size", "12"], 20_000);
      return normalizeDeptMembers(members, deptName);
    };

    const tasks: Array<Promise<WpsMentionItem[]>> = [
      // 群聊/单聊：recent 固定取最近会话（与 Comate 弹层一致），有关键词时本地过滤
      settled(async () => normalizeChats(await searchScript("im", ["recent"], 20_000), q)),
      // 有关键词走搜索；空关键词取本部门成员（Comate 弹层同款「同事」默认列表）
      q
        ? settled(async () => normalizeContacts(await searchScript("contacts", ["search", q, "--page-size", "12"], 20_000), q))
        : settled(loadDeptContacts),
      // 有关键词搜索云文档；空关键词取最近打开/编辑的文档（与 Comate 云文档 tab 一致）
      q
        ? settled(async () => normalizeDrive(await searchScript("drive", ["search", q, "--page-size", "50"], 30_000), q))
        : settled(async () => normalizeLatest(await searchScript("drive", ["latest", "--page-size", "50"], 30_000))),
      // 会议记录：固定取最近列表，有关键词时本地过滤
      settled(async () => normalizeMeetings(await searchScript("meeting", ["list-records"], 30_000), q)),
      // 知识库：drive doclibs 固定列表（私网可用），缓存 5 分钟，关键词本地过滤
      settled(async () => normalizeDoclibsKb(await loadDoclibs(), q)),
    ];
    const [chats, contacts, docs, meetings, kbs] = await Promise.all(tasks);
    return { configured: true, items: [...contacts, ...chats, ...docs, ...kbs, ...meetings] };
  });

  // ---------- 云文档选择器（Comate「从云文档选择」同款）：浏览 / 搜索 / 多选 ----------

  /** 云盘条目的通用归一化（文件夹标记 type 供前端区分导航） */
  /** 云盘条目通用归一化（文件夹标记 type 供前端区分导航） */
  function normalizeEntries(json: unknown): { id: string; name: string; folder: boolean; subtitle: string }[] {
    return asRecords((json as { items?: unknown })?.items)
      .map((it) => {
        const file = (it.file ?? it) as AnyRecord;
        const size = Number(file.size);
        const mtime = clean(file.mtime ?? it.mtime).slice(0, 10);
        return {
          id: clean(file.id),
          name: clean(file.name),
          folder: clean(file.type ?? it.type) === "folder",
          subtitle:
            Number.isFinite(size) && size > 0
              ? `${Math.max(1, Math.round(size / 1024))} KB`
              : mtime
                ? mtime
                : "",
        };
      })
      .filter((e) => e.id && e.name);
  }

  // 最近文档（选择器「最近」视图）
  app.get("/wps/drive/recent", { onRequest: [app.authenticate] }, async () => {
    if (!wpsConfigured()) return { entries: [] };
    const json = await searchScript("drive", ["latest", "--page-size", "50"], 30_000);
    return { entries: normalizeEntries(json) };
  });

  // 目录浏览：private 云盘（parent 默认 root）或指定团队库 drive_id
  app.get("/wps/drive/entries", { onRequest: [app.authenticate] }, async (req) => {
    if (!wpsConfigured()) return { entries: [] };
    const { parent = "root", drive = "private" } = req.query as { parent?: string; drive?: string };
    const args = ["list", "--page-size", "100"];
    if (drive && drive !== "private") args.push("--drive", drive);
    if (parent && parent !== "root") args.push("--parent", parent);
    const json = await searchScript("drive", args, 30_000);
    return { entries: normalizeEntries(json) };
  });

  // 团队文档库列表（选择器「团队文档库」入口）
  app.get("/wps/drive/doclibs", { onRequest: [app.authenticate] }, async () => {
    if (!wpsConfigured()) return { entries: [] };
    const json = await searchScript("drive", ["doclibs"], 30_000);
    return {
      entries: asRecords((json as { items?: unknown })?.items)
        .map((it) => {
          const drive = (it.drive ?? {}) as AnyRecord;
          return { id: clean(drive.id), name: clean(drive.name), folder: true, subtitle: "团队文档库" };
        })
        .filter((e) => e.id && e.name),
    };
  });

  // 文件名搜索（选择器搜索框）
  app.get("/wps/drive/search", { onRequest: [app.authenticate] }, async (req) => {
    if (!wpsConfigured()) return { entries: [] };
    const q = String((req.query as { q?: string })?.q ?? "").trim().slice(0, 64);
    if (!q) return { entries: [] };
    const json = await searchScript("drive", ["search", q, "--page-size", "50"], 30_000);
    return { entries: normalizeEntries(json) };
  });

  // 全量通讯录（组织结构化）：成员递归 + 部门名批量补全，内存缓存 10 分钟；
  // 首次拉取约 6-10 秒（1100+ 人），前端据此展示加载态
  app.get("/wps/contacts", { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!wpsConfigured()) return { configured: false, total: 0, entries: [], fetchedAt: "" };
    try {
      return await loadDirectory();
    } catch (err) {
      return reply.code(502).send({ error: `通讯录拉取失败：${String((err as Error).message ?? err)}` });
    }
  });
}
