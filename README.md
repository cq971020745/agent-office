# 澄台（CHENG）

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
pnpm dev:server     # http://127.0.0.1:38617
pnpm dev:desktop    # Electron 控制台
```

界面有两个入口，二选一即可：Electron 桌面客户端（`pnpm dev:desktop`），或直接用浏览器打开 `http://127.0.0.1:38617/`（服务端会托管 Web 控制台，需先 `pnpm --filter @office/desktop build` 生成渲染层产物）。

服务端环境变量：`PORT`、`DATA_DIR`、`JWT_SECRET`（见 `apps/server/src/config.ts`），以及 `KB_BASE_URL`（见 `apps/server/src/kb-auth.ts`，默认 `http://10.50.11.17/new-general-rag-kb`）。生产部署务必设置强随机 `JWT_SECRET`（未设置时服务端会打告警）。

登录身份是企业知识库用户，密码在知识库里，本应用不再自助注册或修改密码。知识库角色 `superadmin` 在本应用是管理员，其余人是成员。每个用户在侧栏「模型供应商」配置自己的接入；Base URL 需包含 `/v1`（如 `http://host:8080/v1`），拉取模型时请求 `{baseUrl}/models`。侧栏「企业知识库」打开知识库现有工作台。紫金协作按手机号挂到当前用户；两边都是完整 11 位且不一致时不关联。登录连续失败 10 次会锁定 10 分钟。

**宿主终端（terminal）**。任务会话始终带有 `terminal`：Windows 走 PowerShell，Linux/macOS 走 bash，工作目录固定为任务工作区，使用当前服务进程权限且不自动提权。它默认每次调用都要用户确认；用户可以选择「仅本次允许」或「本会话允许」，也可以在任务里撤销会话授权。专家策略里的 `deny` 仍然优先。服务端秘密环境变量（`JWT_SECRET`、WPS 凭证等）不会传给命令。明显破坏性命令（格式化磁盘、递归删除盘根、关机）由写操作护栏拦截。

**可选能力：代码执行（run_code）**。宿主机装有 Docker 且守护进程在运行时，任务会话额外获得 `run_code`——JavaScript/Python 在独立容器里执行（无网络、限内存/CPU/进程数、工作区只读挂载，120s 超时）。它只负责不受信任的计算，不代替宿主终端；Docker 不可用时该工具不注入（见 [ADR 0004](docs/adr/0004-run-code-docker-isolation.md)）。

**文档解析（doc_to_md）**。启动时声明并安装 `pi-quiver@6.13.2`，只启用 `doc_to_md`。它把 PDF、DOCX、旧版 DOC、PPTX、XLSX/XLS 转成工作区隐藏目录 `.parsed/` 里的 Markdown，再由 `workspace_read` 读取。`workspace_read` 遇到二进制文件不再返回乱码；旧版 Word 被存成 `.docx` 时，会按文件头复制一份隐藏的 `.doc` 再交给解析器，原文件不改。高保真降级依赖本机 LibreOffice `soffice`；Docker 镜像已安装 Python 3 与 LibreOffice Writer/Calc/Impress。本地附件不要为了提取正文上传到 WPS 云盘。

**网页检索（web_search）**。启动时声明并安装 `pi-web-access@0.42.0`，任务会话可用 `web_search` 搜公开网页、`fetch_content` 抓取已知 URL（含 GitHub / PDF / 视频）、`get_search_content` 分页读取检索缓存、`source_check` 收集带引用的来源。配置在 `{DATA_DIR}/agent/web-search.json`，不使用本机 `~/.pi`；缺省文件时写入 `toolActivation: "eager"`。无 API 密钥时走包内默认检索链；平台自带的 `fetch_url` 仍作为简单 HTML 回退。专家可在工具策略里对这些工具设 ask/deny。

