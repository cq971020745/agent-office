# 更新日志

记录平台每次迭代的功能、修复与行为变化。领域术语见 [CONTEXT.md](CONTEXT.md)。

## 2026-10-14（八）

### 修复

- **桌面端所有非 GET/POST 请求被 CORS 预检拦截**：`@fastify/cors` 的 `methods` 有默认值且只含 `GET,HEAD,POST`，此前未显式配置——桌面端删除任务（DELETE）、编辑供应商/指令（PUT/PATCH）等操作全部因预检失败报「Failed to fetch」（任务列表能加载、删除必失败即此因）。现显式放行 `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`。
- **修改密码不再要求旧密码**：`POST /auth/change-password` 只需 `newPassword`（凭有效登录态即可改；管理员重置本就无此要求，忘记原密码是自助改密的典型场景），改密后旧 token 仍有效至过期（JWT 无状态，行为不变）。桌面端修改密码对话框移除「当前密码」输入。
- **无请求体的 DELETE/POST 被 Fastify 拒绝（400）**：桌面端请求封装此前对无 body 的请求也发送 `Content-Type: application/json`，触发 Fastify `FST_ERR_CTP_EMPTY_JSON_BODY`——删除任务必报「Bad Request」（此前该雷被 CORS 预检挡住而不可见）。双端修复：桌面端只在确有请求体时声明 JSON；服务端新增宽松 JSON 解析（`json-body.ts`，空体放行为 undefined，坏 JSON 仍 400），覆盖删除任务、批量同步技能等全部无体调用。

### 测试与文档

- 单测新增 10 个（总 112）：CORS 预检放行 DELETE/PUT/PATCH 的应用级回归、改密接口（无旧密码改密 / 新密码可登录 / 旧密码失效 / 缺参与短参 400 / 未登录 401）、无体 DELETE 宽松解析与坏 JSON 400。
- 全量回归：server 单测 110/110、三包 typecheck 全绿；fresh DATA_DIR 冒烟 15 项（含任务删除与级联清理）全通过。

## 2026-10-14（七）

按评审路线图完成 P2 批次（`docs/review-2026-10-14-experts-skills-mcp.md`），评审路线 P0/P1/P2 至此全部落地。

### 新增

- **远程 MCP 连接器（P2-1）**：连接器新增 `type` 字段——既有 stdio 本地进程语义完全不变；`http` 类型直连远程 MCP 服务器（streamable HTTP：JSON-RPC POST + SSE 流式响应，遵循 `mcp-session-id` 会话协商与 `mcp-protocol-version` 协议头）。请求头可配且值支持 `${ENV_NAME}` 引用平台环境变量（令牌不落库、发送时展开，对齐 Codex `bearer_token_env_var`）；`.mcp.json` 导入/导出识别 `http`/`sse` 条目（url + headers）。桌面端连接器对话框提供「本地进程 / 远程服务器」连接方式选择与地址、请求头编辑，卡片按类型显示端点。
- **专家级工具策略（P2-2）**：专家配置新增 per-tool / per-connector 策略（`agents.tool_policy`，键支持精确工具名、`mcp:连接器名:*` 通配与 `mcp:*` 全局兜底）：**默认放行**；`ask` = 该专家每次调用此工具前任务暂停并广播审批请求，用户在任务详情页放行/拒绝（等待期任务显示审批面板，5 分钟未处理自动拒绝，等待期间 30s 心跳续活、180s 看门狗不会误杀会话）；`deny` = 直接对该专家隐藏该工具。`workspace_write` / `fetch_url` / `run_code` 与全部 MCP 工具一并纳管（对齐 Codex approval_policy 与 MCP per-tool approval_mode）。任务详情页新增「工具调用待确认」审批面板（展示工具名与入参），桌面端专家对话框提供逐行「默认放行 / 每次确认 / 禁止」策略选择。
- **平台指令 AGENTS.md（P2-3）**：专家管理页新增「平台指令」标签页（`GET/PUT /admin/instructions`），内容落 `data/agent/AGENTS.md`（64k 字符上限）；保存后以 `<platform_instructions>` 注入**所有专家**的任务会话（位于平台基础规范之后、专家人设之前），形成「平台全局指令 → 专家人设 → 技能清单」的分层提示词（对齐 agents.md 分层约定），全平台统一的协作规范与安全红线不再需要逐专家复制。
- **技能演进闭环（P2-4）**：
  - 漂移检测：url/git/local/builtin 四类来源在安装与同步时记录内容指纹基线（git 用远端短 sha，其余用内容/目录哈希），`GET /admin/skills/updates` 对比远端最新指纹，技能市场卡片显示「有更新」徽标；本批之前安装的存量来源未建基线，如实显示「未检测」说明而非误报；
  - 批量同步：`POST /admin/skills/sync-all` 逐来源同步（单个失败不阻塞其余），桌面端新增「检查更新」「全部同步」按钮；
  - 激活计数：`skill_usage` 表按技能累计 `read_skill` 加载与 `/斜杠` 调用次数及最近使用时间（`GET /admin/skills` 携带 `usageCount/lastUsedAt`，卡片展示），作为市场精选与闲置清理的数据依据。
