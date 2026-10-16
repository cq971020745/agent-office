<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { isChatModel, type AgentConfig, type AgentPackInfo, type McpServerConfig, type SkillInfo, type SkillsCatalog, type ToolPolicy } from "@office/shared";
import {
  createAdminAgent,
  createMcpServer,
  createSkill,
  deleteAdminAgent,
  deleteMcpServer,
  deleteSkill,
  exportAgentPack,
  exportMcpConfig,
  fetchProviderModels,
  generateAdminAgent,
  getPlatformInstructions,
  getRole,
  getSkill,
  getSkillUpdates,
  getSkillsCatalog,
  importAgentPack,
  importMcpConfig,
  installAgentPack,
  installSkill,
  listAgents,
  listAdminAgents,
  listAdminProviders,
  listAgentPacks,
  listMcpServers,
  listSkills,
  savePlatformInstructions,
  syncAllSkills,
  syncSkill,
  testMcpServer,
  updateAdminAgent,
  updateMcpServer,
  updateSkill,
  type AdminProvider,
  type AdminSkillInfo,
} from "../api";
import { confirmDialog } from "../composables/confirm";
import { toast, toastError } from "../composables/toast";
import { timeAgo } from "../utils/format";

type Tab = "experts" | "skills" | "connectors" | "instructions";
const tab = ref<Tab>("experts");
const isAdmin = getRole() === "admin";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "experts", label: "专家", hint: "带专属提示词与模型的智能助手，可反复派发任务" },
  { key: "skills", label: "技能", hint: "平台级能力包（SKILL.md），所有专家共享；模型按需加载，可用 /技能名 参数 直接调用" },
  { key: "connectors", label: "连接器", hint: "接入 MCP 工具服务器（本地 stdio 或远程 streamable HTTP），其工具在本平台所有任务会话中可用" },
  { key: "instructions", label: "平台指令", hint: "AGENTS.md 平台级全局指令：注入所有专家的任务会话，适合放统一的工作规范与安全约束" },
];

const router = useRouter();
const agents = ref<AgentConfig[]>([]);
const loading = ref(true);
const q = ref("");
const activeTag = ref("");

const allTags = computed(() => {
  const set = new Set<string>();
  for (const a of agents.value) for (const t of a.tags) set.add(t);
  return [...set].slice(0, 12);
});

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  return agents.value.filter((a) => {
    if (activeTag.value && !a.tags.includes(activeTag.value)) return false;
    if (!kw) return true;
    return (
      a.name.toLowerCase().includes(kw) ||
      (a.description ?? "").toLowerCase().includes(kw) ||
      a.tags.some((t) => t.toLowerCase().includes(kw)) ||
      a.modelId.toLowerCase().includes(kw)
    );
  });
});

// 头像：按名字哈希取渐变色，保持稳定
const AVATAR_GRADS = [
  "linear-gradient(135deg,#0ea5e9,#6366f1)",
  "linear-gradient(135deg,#10b981,#0ea5e9)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
  "linear-gradient(135deg,#8b5cf6,#ec4899)",
  "linear-gradient(135deg,#14b8a6,#22c55e)",
  "linear-gradient(135deg,#64748b,#334155)",
];
function avatarGrad(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_GRADS[h % AVATAR_GRADS.length]!;
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    agents.value = await listAgents();
  } catch (err) {
    toastError(err, "加载专家失败");
  } finally {
    loading.value = false;
  }
}

function dispatch(a: AgentConfig): void {
  void router.push({ path: "/", query: { agent: a.id } });
}

/** 进入专家详情页：完整提示词、历史任务与产出 */
function openDetail(a: AgentConfig): void {
  void router.push(`/experts/${a.id}`);
}

async function remove(a: AgentConfig): Promise<void> {
  const ok = await confirmDialog({
    title: `删除专家「${a.name}」？`,
    message: "已派发的任务不受影响，但之后无法再选用该专家。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteAdminAgent(a.id);
    toast("success", "专家已删除");
    await refresh();
  } catch (err) {
    toastError(err, "删除失败");
  }
}

// ---------- 专家文件夹（WorkBuddy 式：卡片 ⋮ 菜单直接打开常驻目录） ----------
const menuFor = ref("");

function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? "" : id;
}

async function openFolder(a: AgentConfig): Promise<void> {
  menuFor.value = "";
  if (!a.folderPath) {
    toast("error", "该专家暂无关联文件夹");
    return;
  }
  if (window.agentOffice?.openPath) {
    const res = await window.agentOffice.openPath(a.folderPath);
    if (!res.ok) toast("error", res.message ?? "打开文件夹失败");
    return;
  }
  // 纯浏览器模式没有原生 shell：复制路径兜底
  try {
    await navigator.clipboard.writeText(a.folderPath);
    toast("success", `路径已复制：${a.folderPath}`);
  } catch {
    toast("error", a.folderPath);
  }
}

// ---------- 新建 / 编辑专家 ----------
const showCreate = ref(false);
const editingAgent = ref<AgentConfig | null>(null);
const providers = ref<AdminProvider[]>([]);
const cName = ref("");
const cDesc = ref("");
const cTags = ref("");
const cProvider = ref("");
const cModel = ref("");
const cPrompt = ref("");
const cHighRisk = ref(false);
const modelsLoading = ref(false);
const modelsError = ref("");
const creating = ref(false);
// 技能绑定：useAllSkills = 注入全部平台技能（v1 默认）；取消勾选后按 cSkills 精确绑定
const useAllSkills = ref(true);
const cSkills = ref<string[]>([]);
// 工具策略（P2-2）：ask = 每次调用需人工确认，deny = 对该专家隐藏；未列出 = 正常放行
const cToolPolicy = ref<ToolPolicy>({});

const TOOL_POLICY_BASE_ROWS: { key: string; label: string; desc: string }[] = [
  { key: "workspace_write", label: "工作区写入", desc: "在专家工作区新建/覆盖文件（workspace_write）" },
  { key: "workspace_edit", label: "工作区局部编辑", desc: "在专家工作区局部替换文件内容（workspace_edit）" },
  { key: "transcribe_audio", label: "音频文件转写", desc: "将工作区音频文件转写为文本（transcribe_audio）" },
  { key: "delegate_to_agent", label: "委派其他专家", desc: "将专项子任务委派给其他专家协同执行（delegate_to_agent）" },
  { key: "fetch_url", label: "网页抓取", desc: "从互联网拉取 URL 内容（fetch_url）" },
  { key: "run_code", label: "代码执行", desc: "在隔离沙箱运行代码（run_code，未启用代码执行时无需配置）" },
];

/** 策略编辑行：平台敏感工具 + 每个已登记连接器的全部工具（mcp:连接器:* 通配） */
const policyRows = computed(() => [
  ...TOOL_POLICY_BASE_ROWS,
  ...servers.value.map((s) => ({
    key: `mcp:${s.name}:*`,
    label: `连接器「${s.name}」`,
    desc: s.type === "http" ? `远程 HTTP 连接器的全部工具（${s.url}）` : `本地连接器的全部工具（${s.command}）`,
  })),
]);

function policyAction(key: string): "" | "ask" | "deny" {
  return cToolPolicy.value[key] ?? "";
}

function setPolicyAction(key: string, action: string): void {
  const next: ToolPolicy = { ...cToolPolicy.value };
  if (action === "ask" || action === "deny") next[key] = action;
  else delete next[key];
  cToolPolicy.value = next;
}

// 专家只能选用「可用模型」；enabledModels 缺失时回退到旧缓存字段
const providerModels = computed(() => {
  const p = providers.value.find((x) => x.id === cProvider.value);
  if (!p) return [];
  return p.enabledModels?.length ? p.enabledModels : [];
});
// 可选模型只保留对话模型：向量/重排/语音等（bge、reranker、embed…）不能当专家引擎
const chatModels = computed(() => providerModels.value.filter(isChatModel));
const filteredModels = computed(() => {
  const kw = cModel.value.trim().toLowerCase();
  if (!kw) return chatModels.value;
  return chatModels.value.filter((m) => m.toLowerCase().includes(kw));
});

async function openCreate(): Promise<void> {
  editingAgent.value = null;
  showCreate.value = true;
  cName.value = cDesc.value = cTags.value = cModel.value = cPrompt.value = "";
  cHighRisk.value = false;
  cProvider.value = "";
  aiPrompt.value = "";
  modelsError.value = "";
  useAllSkills.value = true;
  cSkills.value = [];
  cToolPolicy.value = {};
  if (!skills.value.length && !skillsLoading.value) await loadSkills();
  if (!servers.value.length) await loadMcp();
  try {
    providers.value = await listAdminProviders();
  } catch (err) {
    toastError(err, "加载供应商失败");
  }
}

// ---------- AI 一句话生成专家配置（WorkBuddy expert-manager 式） ----------
const aiPrompt = ref("");
const generating = ref(false);

async function generateAgent(): Promise<void> {
  if (generating.value || !aiPrompt.value.trim()) return;
  generating.value = true;
  try {
    const res = await generateAdminAgent({ prompt: aiPrompt.value.trim() });
    cName.value = res.name;
    cDesc.value = res.description;
    cTags.value = res.tags.join("，");
    cPrompt.value = res.systemPrompt;
    if (res.source === "fallback") {
      toast("info", res.note ?? "已用内置模板生成，可手动调整");
    } else {
      toast("success", "已生成专家配置，可在下方调整后保存");
    }
  } catch (err) {
    toastError(err, "AI 生成失败，请手动填写");
  } finally {
    generating.value = false;
  }
}

