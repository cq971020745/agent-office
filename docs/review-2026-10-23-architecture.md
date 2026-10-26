# 架构评审：澄台（CHENG）现状与「插件化 + 记忆」改造

> 历史快照：下面“未修”“不建议合入”等判定仅针对注明的 2026-10-23 快照；2026-10-26 的代码复核、已修项目和未解决限制见 [handoff.md](handoff.md)，现行架构见 [design.md](design.md)。不改写原评审证据，也不把已过期判定当作当前结论。

> 日期：2026-10-23　范围：`apps/server`、`apps/desktop`、`packages/shared`、构建/部署脚本、文档与 ADR
> 方法：三路并行只读审查（服务端 / 桌面端 / 横切面）+ Lead 复核实测；未修改仓库代码。
> 快照说明：评审期间工作区正被另一进程改动（`apps/server/src/plugins/`、`db.ts`、`index.ts`、`routes/*`、`runner.ts` 未提交修改）。本报告结论针对 **HEAD 已提交架构 + 2026-10-23 11:30 快照的进行中改动**。

## 一句话结论

**宏观选型与边界合理，微观模块结构不合理；「插件化 + 记忆」改造方向可行、当前实现不合格，不建议按现状合入。**

- 以当前阶段衡量（内部工具、≤100 用户、单机单进程）：技术选型与 ADR 决策是对的，没有过度设计。
- 以继续演进衡量：这是「没有接缝的单体」——3 个巨文件承担后端核心，5 个巨型 SFC 承担前端核心，新增能力必须同时改 route + runner + db + 前端，变更成本非线性上升。
- 建议做一次约 2–3 周的「接缝手术」，先补风险与测试基线，再上记忆能力，通用插件框架押后。

## 一、量化画像

| 指标 | 数值 |
|---|---|
| 源码规模 | 125 文件约 3.93 万行；服务端 `src` 64 文件 11,684 行；桌面渲染层约 2.2 万行；shared 仅 1 文件 609 行 |
| 服务端大文件 | `routes/admin.ts` 1,366 行 / 40 路由；`runner.ts` 1,195 行 / 17 个依赖；`routes/tasks.ts` 1,055 行 / 32 路由；`db.ts` 426 行 |
| 分层状况 | 97 个路由 handler；**185 处 `.prepare(` 在 `db.ts` 之外**；同款 `getTaskRow + canAccess` 样板重复 25 次 |
| 状态机 | 任务状态写入分散在 `runner.ts` / `tool-approval.ts` / `routes/tasks.ts` 3 个模块 8 处 |
| 依赖图 | **0 循环依赖**（优点）；`db.ts` 扇入 15、`config.ts` 13、`auth.ts` 11；`runner.ts` 扇出 17 |
| 前端 | 27 个 SFC / 17,960 行（style 占 46%）；views 9 文件 10,918 行、0 props/0 emits；`api.ts` 955 行约 95 处 request |
| 巨型 SFC | ExpertsView 2,917 行；TaskDetailView 2,827；HomeView 1,396；AdminView 1,284；App.vue 1,182 |
| 测试 | 28 个 `node:test` 文件 / 195 条；**实测 193 pass / 2 fail**（进行中改动引入）；前端 0 测试 |
| 质量门 | 服务端 typecheck 通过；桌面 `vue-tsc` 失败 2 处（`BrowserPreview.vue:310/511`）；CI 只打包不跑测试/类型检查 |

## 二、做对的地方（不要动）

1. **ADR 是真决策**：服务端执行（0002）、不用服务器数据库（0003）、进程内 pi（0001）、Pi 包随产品分发（0008）、WPS 环境闸门自愈（0009）、冷门端口（0010）都能在代码里对应上。
2. **没有过度设计**：单进程 + SQLite WAL + pi JSONL，备份 = 拷数据目录；对本产品规模是正确的取舍，不要为「架构感」上 MySQL/Redis/K8s。
3. **工具安全层是真抽象**：`tool-policy.ts` / `tool-approval.ts` / `plan-mode.ts` 职责清楚、可单测；terminal 默认每次确认 + 最小 env + 破坏性命令拦截到位。
4. **共享契约真的在共享**：服务端 13 个文件、前端大量引用 `@office/shared`。
5. **可恢复性有设计**：SSE 500 帧回放、会话 idle 回收、重启中断回填、JSONL 会话恢复。
6. **分发链路完整**：electron-vite 三目标 → stage-server → extraResources → 首启解压 deps.tgz，是内网交付的核心资产。
7. **文档治理强于同规模项目**：CONTEXT 术语表、10 个 ADR、AGENTS 边界清单、CHANGELOG。