- **模型能力元数据（P2-5）**：模型供应商新增 per-model 能力覆盖（`model_providers.model_overrides`，`PATCH /admin/providers` 整段覆写、空对象清空）：按模型 ID 配置 `contextWindow` / `maxTokens` / `reasoning`，替换 runner 中 128k 上下文 / 32768 输出 / 无推理的硬编码；缺省回落平台默认，解析宽松容错（坏 JSON / 非法值回落默认，单条脏数据不再影响任务派发）。桌面端供应商编辑对话框提供 JSON 覆盖编辑与校验。

### 测试与文档

- 单测新增 11 个（总 102）：模型覆盖解析/收敛/合并、工具策略解析与精确>连接器通配>`mcp:*` 匹配顺序（含非 ASCII 服务器名规范化）、AGENTS.md 读写、请求头 `${ENV}` 展开、MCP HTTP 客户端（鉴权失败/握手会话头/通知 202/SSE 流式响应/调用会话校验）、技能基线建立与漂移检测往返、激活计数埋点。
- 全量回归：`@office/shared` build、`@office/server` typecheck、`@office/desktop` vue-tsc 全绿；端到端冒烟 15 项全通过（fresh DATA_DIR）。
- 文档：design.md 状态注记七；评审路线图执行状态更新为 P0/P1/P2 全部完成。

## 2026-10-14（六）

### 新增

- **技能渐进披露（对齐 Agent Skills 开放规范的三级加载）**：任务会话的系统提示词不再内联全部技能正文，改为只注入元数据清单（名称/参数提示/描述，总量 4k 字符封顶）；模型命中技能后调 `read_skill` 工具按需读取正文（50k 字符截断），再按需读取技能目录内的 `references/ scripts/ assets/` 资源文件（安装链路保留整个技能目录，不再只搬单文件）。read_skill 路径严格限制在该技能目录内。决策记录见 ADR 0005。
- **技能 frontmatter 对齐开放规范**：解析/写入 `argument-hint`（斜杠参数提示）/ `alias`（别名）/ `metadata`（author/version 等）/ `allowed-tools` / `user-invocable`（缺省由 argument-hint 或 alias 推断）；技能编辑对话框新增「斜杠参数提示」字段，正文占位符语法（`$ARGUMENTS`、`${1:-默认值}`）写进输入框提示。
- **斜杠调用收敛为技能一元机制**：`/技能名 参数`（精确名 > 别名 > 唯一前缀）由服务端在派发与追问时展开为技能正文并做参数替换；正文无占位符时参数以「用户参数：」追加。任务时间线保留用户原文。office-suite 的 pi prompts（/周报、/会议纪要、/邮件润色）迁移为平台 seed 技能（带 argument-hint，首次启动逐技能幂等播种），HomeView 快捷入口不变。
- **专家↔技能绑定**：专家创建/编辑可勾选「可用技能」——**不绑定 = 使用全部平台技能**（v1 兼容），勾选后该专家会话的技能清单按绑定收窄；成员端 AgentConfig 携带绑定状态（`null` = 未显式绑定，驱动客户端「全部技能」开关态）；专家包安装/导入自动绑定包内技能。
- **MCP 连接器编辑与互操作**：
  - 连接器卡片新增「编辑」：名称/命令/参数/环境变量/启用/超时全字段可改，命令类字段变更后自动失效工具缓存并重连；
  - 启动超时（默认 10s）与工具调用超时（默认 60s）可配，非法值回落默认（对齐 Codex `startup_timeout_sec` / `tool_timeout_sec`）；
  - per-tool 停用：连接器详情里每个工具可点选停用/恢复（停用的不注入会话），卡片显示可用/总工具数；
  - `.mcp.json` 导入/导出（`POST /admin/mcp/import`、`GET /admin/mcp/export`）：与 Claude Code / Cursor / VS Code 的 mcpServers 格式互通，导入按名称 upsert 并逐条报告跳过原因（缺 command 等）。
