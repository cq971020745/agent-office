# Agent 办公平台

任务执行型 AI 办公平台（对标腾讯 WorkBuddy）：用户下达任务 → agent 自主拆解执行 → 交付可验收成果物。设计共识见 [docs/design.md](docs/design.md)，领域术语见 [CONTEXT.md](CONTEXT.md)，关键决策见 [docs/adr/](docs/adr/)，迭代历史见 [CHANGELOG.md](CHANGELOG.md)。

## 结构

```
apps/
  server/    Fastify + TS 后端，进程内嵌 pi agent harness（@earendil-works/pi-coding-agent）
  desktop/   Electron + Vue 3 桌面控制台
packages/
  shared/    前后端共享的领域类型与 DTO
pi-packages/ 内置 pi 插件包（office-suite：todo 工具 / 写操作护栏）
skills-catalog/ 内置技能市场（可直接安装进平台技能库的精选 SKILL.md）
agent-packs/   内置专家包（office-agent-package v1，一键安装或分享）
data/        运行时数据卷：app.db（SQLite）/ sessions/（pi JSONL）/ workspaces/<taskId>/
docs/        design.md + adr/
```

## 本地开发

要求：Node ≥ 22.19，pnpm ≥ 10。

```bash
pnpm install
pnpm dev:server     # http://127.0.0.1:8787
pnpm dev:desktop    # Electron 控制台
```

界面有两个入口，二选一即可：Electron 桌面客户端（`pnpm dev:desktop`），或直接用浏览器打开 `http://127.0.0.1:8787/`（服务端会托管 Web 控制台，需先 `pnpm --filter @office/desktop build` 生成渲染层产物）。

服务端环境变量（可用 `.env`，见 `apps/server/src/config.ts`）：`PORT`、`DATA_DIR`、`JWT_SECRET`。生产部署务必设置强随机 `JWT_SECRET`（未设置时服务端会打告警）。

所有用户都可在登录页自行注册；空库中第一个注册账号自动成为管理员，后续账号默认为普通成员。忘记密码时，可在运行服务的这台电脑上按用户名重置并登录，局域网里的其他电脑不能代改。每个用户登录后可在侧栏账号入口同步自己的 WPS 365 用户信息。登录连续失败 10 次会锁定 10 分钟（防暴力破解）。

**宿主终端（terminal）**。任务会话始终带有 `terminal`：Windows 走 PowerShell，Linux/macOS 走 bash，工作目录固定为任务工作区，使用当前服务进程权限且不自动提权。它默认每次调用都要用户确认；用户可以选择「仅本次允许」或「本会话允许」，也可以在任务里撤销会话授权。专家策略里的 `deny` 仍然优先。服务端秘密环境变量（`JWT_SECRET`、WPS 凭证等）不会传给命令。明显破坏性命令（格式化磁盘、递归删除盘根、关机）由写操作护栏拦截。

**可选能力：代码执行（run_code）**。宿主机装有 Docker 且守护进程在运行时，任务会话额外获得 `run_code`——JavaScript/Python 在独立容器里执行（无网络、限内存/CPU/进程数、工作区只读挂载，120s 超时）。它只负责不受信任的计算，不代替宿主终端；Docker 不可用时该工具不注入（见 [ADR 0004](docs/adr/0004-run-code-docker-isolation.md)）。

**文档解析（doc_to_md）**。启动时声明并安装 `pi-quiver@6.13.2`，只启用 `doc_to_md`。它把 PDF、DOCX、旧版 DOC、PPTX、XLSX/XLS 转成工作区隐藏目录 `.parsed/` 里的 Markdown，再由 `workspace_read` 读取。`workspace_read` 遇到二进制文件不再返回乱码；旧版 Word 被存成 `.docx` 时，会按文件头复制一份隐藏的 `.doc` 再交给解析器，原文件不改。高保真降级依赖本机 LibreOffice `soffice`；Docker 镜像已安装 Python 3 与 LibreOffice Writer/Calc/Impress。本地附件不要为了提取正文上传到 WPS 云盘。

**内置 pi 插件包（office-suite）**。服务端启动时把 [pi-packages/office-suite](pi-packages/office-suite/) 正规安装进平台数据目录（`agent/packages/` + `agent/settings.json` 的 packages 声明），由 pi 的资源加载器在每个任务会话中自动生效：

- `todo` 工具——专家接到多步骤请求时先拆解清单、逐步勾选，状态跨轮次与会话恢复保留；
- 写操作护栏——拦截 `workspace_write` 覆盖 `.env`/`.git`/`node_modules`，拦截 `run_code` 和 `terminal` 中的破坏性命令（递归删根目录、fork 炸弹、格式化磁盘等），自动拒绝并说明原因；
- 办公提示词模板——在对话框输入 `/周报 [重点]`、`/会议纪要 <主题或记录>`、`/邮件润色 <草稿>`，模板展开成结构化任务并把产出存进工作区。

**技能安装与同步**。管理端「专家 → 技能」页除了手工新建，还能像主流包管理器一样装和更：