## 三、P0：安全 / 正确性（建议一周内修）

### P0-1 任务工作目录没有边界 → 可读 `app.db`、跨用户工作区、误删全部工作区

- `POST /tasks` 只校验「绝对路径 + 存在」（`apps/server/src/routes/tasks.ts:448-455`，`path.resolve` 后又判断 `isAbsolute`，实际恒真）。
- 成员可把 `workspaceDir` 指到 `data/` 或别人的 `data/workspaces/<taskId>`，再通过 `GET /tasks/:id/workspace/file`（`routes/tasks.ts:985-1009`）下载 `app.db`（`model_providers.api_key` 明文、MCP env/headers）或他人会话文件。
- 删除任务时按 `isPlatformWorkspace` 判断并发起 `rmSync`（`routes/tasks.ts:791-793`、`config.ts:31-36`）；目录若指到 `data/workspaces` 根，会删掉所有任务工作区。
- 修法：统一 workspace boundary 模块，定义允许根集合（平台隔离区 / 专家常驻目录 / 用户显式选择目录），拒绝 `DATA_DIR` 及其内部、其他任务的平台工作区、符号链接；上传/预览/删除/项目接口全部走同一校验。

### P0-2 专家硬删半删（500 且技能已删）

- `DELETE /admin/agents/:id` 只统计 `tasks` 决定软删/硬删（`routes/admin.ts:860-876`）。
- `scheduled_tasks.agent_id` 有外键（`db.ts:287`），better-sqlite3 **默认开启外键**（13.0.3 实测：删除父行报 `FOREIGN KEY constraint failed`）。
- 顺序是先删 `agent_skills`、专家私有技能目录，最后才 DELETE 专家 → 抛错返回 500：专家还在、技能没了。
- 修法：删除前统计全部引用（tasks / scheduled_tasks），统一走软删或事务化级联；外键顺序显式化。

### P0-3 `run_skill_script` 是未纳管的宿主执行面

- 子进程继承**整个 `process.env`** + WPS 凭证（`skill-scripts.ts:103-111`），且不在默认 ask 集合（`tool-policy.ts:50`）。
- 任何登录用户都能从 git/URL 装技能（`routes/admin.ts` 技能安装路由只有登录态）。
- 组合效果：普通成员可让 Agent 在宿主机跑任意 Python，读走 `JWT_SECRET`、模型 Key、`DATA_DIR`。
- 修法：最小 env 白名单（复用 `host-terminal.ts` 的 `buildTerminalEnv` 思路 + WPS 边车白名单）、纳入审批默认 ask、技能安装增加来源约束/审核。

### P0-4 迁移体系不可用于演进

- `db.ts:69-388` 把 V1–V20 迁移、数据回填、吞掉所有 ALTER 异常揉在一个函数；无 `schema_version`、无事务、无回滚；重复启动会重复扫描回填。
- 进行中的插件表也继续内联进 `db.ts`——**通用插件化之前必须先有迁移框架**。
- 修法：引入轻量迁移器（版本表 + 顺序脚本 + 事务 + 失败中止），现有迁移一次性收敛为基线；每个插件/子系统拥有自己的迁移段。

### P0-5（进行中）插件改动已让测试变红

- `plugins/index.ts` 模块加载即 `register()`，`PluginRegistry.register` 立刻 `INSERT INTO platform_plugins`（`plugins/registry.ts:14`），早于 `migrate()`。
- 这打破了仓库既有测试模式（先设 `DATA_DIR` → 动态 import → `migrate()`），实测 `admin.test.ts`、`provider-routes.test.ts` 报 `SqliteError: no such table: platform_plugins`。
- 修法：注册惰性化（在 `migrate()` 之后调用 `initialize` 时才建表/写行），或让 registry 提供 `ensureSchema()` 并由启动/测试显式调用。