- MCP 工具信息透传 `inputSchema`（DTO `McpToolInfo`），管理端与任务会话都能看到真实参数结构。
- 专家包安装/导入返回 `warnings`（技能名非法/内容为空/超 20 个上限逐条告警），客户端逐条 toast——不再静默跳过。

### 修复与健壮性

- **MCP 工具参数 schema 透传**（P0）：`tools/list` 结果的 `inputSchema` 此前在桥接时被截断为 `{name, description}`，所有 MCP 工具以空签名暴露给模型、带参调用全靠猜；现已直通。
- 技能绑定语义修正：无绑定行时 `getAgentSkillBinding` 返回 `undefined`（= 使用全部），此前返回空数组会被解释为「不绑任何技能」，存量专家会瞬间失去所有技能注入。
- 物理删除专家 500：`agent_skills` 外键指向 `agents(id)`，DELETE 时须先清绑定行再删专家行（冒烟测试「专家包导入 → 删除」暴露，已修）。
- `GET /admin/agents` 不再返回原始 `folder` 绝对路径，统一输出 `folderPath`（数据库未登记时回落默认拼接）。
- 删除死代码 `resolveSkillNameConflicts`（`agent-packs.ts`，导入改名逻辑已内联重写）；`listSkills` 与 `getSkill` 的 description 空值语义统一（空回落目录名）。

### 测试与文档

- 单测新增 10 个（总 91）：技能 frontmatter 扩展字段与 user-invocable 推断、渐进披露清单（元数据含名/描述/参数提示、正文不进提示词）、read_skill 路径越界拒绝与资源读取、斜杠展开（精确/别名/唯一前缀/未命中、占位符替换、无占位符追加）、专家技能绑定（undefined↔清单↔空数组往返、非法技能过滤、绑定收窄）；更新 2 个（office-suite 不再声明 prompts、安装副本 prompts 目录清空）。
- 全量回归：`@office/shared` build、`@office/server` typecheck、`@office/desktop` vue-tsc 全绿。
- 文档：design.md 执行架构图工具清单重写为现状（workspace 三件套/fetch_url/run_code/read_skill/MCP 桥接）、§4 专家现状补记、状态注记六；新增 ADR 0005（技能渐进披露）。

## 2026-10-13（五）

### 新增

- **技能安装与同步（对齐主流包管理体验）**：技能不再只能手工新建，现在可以「装」和「更」——
  - `GET /admin/skills/catalog`：内置技能市场（仓库 `skills-catalog/` 目录，首批 4 个：邮件回复、数据解读、演讲大纲、SWOT 分析），一键安装进平台技能库；
  - `POST /admin/skills/install`：从任意来源安装，支持 4 类来源——内置目录（直接给目录 id）、本地路径（指向含 `SKILL.md` 的目录或其父目录，自动扫描）、http(s) 链接（Markdown 直链或页面，也可回落为 git 仓库）、git 仓库（`git:` 前缀或 `.git` 结尾，浅克隆后扫描其中全部技能，一次可装多个）；同名冲突默认 400，勾选覆盖则整体替换；
  - `POST /admin/skills/:name/sync`：从登记的来源重拉并覆盖刷新；来源里已消失的关联技能自动删除，新增的自动补装；`skill_sources` 表（新迁移 V8）记录每个技能的来源、类型、git revision 与同步时间，删除技能时一并清除；
  - 客户端技能 tab 新增「市场」卡片（内置目录一键安装 + 任意来源安装框 + 同名覆盖开关），每张技能卡显示来源徽标（内置/链接/Git/本地）与「同步」按钮。
- **专家插件化：安装与导入**：专家也能像插件一样分发——
  - 专家包格式 `office-agent-package` v1（JSON：format/version/name/description/tags/highRisk/systemPrompt/skills），供应商与模型**不在包内**，安装/导入时再选；
  - `GET /admin/agents/catalog`：内置专家包市场（仓库 `agent-packs/` 目录，首批 2 个：深度研究员、公文写作助手）；
  - `POST /admin/agents/install`：一键安装内置包（可选供应商/模型），包内技能随之落库；
  - `POST /admin/agents/import`：导入 `.json` 专家包文件（multipart 上传或 JSON body），格式校验失败 400；**永不覆盖现有数据**——同名技能自动改名 `-2`…`-99`，包内非法技能跳过；
  - `GET /admin/agents/:id/export?skills=a,b`（或 `all`）：把任意专家导出为可分享的专家包，可勾选捆绑哪些平台技能；
  - 客户端专家 tab 新增包市场条、右上角「导入专家包」（选择 `.json` 文件）、卡片菜单「导出专家包」（技能勾选 + 下载 `.json`）；安装/导入弹窗里选择供应商与模型。