**智能上下文压缩（smart-context）**。启动时声明并安装 `@zhushanwen/pi-smart-context@0.3.9`，并写入 `{DATA_DIR}/agent/config/smart-context-ext-config.json`（缺省才创建）与 `defaultTools: ["+tool_search"]`。会话可用 deferred 工具 `compact_context`；pi 内置自动压缩仍默认开启。桌面任务页输入框下方展示上下文占用（类 Cursor）。**对外客户端能力只认平台 `agentDir`，不要依赖开发机 `~/.pi`**（见 [ADR 0008](docs/adr/0008-product-shipped-pi-packages.md)）。

**任务 Git 面板**。工作区本身是 Git 仓库时，任务顶栏显示分支、更改 +/-、切分支/新建分支、提交/推送与提交历史（Git 图谱）。平台隔离区与专家常驻目录不会误显示宿主 monorepo 的 Git。终端 TUI 的 `pi-git-ui` / statusbar **不**随产品安装，等价能力在桌面 UI。

**内置 pi 插件包（office-suite）**。服务端启动时把 [pi-packages/office-suite](pi-packages/office-suite/) 正规安装进平台数据目录（`agent/packages/` + `agent/settings.json` 的 packages 声明），由 pi 的资源加载器在每个任务会话中自动生效：

- `todo` 工具——专家接到多步骤请求时先拆解清单、逐步勾选，状态跨轮次与会话恢复保留；
- 写操作护栏——拦截 `workspace_write` 覆盖 `.env`/`.git`/`node_modules`，拦截 `run_code` 和 `terminal` 中的破坏性命令（递归删根目录、fork 炸弹、格式化磁盘等），自动拒绝并说明原因；
- 办公提示词模板——在对话框输入 `/周报 [重点]`、`/会议纪要 <主题或记录>`、`/邮件润色 <草稿>`，模板展开成结构化任务并把产出存进工作区。

**技能安装与同步**。管理端「专家 → 技能」页除了手工新建，还能像主流包管理器一样装和更：

- 内置市场（[skills-catalog/](skills-catalog/)）：邮件回复、数据解读、演讲大纲、SWOT 分析，点击「安装」即进平台技能库；
- 任意来源安装：本地路径（含 `SKILL.md` 的目录或其父目录）、http(s) Markdown 链接、git 仓库（浅克隆后扫描其中全部技能，一次装多个）；同名冲突默认拒绝，可勾选覆盖；
- 同步：来源安装的技能会登记来源（类型 / git revision / 同步时间），来源内容更新后点「同步」即可重拉覆盖；来源里消失的关联技能自动删除。

**专家包：安装与导入**。专家可以像插件一样分发（[agent-packs/](agent-packs/) 内置「深度研究员」「公文写作助手」两个包）：

- 管理端「专家」页顶部的包市场可一键安装内置专家包，包内技能随之落库；专家不绑定供应商或默认模型；
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

1. 用户用企业知识库账号登录（带验证码）；需要紫金协作能力时，在侧栏账号入口同步自己的 WPS 用户信息（登录态过期会自动从本机紫金协作客户端重新导入，无需手工处理）
2. 每个用户在「模型供应商」配置自己的接入（Base URL 含 `/v1` + API Key）。没有可用模型时不能派发任务
3. 管理员维护专家（系统提示词、常驻文件夹、技能集，不保存默认模型）以及平台技能与 MCP 连接器
4. 成员下达任务（可附最多 10 个附件，单个 ≤ 20MB，附件作为任务输入落进工作区；也支持把文件直接拖进派发框），围观执行（SSE 事件流），验收并下载/预览成果物；任务完成后可继续追问，也可删除任务。对话气泡会显示本条消息的附件；图片以内联缩略图展示，点击可放大
5. 任务支持多轮追问：任务详情页就是一个会话，完成后可继续发消息（追问同样可带附件——回形针选择或拖入整个输入区），并可在输入栏切换本任务模型（须等本轮结束；下一轮按新模型开会话）。Agent 带着完整上下文继续干活；服务重启后也能从磁盘会话恢复继续对话
6. 宿主终端默认每次确认。任务详情会出现「拒绝 / 仅本次允许 / 本会话允许」；本会话允许后，同一任务里再调用该工具不再询问，也可以撤销。Word、PDF 等附件由 `doc_to_md` / `ocr_to_md` 解析到工作区 `.parsed/`，原件文件名不改，不要指望 `workspace_read` 直接读出正文
7. 桌面客户端任务详情预览区可开「浏览器」页签做网页标注：点选页面元素、填写说明后连同截图发回当前任务（纯浏览器打开时无此能力）