## 四、P1：可维护性 / 扩展瓶颈

1. **路由即控制器**：鉴权、SQL、领域规则、文件 IO、启动 runner 全在 handler；模型归属校验重复 3+ 处（`routes/tasks.ts:435/669`、`scheduler.ts:306`、`routes/admin.ts:733`），且 `PATCH /schedules/:id` 跳过校验（`scheduler.ts:356-373`），触发时用库里的 `provider_id`，可跑别人的供应商。
2. **任务状态机无单一所有者**：`awaiting_approval` 同时表示「高风险计划待确认」（`runner.ts:953-957`）和「工具调用待审批」（`tool-approval.ts:84`）；取消/删除按该二义状态分支处理（`routes/tasks.ts:753-759/777`），工具审批等待中的取消只改库不取消 runner；委派子会话不在 `sessions`、不受 cancel 控制，15s keepAlive 绕过 180s 看门狗（`runner.ts:556-599/885-891`）。
3. **runner 上帝模块**：会话创建、prompt 拼装、工具装配、闸门、状态机、落库、SSE、恢复、委派混在 1,195 行里；仅 `buildPreamble`/`resolveDelegatedAgent` 有测试，turn/审批/竞态零覆盖。
4. **前端无状态层 + 巨型 SFC**：ExpertsView 4 tab + 5 弹窗且 0 子组件；Home/TaskDetail 两套模型选择器、两套 composer 重复接线；无 Pinia，跨视图靠 localStorage + 路由参数 + 各自轮询（App 5s / TasksView 4s / ExpertDetail 6s）。
5. **契约漂移**：shared `AgentConfig` vs 前端 `AdminAgent`、`ModelProvider` vs `AdminProvider` 字段互补/缺失；`CreateTaskRequest.agentId` 必填而两端可选；`WorkspaceEntry` 双写；`Role2` 死类型；`register/resetPassword/changePassword` 客户端死代码对应已下线 410 接口。
6. **部署路径有洞**：`docker-compose.yml` 的 `build: ./apps/server` 与 `apps/server/Dockerfile` 的 `COPY pnpm-workspace.yaml ...` 上下文不匹配，按 README 的 `docker compose up --build` 会失败；Dockerfile 仍写 `EXPOSE 8787`。
7. **JWT 与日志**：签发不带 `expiresIn`（`routes/auth.ts:90`）即永不过期；服务监听 `0.0.0.0`（`index.ts:129`）、CORS `origin: true`（`:80-83`）；SSE / 下载把 JWT 放 query（`routes/tasks.ts:934-947/985-993`），Fastify access log 记录完整 URL（仓库里误提交的 `apps/server/^` 日志为证）。浏览器/容器入口下知识库 iframe 与主应用同源，页面脚本可读主应用 localStorage 的 JWT（桌面 `file://` 入口不同源）。

## 五、P2（风格/次要）

固定端口 + `API_BASE` + CSP 四处手工同步（AGENTS.md 已注明）、无单实例锁（双开抢端口）；SSE 重连全量回放 + seq 去重；无 ESLint/Prettier；路由全量 eager import；CSP 缺 `media-src`；3 处裸 fetch 绕过统一 401；仓库误提交 `apps/server/^`（21KB server.log）与本机脚本 `start-server.cmd`；`docs/design.md` 堆了 20+ 条状态注记已不可读，pi 版本仍写 0.87.1（实际 1.2.0）。

## 六、对「插件化 + 记忆」改造的判定

目标（用户隔离、可替换 backend、失败降级、不依赖 `~/.pi`、admin 启停）方向正确，也符合 ADR 0008；但设计与当前实现有几处结构性问题：