- 新增 `skill-install.ts`（来源解析/安装/同步）与 `agent-packs.ts`（专家包读写/校验/改名安装）两个模块；服务端单测新增 12 个用例（总 81），覆盖四类来源安装、冲突与覆盖、同步增删改、内置包校验、改名导入与导出 roundtrip；冒烟测试新增「技能安装/同步」与「专家包安装/导出/导入 roundtrip」两段。

## 2026-10-13（四）

### 新增

- **内置 pi 插件包（office-suite）**：以标准 pi package 形式为平台 agent 装上三件套，服务端启动时自动安装到 `{DATA_DIR}/agent/packages/office-suite/` 并把声明写入 `{DATA_DIR}/agent/settings.json`（等价于 `pi install ./local-package`，内容差异驱动的幂等同步，数据目录整体迁移声明仍有效）：
  - `todo` 扩展：多步骤任务清单工具——专家先拆解清单再逐步勾选，状态存于工具结果 details，跨轮次、会话恢复与分支导航自动重建（pi 官方 todo 扩展的无头适配版）；
  - `write-guard` 扩展：写操作护栏——拦截 `workspace_write` 覆盖 `.env`/`.git`/`node_modules`，拦截 `run_code` 中的破坏性脚本（递归删根/家目录、fork 炸弹、格式化磁盘、下载即执行远程脚本等），自动拒绝并给模型可读原因（无 UI 依赖，无头 SDK 会话可用）；
  - 办公提示词模板：`/周报 [重点]`、`/会议纪要 <主题或记录>`、`/邮件润色 <草稿或要点>`——在平台对话框直接输入，模板展开成结构化任务并把产出保存进工作区。
- 插件包源码独立于服务端放在 `pi-packages/office-suite/`（`pi` 清单声明资源，`pi-package` 关键字，peerDependencies 交由 pi 注入）；新增 `packages.ts` 负责探测/同步/声明（`PI_PACKAGES_DIR` 可覆盖模板目录），启动与每任务会话日志都会报告插件状态。
- **pi 升级至 1.2.0**：`@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core` 从 0.87.1 升到 1.2.0（Node ≥ 22.19 要求已满足）。逐条核对 0.88→1.2.0 的破坏性变更：仅 Azure 供应商改名（平台未使用）、`before_agent_start`/busy 语义变化（仅影响 `pi.sendMessage({ triggerTurn: true })` 调用方，平台走 `session.prompt()`）、MCP 资源列表行为（SDK 工具注入不受影响）、主题 schema（平台未使用）——均不触及平台用法。全量回归验证通过：typecheck / 69 单测（含 SDK 集成与扩展加载）/ build / 冒烟 13 项全绿。
- 单测新增 7 个（包探测/同步幂等/篡改修复/settings 声明合并/DefaultResourceLoader 真实加载扩展与提示词），总数 69；冒烟日志确认每个任务会话加载 2 个 pi 扩展。

## 2026-10-12（三）

### 新增

- **对话上传附件**：多轮追问也能带附件——任务详情页输入框新增回形针按钮与文件条（可逐个移除），发送时以 multipart 提交，附件落进任务工作区、记入 `task_uploads`（作为输入**不计入成果物**），并合成附件清单（文件名 + 大小）注入本轮提示词；任务等待审批时追问直接拒绝。派发表单与对话输入框共用 `useAttachments` composable。
- **拖拽上传**：首页派发卡片与任务对话输入框均支持把文件直接拖入（dragenter/dragleave 计数防闪烁，拖入时边框高亮）；App 层全局阻止文件拖放默认行为，防止 Electron 被拖拽导航到 file:// 覆盖应用。
- **附件信息进提示词**：带附件派发/追问时，agent 被明确告知附件已存入工作区、可用 `workspace_read` 读取；平台隔离工作区的首轮环境提示词相应从「目录为空」改为「附件已就位」（自选目录/专家文件夹的提示词本就声明目录可能已有文件，无需改动）。

### 修复与健壮性

- 追问并发竞态：先落附件再启动本轮；若 `sendMessage` 撞上 busy，回滚刚落盘的附件文件与登记，不留半途状态。
- 附件链路抽为 `uploads.ts`（净化/去重/暂存/提示词合成），派发与追问两条路由复用；新增 uploads 单测（净化/重名避让/附件清单合成/大小格式化），单测总数 61。
- 冒烟测试新增「追问带附件」用例：multipart 追问 → 附件落工作区 → 不计成果物 → 第二条用户消息含附件清单。

## 2026-10-12（二）

