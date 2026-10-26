import { memoryPlugin } from "./memory.js";
import { skinMarketPlugin } from "./skin-market.js";
import { PluginRegistry } from "./registry.js";
import type { FastifyInstance } from "fastify";

const schedulerPlugin = {
  manifest: { id: "scheduler", version: "0.1.0", name: "定时任务", description: "定时与自动化巡检任务" },
  async start() {
    const { startScheduler } = await import("../scheduler.js");
    startScheduler();
  },
  async stop() {
    const { stopScheduler } = await import("../scheduler.js");
    stopScheduler();
  },
  async registerRoutes(app: FastifyInstance) {
    const { registerScheduleRoutes } = await import("../scheduler.js");
    registerScheduleRoutes(app);
  },
};

const voicePlugin = {
  manifest: { id: "voice", version: "0.1.0", name: "语音输入", description: "远端或本地离线语音转写" },
  async registerRoutes(app: FastifyInstance) {
    const { registerVoiceRoutes } = await import("../routes/voice.js");
    registerVoiceRoutes(app);
  },
  async createTools(ctx: import("./types.js").PluginToolContext) {
    const { voiceTools } = await import("../tools.js");
    return voiceTools(ctx.workspacePath, ctx.userId);
  },
};

const webAccessPlugin = {
  manifest: { id: "web-access", version: "0.1.0", name: "网页访问", description: "抓取已知 HTTP(S) 网页内容" },
  async createTools(ctx: import("./types.js").PluginToolContext) {
    const { webTools } = await import("../tools.js");
    return webTools(ctx.workspacePath);
  },
};

const wpsPlugin = {
  manifest: { id: "wps", version: "0.1.0", name: "WPS 协作", description: "WPS 通讯录、文档与消息连接器" },
  async start() {
    const { warmDirectoryCache } = await import("../routes/wps.js");
    warmDirectoryCache();
  },
  async registerRoutes(app: FastifyInstance) {
    const { registerWpsRoutes } = await import("../routes/wps.js");
    registerWpsRoutes(app);
  },
};

const knowledgeBasePlugin = {
  manifest: { id: "knowledge-base", version: "0.1.0", name: "企业知识库", description: "知识库工作台嵌入与会话续期" },
  async start() {
    const { startKbSessionKeeper } = await import("../kb-session.js");
    startKbSessionKeeper();
  },
  async stop() {
    const { stopKbSessionKeeper } = await import("../kb-session.js");
    stopKbSessionKeeper();
  },
  async registerRoutes(app: FastifyInstance) {
    const { registerKbEmbedRoutes } = await import("../kb-embed.js");
    await registerKbEmbedRoutes(app);
  },
  async createTools(ctx: import("./types.js").PluginToolContext) {
    const { knowledgeTools } = await import("../knowledge-tools.js");
    const { agentUsesSkill } = await import("../skills.js");
    return agentUsesSkill(ctx.agentId, "enterprise-knowledge")
      ? knowledgeTools(ctx.workspacePath, ctx.userId)
      : [];
  },
};

const mcpPlugin = {
  manifest: { id: "mcp", version: "0.1.0", name: "MCP 连接器", description: "按用户启用状态注入远程和本地 MCP 工具" },
  async createTools(ctx: import("./types.js").PluginToolContext) {
    const { getMcpTools } = await import("../mcp.js");
    return getMcpTools(ctx.userId);
  },
  async stop() {
    // 停用插件时回收 stdio 子进程 / 远程会话，避免残留
    const { closeAllMcpClients } = await import("../mcp.js");
    closeAllMcpClients();
  },
};

const skillsPlugin = {
  manifest: { id: "skills", version: "0.1.0", name: "平台技能", description: "内置 Agent Skills 与技能目录" },
  async start() {
    const { ensureSeedSkills } = await import("../skills.js");
    const { installSkillFromSource } = await import("../skill-install.js");
    ensureSeedSkills();
    for (const skillId of ["wps365-skill", "document-ocr", "skill-creator"] as const) {
      try {
        const outcome = await installSkillFromSource(skillId);
        console.log(`[skills] 内置技能已就绪：${outcome.names.join("、")}（来源 ${outcome.source}）`);
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        if (msg.includes("已存在")) console.log(`[skills] 内置技能 ${skillId} 已安装，跳过`);
        else console.warn(`[skills] 内置技能 ${skillId} 自动安装失败：${msg}`);
      }
    }
  },
  async createTools(ctx: import("./types.js").PluginToolContext) {
    const { listEffectiveSkills, readSkillTool, writeSkillTool } = await import("../skills.js");
    const { skillScriptTool } = await import("../skill-scripts.js");
    const tools = [writeSkillTool()];
    if (listEffectiveSkills(ctx.agentId).length) tools.push(readSkillTool(ctx.agentId), skillScriptTool(ctx.agentId));
    return tools;
  },
};

const piPackagesPlugin = {
  manifest: { id: "pi-packages", version: "0.1.0", name: "Pi 扩展包", description: "随产品交付并隔离在平台 agent 目录的 Pi 扩展" },
  async start() {
    const { ensureExternalPiPackages, installPiPackages } = await import("../packages.js");
    const result = installPiPackages();
    for (const { id, dest, alreadySynced } of result.installed) {
      console.log(`[packages] pi 插件包 ${id} 就绪（${alreadySynced ? "已是最新" : "已更新"}）：${dest}`);
    }
    for (const id of result.skipped) console.warn(`[packages] 跳过 pi 插件包 ${id}：仓库内未找到包模板`);
    const external = await ensureExternalPiPackages();
    for (const source of external.ready) console.log(`[packages] ${source} 已就绪`);
    for (const { source, error } of external.failed) console.warn(`[packages] ${source} 安装失败：${error}`);
  },
  async onTaskStarted(ctx: import("./types.js").TaskStartContext) {
    const { writeTaskOcrRuntime } = await import("../ocr-runtime.js");
    writeTaskOcrRuntime(ctx.taskId, ctx.userId);
  },
  async stop() {
    const { disableManagedPiPackages } = await import("../packages.js");
    disableManagedPiPackages();
  },
};

export const platformPlugins = new PluginRegistry();
platformPlugins.register(memoryPlugin);
platformPlugins.register(skinMarketPlugin);
platformPlugins.register(skillsPlugin);
platformPlugins.register(piPackagesPlugin);
platformPlugins.register(schedulerPlugin);
platformPlugins.register(voicePlugin);
platformPlugins.register(webAccessPlugin);
platformPlugins.register(wpsPlugin);
platformPlugins.register(knowledgeBasePlugin);
platformPlugins.register(mcpPlugin);