async function openEdit(a: AgentConfig): Promise<void> {
  menuFor.value = "";
  editingAgent.value = a;
  showCreate.value = true;
  cName.value = a.name;
  cDesc.value = a.description;
  cTags.value = a.tags.join("，");
  cPrompt.value = "";
  cHighRisk.value = a.highRisk;
  cProvider.value = a.providerId;
  cModel.value = a.modelId;
  modelsError.value = "";
  useAllSkills.value = true;
  cSkills.value = [];
  cToolPolicy.value = {};
  if (!skills.value.length && !skillsLoading.value) await loadSkills();
  if (!servers.value.length) await loadMcp();
  try {
    providers.value = await listAdminProviders();
    // 成员接口不带系统提示词，从管理端全量数据补齐（含技能绑定与工具策略）
    const full = (await listAdminAgents()).find((x) => x.id === a.id);
    if (full && editingAgent.value?.id === a.id) {
      cPrompt.value = full.systemPrompt;
      if (full.skills !== null) {
        useAllSkills.value = false;
        cSkills.value = full.skills;
      }
      cToolPolicy.value = full.toolPolicy ?? {};
    }
  } catch (err) {
    toastError(err, "加载专家信息失败");
  }
}

/** 切换供应商：优先用已缓存的模型列表，没有则现场拉取。 */
async function onProviderChange(): Promise<void> {
  cModel.value = "";
  modelsError.value = "";
  const p = providers.value.find((x) => x.id === cProvider.value);
  if (!p || p.models.length) return;
  modelsLoading.value = true;
  try {
    const res = await fetchProviderModels(p.id);
    p.models = res.models;
    p.enabledModels = res.enabledModels;
    p.modelsFetchedAt = res.fetchedAt;
  } catch (err) {
    modelsError.value = err instanceof Error ? err.message : "获取模型列表失败";
  } finally {
    modelsLoading.value = false;
  }
}

async function retryModels(): Promise<void> {
  const p = providers.value.find((x) => x.id === cProvider.value);
  if (!p) return;
  modelsError.value = "";
  modelsLoading.value = true;
  try {
    const res = await fetchProviderModels(p.id);
    p.models = res.models;
    p.enabledModels = res.enabledModels;
    p.modelsFetchedAt = res.fetchedAt;
  } catch (err) {
    modelsError.value = err instanceof Error ? err.message : "获取模型列表失败";
  } finally {
    modelsLoading.value = false;
  }
}

function selectModel(m: string): void {
  cModel.value = m;
}

async function submitCreate(): Promise<void> {
  if (!cName.value.trim() || !cPrompt.value.trim() || creating.value) return;
  // 默认模型可选，但提供时必须成对
  if (!!cProvider.value !== !!cModel.value.trim()) {
    toast("error", "默认模型需要同时选择供应商与模型，或都留空");
    return;
  }
  const payload = {
    name: cName.value.trim(),
    description: cDesc.value.trim(),
    systemPrompt: cPrompt.value,
    providerId: cProvider.value || undefined,
    modelId: cModel.value.trim() || undefined,
    tags: cTags.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    highRisk: cHighRisk.value,
    // 「使用全部技能」= 绑定空数组（无绑定行 = 全部）；否则传勾选清单
    skills: useAllSkills.value ? [] : [...cSkills.value],
    // 空对象 = 全部放行（等效默认）；ask/deny 条目整段覆写
    toolPolicy: cToolPolicy.value,
  };
  creating.value = true;
  try {
    if (editingAgent.value) {
      await updateAdminAgent(editingAgent.value.id, payload);
      toast("success", "专家已更新");
    } else {
      await createAdminAgent(payload);
      toast("success", "专家已创建，已为其建立专属文件夹");
    }
    showCreate.value = false;
    await refresh();
  } catch (err) {
    toastError(err, editingAgent.value ? "保存专家失败" : "创建专家失败");
  } finally {
    creating.value = false;
  }
}

// ---------- 技能 ----------
const skills = ref<AdminSkillInfo[]>([]);
const skillsLoading = ref(false);
const showSkillDialog = ref(false);
const editingSkill = ref<string | null>(null);
const sName = ref("");
const sDesc = ref("");
const sContent = ref("");
const sArgHint = ref("");
const skillSaving = ref(false);

function openCreateSkill(): void {
  editingSkill.value = null;
  sName.value = sDesc.value = sContent.value = sArgHint.value = "";
  showSkillDialog.value = true;
}

async function openEditSkill(name: string): Promise<void> {
  try {
    const detail = await getSkill(name);
    editingSkill.value = name;
    sName.value = detail.name;
    sDesc.value = detail.description;
    sContent.value = detail.content;
    sArgHint.value = detail.argumentHint ?? "";
    showSkillDialog.value = true;
  } catch (err) {
    toastError(err, "读取技能失败");
  }
}

async function submitSkill(): Promise<void> {
  if (skillSaving.value) return;
  if (!editingSkill.value && !sName.value.trim()) {
    toast("error", "请填写技能名称");
    return;
  }
  if (!sContent.value.trim()) {
    toast("error", "请填写技能内容");
    return;
  }
  skillSaving.value = true;
  try {
    if (editingSkill.value) {
      await updateSkill(editingSkill.value, {
        description: sDesc.value.trim(),
        content: sContent.value,
        argumentHint: sArgHint.value.trim(),
      });
      toast("success", "技能已更新");
    } else {
      await createSkill({
        name: sName.value.trim(),
        description: sDesc.value.trim(),
        content: sContent.value,
        argumentHint: sArgHint.value.trim() || undefined,
      });
      toast("success", "技能已创建，之后派发的任务会自动携带");
    }
    showSkillDialog.value = false;
    await loadSkills();
  } catch (err) {
    toastError(err, "保存技能失败");
  } finally {
    skillSaving.value = false;
  }
}