| 问题 | 说明 |
|---|---|
| 抽象过早 | 只有一个 memory 插件却引入通用 `PluginRegistry`；接口只有 turn 生命周期 + `registerRoutes`，缺 tools/prompt 片段/顺序/依赖/超时等真正扩展点。建议先做 memory 子系统 + 3 个明确 hook，注册表等第二个插件出现再抽象。 |
| 中文召回实际失效 | `plugins/memory.ts:41-44` 按非字母数字切词 → 中文整句成为一个 term → `LIKE '%整句%'`，几乎永不命中；FTS5 默认 unicode61 同样不分中文词。需要 trigram / 分词 / embedding，或关键词抽取 + 全句兜底。 |
| 缺记忆投毒威胁模型 | `afterTurn` 自动沉淀 + `beforeTurn` 自动注入（`runner.ts:893-956`），任务内容可写入长期记忆并影响后续所有任务；注入块没有 provenance/trust 标记，模型无法区分用户指令与历史数据。需默认关闭、白名单 kind、限长、用户可见可删、注入时声明「仅作参考」。 |
| 生命周期/质量缺口 | 每个 completed 多轮都沉淀（仅按全文去重），无衰减/TTL/上限；`completed` 不等于有成果物；无召回质量/延迟测试。 |
| 工程正确性（快照） | `register()` 在 import 时写库导致测试红；`onTaskDeleted` 被接在 `PATCH /tasks/:id/model`（`routes/tasks.ts:662-665`）——换模型会清空该任务沉淀的记忆，而真正的 `DELETE /tasks/:id` 没接；前端 0 引用 `/memory`、无 UI；`beforeTurn` 在 turn 关键路径上无超时预算。 |

**结论：这批改动现在不能合。** 先把迁移框架、测试基线、runner 生命周期接缝做好，再把 memory 收窄为带威胁模型的子系统；`PluginRegistry` 押后再抽象。

## 七、建议路线（约 2–3 周，期间不加新功能）

1. **修风险（1 周）**：workspace boundary；专家删除级联；`run_skill_script` 最小 env + 审批；JWT 过期与 query token 换代金券、日志脱敏；compose 修上下文；修 2 个类型错误 + 2 条红测试；CI 加 `typecheck + test`。
2. **抽接缝（1 周）**：`db/migrations`（版本表 + 事务）；`repositories`（tasks/agents/providers）；`task-store` + 单一状态机（拆 `awaiting_plan` / `awaiting_tool`）；runner 拆 session-factory / model-runtime / turn-runner / recovery，只留门面；补 runner 与状态迁移测试。
3. **前端基线（并行）**：feature 目录 + Pinia（auth/task-list/theme/toast）、轮询收敛、api 按域拆；ExpertsView/TaskDetailView 先拆弹窗与 composer，目标各 ≤600 行。
4. **记忆 v1（接在 1–2 之后）**：手动偏好 + 完成经验两类、默认关闭、LIKE + 关键词召回、上限/衰减、用户管理 UI、注入隔离；先补 ADR（迁移框架、记忆威胁模型、扩展点边界）。

## 八、判定标准与责任边界

- 本报告按「变更成本」判架构，不按文件大小或代码风格扣分。
- 未覆盖：真实运行性能、并发压测、生产环境遥测（仓库内无数据）；「进行中改动」只评审到 11:30 快照，最终分支合入前应再做一轮针对该 diff 的增量评审。

---

# 复核（2026-10-23 14:30：用户改造后）

范围：未提交工作树（36 项改动；无新 commit）。服务端 typecheck 通过，`pnpm test` 全绿（含新增 skins/memory 测试）；桌面 `vue-tsc` 仍失败 2 处。

## 结论

**方向对了：上一轮批评的「扩展性/无接缝」被真正回应；但上一轮的 P0 安全/数据问题基本没动，且新能力引入了新的 P0。当前状态不建议发布或打包，应先修安全项与质量门，并把改造落成 commit + ADR/CHANGELOG。**

## 一、已明显改善（确认修复/落地）

