# 当前架构

核对日期：2026-10-26。本文描述当前代码；历史迭代见 [CHANGELOG](../CHANGELOG.md)，取舍见 [ADR](adr/)，尚未实现的增强见 [产品与 UI 待办](product-roadmap.md)。

## 产品与技术栈

木牛流马（历史名称：澄台）是任务执行型 AI 办公平台。任务执行始终在 Node 服务端；桌面一体包把这台服务端放在用户电脑上，远程模式则连接独立服务端。桌面退出是否影响执行取决于服务端所在位置，不能一概认为关机后仍运行。

| 层 | 当前实现 |
| --- | --- |
| 控制台 | Electron 38 + Vue 3 + TypeScript，同一渲染层可作为 Web 控制台 |
| API | Fastify 5；REST 管业务，SSE 传执行事件 |
| 执行引擎 | 进程内嵌入 `@earendil-works/pi-coding-agent`，相关 Pi 包精确锁定 `1.2.0` |
| 业务数据 | better-sqlite3，SQLite WAL；单服务进程，不引入服务器数据库 |
| 会话 | Pi JSONL，每任务关联自己的会话；数据库保存面向界面的消息及轨迹摘要 |
| 部署 | 本地开发、桌面一体包、远程 API/容器；默认 API 38617，开发渲染层 38618 |

```text
Electron / Web 控制台
    REST + SSE
Fastify API
    ├─ 核心：认证、任务、项目、管理、皮肤文件
    ├─ PluginRegistry：内置插件启停、路由门控、任务生命周期
    └─ Runner → Pi AgentSession
                  ├─ 当前用户的供应商与模型
                  ├─ 工作区工具、terminal、专家委派
                  ├─ 插件创建的技能 / 语音 / 网页 / 知识库 / MCP 工具
                  └─ 平台 agentDir 内的 Pi 扩展包
SQLite + sessions/*.jsonl + workspaces/ + agents/ + agent/ + skins/
```

## 身份与资源归属

| 资源 | 归属和权限 |
| --- | --- |
| 登录身份 | 企业知识库用户；只有 `superadmin` 映射本应用管理员；本地 JWT 默认 7 天过期 |
| 模型供应商 | `model_providers.user_id`；每个用户自己的密钥、协议和启用模型 |
| MCP 连接器 | `mcp_servers.user_id`；只向该用户任务注入其启用连接器 |
| 任务、巡检、记忆 | 按用户隔离；各管理接口另有权限判断 |
| 专家、平台技能 | 登录用户可管理；专家包技能存专家私有目录，不进入平台技能库 |
| 平台指令、插件启停 | 管理员可改；插件启停属于整个服务实例 |
| 皮肤 | 文件包属于服务实例，选用偏好保存在客户端；管理通道与开放市场通道分别鉴权 |

专家不持有模型。派发和追问使用当前用户选择的模型；巡检保存用户模型配置，未指定时回退到所属用户的可用模型。Base URL 按用户输入使用，模型列表仅请求 `{baseUrl}/models`，不自动补路径。

企业知识库工作台使用既有知识空间、文档和问答页面，经 `/new-general-rag-kb` 同源代理注入当前用户凭证。企业知识库认证仍是核心能力，停用工作台插件不等于停用登录。WPS 身份通过用户同步关联，失效时由 `wps-env-gate.ts` 重导后重试。

## 任务执行与文件

1. API 校验用户、模型、附件和自选目录，登记任务；工作区优先级为自选目录、专家目录、平台隔离目录。
2. Runner 触发 `onTaskStarted`，创建或恢复 Pi 会话；组装核心工具、启用插件工具、平台指令、专家人设及技能元数据。
3. 每轮调用 `beforeTurn`，将记忆等参考资料加入提示词；Pi 事件转为 SSE，工具策略执行 ask/deny 和会话授权。
4. 执行文本、思考与工具步骤摘要写入消息记录；轮次结束扫描成果物，发布状态和文件更新，再调用 `afterTurn`。
5. 重启后可恢复磁盘会话继续追问；已中断的任务会回填状态，不承诺自动重放已执行的外部操作。

当前任务状态为 `pending / running / awaiting_approval / completed / failed / cancelled`。`awaiting_approval` 同时用于计划确认和工具审批，客户端根据审批事件区分；没有独立的“成果物已验收”状态。

