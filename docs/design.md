# 设计共识（grill 会话产出）

> 状态：**已确认**（2026-09-24，A1/A2 经用户确认，grill 会话收敛）。

## 1. 产品

任务执行型 AI 办公平台，对标腾讯 WorkBuddy：用户下达任务 → agent 自主拆解执行 → 交付可验收成果物。知识库/RAG 出范围（另一项目）。术语见根目录 `CONTEXT.md`。

## 2. 技术栈与形态

| 层 | 选型 | 依据 |
|---|---|---|
| 客户端 | Electron + Vue 3 + TS（控制台） | 托盘/通知/分发体验；Web 端可复用同一后端 |
| 后端 | Node ≥ 22.19 + TypeScript + Fastify | pi 官方推荐进程内 SDK 嵌入，钉死 TS 全栈 |
| agent 引擎 | `@earendil-works/pi-coding-agent` 的 `createAgentSession()`，精确锁 0.87.1 | pi 官方嵌入最佳实践（ADR 0001） |
| 业务库 | SQLite（better-sqlite3，WAL；用户/任务登记/成果物索引/审计） | pi 生态无服务器数据库实践；规模足够（ADR 0003） |
| agent 会话 | pi 原生 JSONL，`SessionManager` 自定义目录，每任务一个 | ADR 0003 |
| 部署 | Docker Compose，单容器 app + 数据卷（SQLite / 会话 / 任务工作区），≤100 人 | 备份 = 拷贝数据卷 |

## 3. 执行架构

```
Electron + Vue 客户端（控制台）
   │  REST(业务) + SSE(围观执行流)
   ▼
Node 后端 (Fastify + TS) ——单容器
   ├── 业务 API：登录(JWT)、任务 CRUD、成果物上传下载、管理端(用户/key/agent 预置)
   │     └→ SQLite（better-sqlite3，WAL）
   └── pi SDK（进程内，每任务一个 AgentSession）
        ├── customTools：workspace_list / workspace_read / workspace_write / fetch_url /
        │   run_code / read_skill / MCP 桥接工具（TypeBox schema）
        │   · 输出按官方规范截断（2000 行 / 50KB，全量落盘给路径引用）
        │   · beforeToolCall 路径 jail（限制在任务工作区内）——MVP 便利级隔离
        ├── 技能：{agentDir}/skills/<name>/SKILL.md 渐进披露——系统提示词只注入元数据清单，
        │   正文与 scripts/references 资源由模型调 read_skill 按需加载（ADR 0005）
        ├── 会话：SessionManager.create(cwd, sessionsDir)，与任务 ID 关联
        ├── 模型：pi-ai 多 provider（DeepSeek/Qwen/Moonshot/任意 OpenAI 兼容），
        │   自定义 CredentialStore；key 管理员统一配置；compat 按 baseUrl 自动探测
        ├── compaction 默认开启（reserve 16k / keep 20k）
        └── 事件：session.subscribe → SSE 桥（自写；agent_settled 判定轮次终结）
```

数据卷布局：`data/app.db`（SQLite）、`data/sessions/`（pi JSONL）、`data/workspaces/<taskId>/`（任务工作区）、`data/deliverables/`（成果物）。

## 4. MVP 范围（第一版做什么）

1. 登录（账号密码 + JWT，管理员/成员两级角色）
2. 任务：下达（自然语言 + 附件上传至任务工作区）→ 围观（SSE 事件流：文本/思考/工具执行三段式）→ 验收（成果物列表 + 下载）
3. 官方预置 agent 2~3 个（通用任务、文档生成等），管理员可配 system prompt 与工具集；用户不建 agent（现状已超出该设想：专家 = 管理员配置 + AI 一句话生成 + 专家包市场/导入导出，且可绑定技能子集，见状态注记五/六）
4. 模型管理端：provider / key / 模型开关，平台统一计 key
5. 任务列表 / 历史 / 会话回放（走 pi 会话 API）

**明确不做（本期）**：知识库/RAG、代码执行、用户自建 agent、IM 入口、计费/多租户、本地文件执行位。

## 5. 二期路线（按优先级）