- 内置市场（[skills-catalog/](skills-catalog/)）：邮件回复、数据解读、演讲大纲、SWOT 分析，点击「安装」即进平台技能库；
- 任意来源安装：本地路径（含 `SKILL.md` 的目录或其父目录）、http(s) Markdown 链接、git 仓库（浅克隆后扫描其中全部技能，一次装多个）；同名冲突默认拒绝，可勾选覆盖；
- 同步：来源安装的技能会登记来源（类型 / git revision / 同步时间），来源内容更新后点「同步」即可重拉覆盖；来源里消失的关联技能自动删除。

**专家包：安装与导入**。专家可以像插件一样分发（[agent-packs/](agent-packs/) 内置「深度研究员」「公文写作助手」两个包）：

- 管理端「专家」页顶部的包市场可一键安装内置专家包，包内技能随之落库，供应商与模型在安装时选择；
- 「导入专家包」读取 `office-agent-package` v1 的 `.json` 文件（永不覆盖现有数据，同名技能自动改名 `-2`）；
- 卡片菜单「导出专家包」把任意专家连同勾选的平台技能导出为可分享的 `.json` 包。

## 测试

```bash
pnpm test   # 服务端单元测试（node:test）：auth / tools / skills / sse / tasks 分页 / uploads 附件 / pi 插件包安装与加载 / run_code 命令 / 技能安装与同步 / 专家包导入导出 / admin 解析
```

端到端冒烟（走真实 HTTP + mock 供应商，覆盖派发→完成→成果物→删除→限流全链路）：

```bash
node scripts/mock-openai.mjs                                    # 终端 1
PORT=8790 DATA_DIR=<空目录> node apps/server/dist/index.js        # 终端 2（需先 pnpm build）
SMOKE_BASE=http://127.0.0.1:8790 SMOKE_DATA_DIR=<同一空目录> node scripts/smoke.mjs   # 终端 3
```

## 使用流程

1. 用户在登录页自行注册并登录；需要 WPS 365 能力时，在侧栏账号入口同步自己的 WPS 用户信息
2. 管理员在客户端「管理」页配置模型供应商（baseUrl + apiKey，DeepSeek/Qwen/Moonshot 或任意 OpenAI Chat Completions 兼容端点）
3. 管理员配置 Agent（system prompt + 供应商 + 模型 ID），并维护平台技能与 MCP 连接器
4. 成员下达任务（可附最多 10 个附件，单个 ≤ 20MB，附件作为任务输入落进工作区；也支持把文件直接拖进派发框），围观执行（SSE 事件流），验收并下载/预览成果物；任务完成后可继续追问，也可删除任务
5. 任务支持多轮追问：任务详情页就是一个会话，完成后可继续发消息（追问同样可带附件——回形针选择或拖入输入框），Agent 带着完整上下文继续干活；服务重启后也能从磁盘会话恢复继续对话
6. 宿主终端默认每次确认。任务详情会出现「拒绝 / 仅本次允许 / 本会话允许」；本会话允许后，同一任务里再调用该工具不再询问，也可以撤销。Word、PDF 等附件由 `doc_to_md` 解析到工作区 `.parsed/`，不要指望 `workspace_read` 直接读出正文

任务列表支持服务端分页、按状态筛选与关键词搜索（返回 items/total/counts）；数据量大时页面按「加载更多」增量拉取。

任务的工作目录三选一：派发时自选本地目录 > 专家常驻文件夹（产出沉淀在专家目录）> 平台隔离工作区。删除任务时会清理平台隔离工作区、会话文件和本会话工具授权；自选目录与专家文件夹里的文件不动（上传的附件属于任务输入，删除任务时只清理登记，文件本身留在原地）。

没有真实 API Key 时，可以用本地 mock 供应商体验完整链路：

```bash
node scripts/mock-openai.mjs   # 监听 127.0.0.1:9990，固定返回一次 workspace_write 调用
```

管理端把 baseUrl 填 `http://127.0.0.1:9990/v1`、模型 ID 填 `mock-model` 即可。

## 部署

```bash
docker compose up -d --build   # 单容器 + ./data 数据卷
```

<!-- README-AUTO:START -->
文档自动生成于：2026-10-15 17:12

### 项目概览
- 名称：agent-office
- 包管理：pnpm workspace
- 应用：`@office/server`（Fastify + pi agent）、`@office/desktop`（Electron + Vue 3）、`@office/shared`（共享 DTO）

### 运行脚本
- `dev:server`：启动 API，默认 http://127.0.0.1:8787
- `dev:desktop`：启动 Electron 开发窗口（渲染层 http://localhost:5173/，接口仍走 8787）
- `build`：递归构建各包；浏览器入口依赖 `@office/desktop` 的渲染产物
- `typecheck`：递归类型检查
- `test`：服务端 `node:test`

### 关键目录
- `apps/server/src`：任务执行、宿主终端、会话授权、文档包声明
- `apps/desktop/src/renderer`：Vue 控制台
- `packages/shared/src`：共享类型
- `pi-packages/office-suite`：todo 与写操作护栏
- `skills-catalog`：内置技能，含 WPS 365
- `docs`：设计共识与 ADR
<!-- README-AUTO:END -->