自选目录校验拒绝应用数据目录及其子目录、目录本身为符号链接等情况。删除平台工作区只允许严格位于根目录内的子目录，不删除工作区根。工作区文件接口另做相对路径校验；这不是宿主进程的操作系统沙箱。`terminal` 和技能脚本使用宿主权限，默认需要确认；`run_code` 仅在 Docker 可用时提供逐次调用、无网络和只读工作区容器。

附件登记为任务输入，不计入成果物；文档解析写 `.parsed/`。成果物按相对路径登记，没有历史文件快照，相同路径再次修改不产生版本。当前可预览 HTML、图片、PDF、音频、文本、Markdown 和 CSV/TSV；DOCX/XLSX/PPTX 下载或交系统应用打开。

## 平台插件与扩展边界

`plugins/index.ts` 显式注册 10 个内置插件，不从用户目录加载第三方服务端代码。

| 插件 id | 职责 |
| --- | --- |
| `memory` | 用户记忆 CRUD、轮前召回、可选轮后沉淀 |
| `skin-market` | 本服务器、npm、GitHub 皮肤市场 |
| `skills` | 默认技能播种、技能读写和脚本工具 |
| `pi-packages` | 随产品分发的 Pi 包声明、安装与 OCR 运行时配置 |
| `scheduler` | 巡检 API 与可停止轮询器 |
| `voice` | 听写、转写 API 与音频转写工具 |
| `web-access` | 平台 `fetch_url` 回退工具；Pi 网页检索工具属于 `pi-packages` |
| `wps` | WPS API 与通讯录预热 |
| `knowledge-base` | 工作台嵌入、会话续期和按专家技能绑定的知识库工具 |
| `mcp` | 当前用户连接器工具；停用时关闭 MCP 客户端 |

生命周期接口为 `migrate/start/stop/registerRoutes/onTaskStarted/createTools/beforeTurn/afterTurn/onTaskDeleted`。注册阶段只保存定义，核心迁移后才初始化状态。单插件 hook 异常独立记录，其他插件继续运行。

插件路由通过 Fastify 封装域门控，停用或未启动时返回 503；技能路由仍由核心路由文件挂载并显式门控。工具在创建会话时装配，停用不强制清空已有会话；应新建任务验证工具变更。Pi 扩展停用仅移除平台管理的声明，不删除用户自装声明。平台插件没有依赖图、通用超时或独立数据库迁移管理器。

长期记忆默认手动维护；`MEMORY_AUTO_CAPTURE=1` 才在成功轮次保存限长经验摘要，失败和取消不写入。召回是 SQLite LIKE 配合中文二元片段，不是向量检索或事实抽取；参考块明确标为非用户指令。来源任务删除时，在记忆插件启用的前提下清理关联记忆。接口和风险边界见 [集成说明](integration-guide.md)、[ADR 0012](adr/0012-platform-plugins-memory.md)。

CSS 皮肤是渲染层扩展，不能装载 JavaScript；与服务端平台插件、Pi 扩展包分别管理。基础样式 → `runtime-theme` → `data-skin-style` 三层级联，细节见 [皮肤开发](../skin-packs/README.md) 和 [ADR 0011](adr/0011-skin-packs-css-only.md)。

## 存储与迁移

| 表/目录 | 内容 |
| --- | --- |
| `users` | 企业知识库身份 |
| `wps_profile` | 当前用户关联的紫金协作同步资料 |
| `model_providers`、`mcp_servers` | 用户自己的模型与连接器配置，包含敏感凭证 |
| `agents`、`agent_skills` | 专家配置、技能绑定及软删除标记 |
| `tasks`、`task_messages`、`task_uploads`、`deliverables` | 任务登记、消息、输入附件、成果物索引 |
| `task_session_grants`、`scheduled_tasks` | 会话授权和巡检配置 |
| `skill_sources`、`skill_usage` | 技能来源、版本基线和使用计数 |
| `platform_plugins` | 插件 id、启用状态、预留 JSON 配置、更新时间 |
| `memories` | 用户、类型、内容、来源任务、置信度、元数据、active 与时间戳 |
| `sessions/`、`workspaces/`、`agents/` | 会话 JSONL、平台隔离工作区、专家常驻文件 |
| `agent/` | 平台指令、技能、专家私有技能和 Pi 包配置 |
| `skins/` | 皮肤目录及 `builtins.json` 内置登记；无皮肤业务表 |

数据库表仍集中在 `apps/server/src/db.ts` 的幂等迁移中，不具备完整版本迁移/回滚框架。备份必须覆盖整个有效数据目录；在线 WAL 不可只拷贝主 `.db` 文件。流程见 [运行手册](runbook.md)。