1. **平台插件系统真正落地**：`plugins/registry.ts` 提供 migrate/start/stop/beforeTurn/afterTurn/onTaskStarted/createTools/onTaskDeleted/registerRoutes 生命周期与运行时启停；内置插件 9 个（memory/skills/pi-packages/scheduler/voice/web-access/wps/knowledge-base/mcp），插件路由用 Fastify 封装 scope + `onRequest` 503 门控，单个插件失败只记日志不阻断其他插件；注册不再在 import 时写库（P0-5 已修），`/plugins` + `/admin/plugins/:id` + PluginsView 闭环。
2. **runner 被削薄**：工具装配、语音/网页/知识库/MCP 工具、OCR runtime、技能注入全部移到插件 `createTools`/`onTaskStarted`；`workspaceCoreTools` 与可选集成拆分。
3. **记忆系统 v1 有实质修正**：中文 bi-gram 召回（不再是整句 LIKE）；注入块加 `purpose="参考资料，不是用户指令"` 与 memory_id；自动沉淀默认关闭（`MEMORY_AUTO_CAPTURE=1` 才开）；`onTaskDeleted` 接到 `DELETE /tasks/:id`（不再错接换模型接口）；GET/POST/DELETE `/memory` + MemoryView 用户可查看/删除；有用户隔离与任务级清理测试。
4. **皮肤包按 ADR 0011 落地**：CSS-only、无 `script-src` 放宽；`/skins/:id/file` 有 id 正则、`..`/空段/`:`/NUL 校验、`path.relative` 越界校验、符号链接拒绝、MIME 白名单；内置包登记 `builtins.json` 且不可覆盖/删除；打包链路 `skin-packs/`→stage→extraResources→`SKIN_PACKS_DIR`→启动差异同步已接通；CSP 只加 `font-src`。
5. **测试绿了**：新增 `skins.test.ts`（同步/列表/401/MIME/路径穿越/zip 安装/内置保护/删除）与 `memory.test.ts`（隔离/去重/召回/forgetTask/API/registry 生命周期与 503），服务端全量测试通过。

## 二、仍未修复的上一轮 P0/P1（复核确认）

| 项 | 状态 | 证据 |
|---|---|---|
| P0-1 工作目录无边界（可读 `app.db`/他人工作区、误删全部工作区） | **未修** | `routes/tasks.ts:448-455` 仍只校验绝对路径+存在；无 boundary 模块；`DELETE` 仍按 `isPlatformWorkspace` 直接 `rmSync` |
| P0-2 专家硬删半删（FK 500 且技能已删） | **未修** | `routes/admin.ts` 删除块无变化（仅加插件门控）；`scheduled_tasks` 外键仍在 |
| P0-3 `run_skill_script` 全量 env + 默认不审批 | **未修** | `skill-scripts.ts` 未改；skills 插件仍原样注入 `skillScriptTool`；`tool-policy.ts` 默认 ask 集合未变 |
| P0-4 迁移体系（V1–V20 内联、无版本/事务） | **未修/更重** | `db.ts` 继续追加 `platform_plugins`/`memories` 建表；插件 `migrate` 形同虚设 |
| P1 JWT 永不过期 / query token 进日志 / 监听 0.0.0.0 | **未修且扩大** | `routes/auth.ts:90` 仍无 `expiresIn`；新增 `/skins/:id/file?token=`（ADR 0011 明确沿用 SSE 先例）；Fastify 仍记录完整 URL |
| P1 docker compose 上下文不匹配 / EXPOSE 8787 | **未修** | `docker-compose.yml`、`apps/server/Dockerfile` 无改动 |
| P1 桌面类型基线 | **仍红** | `vue-tsc` 仍报 `BrowserPreview.vue:310/511`；无 CI 跑 typecheck |
| P1 前端巨型 SFC / 无状态层 | **未动** | ExpertsView 2,917 / TaskDetail 2,827 / App 1,190；api.ts 955→1,043 |

## 三、新发现的问题

### P0（新发现，建议立即修）

**zip 解压路径穿越（Windows 反斜杠）——任意登录用户可写服务器文件系统**
`zip-pack.ts:unzipTo` 只用 `name.split("/")` 拆段并拒绝 `..`/空段，但 zip 条目名可含反斜杠：`..\..\evil.txt` 作为单段通过校验，`path.join(dest, "..\\evil.txt")` 在 Windows 上归一化到父目录（已用 `path.win32.join/resolve` 实测逃逸），随后 `fs.writeFileSync` 直接落盘。入口均为已登录可用：`POST /skins`（皮肤 zip）、技能 zip 安装（`skill-install.ts:294`）、专家包导入（`routes/admin.ts:917`）。桌面一体包以当前用户权限运行 → 可写启动目录/应用资源，等同代码执行。修法：条目名先 `replace(/\\/g,"/")`、再 `path.posix` 规范化并校验 `path.relative(dest, target)` 不以 `..` 开头、拒绝盘符/UNC；补一条带反斜杠条目的回归测试。
（另：解压体积上限在解压后才判断，压缩炸弹仍可打满内存 → P1。）