async function removeSkill(s: SkillInfo): Promise<void> {
  const ok = await confirmDialog({
    title: `删除技能「${s.name}」？`,
    message: "删除后，之后派发的任务不再携带该技能。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteSkill(s.name);
    toast("success", "技能已删除");
    await loadSkills();
  } catch (err) {
    toastError(err, "删除技能失败");
  }
}

// ---------- 技能安装 / 同步（内置目录 + URL/Git/本地来源，安装后可一键同步更新） ----------
const skillCatalog = ref<SkillsCatalog>({ catalog: [], sources: {} });
const installingId = ref(""); // 正在安装的市场技能 id；"_source" 表示自定义来源安装中
const syncingName = ref("");
const installSource = ref("");
const installOverwrite = ref(false);

const KIND_LABEL: Record<string, string> = { builtin: "内置", url: "链接", git: "Git", local: "本地" };

/** 来源缩略显示：去协议头，过长截断 */
function shortSource(src: string): string {
  const s = src.replace(/^https?:\/\//, "").replace(/^git:/, "");
  return s.length > 42 ? `${s.slice(0, 42)}…` : s;
}

async function loadSkills(): Promise<void> {
  if (!isAdmin) return;
  skillsLoading.value = true;
  try {
    const [list, catalog] = await Promise.all([listSkills(), getSkillsCatalog()]);
    skills.value = list;
    skillCatalog.value = catalog;
  } catch (err) {
    toastError(err, "加载技能失败");
  } finally {
    skillsLoading.value = false;
  }
}

async function doInstallSkill(source: string, overwrite: boolean, id: string): Promise<void> {
  if (installingId.value) return;
  installingId.value = id;
  try {
    const res = await installSkill(source, overwrite);
    const parts = [
      res.added.length ? `新增 ${res.added.join("、")}` : "",
      res.updated.length ? `覆盖更新 ${res.updated.join("、")}` : "",
    ].filter(Boolean);
    toast("success", parts.length ? `安装完成：${parts.join("；")}` : "没有需要安装的技能");
    installSource.value = "";
    installOverwrite.value = false;
    await loadSkills();
  } catch (err) {
    toastError(err, "安装技能失败");
  } finally {
    installingId.value = "";
  }
}

function installCatalogSkill(id: string): void {
  void doInstallSkill(id, false, id);
}

function submitInstallSource(): void {
  const src = installSource.value.trim();
  if (!src) return;
  void doInstallSkill(src, installOverwrite.value, "_source");
}

async function doSyncSkill(s: SkillInfo): Promise<void> {
  if (syncingName.value) return;
  syncingName.value = s.name;
  try {
    const res = await syncSkill(s.name);
    const parts = [
      res.updated.length ? `更新 ${res.updated.length}` : "",
      res.added.length ? `新增 ${res.added.length}` : "",
      res.removed.length ? `移除 ${res.removed.length}` : "",
    ].filter(Boolean);
    toast("success", `同步完成${parts.length ? `：${parts.join("、")}` : "，已是最新"}`);
    await loadSkills();
  } catch (err) {
    toastError(err, "同步技能失败");
  } finally {
    syncingName.value = "";
  }
}

// ---------- 技能演进闭环（P2-4）：漂移检测 + 批量同步 ----------
const checkingUpdates = ref(false);
const syncingAll = ref(false);

/** 检测所有登记技能源的更新，刷新「有更新」标记。 */
async function checkSkillUpdates(): Promise<void> {
  if (checkingUpdates.value) return;
  checkingUpdates.value = true;
  try {
    const ups = await getSkillUpdates();
    const withUpdate = ups.filter((u) => u.hasUpdate);
    if (withUpdate.length) {
      toast("info", `${withUpdate.length} 个来源有更新：${withUpdate.map((u) => u.source).join("、")}，可逐个同步或点「全部同步」`);
    } else {
      toast("success", "检查完成：所有技能源均为最新");
    }
    await loadSkills();
  } catch (err) {
    toastError(err, "检查更新失败");
  } finally {
    checkingUpdates.value = false;
  }
}

/** 一键同步全部技能源（每个来源同步一次，失败的不阻塞其余来源）。 */
async function doSyncAllSkills(): Promise<void> {
  if (syncingAll.value) return;
  syncingAll.value = true;
  try {
    const res = await syncAllSkills();
    if (res.failed.length) {
      toast("info", `已同步 ${res.sources.length} 个来源，${res.failed.length} 个失败：${res.failed.map((f) => f.source).join("、")}`);
    } else {
      toast("success", `已同步 ${res.sources.length} 个技能来源`);
    }
    await loadSkills();
  } catch (err) {
    toastError(err, "批量同步失败");
  } finally {
    syncingAll.value = false;
  }
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

// ---------- 专家包：内置市场一键安装 / 文件导入（office-agent-package，可导入也可分享） ----------
const agentPacks = ref<AgentPackInfo[]>([]);
const showPackDialog = ref(false);
const packMode = ref<"builtin" | "import">("builtin");
const packToInstall = ref<AgentPackInfo | null>(null);
const packFile = ref<File | null>(null);
const packProvider = ref("");
const packModel = ref("");
const packBusy = ref(false);
const packModelsLoading = ref(false);
const importInput = ref<HTMLInputElement | null>(null);

const packChatModels = computed(() => {
  const p = providers.value.find((x) => x.id === packProvider.value);
  return (p?.enabledModels ?? []).filter(isChatModel);
});

async function loadPacks(): Promise<void> {
  if (!isAdmin) return;
  try {
    agentPacks.value = await listAgentPacks();
  } catch {
    // 市场加载失败不阻塞专家列表
  }
}

async function ensureProviders(): Promise<void> {
  if (providers.value.length) return;
  try {
    providers.value = await listAdminProviders();
  } catch (err) {
    toastError(err, "加载供应商失败");
  }
}

async function openInstallPack(p: AgentPackInfo): Promise<void> {
  packMode.value = "builtin";
  packToInstall.value = p;
  packFile.value = null;
  packProvider.value = "";
  packModel.value = "";
  await ensureProviders();
  showPackDialog.value = true;
}

function pickImportFile(): void {
  importInput.value?.click();
}

function onImportPicked(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".json")) {
    toast("error", "请选择 .json 专家包文件");
    return;
  }
  packMode.value = "import";
  packToInstall.value = null;
  packFile.value = file;
  packProvider.value = "";
  packModel.value = "";
  void ensureProviders().then(() => (showPackDialog.value = true));
}

async function onPackProviderChange(): Promise<void> {
  packModel.value = "";
  const p = providers.value.find((x) => x.id === packProvider.value);
  if (!p || p.enabledModels?.length) return;
  packModelsLoading.value = true;
  try {
    const res = await fetchProviderModels(p.id);
    p.models = res.models;
    p.enabledModels = res.enabledModels;
    p.modelsFetchedAt = res.fetchedAt;
  } catch (err) {
    toastError(err, "获取模型列表失败");
  } finally {
    packModelsLoading.value = false;
  }
}

async function submitPack(): Promise<void> {
  if (packBusy.value) return;
  const providerId = packProvider.value || undefined;
  const modelId = packModel.value.trim() || undefined;
  if (!!providerId !== !!modelId) {
    toast("error", "默认模型需要同时选择供应商与模型，或都留空");
    return;
  }
  packBusy.value = true;
  try {
    const res =
      packMode.value === "import" && packFile.value
        ? await importAgentPack(packFile.value, providerId, modelId)
        : packToInstall.value
          ? await installAgentPack(packToInstall.value.id, providerId, modelId)
          : null;
    if (!res) return;
    const name = packToInstall.value?.name ?? packFile.value?.name ?? "专家包";
    toast("success", `「${name}」安装成功${res.skills.length ? `，随包安装 ${res.skills.length} 个技能` : ""}`);
    // 包里被跳过的技能（非法名/空内容）逐条提示
    for (const w of res.warnings ?? []) toast("info", w);
    showPackDialog.value = false;
    packFile.value = null;
    await refresh();
  } catch (err) {
    toastError(err, packMode.value === "import" ? "导入专家包失败" : "安装专家包失败");
  } finally {
    packBusy.value = false;
  }
}

// ---------- 专家包导出：勾选携带的技能，生成可分享的 JSON ----------
const showExportDialog = ref(false);
const exportTarget = ref<AgentConfig | null>(null);
const exportSkills = ref<string[]>([]);
const exporting = ref(false);

async function openExportPack(a: AgentConfig): Promise<void> {
  menuFor.value = "";
  exportTarget.value = a;
  exportSkills.value = [];
  showExportDialog.value = true;
  if (!skills.value.length && !skillsLoading.value) await loadSkills();
}

async function submitExport(): Promise<void> {
  if (!exportTarget.value || exporting.value) return;
  exporting.value = true;
  try {
    await exportAgentPack(exportTarget.value.id, exportSkills.value, `${exportTarget.value.name}.json`);
    toast("success", "专家包已导出，可直接分享给其他平台导入");
    showExportDialog.value = false;
  } catch (err) {
    toastError(err, "导出专家包失败");
  } finally {
    exporting.value = false;
  }
}

// ---------- 连接器（MCP：本地 stdio / 远程 streamable HTTP） ----------
const servers = ref<McpServerConfig[]>([]);
const mcpLoading = ref(false);
const showMcpDialog = ref(false);
const editingMcp = ref<McpServerConfig | null>(null);
const mName = ref("");
const mType = ref<"stdio" | "http">("stdio");
const mCommand = ref("");
const mArgs = ref("");
const mEnv = ref("");
const mUrl = ref("");
const mHeaders = ref("");
const mStartupTimeout = ref("10");
const mToolTimeout = ref("60");
const mcpSaving = ref(false);
const testing = ref("");
const expanded = ref("");
const mcpFileInput = ref<HTMLInputElement | null>(null);

async function loadMcp(): Promise<void> {
  if (!isAdmin) return;
  mcpLoading.value = true;
  try {
    servers.value = await listMcpServers();
  } catch (err) {
    toastError(err, "加载连接器失败");
  } finally {
    mcpLoading.value = false;
  }
}

function resetMcpFields(): void {
  mName.value = mCommand.value = mArgs.value = mEnv.value = mUrl.value = mHeaders.value = "";
  mType.value = "stdio";
  mStartupTimeout.value = "10";
  mToolTimeout.value = "60";
}

function openCreateMcp(): void {
  editingMcp.value = null;
  resetMcpFields();
  showMcpDialog.value = true;
}

/** 编辑连接器：回填全部字段（含类型/地址/请求头/超时），保存走 PATCH（类型不可改）。 */
function openEditMcp(s: McpServerConfig): void {
  editingMcp.value = s;
  mName.value = s.name;
  mType.value = s.type === "http" ? "http" : "stdio";
  mCommand.value = s.command;
  mArgs.value = s.args.join(" ");
  mEnv.value = Object.entries(s.env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  mUrl.value = s.url ?? "";
  mHeaders.value = Object.entries(s.headers ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  mStartupTimeout.value = String(s.startupTimeoutSec ?? 10);
  mToolTimeout.value = String(s.toolTimeoutSec ?? 60);
  showMcpDialog.value = true;
}

/** 解析超时输入；非法或非正数回退默认（与 cl 时服务端行为一致）。 */
function parseTimeout(raw: string, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** 解析 KEY=VALUE 多行文本（环境变量 / HTTP 请求头共用）；首个 = 分隔。 */
function parseKeyValueLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function submitMcp(): Promise<void> {
  if (mcpSaving.value) return;
  if (!mName.value.trim()) {
    toast("error", "请填写名称");
    return;
  }
  if (mType.value === "http" && !/^https?:\/\//i.test(mUrl.value.trim())) {
    toast("error", "远程连接器需要填写 http(s):// 的服务地址");
    return;
  }
  if (mType.value === "stdio" && !mCommand.value.trim()) {
    toast("error", "本地连接器需要填写启动命令");
    return;
  }
  mcpSaving.value = true;
  try {
    const common = {
      name: mName.value.trim(),
      startupTimeoutSec: parseTimeout(mStartupTimeout.value, 10),
      toolTimeoutSec: parseTimeout(mToolTimeout.value, 60),
    };
    if (mType.value === "http") {
      // 远程连接器：JSON-RPC 走 streamable HTTP；令牌等敏感值用 ${ENV_NAME} 引用，不落库
      const payload = { ...common, type: "http" as const, url: mUrl.value.trim(), headers: parseKeyValueLines(mHeaders.value) };
      if (editingMcp.value) {
        await updateMcpServer(editingMcp.value.id, payload);
        toast("success", "连接器已更新，下次任务按新配置重连");
      } else {
        await createMcpServer(payload);
        toast("success", "连接器已添加，点击「测试连接」获取工具列表");
      }
    } else {
      const payload = {
        ...common,
        command: mCommand.value.trim(),
        args: mArgs.value.trim() ? mArgs.value.trim().split(/\s+/) : [],
        env: parseKeyValueLines(mEnv.value),
      };
      if (editingMcp.value) {
        await updateMcpServer(editingMcp.value.id, payload);
        toast("success", "连接器已更新，已断开旧进程，下次任务按新配置重连");
      } else {
        await createMcpServer(payload);
        toast("success", "连接器已添加，点击「测试连接」获取工具列表");
      }
    }
    showMcpDialog.value = false;
    editingMcp.value = null;
    await loadMcp();
  } catch (err) {
    toastError(err, editingMcp.value ? "保存连接器失败" : "添加连接器失败");
  } finally {
    mcpSaving.value = false;
  }
}

/** 点击工具 chip 启用/禁用单个工具（禁用后不再注入任务会话）。 */
async function toggleMcpTool(s: McpServerConfig, toolName: string): Promise<void> {
  const disabled = new Set(s.disabledTools ?? []);
  if (disabled.has(toolName)) disabled.delete(toolName);
  else disabled.add(toolName);
  const next = [...disabled];
  try {
    await updateMcpServer(s.id, { disabledTools: next });
    s.disabledTools = next;
  } catch (err) {
    toastError(err, "更新工具状态失败");
  }
}

/** 导入 .mcp.json（Claude/Codex 互操作格式）。 */
function pickMcpFile(): void {
  mcpFileInput.value?.click();
}

async function onMcpFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const res = await importMcpConfig(text);
    const skipNote = res.skipped.length
      ? `；跳过 ${res.skipped.length} 个（${res.skipped.map((x) => `${x.name}：${x.reason}`).join("；")}）`
      : "";
    toast("success", `已导入 ${res.imported.length} 个连接器${skipNote}`);
    await loadMcp();
  } catch (err) {
    toastError(err, "导入 .mcp.json 失败");
  }
}

async function exportMcpJson(): Promise<void> {
  try {
    await exportMcpConfig();
  } catch (err) {
    toastError(err, "导出 .mcp.json 失败");
  }
}

async function toggleMcp(s: McpServerConfig): Promise<void> {
  try {
    await updateMcpServer(s.id, { enabled: !s.enabled });
    await loadMcp();
  } catch (err) {
    toastError(err, "操作失败");
  }
}

async function removeMcp(s: McpServerConfig): Promise<void> {
  const ok = await confirmDialog({
    title: `删除连接器「${s.name}」？`,
    message: "其 MCP 工具将不再注入任务会话。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteMcpServer(s.id);
    toast("success", "连接器已删除");
    await loadMcp();
  } catch (err) {
    toastError(err, "删除失败");
  }
}

async function testMcp(s: McpServerConfig): Promise<void> {
  testing.value = s.id;
  try {
    const res = await testMcpServer(s.id);
    toast("success", `连接成功，发现 ${res.tools.length} 个工具`);
    expanded.value = s.id;
    await loadMcp();
  } catch (err) {
    toastError(err, "连接失败");
  } finally {
    testing.value = "";
  }
}

function toggleExpand(id: string): void {
  expanded.value = expanded.value === id ? "" : id;
}

// ---------- 平台指令（AGENTS.md，P2-3：平台级全局指令，注入所有专家） ----------
const INSTRUCTIONS_MAX = 64000;
const insContent = ref("");
const insLoading = ref(false);
const insSaving = ref(false);
const insLoaded = ref(false);

async function loadInstructions(): Promise<void> {
  if (!isAdmin) return;
  insLoading.value = true;
  try {
    const res = await getPlatformInstructions();
    insContent.value = res.content;
    insLoaded.value = true;
  } catch (err) {
    toastError(err, "加载平台指令失败");
  } finally {
    insLoading.value = false;
  }
}

async function saveInstructions(): Promise<void> {
  if (insSaving.value) return;
  if (insContent.value.length > INSTRUCTIONS_MAX) {
    toast("error", `平台指令超出长度限制（${insContent.value.length}/${INSTRUCTIONS_MAX} 字符），请精简后保存`);
    return;
  }
  insSaving.value = true;
  try {
    await savePlatformInstructions(insContent.value);
    toast("success", "平台指令已保存，之后派发的任务立即生效");
  } catch (err) {
    toastError(err, "保存平台指令失败");
  } finally {
    insSaving.value = false;
  }
}

watch(tab, (t) => {
  if (t === "skills") void loadSkills();
  if (t === "connectors") void loadMcp();
  if (t === "instructions" && !insLoaded.value) void loadInstructions();
});

onMounted(() => {
  void refresh();
  void loadPacks();
});
</script>

<template>
  <div class="page">
    <div class="head">
      <div class="seg">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          class="seg-btn"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="head-actions">
        <button v-if="isAdmin && tab === 'experts'" type="button" class="ghost-btn" @click="pickImportFile">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
          导入专家包
        </button>
        <template v-if="isAdmin && tab === 'skills'">
          <button type="button" class="ghost-btn" title="对比技能源远端内容与本地基线，标记「有更新」" :disabled="checkingUpdates" @click="checkSkillUpdates">
            <svg class="icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></svg>
            {{ checkingUpdates ? "检查中…" : "检查更新" }}
          </button>
          <button type="button" class="ghost-btn" title="逐个同步全部技能来源（失败的不阻塞其余来源）" :disabled="syncingAll" @click="doSyncAllSkills">
            <svg class="icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" transform="rotate(180 12 12)" /></svg>
            {{ syncingAll ? "同步中…" : "全部同步" }}
          </button>
        </template>
        <template v-if="isAdmin && tab === 'connectors'">
          <button type="button" class="ghost-btn" title="导入 Claude/Codex 风格的 .mcp.json（仅 stdio）" @click="pickMcpFile">
            <svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
            导入 .mcp.json
          </button>
          <button type="button" class="ghost-btn" title="把已启用的连接器导出为 .mcp.json" @click="exportMcpJson">
            <svg class="icon" viewBox="0 0 24 24"><path d="M12 21V9m0 0-4 4m4-4 4 4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" /></svg>
            导出 .mcp.json
          </button>
          <input ref="mcpFileInput" type="file" accept=".json,application/json" class="hidden-file" @change="onMcpFilePicked" />
        </template>
        <button
          v-if="isAdmin && tab !== 'instructions'"
          type="button"
          class="new-btn"
          @click="tab === 'experts' ? openCreate() : tab === 'skills' ? openCreateSkill() : openCreateMcp()"
        >
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          {{ tab === "experts" ? "新建专家" : tab === "skills" ? "新建技能" : "新建连接器" }}
        </button>
        <input ref="importInput" type="file" accept=".json,application/json" class="hidden-file" @change="onImportPicked" />
      </div>
    </div>
    <p class="tab-hint">{{ TABS.find((t) => t.key === tab)?.hint }}</p>

    <!-- 专家 -->
    <template v-if="tab === 'experts'">
      <div class="toolbar">
        <div class="search">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input v-model="q" placeholder="搜索专家名称、说明或标签" />
        </div>
        <div v-if="allTags.length" class="tag-chips">
          <button type="button" class="t-chip" :class="{ active: activeTag === '' }" @click="activeTag = ''">全部</button>
          <button
            v-for="t in allTags"
            :key="t"
            type="button"
            class="t-chip"
            :class="{ active: activeTag === t }"
            @click="activeTag = activeTag === t ? '' : t"
          >
            {{ t }}
          </button>
        </div>
      </div>

      <!-- 专家市场：内置专家包一键安装（也可从右上角导入分享包） -->
      <div v-if="isAdmin && agentPacks.length" class="pack-strip">
        <div class="pack-strip-head">
          <span class="pack-strip-title">专家市场</span>
          <span class="pack-strip-hint">一键安装精选专家包，也可以从右上角「导入专家包」导入分享的 .json 包</span>
        </div>
        <div v-for="p in agentPacks" :key="p.id" class="pack-item">
          <div class="pack-info">
            <div class="pack-name">{{ p.name }}</div>
            <p class="pack-desc">{{ p.description }}</p>
            <div class="pack-tags">
              <span v-for="t in p.tags" :key="t" class="tag">{{ t }}</span>
              <span v-if="p.skillCount" class="tag alt">{{ p.skillCount }} 个技能</span>
            </div>
          </div>
          <button type="button" class="mini-btn primary-mini" @click="openInstallPack(p)">安装</button>
        </div>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="filtered.length" class="grid">
        <div v-for="a in filtered" :key="a.id" class="expert-card clickable" @click="openDetail(a)">
          <div class="card-top">
            <div class="avatar" :style="{ background: avatarGrad(a.name) }">{{ a.name.slice(0, 1) }}</div>
            <button
              v-if="isAdmin"
              type="button"
              class="more-btn"
              title="更多操作"
              @click.stop="toggleMenu(a.id)"
            >
              <svg class="icon" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
              </svg>
            </button>
          </div>
          <div class="name-row">
            <div class="name">{{ a.name }}</div>
            <span v-if="a.highRisk" class="risk-badge" title="高风险专家：任务执行前需逐项确认执行清单">高风险</span>
          </div>
          <p class="desc">{{ a.description || "暂无说明" }}</p>
          <div class="model-line">
            <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></svg>
            {{ a.modelId ? `${a.providerName} · ${a.modelId}` : "模型 · 派发任务时选择" }}
          </div>
          <div v-if="a.tags.length" class="tags">
            <span v-for="t in a.tags" :key="t" class="tag">{{ t }}</span>
          </div>
          <div class="card-actions">
            <button type="button" class="dispatch" @click.stop="dispatch(a)">发任务</button>
          </div>
          <template v-if="menuFor === a.id">
            <div class="menu-backdrop" @click.stop="menuFor = ''"></div>
            <div class="card-menu">
              <button type="button" class="menu-item" @click.stop="openFolder(a)">
                <svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                打开文件夹
              </button>
              <button type="button" class="menu-item" @click.stop="openEdit(a)">
                <svg class="icon" viewBox="0 0 24 24"><path d="m14.5 4.5 5 5L8 21H3v-5z" /></svg>
                编辑专家
              </button>
              <button type="button" class="menu-item" @click.stop="openExportPack(a)">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 21V9m0 0 4 4m-4-4-4 4M4 5v-2h16v2" /></svg>
                导出专家包
              </button>
              <button type="button" class="menu-item danger" @click.stop="menuFor = ''; remove(a)">
                <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>
                删除
              </button>
            </div>
          </template>
        </div>
      </div>
      <div v-else class="empty">
        {{ agents.length ? "没有匹配的专家" : "还没有专家，请管理员点击右上角「新建专家」创建" }}
      </div>
    </template>

    <!-- 技能 -->
    <template v-else-if="tab === 'skills'">
      <div v-if="!isAdmin" class="empty">技能管理需要管理员权限</div>
      <div v-else-if="skillsLoading" class="empty">加载中…</div>
      <template v-else>
        <!-- 技能市场：内置精选 + 任意来源（URL 直链 / Git 仓库 / 本机目录） -->
        <div class="market-card">
          <div class="market-head">
            <div class="market-title">技能市场</div>
            <p class="market-hint">一键安装精选技能；也可从 URL、Git 仓库或本机目录安装，安装后可随时「同步」拉取更新。</p>
          </div>
          <div v-if="skillCatalog.catalog.length" class="market-grid">
            <div v-for="c in skillCatalog.catalog" :key="c.id" class="market-item">
              <div class="market-item-name">{{ c.id }}</div>
              <p class="market-item-desc">{{ c.description }}</p>
              <div class="market-item-foot">
                <button v-if="!c.installed" type="button" class="mini-btn primary-mini" :disabled="installingId === c.id" @click="installCatalogSkill(c.id)">
                  {{ installingId === c.id ? "安装中…" : "安装" }}
                </button>
                <span v-else class="installed-tag">已安装</span>
              </div>
            </div>
          </div>
          <div class="install-row">
            <input
              v-model="installSource"
              placeholder="安装来源：https://…/SKILL.md 直链、Git 仓库地址（git:github.com/user/repo）或本机目录"
              @keydown.enter.prevent="submitInstallSource"
            />
            <label class="overwrite-toggle" title="同名技能将被覆盖更新">
              <input v-model="installOverwrite" type="checkbox" />
              同名覆盖
            </label>
            <button type="button" class="mini-btn primary-mini" :disabled="installingId === '_source' || !installSource.trim()" @click="submitInstallSource">
              {{ installingId === "_source" ? "安装中…" : "安装" }}
            </button>
          </div>
        </div>

        <div v-if="skills.length" class="grid">
          <div v-for="s in skills" :key="s.name" class="expert-card">
            <div class="card-top">
              <div class="avatar skill-avatar">
                <svg class="icon" viewBox="0 0 24 24"><path d="m12 2 2.4 7.2H22l-6 4.4 2.3 7.2-6.3-4.5-6.3 4.5L8 13.6l-6-4.4h7.6z" /></svg>
              </div>
              <div class="row-actions">
                <button type="button" class="del" title="编辑技能" @click="openEditSkill(s.name)">
                  <svg class="icon" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                </button>
                <button type="button" class="del" title="删除技能" @click="removeSkill(s)">
                  <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>
                </button>
              </div>
            </div>
            <div class="name">{{ s.name }}</div>
            <p class="desc">{{ s.description || "暂无描述" }}</p>
            <div class="model-line">
              <svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
              SKILL.md · {{ fmtSize(s.size) }} · {{ timeAgo(s.updatedAt) }}
            </div>
            <div v-if="(s.usageCount ?? 0) > 0" class="usage-line" title="read_skill 加载与 /斜杠 调用的累计次数（P2-4 激活计数，用于市场精选与闲置清理）">
              <svg class="icon" viewBox="0 0 24 24"><path d="M3 12h4l2 7 4-16 2 9h6" /></svg>
              已被激活 {{ s.usageCount }} 次<template v-if="s.lastUsedAt"> · 最近 {{ timeAgo(s.lastUsedAt) }}</template>
            </div>
            <div v-if="skillCatalog.sources[s.name]" class="src-line">
              <span class="src-kind">{{ KIND_LABEL[skillCatalog.sources[s.name]!.kind] ?? skillCatalog.sources[s.name]!.kind }}</span>
              <span class="src-text" :title="skillCatalog.sources[s.name]!.source">{{ shortSource(skillCatalog.sources[s.name]!.source) }}</span>
              <span v-if="skillCatalog.sources[s.name]!.hasUpdate" class="upd-badge" title="来源内容比本地基线新，点「同步」拉取">有更新</span>
              <span
                v-else-if="skillCatalog.sources[s.name]!.note"
                class="upd-badge muted"
                :title="skillCatalog.sources[s.name]!.note"
              >未检测</span>
              <button type="button" class="mini-btn" :disabled="syncingName === s.name" @click="doSyncSkill(s)">
                {{ syncingName === s.name ? "同步中…" : "同步" }}
              </button>
            </div>
          </div>
        </div>
        <div v-else class="empty">还没有技能 —— 从上方「技能市场」安装，或点击右上角「新建技能」创建</div>
      </template>
    </template>

    <!-- 连接器 -->
    <template v-else-if="tab === 'connectors'">
      <div v-if="!isAdmin" class="empty">连接器管理需要管理员权限</div>
      <div v-else-if="mcpLoading" class="empty">加载中…</div>
      <div v-else-if="servers.length" class="conn-list">
        <div v-for="s in servers" :key="s.id" class="conn-card">
          <div class="conn-head">
            <div class="conn-title" @click="toggleExpand(s.id)">
              <span class="status-dot" :class="{ on: s.enabled && s.tools.length, off: !s.enabled }"></span>
              <span class="name">{{ s.name }}</span>
              <span class="src-kind">{{ s.type === "http" ? "HTTP" : "stdio" }}</span>
              <span v-if="s.type === 'http'" class="conn-cmd" :title="s.url">{{ s.url }}</span>
              <span v-else class="conn-cmd" :title="`${s.command} ${s.args.join(' ')}`">{{ s.command }} {{ s.args.join(" ") }}</span>
            </div>
            <div class="row-actions">
              <button type="button" class="del" title="编辑连接器" @click="openEditMcp(s)">
                <svg class="icon" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
              </button>
              <button type="button" class="mini-btn" :disabled="testing === s.id" @click="testMcp(s)">
                {{ testing === s.id ? "连接中…" : "测试连接" }}
              </button>
              <button type="button" class="switch" :class="{ on: s.enabled }" :title="s.enabled ? '已启用，点击停用' : '已停用，点击启用'" @click="toggleMcp(s)">
                <span class="knob"></span>
              </button>
              <button type="button" class="del" title="删除连接器" @click="removeMcp(s)">
                <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>
              </button>
            </div>
          </div>
          <div class="conn-meta">
            <template v-if="s.toolsCheckedAt">
              {{ s.enabled ? `已启用 · ${s.tools.length - (s.disabledTools?.length ?? 0)}/${s.tools.length} 个工具` : "已停用" }}
              <template v-if="s.disabledTools?.length"> · 已禁用 {{ s.disabledTools.length }} 个</template>
              <template v-if="s.tools.length"> · 最近检测 {{ timeAgo(s.toolsCheckedAt ?? "") }}</template>
            </template>
            <template v-else>尚未测试 —— 点击「测试连接」获取该服务器提供的工具</template>
          </div>
          <div v-if="expanded === s.id && s.tools.length" class="tool-chips">
            <span class="tool-chips-hint">点击工具切换启用/禁用（禁用后不注入任务会话）</span>
            <button
              v-for="t in s.tools"
              :key="t.name"
              type="button"
              class="tag tool-chip"
              :class="{ off: s.disabledTools?.includes(t.name) }"
              :title="`${t.description}（${s.disabledTools?.includes(t.name) ? '已禁用，点击启用' : '点击禁用'}）`"
              @click="toggleMcpTool(s, t.name)"
            >
              {{ t.name }}{{ s.disabledTools?.includes(t.name) ? " ⃠" : "" }}
            </button>
          </div>
        </div>
      </div>
      <div v-else class="empty">
        还没有连接器 —— 点击右上角「新建连接器」接入 MCP 服务器（如 npx @modelcontextprotocol/server-filesystem 目录）
      </div>
    </template>

    <!-- 平台指令（AGENTS.md） -->
    <template v-else-if="tab === 'instructions'">
      <div v-if="!isAdmin" class="empty">平台指令需要管理员权限</div>
      <div v-else class="ins-card">
        <div class="ins-head">
          <div>
            <div class="ins-title">平台级全局指令（AGENTS.md）</div>
            <p class="ins-hint">
              这里的内容会以 &lt;platform_instructions&gt; 注入<b>所有专家</b>的任务会话（位于平台基础规范之后、专家人设之前），
              适合放全平台统一的协作规范、回复格式与安全红线；专家个性仍由各自的系统提示词负责。
            </p>
          </div>
          <button type="button" class="new-btn" :disabled="insLoading || insSaving" @click="saveInstructions">
            {{ insSaving ? "保存中…" : "保存指令" }}
          </button>
        </div>
        <div v-if="insLoading" class="empty">加载中…</div>
        <template v-else>
          <textarea
            v-model="insContent"
            class="ins-editor"
            rows="16"
            :placeholder="`如：\n- 涉及删除文件、批量改写的操作，先说明影响再执行\n- 对外发送的内容一律使用中文商务语气\n- 数据结论必须注明来源与统计口径`"
          ></textarea>
          <div class="ins-foot">
            <span :class="{ over: insContent.length > INSTRUCTIONS_MAX }">{{ insContent.length }} / {{ INSTRUCTIONS_MAX }} 字符</span>
            <span>留空即不注入；保存后写入 data/agent/AGENTS.md，可纳入版本管理。</span>
          </div>
        </template>
      </div>
    </template>

    <!-- 新建专家弹窗 -->
    <teleport to="body">
      <div v-if="showCreate" class="overlay" @click.self="showCreate = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>{{ editingAgent ? `编辑专家「${editingAgent.name}」` : "新建专家" }}</h3>
            <button type="button" class="close" @click="showCreate = false">✕</button>
          </div>
          <form class="form" @submit.prevent="submitCreate">
            <div v-if="!editingAgent" class="ai-block">
              <div class="ai-head">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L15 15l6-3z" /></svg>
                <span>AI 快速生成</span>
                <em>用一句话描述你想要的专家，自动填好下方配置</em>
              </div>
              <div class="ai-row">
                <textarea
                  v-model="aiPrompt"
                  rows="2"
                  placeholder="如：帮我建一个能写小红书爆款文案的写手"
                  @keydown.enter.exact.prevent="generateAgent"
                ></textarea>
                <button type="button" class="ai-btn" :disabled="generating || !aiPrompt.trim()" @click="generateAgent">
                  {{ generating ? "生成中…" : "AI 生成" }}
                </button>
              </div>
            </div>
            <div class="folder-note">
              <svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              <template v-if="editingAgent?.folderPath">
                <span class="folder-path" :title="editingAgent.folderPath">{{ editingAgent.folderPath }}</span>
                <button type="button" class="folder-open" @click="openFolder(editingAgent)">打开</button>
              </template>
              <span v-else>创建后自动建立专属文件夹，任务默认在其中执行；文件夹可随时从卡片菜单打开。</span>
            </div>
            <label class="field">
              <span>名称 <i>*</i></span>
              <input v-model="cName" placeholder="如 行业研究员" required />
            </label>
            <label class="field">
              <span>一句话说明</span>
              <input v-model="cDesc" placeholder="如 追踪行业动态，输出结构化研究报告" />
            </label>
            <label class="field">
              <span>标签</span>
              <input v-model="cTags" placeholder="用逗号分隔，如 研究, 写作" />
            </label>
            <label class="field risk-field">
              <span>高风险专家</span>
              <span class="risk-toggle">
                <input v-model="cHighRisk" type="checkbox" />
                <em>开启后，派发的任务会先由 Agent 生成执行清单（运行哪些命令、增删哪些文件），用户逐项确认后才会真正执行。</em>
              </span>
            </label>
            <label v-if="false" class="field">
              <span>默认供应商</span>
              <select v-model="cProvider" @change="onProviderChange">
                <option value="">不绑定（派发任务时再选择模型）</option>
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.enabled ? "" : "（已停用）" }}</option>
              </select>
            </label>
            <label v-if="false" class="field model-field">
              <span>默认模型</span>
              <input
                v-model="cModel"
                placeholder="可留空；选择供应商后点击下方模型自动填入"
                autocomplete="off"
              />
              <div v-if="cProvider" class="model-picker">
                <div v-if="modelsLoading" class="model-state">正在获取模型列表…</div>
                <template v-else>
                  <div v-if="modelsError" class="model-error-row">
                    <span class="model-state error">{{ modelsError }}</span>
                    <button type="button" class="retry" @click="retryModels">重新获取</button>
                  </div>
                  <div v-if="providerModels.length" class="model-chips">
                    <button
                      v-for="m in filteredModels"
                      :key="m"
                      type="button"
                      class="m-chip"
                      :class="{ on: m === cModel }"
                      :title="`点击填入 ${m}`"
                      @click="selectModel(m)"
                    >
                      {{ m }}
                    </button>
                    <span v-if="!filteredModels.length" class="model-state">
                      {{ chatModels.length ? "无匹配模型，可直接使用输入的模型 ID" : "该供应商没有可对话的模型（向量/重排类已过滤），请到管理后台启用对话模型" }}
                    </span>
                  </div>
                  <div v-else-if="!modelsError" class="model-state">
                    该供应商还没有可用模型：到管理后台获取并启用模型，或直接输入模型 ID
                  </div>
                </template>
              </div>
            </label>
            <label class="field">
              <span>系统提示词 <i>*</i></span>
              <textarea v-model="cPrompt" rows="4" placeholder="这个专家的职责、风格与工作方式" required></textarea>
            </label>
            <div class="field">
              <span>可用技能</span>
              <label class="risk-toggle all-skills-toggle">
                <input v-model="useAllSkills" type="checkbox" />
                <em>使用全部平台技能（{{ skills.length }} 个）——技能会按需注入该专家的任务会话</em>
              </label>
              <div v-if="!useAllSkills" class="export-skills">
                <label v-for="s in skills" :key="s.name" class="export-check">
                  <input v-model="cSkills" type="checkbox" :value="s.name" />
                  <span :title="s.description">{{ s.name }}</span>
                </label>
                <span v-if="!skills.length" class="model-state">平台暂无技能</span>
              </div>
            </div>
            <div class="field">
              <span>工具策略</span>
              <p class="policy-hint">细粒度控制该专家能用哪些敏感工具：默认放行；「每次确认」在任务执行中弹出审批；「禁止」直接对该专家隐藏。</p>
              <div class="policy-table">
                <div v-for="row in policyRows" :key="row.key" class="policy-row">
                  <div class="policy-info">
                    <span class="policy-label">{{ row.label }}</span>
                    <span class="policy-desc" :title="row.desc">{{ row.desc }}</span>
                  </div>
                  <div class="policy-actions">
                    <button
                      v-for="act in [
                        { v: '', t: '默认放行' },
                        { v: 'ask', t: '每次确认' },
                        { v: 'deny', t: '禁止' },
                      ]"
                      :key="act.v"
                      type="button"
                      class="p-btn"
                      :class="{ on: policyAction(row.key) === act.v, warn: act.v === 'ask' && policyAction(row.key) === 'ask', danger: act.v === 'deny' && policyAction(row.key) === 'deny' }"
                      @click="setPolicyAction(row.key, act.v)"
                    >
                      {{ act.t }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="showCreate = false">取消</button>
              <button type="submit" class="primary" :disabled="creating || !cName.trim() || !cPrompt.trim() || !!cProvider !== !!cModel.trim()">
                {{ creating ? (editingAgent ? "保存中…" : "创建中…") : editingAgent ? "保存修改" : "创建专家" }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </teleport>

    <!-- 新建/编辑技能弹窗 -->
    <teleport to="body">
      <div v-if="showSkillDialog" class="overlay" @click.self="showSkillDialog = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>{{ editingSkill ? `编辑技能「${editingSkill}」` : "新建技能" }}</h3>
            <button type="button" class="close" @click="showSkillDialog = false">✕</button>
          </div>
          <form class="form" @submit.prevent="submitSkill">
            <label class="field">
              <span>名称 <i v-if="!editingSkill">*</i></span>
              <input v-model="sName" placeholder="如 数据清洗（创建后不可修改）" :disabled="!!editingSkill" required />
            </label>
            <label class="field">
              <span>描述</span>
              <input v-model="sDesc" placeholder="一句话说明这个技能的用途，模型据此判断何时使用" />
            </label>
            <label class="field">
              <span>斜杠参数提示</span>
              <input v-model="sArgHint" placeholder="可留空；填写后可在对话框用 /技能名 参数 直接调用，如 <主题或要点>" />
            </label>
            <label class="field">
              <span>技能内容 <i>*</i></span>
              <textarea v-model="sContent" rows="9" placeholder="技能的具体指令（Markdown）。任务会话按需经 read_skill 加载；支持 $ARGUMENTS 与 ${1:-默认值} 占位符承接斜杠参数。" required></textarea>
            </label>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="showSkillDialog = false">取消</button>
              <button type="submit" class="primary" :disabled="skillSaving || !sContent.trim()">
                {{ skillSaving ? "保存中…" : editingSkill ? "保存修改" : "创建技能" }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </teleport>

    <!-- 新建/编辑连接器弹窗 -->
    <teleport to="body">
      <div v-if="showMcpDialog" class="overlay" @click.self="showMcpDialog = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>{{ editingMcp ? `编辑连接器「${editingMcp.name}」` : "新建连接器" }}</h3>
            <button type="button" class="close" @click="showMcpDialog = false">✕</button>
          </div>
          <form class="form" @submit.prevent="submitMcp">
            <label class="field">
              <span>名称 <i>*</i></span>
              <input v-model="mName" placeholder="如 文件系统、数据库" required />
            </label>
            <label class="field">
              <span>连接方式</span>
              <select v-model="mType" :disabled="!!editingMcp">
                <option value="stdio">本地进程（stdio）</option>
                <option value="http">远程服务器（streamable HTTP）</option>
              </select>
            </label>
            <template v-if="mType === 'http'">
              <label class="field">
                <span>服务地址 <i>*</i></span>
                <input v-model="mUrl" placeholder="https://mcp.example.com/mcp（streamable HTTP 端点）" required />
              </label>
              <label class="field">
                <span>请求头</span>
                <textarea v-model="mHeaders" rows="3" placeholder="每行一个，格式 KEY=VALUE（如 Authorization=Bearer ${MY_TOKEN_ENV}）。值支持 ${ENV_NAME} 引用平台环境变量，令牌不落库。"></textarea>
              </label>
            </template>
            <template v-else>
              <label class="field">
                <span>启动命令 <i>*</i></span>
                <input v-model="mCommand" placeholder="如 npx / node / python" required />
              </label>
              <label class="field">
                <span>命令参数</span>
                <input v-model="mArgs" placeholder="空格分隔，如 -y @modelcontextprotocol/server-filesystem D:\docs" />
              </label>
              <label class="field">
                <span>环境变量</span>
                <textarea v-model="mEnv" rows="3" placeholder="每行一个，格式 KEY=VALUE（如 API_KEY=xxx）"></textarea>
              </label>
            </template>
            <div class="field-row">
              <label class="field">
                <span>启动超时（秒）</span>
                <input v-model="mStartupTimeout" type="number" min="1" max="300" placeholder="10" />
              </label>
              <label class="field">
                <span>工具调用超时（秒）</span>
                <input v-model="mToolTimeout" type="number" min="1" max="600" placeholder="60" />
              </label>
            </div>
            <p class="mcp-tip">
              <template v-if="mType === 'http'">
                平台通过 streamable HTTP（JSON-RPC POST + SSE）与远程服务器通信，并遵循 mcp-session-id 会话协议；保存后点击「测试连接」完成握手并获取工具列表。
                {{ editingMcp ? "修改地址/请求头/超时后会自动按新配置重连。" : "" }}
              </template>
              <template v-else>
                平台通过 stdio（JSON-RPC）与该进程通信；保存后点击「测试连接」完成握手并获取工具列表，工具会注入所有任务会话。
                {{ editingMcp ? "修改命令/参数/环境/超时后会自动断开旧进程并按新配置重连。" : "" }}
              </template>
            </p>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="showMcpDialog = false">取消</button>
              <button type="submit" class="primary" :disabled="mcpSaving || !mName.trim() || (mType === 'http' ? !mUrl.trim() : !mCommand.trim())">
                {{ mcpSaving ? (editingMcp ? "保存中…" : "创建中…") : editingMcp ? "保存修改" : "创建连接器" }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </teleport>

    <!-- 安装/导入专家包弹窗 -->
    <teleport to="body">
      <div v-if="showPackDialog" class="overlay" @click.self="showPackDialog = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>{{ packMode === "import" ? "导入专家包" : `安装专家包「${packToInstall?.name}」` }}</h3>
            <button type="button" class="close" @click="showPackDialog = false">✕</button>
          </div>
          <div class="form">
            <div v-if="packMode === 'import' && packFile" class="pack-file-row">
              <svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
              <span class="pack-file-name">{{ packFile.name }}</span>
              <span class="pack-file-size">{{ fmtSize(packFile.size) }}</span>
            </div>
            <template v-else-if="packToInstall">
              <div class="pack-meta">
                <div class="pack-name-lg">{{ packToInstall.name }}</div>
                <p class="pack-meta-desc">{{ packToInstall.description }}</p>
                <div class="pack-tags">
                  <span v-for="t in packToInstall.tags" :key="t" class="tag">{{ t }}</span>
                  <span v-if="packToInstall.skillCount" class="tag alt">随包安装 {{ packToInstall.skillCount }} 个技能</span>
                </div>
              </div>
            </template>
            <label v-if="false" class="field">
              <span>默认供应商</span>
              <select v-model="packProvider" @change="onPackProviderChange">
                <option value="">不绑定（派发任务时再选择模型）</option>
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.enabled ? "" : "（已停用）" }}</option>
              </select>
            </label>
            <label v-if="false" class="field">
              <span>默认模型</span>
              <select v-model="packModel" :disabled="!packProvider || packModelsLoading">
                <option value="">不绑定</option>
                <option v-for="m in packChatModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <span v-if="packModelsLoading" class="model-state">正在获取模型列表…</span>
            </label>
            <p class="mcp-tip">
              {{ packMode === "import"
                ? "导入会新建专家并随包安装技能；与现有重名的技能会自动改名（追加 -2），不会覆盖已有内容。"
                : "安装会新建专家并随包安装技能；与现有重名的技能会自动改名（追加 -2），不会覆盖已有内容。" }}
            </p>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="showPackDialog = false">取消</button>
              <button type="button" class="primary" :disabled="packBusy" @click="submitPack">
                {{ packBusy ? "安装中…" : packMode === "import" ? "导入专家" : "安装专家" }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 导出专家包弹窗 -->
    <teleport to="body">
      <div v-if="showExportDialog && exportTarget" class="overlay" @click.self="showExportDialog = false">
        <div class="dialog">
          <div class="dialog-head">
            <h3>导出专家包「{{ exportTarget.name }}」</h3>
            <button type="button" class="close" @click="showExportDialog = false">✕</button>
          </div>
          <div class="form">
            <div class="field">
              <span>携带技能</span>
              <div class="export-skills">
                <label v-for="s in skills" :key="s.name" class="export-check">
                  <input v-model="exportSkills" type="checkbox" :value="s.name" />
                  <span>{{ s.name }}</span>
                </label>
                <span v-if="!skills.length" class="model-state">平台暂无技能可携带</span>
              </div>
            </div>
            <p class="mcp-tip">专家包为 JSON 文件（office-agent-package 格式），包含专家配置与勾选的技能；对方通过「导入专家包」即可使用，模型在导入时再选择。</p>
            <div class="dialog-foot">
              <button type="button" class="ghost" @click="showExportDialog = false">取消</button>
              <button type="button" class="primary" :disabled="exporting" @click="submitExport">
                {{ exporting ? "导出中…" : "导出 .json" }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.page {
  max-width: 1100px;
  margin: 24px auto;
  padding: 0 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: rise 0.22s ease-out;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.seg {
  display: flex;
  gap: 4px;
  background: var(--surface-2);
  border-radius: 10px;
  padding: 3px;
}
.seg-btn {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 7px 18px;
  font-size: 13.5px;
  color: var(--text-2);
  border-radius: 8px;
}
.seg-btn:hover {
  border-color: transparent;
  color: var(--text);
}
.seg-btn.active {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.new-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13.5px;
  font-weight: 500;
}
.new-btn:hover {
  background: var(--accent-strong);
  color: var(--on-accent);
}
.new-btn .icon {
  width: 15px;
  height: 15px;
}
.tab-hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 12px;
  height: 38px;
  width: 300px;
  color: var(--text-3);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  border: none;
  box-shadow: none;
  padding: 0;
  height: 100%;
  background: transparent;
}
.search input:focus {
  box-shadow: none;
}
.search .icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.t-chip {
  border-radius: 999px;
  padding: 5px 13px;
  font-size: 12.5px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  box-shadow: none;
}
.t-chip:hover {
  border-color: var(--text-3);
  color: var(--text);
}
.t-chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.expert-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  transition: box-shadow 0.18s, transform 0.18s, border-color 0.18s;
}
.expert-card:hover {
  box-shadow: var(--shadow-2);
  border-color: var(--border-strong);
  transform: translateY(-2px);
}
/* 专家卡片可点击进入详情；技能/连接器卡片不联动 */
.expert-card.clickable {
  cursor: pointer;
}
.expert-card.clickable:hover {
  border-color: var(--accent-border);
}

.risk-badge {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: var(--warn);
  background: var(--warn-soft);
  border: 1px solid var(--warn);
}
.name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.name-row .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.risk-field .risk-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.risk-field input[type="checkbox"] {
  margin-top: 3px;
  width: 15px;
  height: 15px;
  accent-color: var(--warn);
  flex-shrink: 0;
}
.risk-field em {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.55;
}
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.del {
  border: none;
  box-shadow: none;
  background: transparent;
  color: var(--text-3);
  padding: 4px;
  border-radius: 8px;
}
.del:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.del .icon {
  width: 15px;
  height: 15px;
}
.more-btn {
  border: none;
  box-shadow: none;
  background: transparent;
  color: var(--text-3);
  padding: 4px 6px;
  border-radius: 8px;
  position: relative;
  z-index: 3;
}
.more-btn:hover,
.more-btn[aria-expanded="true"] {
  color: var(--text);
  background: var(--surface-2);
}
.more-btn .icon {
  width: 16px;
  height: 16px;
}
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2;
}
.card-menu {
  position: absolute;
  right: 14px;
  top: 52px;
  z-index: 3;
  min-width: 148px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-pop);
  padding: 5px;
  display: flex;
  flex-direction: column;
  animation: menu-in 0.14s ease;
}
@keyframes menu-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.menu-item {
  border: none;
  box-shadow: none;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.menu-item:hover {
  background: var(--surface-2);
}
.menu-item.danger {
  color: var(--danger);
}
.menu-item.danger:hover {
  background: var(--danger-soft);
}
.menu-item .icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.folder-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--surface-2);
  border: 1px dashed var(--border-strong);
  font-size: 12px;
  color: var(--text-2);
}
.ai-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.ai-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--accent);
}
.ai-head .icon {
  width: 15px;
  height: 15px;
  color: var(--accent);
}
.ai-head em {
  font-style: normal;
  font-weight: 400;
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ai-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.ai-row textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 10px;
  font-size: 12.5px;
  line-height: 1.5;
  font-family: inherit;
  background: var(--surface);
  color: var(--text);
  min-width: 0;
}
.ai-row textarea:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
.ai-btn {
  border: none;
  box-shadow: none;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12.5px;
  font-weight: 600;
  padding: 0 14px;
  border-radius: 9px;
  white-space: nowrap;
  align-self: stretch;
}
.ai-btn:hover:not(:disabled) {
  filter: brightness(1.06);
}
.ai-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.folder-note .icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--accent);
}
.folder-path {
  flex: 1;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.folder-open {
  border: none;
  box-shadow: none;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 7px;
  flex-shrink: 0;
}
.folder-open:hover {
  filter: brightness(1.08);
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.skill-avatar {
  background: linear-gradient(135deg, #f59e0b, #ef4444);
}
.skill-avatar .icon {
  width: 20px;
  height: 20px;
}

/* 连接器 */
.conn-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.conn-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: box-shadow 0.18s, border-color 0.18s;
}
.conn-card:hover {
  box-shadow: var(--shadow-2);
  border-color: var(--border-strong);
}
.conn-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.conn-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  cursor: pointer;
}
.conn-title .name {
  font-size: 14.5px;
  font-weight: 700;
  flex-shrink: 0;
}
.conn-cmd {
  font-size: 12px;
  color: var(--text-3);
  font-family: var(--mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--border-strong);
  flex-shrink: 0;
}
.status-dot.on {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.status-dot.off {
  background: var(--border-strong);
}
.mini-btn {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-2);
  box-shadow: none;
}
.mini-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.mini-btn:disabled {
  opacity: 0.6;
}
.switch {
  width: 34px;
  height: 19px;
  border-radius: 999px;
  background: var(--border-strong);
  border: none;
  box-shadow: none;
  padding: 0;
  position: relative;
  transition: background 0.15s;
  flex-shrink: 0;
}
.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.switch.on {
  background: var(--accent);
}
.switch.on .knob {
  transform: translateX(15px);
}
.conn-meta {
  font-size: 12px;
  color: var(--text-3);
}
.tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 2px;
  align-items: center;
}
.tool-chips-hint {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--text-3);
}
.tool-chip {
  cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
}
.tool-chip.off {
  opacity: 0.45;
  text-decoration: line-through;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.all-skills-toggle {
  margin-bottom: 6px;
}
.mcp-tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  background: var(--surface-2);
  border-radius: 8px;
  padding: 8px 12px;
}
.name {
  font-size: 15.5px;
  font-weight: 700;
}
.desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 20px;
}
.model-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  font-family: var(--mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-line .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  font-size: 11.5px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 2px 10px;
}
.card-actions {
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  justify-content: flex-end;
}
.dispatch {
  border-radius: 9px;
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.dispatch:hover {
  background: var(--accent-strong);
  color: var(--on-accent);
}
.empty {
  padding: 60px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 13.5px;
  border: 1px dashed var(--border-strong);
  border-radius: 16px;
}
.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border-style: dashed;
}
.ph-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--surface-2);
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.ph-icon .icon {
  width: 24px;
  height: 24px;
}
.placeholder h3 {
  margin: 4px 0 0;
  font-size: 15px;
  color: var(--text-2);
}
.placeholder p {
  margin: 0;
  max-width: 420px;
  line-height: 1.6;
}