> 状态注记（2026-10-12）：原第 3 项「MCP 桥接」已提前落地（管理端 stdio 连接器 + 工具注入，见 CHANGELOG）；专家常驻文件夹、模型解耦、技能库也已在 MVP 后补齐。
> 状态注记二（2026-10-12 二批）：第 1 项部分落地——`run_code` 工具按「逐次调用 Docker 容器」实现（无网络/限资源/只读挂载，见 ADR 0004），Docker 不可用时静默降级；**每任务常驻容器**的进一步硬隔离仍留在本路线。第 5 项「附件上传」已落地（multipart 派发 + 附件落工作区 + 不计成果物）；任务列表已支持服务端分页。
> 状态注记三（2026-10-12 三批）：附件上传延伸到多轮追问——任务详情页对话输入框支持回形针/拖拽上传，追问附件同样落工作区、不计成果物，并合成清单注入本轮提示词；平台工作区首轮提示词随附件就位动态调整。
> 状态注记四（2026-10-13 四批）：接入 pi 插件体系——内置 pi package「office-suite」（`pi-packages/office-suite/`），启动时同步到 `{agentDir}/packages/` 并在 `{agentDir}/settings.json` 写入 packages 声明（`packages.ts`，等价 `pi install ./local-package`）；含 todo 清单扩展、写操作护栏扩展（workspace_write 关键文件 + run_code 破坏性脚本拦截）、办公提示词模板（/周报、/会议纪要、/邮件润色，`session.prompt()` 原生展开）。第 4 项子 agent 编排可继续参考 `examples/extensions/subagent/`；后续如需更多插件优先评估 pi 官方扩展示例的无头适配。
> 状态注记五（2026-10-13 五批）：技能与专家从「手工配置」升级为「可安装/可同步/可分发」——技能支持内置市场（`skills-catalog/`）与四类来源安装（本地路径 / http(s) Markdown / git 浅克隆 / 内置目录 id），来源登记进 `skill_sources` 表（kind/revision/synced_at）支持一键同步重拉、来源消失的关联技能自动删除；专家包格式 `office-agent-package` v1，内置包市场（`agent-packs/`）、一键安装、`.json` 导入（同名技能自动改名不覆盖）与任意专家导出（可捆绑平台技能）。第 2 项「用户自建 agent」的生态位由此补上分发侧：装（内置市场）/导（文件包）/同（来源刷新）三件套齐备，远端注册表（统一目录服务）仍留在后续。
> 状态注记六（2026-10-14 六批，按 `review-2026-10-14-experts-skills-mcp.md` 路线图完成 P0 全部 + P1 全部）：技能侧——frontmatter 对齐 Agent Skills 开放规范（argument-hint/alias/metadata/allowed-tools/user-invocable），**渐进披露**上线：系统提示词只注入元数据清单（4k 字符封顶），正文与 scripts/references 资源由模型调 `read_skill` 按需加载（ADR 0005）；斜杠调用收敛为技能一元机制（`/技能名 参数` 服务端展开，$ARGUMENTS 与 ${1:-默认值} 替换），office-suite 的 pi prompts（/周报、/会议纪要、/邮件润色）迁移为平台 seed 技能。专家侧——新增专家↔技能绑定（`agent_skills` 表，**无绑定行 = 使用全部**，兼容 v1），专家包安装/导入逐条返回告警（非法/空内容/超上限技能不再静默跳过）。MCP 侧——工具参数 schema 透传（修复带参工具不可用）、连接器全字段可编辑（命令类字段变更自动失效工具缓存）、启动/工具超时可配（默认 10s/60s，对齐 Codex）、per-tool 停用、`.mcp.json` 导入导出（与 Claude Code / Cursor / VS Code 互通）。顺带收敛：`GET /admin/agents` 不再返回原始 folder 绝对路径，删除死代码 `resolveSkillNameConflicts`，listSkills/getSkill 描述语义统一。P2（远程 MCP、专家级工具策略、AGENTS.md 分层指令、技能更新闭环、模型能力元数据）按需排期。
> 状态注记七（2026-10-14 七批，按 `review-2026-10-14-experts-skills-mcp.md` 路线图完成 P2 全部，评审路线 P0/P1/P2 至此全部收官）：**P2-1 远程 MCP**——连接器 `type` 扩展为 stdio（v1 语义不变）/ http（streamable HTTP：JSON-RPC POST + SSE 流式响应、mcp-session-id 会话协商、mcp-protocol-version 头），请求头支持 `${ENV_NAME}` 凭据引用（令牌不落库，发送时展开，对齐 Codex bearer_token_env_var 思路），`.mcp.json` 导入导出识别 http/sse 条目。**P2-2 专家级工具策略**——`agents.tool_policy` 按精确工具名 / `mcp:连接器:*` 通配 / `mcp:*` 配置 ask / deny（未列出 = 放行），ask 在工具执行前暂停任务并广播审批事件（状态转 awaiting_approval，任务详情页放行/拒绝，5 分钟超时自动拒绝；等待期 30s 心跳续活防 180s 看门狗误杀；deny 直接不注入），workspace_write / fetch_url / run_code / 全部 MCP 工具纳管。**P2-3 平台指令**——`data/agent/AGENTS.md`（`GET/PUT /admin/instructions`，64k 字符上限）以 `<platform_instructions>` 注入所有专家（平台基础规范之后、专家人设之前），形成 平台全局指令 → 专家人设 → 技能清单 的分层提示词。**P2-4 技能演进闭环**——安装/同步即记录内容指纹基线（git 远端短 sha / 内容与目录哈希），`GET /admin/skills/updates` 漂移检测驱动「有更新」徽标（未建基线的存量来源如实显示「未检测」不误报），`POST /admin/skills/sync-all` 批量同步（失败不阻塞），`skill_usage` 表累计 read_skill 与斜杠激活次数（`GET /admin/skills` 携带 usageCount/lastUsedAt）。**P2-5 模型能力元数据**——`model_providers.model_overrides` 按模型 ID 覆盖 contextWindow/maxTokens/reasoning（缺省 128k/32768/无推理；解析宽松容错，坏数据回落默认），替换 runner 硬编码。D8（成员 systemPrompt 可见性）留待后续。

