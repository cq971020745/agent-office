# 木牛流马（Muni）

任务执行型 AI 办公平台：用自然语言下达任务，由 Agent 拆解并调用工具执行，交付文档、表格、报告或网页等成果物。产品界面和安装包使用「木牛流马」；历史名称为「澄台（CHENG）」；仓库、包名及兼容存储键沿用 `agent-office`。

## 快速开始

要求 Node.js ≥ 22.19、pnpm 10（仓库固定 `10.28.1`）。登录需要能访问企业知识库；首次启动安装扩展包需要能访问 npm 或配置的镜像。

```bash
pnpm install --frozen-lockfile
pnpm dev:server
```

在另一个终端启动桌面客户端：

```bash
pnpm dev:desktop
```

API 默认 `http://127.0.0.1:38617`，桌面开发渲染层默认 `http://localhost:38618`。开发模式需要分别启动服务端和桌面端；安装包会自行启动内置服务端。

如需纯网页入口，先构建界面，再启动或重启服务端：

```bash
pnpm --filter @office/desktop build
pnpm dev:server
```

浏览器打开 `http://127.0.0.1:38617/`。服务端启动时才检查渲染产物是否存在；浏览器模式没有 Electron 的内嵌网页标注等本机能力。启动、数据目录、部署和故障排查见 [运行手册](docs/runbook.md)。

本次云端入口：[业务控制台](http://139.196.147.134/AI/muniu-workbench/)、[官网与下载](http://139.196.147.134/AI/muniu-liuma/)。服务路径、登录依赖和回滚方式见 [0.1.5 部署记录](docs/deployment-0.1.5.md)。

## 开始使用

1. 使用企业知识库账号和验证码登录；本应用不提供自助注册或改密。只有知识库角色 `superadmin` 是本应用管理员。
2. 在「模型供应商」配置**自己的**地址、密钥、对话协议和启用模型。地址按供应商要求填写，程序仅请求 `{baseUrl}/models`，不自动补 `/v1`；支持 Chat Completions、Anthropic Messages 和 Responses。
3. 直接派发任务，或选择专家，添加附件、`@` 引用、`/` 技能及会话权限。附件最多 10 个，单个不超过 20MB。
4. 在任务详情围观执行、处理审批、预览或下载成果物；可以继续追问、补附件、打断本轮，或在空闲时切换模型。
5. 需要办公集成时，在账号入口同步本机紫金协作用户信息；已有登录态失效由环境闸门自动重导后重试。

## 已有能力

| 领域 | 当前能力 |
| --- | --- |
| 任务与项目 | 历史分页、状态和关键词筛选、多轮追问、失败重试、SSE 重连、上下文占用、自选目录项目归组、Git 面板 |
| 专家与技能 | 登录用户可管理；内置市场、来源同步、更新检查、目录资源渐进加载；专家包兼容 v1 JSON 与 v2 目录/zip，包内技能只属于该专家 |
| 工具与连接器 | 当前用户自己的 stdio/HTTP MCP 连接器、工具筛选、专家工具策略、计划模式、逐次/本会话授权、宿主终端、多专家委派 |
| 办公内容 | 企业知识库既有工作台嵌入、WPS 引用、文档解析/OCR、听写与音频转写、网页检索 |
| 自动化 | 每日、每周和固定分钟间隔巡检；启停、立即执行、生成独立任务 |
| 平台插件与记忆 | 管理员启停内置服务端插件；用户可查看、手动添加和删除长期记忆；相关记忆按用户召回，自动沉淀默认关闭 |
| 外观 | 浅色/深色/玻璃、主色和深浅调节、桌宠、CSS 皮肤、任务生成皮肤、本服务器/npm/GitHub 皮肤市场 |
| 交付与预览 | Markdown、HTML、CSV/TSV、图片、PDF、音频预览；桌面内嵌浏览器和网页标注；Office 文件可下载或交系统应用打开 |

成果物当前是文件索引和预览下载，尚无版本快照或独立的验收状态；候选增强项见 [产品与 UI 待办](docs/product-roadmap.md)。

## 工作区与数据

工作区优先级：用户显式自选目录 → 专家常驻文件夹 → 平台隔离工作区。只有自选目录归为侧栏「项目」；移除项目只取消归组。删除任务不删除自选目录或专家文件夹；文档解析只写 `.parsed/`，不改上传原件。

`DATA_DIR` 未设置时相对**服务端进程工作目录**解析。根目录执行 `pnpm dev:server` 会在 `apps/server` 运行，因此默认数据是 `apps/server/data/`，不是仓库根 `data/`。安装包和容器有各自的数据目录，详见运行手册。

## 仓库结构

```text
apps/server/       Fastify API、Pi 执行器、SQLite、平台插件
apps/desktop/      Electron 主进程 + Vue 3 控制台
apps/website/      官网与下载元数据
packages/shared/   前后端共享契约
pi-packages/       随产品分发的 Pi 扩展包
skills-catalog/    平台技能市场
agent-packs/       专家包及其私有技能
skin-packs/        CSS 皮肤包、开发和市场文档
docs/              当前架构、运行手册、接口说明、交接与 ADR
```

## 检查与交付

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack:win      # 在 Windows 上执行；另有 pack:mac / pack:linux
```

`pnpm test` 由 `apps/server/scripts/run-tests.mjs` 逐文件运行服务端 `src/*.test.ts`，遇失败退出；不包含嵌套目录中的测试。CI 配置见 [.github/workflows/checks.yml](.github/workflows/checks.yml)。桌面打包输出在 `apps/desktop/release/`，舞台目录为 `dist/stage/`。完整发布流程见 [官网与发布](apps/website/muniu-liuma/DEPLOY.md)。本次本机 Electron 启动故障和验证边界见 [交接状态](docs/handoff.md)。

## 文档入口

- [文档索引](docs/README.md)：按使用、开发和运维职责查阅。
- [当前架构](docs/design.md)：执行链路、数据归属和扩展边界。
- [运行手册](docs/runbook.md)：环境变量、启动、备份和排障。
- [插件、记忆与皮肤接口](docs/integration-guide.md)：请求格式、权限与错误码。
- [领域术语](CONTEXT.md)、[开发边界](AGENTS.md)、[架构决策](docs/adr/)、[更新日志](CHANGELOG.md)。
