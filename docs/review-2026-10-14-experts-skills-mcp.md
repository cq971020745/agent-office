# 评审与路线图：专家 / 技能 / MCP 连接器（2026-10-14）

**一句话结论：选型正确、皮骨分离。** 技能层采用了 SKILL.md 这个正确格式，但只实现了它的元数据层，没有实现它真正的价值机制（渐进披露 + 目录级资源）；专家层概念成立，但技能是全局注入，"专家"没有自己的技能边界；MCP 层因参数 schema 在桥接时丢失，带参工具事实上不可用。对标 2026-10 的主流（Agent Skills 开放规范 40+ 采用方、Codex 已把 skills 做成核心子系统、MCP 主流配置是 `.mcp.json` + 远程 HTTP），差距集中在五件事：**渐进披露、目录级技能、专家-技能绑定、MCP schema/编辑/互操作、机制化更新**。

评审方法：两路并行调研——仓库代码事实基线（专家/技能/MCP 的数据模型、API、注入链路、UI）与主流约定基准（agentskills.io 规范、openai/codex 仓库与 release notes、agents.md、Claude Code / Cursor / VS Code 官方文档、modelcontextprotocol.io）。

> **执行状态（2026-10-14）**：P0-1～P0-4、P1-1～P1-6 与 P2-1～P2-5 已全部落地（P0/P1 见 CHANGELOG「2026-10-14（六）」与 ADR 0005，P2 见「2026-10-14（七）」与 design.md 状态注记七），102 项单测 + 三包 typecheck + 端到端冒烟（15 项）全绿。D1–D9 决策均按推荐采纳，仅 D8（systemPrompt 成员可见性）留待后续批次。

## 0 评审基线假设

本轮按以下假设执行（用户未确认，均为推荐项，见 §5 决策点）：

- **D1 对标基准**：兼收并蓄——数据格式对齐开放标准（SKILL.md / AGENTS.md / MCP），配置与交互体验参考 Codex；
- **D2 交付形式**：先评审 + 路线图，确认后逐批实施；
- **D3 兼容性**：专家包 v1 与既有技能库必须向后兼容；
- **D4 持续改进**：指机制化演进（版本、同步、更新、反馈），非一次性整改。

## 1 现状事实（代码基线）

### 技能

- 存储为 `{DATA_DIR}/agent/skills/<name>/SKILL.md`，数据库只登记来源（`skill_sources`：source/kind/revision/synced_at）（`apps/server/src/db.ts:184-192`，`apps/server/src/skills.ts:11`）。
- frontmatter 只解析 `name` + `description`（手写解析器，`skills.ts:20-32`），其余字段全部落入正文，规范字段（license/compatibility/metadata/allowed-tools）无法承载。
- **全量内联注入**：所有已装技能的完整正文包进每个任务会话的 systemPrompt（`<platform_skills>`，`runner.ts:261-264`），单技能 6,000 字符、总量 40,000 上限（`skills.ts:103-104`）。pi 原生技能加载因平台禁用内置工具而不生效（`runner.ts:299` `noTools:"builtin"`；pi 的 skill 加载注释明确技能依赖 read/bash 工具），所以平台手动内联。
- **技能 = 单文件**：内容以纯文本字符串流转（专家包只收 `content` 文本，`agent-packs.ts:35-44`），`scripts/ references/ assets/` 等附属资源在安装链路上没有承载——主流生态技能（如 anthropics/skills 的 docx/pdf 技能，带脚本与参考文件）装进来就是残的。
- 会话里没有任何"读技能正文/资源"的工具（工具集 = workspace 三件套 + fetch_url + MCP + run_code，`tools.ts:46-117`），模型只能被动吃全量注入。
- 安装来源四类（内置/URL/git/本地，`skill-install.ts:226-275`），同名冲突默认拒绝、可覆盖；同步整源重拉、自动清理源里消失的技能（`skill-install.ts:331-355`）。同步是纯手动的，无"有更新"提示。
- seed 技能 周报生成 / 会议纪要（`skills.ts:123-156`）与 pi prompts `/周报` `/会议纪要`（`pi-packages/office-suite/prompts/`）是**同意图两套机制**；HomeView 快捷入口指向技能版（`HomeView.vue:92-94`）。
- 目录技能质量薄：内置市场 4 个技能每个只有 15-18 行，description 未按规范写"是什么 + 何时用"。