1. 代码执行工具 + 每任务 Docker 容器（pi 官方 containerization 路线；`run_code` 已提供逐次调用的容器隔离，剩余为每任务常驻容器升级）
2. 用户自建 agent（模型/提示词/工具组合）
3. 本地执行位 / 云端长任务（WorkBuddy 混合形态）；pi-durable 转正评估（跟踪其 CHANGELOG）
4. 子 agent 编排（pi 无原生 API，参考 `examples/extensions/subagent/` 在工具内嵌套）
5. ~~附件上传至任务工作区~~（已落地，2026-10-12）

## 5.1 运行时资源治理（2026-10-12 增补）

- SSE 事件回放缓冲：每任务上限 500 帧，最多跟踪 100 个最近活跃任务，超限淘汰最久未活跃者；任务删除时清空。
- 内存 AgentSession：闲置 > 1 小时由 sweeper 回收（10 分钟一扫）；会话 JSONL 常驻磁盘，追问时自动恢复。
- 任务删除：级联清理成果物索引、消息、附件登记、平台隔离工作区目录、会话 JSONL 与事件缓冲；用户自选目录/专家常驻文件夹不删。
- 登录限流：用户名+IP 维度，10 次失败锁 10 分钟（进程内，重启清零）。
- 附件上传：单条消息 ≤ 10 个文件、单文件 ≤ 20MB（服务端 + 客户端双重限制，派发与追问共用 `uploads.ts`）；附件记入 `task_uploads` 表并从成果物扫描中排除；追问竞态 busy 时回滚刚落盘的附件。
- 代码执行：`run_code` 每次调用独立 `docker run`（无网络、512MB 内存、1 CPU、64 进程、只读根 + 只读工作区挂载），120s 硬超时；Docker 守护进程不可用时工具不注入（见 ADR 0004）。
- pi 插件包（2026-10-13 增补）：`pi-packages/office-suite` 随服务端启动同步到 `{agentDir}/packages/office-suite`（内容差异驱动、幂等、可自愈），声明写 `{agentDir}/settings.json` 的 `packages` 数组（相对路径，随数据目录迁移）；DefaultResourceLoader 每任务会话自动加载，扩展加载失败只告警不阻断任务。

## 6. 假设与遗留问题（需用户确认）

- **A1 产品定位**：内部/小团队使用，非多租户 SaaS（与「不上服务器数据库」一致）。若要 SaaS 化：补计费、多租户，并触发 ADR 0003 的数据库重评。
- **A2 团队与时间**：假设 1~2 人、无硬 deadline，MVP 按第 4 节最小闭环裁剪；若团队 ≥3 人或有演示 deadline，重排第 4 节优先级。

## 7. 关键参考

- pi 文档：pi.dev/docs/latest → sdk.md（嵌入）、sessions.md（会话目录）、compaction.md（压缩）、containerization.md（隔离）
- 官方范例：`packages/coding-agent/examples/sdk/01~13`（嵌入全流程）、`examples/extensions/truncated-tool.ts`（截断规范）、`permission-gate.ts` / `protected-paths.ts`（路径拦截）
- 选型证据链：`docs/adr/0001`（pi vs codex）、`0002`（服务端执行）、`0003`（无服务器数据库）；调研原始报告见 2026-09-24 会话记录
