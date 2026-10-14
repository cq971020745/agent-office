# Agent 办公平台

任务执行型 AI 办公平台（对标腾讯 WorkBuddy）：用户下达任务 → agent 自主拆解执行 → 交付可验收成果物。设计共识见 [docs/design.md](docs/design.md)，领域术语见 [CONTEXT.md](CONTEXT.md)，关键决策见 [docs/adr/](docs/adr/)，迭代历史见 [CHANGELOG.md](CHANGELOG.md)。

## 结构

```
apps/
  server/    Fastify + TS 后端，进程内嵌 pi agent harness（@earendil-works/pi-coding-agent）
  desktop/   Electron + Vue 3 桌面控制台
packages/
  shared/    前后端共享的领域类型与 DTO
pi-packages/ 内置 pi 插件包（office-suite：todo 工具 / 写操作护栏 / 办公提示词模板）
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

第一个注册的用户自动成为管理员；之后的注册仅限管理员操作。登录连续失败 10 次会锁定 10 分钟（防暴力破解）。

**可选能力：代码执行（run_code）**。宿主机装有 Docker 且守护进程在运行时，任务会话自动获得 `run_code` 工具——JavaScript/Python 在独立容器里执行（无网络、限内存/CPU/进程数、工作区只读挂载，120s 超时）；Docker 不可用时该工具不注入，其余功能不受影响（见 [ADR 0004](docs/adr/0004-run-code-docker-isolation.md)）。

**内置 pi 插件包（office-suite）**。服务端启动时把 [pi-packages/office-suite](pi-packages/office-suite/) 正规安装进平台数据目录（`agent/packages/` + `agent/settings.json` 的 packages 声明），由 pi 的资源加载器在每个任务会话中自动生效：

- `todo` 工具——专家接到多步骤请求时先拆解清单、逐步勾选，状态跨轮次与会话恢复保留；
- 写操作护栏——拦截 `workspace_write` 覆盖 `.env`/`.git`/`node_modules`，拦截 `run_code` 中的破坏性脚本（递归删根目录、fork 炸弹、格式化磁盘等），自动拒绝并说明原因；
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

1. 管理员在客户端「管理」页配置模型供应商（baseUrl + apiKey，DeepSeek/Qwen/Moonshot 或任意 OpenAI Chat Completions 兼容端点）
2. 管理员配置 Agent（system prompt + 供应商 + 模型 ID），并按需创建成员账号；可维护平台技能与管理 MCP 连接器
3. 成员下达任务（可附最多 10 个附件，单个 ≤ 20MB，附件作为任务输入落进工作区；也支持把文件直接拖进派发框），围观执行（SSE 事件流），验收并下载/预览成果物；任务完成后可继续追问，也可删除任务
4. 任务支持多轮追问：任务详情页就是一个会话，完成后可继续发消息（追问同样可带附件——回形针选择或拖入输入框），Agent 带着完整上下文继续干活；服务重启后也能从磁盘会话恢复继续对话

任务列表支持服务端分页、按状态筛选与关键词搜索（返回 items/total/counts）；数据量大时页面按「加载更多」增量拉取。

任务的工作目录三选一：派发时自选本地目录 > 专家常驻文件夹（产出沉淀在专家目录）> 平台隔离工作区。删除任务时会清理平台隔离工作区与会话文件；自选目录与专家文件夹里的文件不动（上传的附件属于任务输入，删除任务时只清理登记，文件本身留在原地）。

没有真实 API Key 时，可以用本地 mock 供应商体验完整链路：

```bash
node scripts/mock-openai.mjs   # 监听 127.0.0.1:9990，固定返回一次 workspace_write 调用
```

管理端把 baseUrl 填 `http://127.0.0.1:9990/v1`、模型 ID 填 `mock-model` 即可。

## 部署

```bash
docker compose up -d --build   # 单容器 + ./data 数据卷
```