### 专家

- agents 表：name/description/system_prompt/provider+model/tags/high_risk/folder/软删（`db.ts:29-37,75,118,130,155`）。
- AI 一句话生成 + 10+ 关键词模板兜底（`admin.ts:536-587`）。
- 专家包 office-agent-package v1：单 JSON，技能内联为 `{description, content}`，≤20 技能、单技能 200k 字符；导入永不覆盖、重名 `-2…-99`；导出可选技能（`agent-packs.ts:25-44,161-170`）。
- **专家与技能无绑定**：不管专家是谁，全部技能注入每个会话——"公文写作助手"接任务时 SWOT 分析也在提示词里。专家包带了技能却不能收窄可见范围，名实不符。
- `GET /agents/:id` 向任意登录成员返回完整 systemPrompt（`tasks.ts:218-254`）——导入的商业提示词等于公开。
- 模型元数据全局硬编码：128k ctx / 32,768 maxTokens / 无推理（`runner.ts:83-91`），`enabled_models` 精选与真实能力脱节。

### MCP 连接器

- `mcp_servers` 表：name/command/args/env/enabled/tools 缓存（`db.ts:135-147`）；**仅 stdio**；全局生效、无专家级绑定。
- 自研 JSON-RPC/stdio 客户端，协议版本写死 2024-11-05，请求 30s 超时（`mcp.ts:130-134`）。
- **P0 bug——参数 schema 丢失**：tools/list 结果只映射 `{name, description}`（`mcp.ts:136-141`），下游 `mcpToolToDefinition` 的 `rawSchema` 读取（`mcp.ts:261-264`）因此永远 undefined——**所有 MCP 工具以 `{type:"object",properties:{}}` 空签名暴露给模型**，带参调用全靠模型猜。schema 透传代码已写好，实际是死路。
- PATCH 支持 name/command/args/env（`admin.ts:843-859`）但 UI 只发 `{name, enabled}`（`api.ts:449-451`）：改参数/环境变量必须删除重建，且编辑后不失效工具缓存。
- 子进程环境 = 服务端全量 process.env + 行内 env（`mcp.ts:37`）；Windows 下 `shell:true` + 手工引号转义（`mcp.ts:39-41`）。

### 文档债与代码卫生

- `design.md:30-39` 仍列着从未实现的工具清单（gen_docx / web_search…）；§4 "用户不建 agent" 与现状（管理员配置 + AI 生成 + 包导入）脱节，仅在状态注记五（`design.md:59`）间接补记。
- 死代码：`resolveSkillNameConflicts` 导出未用（`agent-packs.ts:146-154`，`installPackageSkills` 内联重写了同一逻辑）。
- DTO 漂移：`GET /admin/agents` 同时返回 folder/folderPath（`admin.ts:518-519`）而客户端类型缺字段（`api.ts:306-315`）；`listSkills` 与 `getSkill` 的 description 空值语义不一致（`skills.ts:57`）。

## 2 对标主流（2026-10）