### 新增

- **任务附件上传**：派发时可随任务上传最多 10 个附件（单个 ≤ 20MB），附件落进任务工作区并注入上下文描述；上传件记入 `task_uploads` 表，作为任务输入**不计入成果物**。客户端派发表单新增附件选择（回形针按钮 + 文件条，可逐个移除）。
- **任务列表服务端分页**：`GET /tasks` 支持 `limit`（1..200，默认 50）/`offset`/`status`（running 含排队）/`q`（标题与描述模糊搜索）参数，返回 `{ items, total, counts }`；不带参数时保持旧行为返回全量数组（兼容旧客户端）。任务页改为服务端分页 + 300ms 防抖搜索 + 「加载更多」，状态计数改由服务端统计。
- **run_code 代码执行工具（Docker 隔离）**：Docker 守护进程可用时，任务会话自动注入 `run_code`——按次调用独立容器执行 JavaScript（node:22-alpine）/Python（3.12-alpine），无网络、512MB 内存、1 CPU、64 进程上限、只读根文件系统、工作区只读挂载、120s 硬超时；输出截断回传，非零退出码把容器输出带回给模型自修正。**Docker 不可用时静默降级**（工具不注入、提示词回落），决策记录见 ADR 0004。
- 新增单元测试（共 11 个新用例）：任务列表参数解析与 WHERE 构建、附件文件名净化与重名避让、run_code 命令构建的隔离约束。

### 修复与健壮性

- 附件文件名净化：剥离路径部分（防遍历）、去控制字符与前导点、限长 120；同名附件自动追加序号不覆盖。
- 删除任务时级联清理附件登记。

## 2026-10-12

### 新增

- **任务删除**：`DELETE /tasks/:id`（本人或管理员），连带清理成果物索引、消息记录、平台隔离工作区目录与会话 JSONL；进行中/排队中的任务需先取消再删除。任务列表对非进行中任务显示删除按钮（带确认框）。
- **服务端单元测试**：`pnpm test`（node:test + tsx，37 个用例）覆盖密码哈希、工作区工具（截断/路径 jail/协议白名单）、技能解析与 CRUD、SSE 总线（序号/回放/清理）、AI 生成专家配置的容错解析。

### 修复与健壮性

- SSE 事件回放缓冲按任务数设上限（100 个最近活跃任务），长期运行不再无界增长；删除任务时同步清缓冲。
- 内存中的 AgentSession 闲置超过 1 小时自动回收（每 10 分钟清扫一次），追问时从磁盘 JSONL 自动恢复，上下文不丢。
- 登录限流：同一 用户名+IP 连续失败 10 次锁定 10 分钟（429），防暴力破解。
- `fetch_url` 工具仅允许 http/https 协议，拒绝 file:/ftp:/data: 等。
- 未设置 `JWT_SECRET` 时启动打告警，提示部署者配置强随机密钥。

### 已知限制（不变）

- 工作区路径 jail 是便利级隔离，非安全边界（硬隔离见二期路线）。
- 登录限流状态在进程内，服务重启即清零。

## 2026-09-24 ~ 2026-10-12（自 MVP 以来的累积交付）

- MVP 闭环：登录（JWT，首注册即管理员）、任务下达/围观（SSE 三段式事件流）/取消、成果物扫描与下载、多轮追问（任务详情即会话，重启后可从磁盘恢复）。
- 模型管理端：OpenAI 兼容供应商（baseUrl+key）、模型列表拉取缓存、候选/可用两层模型管理；任务派发与专家默认模型解耦（派发时可选任意可用供应商的模型）。
- 专家（agent）：管理员 CRUD、AI 一句话生成专家配置（真实模型优先、内置 10+ 模板兜底）、软删除（有历史任务时）、专家常驻文件夹（卡片直接打开，任务默认跑在该目录）、自定义工作目录派发。
- 平台技能：`{agentDir}/skills/<name>/SKILL.md` 全局技能库，管理端增删改查，注入各任务系统提示词；内置周报/会议纪要示例技能。
- MCP 连接器：管理端配置 stdio 服务器（含 Windows shell 兼容），握手拉取工具列表并注入任务会话，进程崩溃自动重连。
- 客户端：Electron + Vue 3 控制台（登录/首页派发/任务/专家/管理五页），明暗双主题，成果物预览面板（HTML 源码/渲染双视图），个人修改密码与管理员重置密码。
- 运行时健壮性：模型 180 秒无响应看门狗、输出长度截断自动续跑（≤3 轮）、服务重启后孤儿任务标记失败、SSE 事件历史回放（晚连接不丢过程）。