任务列表支持服务端分页、按状态筛选与关键词搜索（返回 items/total/counts）；数据量大时页面按「加载更多」增量拉取。

任务的工作目录三选一：派发时自选本地目录 > 专家常驻文件夹（产出沉淀在专家目录）> 平台隔离工作区。只有「自选本地目录」会进入侧栏「项目」（可在同一目录继续开新任务、查看文件、在资源管理器中打开，或移除归组——移除不删磁盘与任务）。删除任务时会清理平台隔离工作区、会话文件和本会话工具授权；自选目录与专家文件夹里的文件不动（上传的附件属于任务输入，删除任务时只清理登记，文件本身留在原地）。

没有真实 API Key 时，可以用本地 mock 供应商体验完整链路：

```bash
node scripts/mock-openai.mjs   # 监听 127.0.0.1:9990，固定返回一次 workspace_write 调用
```

在「模型供应商」把 Base URL 填 `http://127.0.0.1:9990/v1`，获取模型列表后选用 `mock-model`。

## 部署

```bash
docker compose up -d --build   # 单容器 + ./data 数据卷
```

### 客户端一体包（给别人安装用）

一体包 = Electron 桌面端 + 内嵌服务端 + 捆绑的 Node 运行时。用户双击安装/解压后即可用，数据写在本机应用用户目录，接口仍是本机 `127.0.0.1:38617`（冷门端口，避免与其他项目冲突；可用环境变量 `PORT` 覆盖）。

要求：在**目标操作系统**上打包（会把该系统的 `node` 可执行文件打进包内，并用 npm 装好服务端依赖）。本仓库 Windows 机打 Windows 包；macOS / Linux 在对应机器或 CI 跑同一脚本。

```bash
pnpm install
pnpm pack:win      # Windows：NSIS 安装包 + portable
pnpm pack:mac      # macOS：dmg（需在 macOS 上执行；正式发布另需签名/公证）
pnpm pack:linux    # Linux：AppImage + deb
# 或当前平台：
pnpm pack:desktop
```

产物在 [`apps/desktop/release/`](apps/desktop/release/)。中间舞台目录为 `dist/stage/`（`pnpm stage:server` 单独刷新）。

说明：

- 首次启动会拉起内嵌服务端：把随包的 `deps.tgz` 解压到用户目录（只需一次），并可能下载 `pi-quiver` / `pi-web-access` / `@zhushanwen/pi-smart-context` 到 `{DATA_DIR}/agent`，需能访问 npm；不要依赖开发机 `~/.pi`。
- 安装包故意不散装上万个 `node_modules` 小文件（否则 NSIS 安装会卡很久）；依赖以单个 `deps.tgz` 进包。
- 登录仍走企业知识库；接收方需能访问 `KB_BASE_URL`（默认内网知识库）。
- `doc_to_md` 高保真降级依赖本机 LibreOffice；`run_code` 依赖本机 Docker——未安装时对应能力不可用，其余功能正常。

<!-- README-AUTO:START -->
文档自动生成于：2026-10-16 10:41

### 项目概览
- 产品名：澄台（安装包/快捷方式）；仓库包名仍为 agent-office
- 包管理：pnpm workspace
- 应用：`@office/server`（Fastify + pi agent）、`@office/desktop`（Electron + Vue 3）、`@office/shared`（共享 DTO）

### 运行脚本
- `dev:server`：启动 API，默认 http://127.0.0.1:38617
- `dev:desktop`：启动 Electron 开发窗口（渲染层 http://localhost:38618/，接口仍走 38617）
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