| 维度 | 主流约定 | 本平台 | 差距 |
|---|---|---|---|
| 技能格式 | Agent Skills 开放规范（agentskills.io），40+ 采用方：Claude Code、**ChatGPT & Codex**、Gemini CLI、Cursor、GitHub Copilot/VS Code、Goose… | SKILL.md ✓，但仅 name+description | 半对齐 |
| 加载机制 | 三级渐进披露：启动只载元数据（~100 token）→ 激活读正文（建议 <5k token / <500 行）→ 按需读 scripts/references/assets | 全量内联正文，40k 封顶 | 缺失 |
| 技能形态 | 目录：SKILL.md + scripts/ + references/ + assets/；官方校验器 skills-ref validate | 单文件字符串流转 | 缺失 |
| 触发与调用 | description 决定自动触发；显式调用 `$名称`（Codex）、`/名称`（Claude Code：**commands 已并入 skills**，argument-hint 字段） | 仅 3 个固定 pi prompts | 部分缺失 |
| 指令分层 | AGENTS.md 全局 → 仓库 → 子目录逐层覆盖（Linux 基金会治理，60k+ 项目采用） | 无分层，仅专家 system_prompt | 缺失 |
| 审批策略 | codex approval_policy（untrusted/on-failure/on-request/never）+ MCP per-tool approval_mode；Claude Code allowed-tools/disallowed-tools | 仅 high_risk"先计划后执行" | 粗粒度 |
| MCP 配置 | `.mcp.json`（mcpServers）为跨工具交换格式；stdio + 远程 streamable HTTP + OAuth；startup/tool 超时可配；官方 registry（v0.1 冻结，未 GA） | 仅 stdio、表单手工录入、30s 写死、无互操作格式 | 大 |
| 分发 | 收敛到插件/市场包：Claude marketplaces、Codex 弃独立技能目录改 plugins（包捆绑 skills+agents+MCP） | 专家包 v1（单 JSON、技能内联）+ 内置市场 | 同构但格式封闭 |

主要来源：agentskills.io/specification；anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills（2025-10-16 发布，2025-12-18 开放为标准）；github.com/openai/codex（docs/config.md、codex-rs/config/defaults.toml、releases 至 0.163.0-alpha.10，2026-10-13）；agents.md；code.claude.com/docs/en/mcp 与 /skills；cursor.com/docs/context/mcp；code.visualstudio.com/docs/copilot/chat/mcp-servers（2026-10-07 更新）；modelcontextprotocol.io（2026-07-28 版）；registry.modelcontextprotocol.io。

**关键判断**：说"参考 codex"在 2026-10 的含义已经变化——Codex 自己采纳了 Anthropic 发起的 SKILL.md 开放标准（agentskills.io 将 ChatGPT & Codex 列为采用方）。技能层不需要在两大生态里二选一：**SKILL.md 就是主流本身**。Codex 真正值得抄的是配置体验：per-tool 审批、启动/工具超时、profile 式预设，以及 AGENTS.md 式分层指令。

## 3 改进路线图

### P0 正确性（不修则功能残缺）

| # | 事项 | 证据 → 改法 | 规模 |
|---|---|---|---|
| P0-1 | MCP 工具参数 schema 透传 | `mcp.ts:136-141` 只取 name/description → tools/list 的 inputSchema 直通（`mcp.ts:262-264` 的 Type.Unsafe 已就位，去掉映射截断即可） | S |
| P0-2 | 连接器可编辑 | 补编辑表单（服务端 PATCH 已支持，`admin.ts:843-859`）；编辑 command/args/env 后失效 tools 缓存 | S |
| P0-3 | 双机制收敛：/周报 等 | seed 技能 vs pi prompts 二选一 → 统一为"技能"，SKILL.md 增加 user-invocable / argument-hint 约定（对齐 Claude Code "commands 并入 skills"），pi prompts 迁移为技能 | M |
| P0-4 | 文档/死代码清理 | 重写 design.md 工具清单与 §4；删 `resolveSkillNameConflicts`；收敛 folder/folderPath；统一 description 语义 | S |

### P1 好用 + 对齐主流核心机制

| # | 事项 | 说明 | 规模 |
|---|---|---|---|
| P1-1 | 渐进披露 | 系统提示只注入 name+description（元数据级），新增 `read_skill` 自定义工具按需读正文（内置 read 已被 noTools 关死，需自带；路径管控可复用 workspace 工具的 jail 逻辑）。6k/40k 上限自然松绑 | M |
| P1-2 | 目录级技能 | 安装保留整个技能目录（scripts/references/assets），read_skill 支持列目录/读资源；专家包 v2 预留目录式打包（v1 继续导入） | M |
| P1-3 | 专家↔技能绑定 | agents_skills 关联 + 专家编辑页勾选；**默认全量（兼容现状）**，勾选后收窄——专家包从此名实相符 | M |
| P1-4 | frontmatter 对齐规范 | 解析/校验 metadata(version,author) / license / compatibility；包导入对非法技能**告警**替代静默跳过（`agent-packs.ts:100-143`）；UI 展示；name 与目录名一致性检查 | M |
| P1-5 | .mcp.json 导入/导出 | 连接器页支持 mcpServers JSON 批量导入导出，与 Claude Code / Cursor / VS Code 生态互通 | S |
| P1-6 | MCP 超时与工具筛选 | 启动/工具超时可配（默认 10s / 60s，对齐 codex）；连接器内 per-tool 启用勾选（工具缓存已有，缺选择 UI） | S |