### P1（新能力带来的）

1. **插件边界不完整**：skills 的路由仍散在 `routes/admin.ts`/`routes/tasks.ts`，用重复的 `requireSkillsPlugin` preHandler 手工门控（且该函数发完 503 后没有 `return reply`，有重复响应风险）；memory/wps/kb/voice 走 `registerRoutes`；skins 完全在插件系统之外。插件"所有权"没有统一规则。
2. **插件系统缺治理设施**：无依赖/顺序声明（知识库工具依赖 skills 数据，但两者独立启停）；`migrate` 无归属（插件表仍在核心 `db.ts`）；`apiPrefixes` 需手改 `index.ts`；mcp 插件无 `stop()`（停用后子进程不回收）；已有 AgentSession 缓存 1h，停用插件后正在运行的任务不会立即降级。
3. **皮肤全局共享 + 任何登录用户可管理**：`POST/DELETE /skins` 只有登录态；皮肤是服务端全局状态（ADR 刻意如此），多用户容器部署下任一成员可改所有人的 UI（CSS 可做 UI redress/遮挡审批按钮），并对内置包以外所有用户皮肤有删改权。建议服务端模式限管理员，或改为按用户皮肤。
4. **`GET /skins` 返回 `skinDir` 绝对路径**给任意登录用户（与 `GET /admin/agents` 不返回 folder 的既有约定不一致）。
5. **皮肤 `url()` 改写只处理相对路径**：绝对 `http(s)`/`//` 原样保留，当前靠 CSP 兜底阻止外联；CSS `@import` 同理。建议按白名单改写并在 ADR 记录依赖 CSP 的边界（CSS-only ≠ 无风险）。

### P2

`setEnabled` 失败时统一回 404（应 500/状态保持可诊断）；插件路由前缀与静态托管 `apiPrefixes` 手工同步；`/plugins` 对成员可见但无用户级偏好；`.zcode/` 等本机规划文件曾出现在工作树（当前已清）；新增功能未写入 CHANGELOG、插件化/记忆无 ADR（与仓库治理约定不符）。

## 四、量化对比（上一轮 → 本次）

| 指标 | 之前 | 现在 |
|---|---|---|
| 服务端测试 | 193 pass / 2 fail | 全绿（新增 skins/memory 共 12+ 用例） |
| 服务端 typecheck | 通过 | 通过 |
| 桌面 vue-tsc | 2 errors | 2 errors（未修） |
| `runner.ts` | 1,195 行 | 1,182 行（变化很小） |
| `routes/admin.ts` / `tasks.ts` | 1,366 / 1,055 | 1,381 / 1,059 |
| 前端最大 SFC | 2,917 / 2,827 | 2,917 / 2,827（未拆） |
| 插件/皮肤/记忆新增代码 | — | 插件 ~10 文件、skins 224 行、memory 103 行、2 个新视图、api.ts +88 行 |

含义：**扩展性改造成功了一半（能力边界有了），但"巨文件 + 无分层 + 迁移/安全欠账"没有改变；新增的插件抽象目前是"能力装配层"，还不是"可独立演进/迁移/降级的边界"。**

## 五、建议下一步（按优先级）

1. 修 4 个 P0：zip 反斜杠穿越；workspace boundary；专家删除级联；`run_skill_script` 最小 env + 审批。
2. 修桌面 2 个类型错误 + CI 加 `typecheck + test`（这是上一轮就提的基线）。
3. 插件治理补齐：skills 路由迁回 skills 插件（或统一插件路由所有权规则）、preHandler `return reply`、mcp `stop()`、`apiPrefixes` 由 registry 提供、停用插件时 `invalidateSession` 已有会话。
4. 迁移框架：引入 `schema_version` + 事务迁移，插件表迁给插件 `migrate`；这是后续任何数据演进的前置。
5. 皮肤：服务端模式限管理员或 per-user；`?token=` 改短时 ticket；`GET /skins` 不返回绝对路径。
6. 收尾：commit + CHANGELOG + 插件化/记忆 ADR（含威胁模型：记忆投毒、CSS 皮肤 UI redress、zip 上传）。