/* 弹窗 */
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(2px);
  display: grid;
  place-items: center;
  z-index: 60;
}
.dialog {
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--surface);
  border-radius: 18px;
  box-shadow: var(--shadow-pop);
  animation: rise 0.18s ease-out;
}
.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 0;
}
.dialog-head h3 {
  margin: 0;
  font-size: 16px;
}
.close {
  border: none;
  box-shadow: none;
  background: transparent;
  color: var(--text-3);
  padding: 4px 8px;
  border-radius: 8px;
}
.close:hover {
  color: var(--text);
  background: var(--surface-2);
}
.form {
  padding: 14px 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
.field i {
  color: var(--danger);
  font-style: normal;
}
.model-picker {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 132px;
  overflow-y: auto;
}
.m-chip {
  font-size: 12px;
  font-family: var(--mono, monospace);
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 4px 12px;
  box-shadow: none;
}
.m-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.m-chip.on {
  border-color: var(--accent);
  color: var(--on-accent);
  background: var(--accent);
  font-weight: 600;
}
.model-state {
  font-size: 12.5px;
  color: var(--text-3);
}
.model-state.error {
  color: var(--danger);
}
.model-error-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.model-error-row .model-state {
  flex: 1;
}
.retry {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 8px;
}
.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
.ghost {
  background: transparent;
}

/* ---------- 专家包 / 技能市场 / 安装同步 ---------- */
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 13.5px;
}
.ghost-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}
.ghost-btn .icon {
  width: 15px;
  height: 15px;
}
.hidden-file {
  display: none;
}
.mini-btn.primary-mini {
  color: var(--accent);
  border-color: var(--accent);
  background: transparent;
}
.mini-btn.primary-mini:hover {
  background: var(--accent);
  color: var(--on-accent);
}
.pack-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  background: var(--surface-2);
  border: 1px dashed var(--border);
  border-radius: 14px;
  padding: 12px 14px;
}
.pack-strip-head {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.pack-strip-title {
  font-size: 13.5px;
  font-weight: 600;
}
.pack-strip-head span:last-child {
  font-size: 12px;
  color: var(--text-3);
}
.pack-item {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 14px;
  flex: 1 1 320px;
  min-width: 280px;
}
.pack-info {
  flex: 1;
  min-width: 0;
}
.pack-name {
  font-weight: 600;
  font-size: 13.5px;
}
.pack-desc {
  margin: 3px 0 6px;
  font-size: 12.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.market-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.market-title {
  font-weight: 600;
  font-size: 14px;
}
.market-head p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.market-item {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.market-item-name {
  font-weight: 600;
  font-size: 13.5px;
}
.market-item-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
  flex: 1;
}
.market-item-foot {
  display: flex;
  justify-content: flex-end;
}
.installed-tag {
  font-size: 12px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}
.install-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px dashed var(--border);
}
.install-row input:first-child {
  flex: 1;
  font-size: 13px;
}
.overwrite-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--text-2);
  white-space: nowrap;
  cursor: pointer;
}
.overwrite-toggle input {
  width: auto;
}
.src-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  font-size: 12px;
  color: var(--text-3);
}
.src-kind {
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 7px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--surface-2);
}
.src-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13px;
}
.pack-file-row .icon {
  width: 16px;
  height: 16px;
  color: var(--accent);
}
.pack-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-file-size {
  color: var(--text-3);
  font-size: 12px;
}
.pack-meta {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.pack-name-lg {
  font-weight: 600;
  font-size: 14.5px;
}
.pack-meta-desc {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.export-skills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.export-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 5px 12px;
  cursor: pointer;
}
.export-check input {
  width: auto;
}
.usage-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.usage-line .icon {
  width: 13px;
  height: 13px;
}
.upd-badge {
  flex-shrink: 0;
  border-radius: 6px;
  padding: 1px 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: #b45309;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.upd-badge.muted {
  color: var(--text-3);
  background: var(--surface-2);
  border-color: var(--border);
  font-weight: 400;
  cursor: help;
}
/* 工具策略编辑器（P2-2） */
.policy-hint {
  margin: 4px 0 8px;
  font-size: 12px;
  color: var(--text-3);
}
.policy-table {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.policy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
}
.policy-row + .policy-row {
  border-top: 1px solid var(--border);
}
.policy-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.policy-label {
  font-size: 13px;
  font-weight: 500;
}
.policy-desc {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.policy-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.p-btn {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-2);
}
.p-btn.on {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.p-btn.on.warn {
  border-color: #d97706;
  color: #b45309;
}
.p-btn.on.danger {
  border-color: #dc2626;
  color: #dc2626;
}
/* 平台指令（AGENTS.md）编辑页（P2-3） */
.ins-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ins-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ins-title {
  font-weight: 600;
  font-size: 14.5px;
}
.ins-hint {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.6;
  max-width: 720px;
}
.ins-editor {
  width: 100%;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 13px;
  line-height: 1.65;
  resize: vertical;
}
.ins-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-3);
}
.ins-foot .over {
  color: #dc2626;
  font-weight: 600;
}
</style>