### P2 机制化演进

| # | 事项 | 说明 | 规模 |
|---|---|---|---|
| P2-1 | 远程 MCP（streamable HTTP）+ 凭据 | 加 type 字段：stdio 现状保留；HTTP url+headers；token 走环境变量引用（对齐 codex bearer_token_env_var） | L |
| P2-2 | 专家级工具策略 | high_risk 泛化为 per-tool / per-connector allow / ask / deny（对齐 codex approval_policy 与 MCP per-tool approval_mode）；workspace_write / fetch_url / run_code / MCP 一并纳管 | L |
| P2-3 | AGENTS.md 式分层指令 | 平台级全局指令（所有专家共享的办公规范）+ 专家 system_prompt 覆盖/叠加；表达为 `data/agent/AGENTS.md` 或 DB 字段 | M |
| P2-4 | 技能演进闭环 | 来源 revision 漂移检测（"有更新"徽标）、批量/定时同步、技能激活计数（read_skill 埋点）反哺市场精选 | M |
| P2-5 | 模型能力元数据 | 128k/32k 硬编码（`runner.ts:83-91`）改 per-model 配置 | M |

**批次建议**：第一批 = P0 全部 + P1-5 / P1-6（一周内可完成）；第二批 = P1-1 → P1-3 → P1-4（渐进披露先行，它改变注入协议，其余依赖它）；第三批 = P2 按需排期。每批过 `pnpm test` + 冒烟 + CHANGELOG 记录。

## 4 顺带发现（不在本轮范围，先登记）

- `GET /agents/:id` 向成员暴露完整 systemPrompt（`tasks.ts:218-254`）——包导入的商业提示词会外泄（D8）。
- MCP 子进程继承服务端全量 process.env（`mcp.ts:37`）——应最小化传递。
- Windows `shell:true` 引号转义（`mcp.ts:39-41`）——建议改 spawn 数组参数免 shell。
- 表现良好的部分保持：任务工作区三选一、会话恢复、写操作护栏、high_risk 先计划后执行、来源同步语义。

## 5 待确认决策（grill 遗留）

- ❓ **D1 对标基准**：兼收并蓄 / Codex 优先 / Claude 优先 ➡️ **兼收并蓄**（已按此执行；SKILL.md 本身已是跨生态标准）
- ❓ **D2 交付形式**：评审+路线图 / 直接实施 / 仅报告 ➡️ **评审+路线图，确认后逐批实施**
- ❓ **D3 兼容性**：v1 包与既有数据是否向后兼容 ➡️ **必须兼容**（v2 仅做扩展）
- ❓ **D4 持续改进**：机制化 / 一次性 / 先度量 ➡️ **机制化**（P2-4 即其骨架）
- ❓ **D5 渐进披露载体**：自定义 read_skill 工具 vs 启用 pi 内置 read 工具 ➡️ **read_skill**（不重新打开内置工具口子，管控面小）
- ❓ **D6 专家-技能默认范围**：默认全量可收窄 vs 默认空需显式勾选 ➡️ **默认全量**（兼容现状），专家可收窄
- ❓ **D7 技能命名**：本地中文名 vs 规范 lowercase-hyphen ➡️ **双轨**：显示名自由，存储目录 slug 化，导入时映射
- ❓ **D8 systemPrompt 成员可见性** ➡️ 成员端只回描述，不回全文
- ❓ **D9 /周报 入口形态**（收敛后）➡️ 技能 + argument-hint，HomeView 快捷入口不变

## 6 术语表

本次已把 **专家 / 技能 / 技能来源 / 专家包 / MCP 连接器** 记入 CONTEXT.md（原有 Agent 条目保留：专家 = Agent 的可配置实例，是界面对用户的称谓；代码表名 agents 不变）。
