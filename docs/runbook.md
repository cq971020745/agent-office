# 运行与运维手册

核对日期：2026-10-26。包管理器版本、脚本和依赖以仓库 `package.json` 为准。

本项目已新增独立的云端业务服务部署，实际入口、systemd 服务、nginx 路由和数据目录见 [0.1.5 部署记录](deployment-0.1.5.md)。官网与业务控制台不是同一页面。

## 本地开发与网页入口

在仓库根执行 `pnpm install --frozen-lockfile`。终端一运行 `pnpm dev:server`；终端二运行 `pnpm dev:desktop`。API 为 `http://127.0.0.1:38617`，开发渲染层为 `http://localhost:38618`。不要启动多个服务进程共用同一数据目录；看到 EADDRINUSE 时先确认占用者是否为本项目。

不启动 Electron 的网页方式：

```bash
pnpm --filter @office/desktop build
pnpm dev:server
```

构建成功后再启动或重启服务端，然后打开 `http://127.0.0.1:38617/`。服务端从工作目录相对路径 `../desktop/out/renderer` 托管页面；自定义启动目录时设置绝对 `WEB_DIST`。`38618` 是开发服务器地址，不能作为构建产物入口。

PowerShell API 冒烟：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:38617/auth/captcha
```

返回 200 仅证明验证码入口可用，不等于企业知识库登录、模型和外部连接器全部可用。模型调试可运行 `node scripts/mock-openai.mjs`，在个人模型供应商中填 `http://127.0.0.1:9990/v1` 并启用 `mock-model`；企业知识库登录仍需真实可达的企业服务。`scripts/smoke.mjs` 保留的是历史 HTTP 冒烟脚本，使用前需核对与当前企业知识库认证流程的兼容性，不作为当前发布已通过的证据。

## 数据目录与配置

| 运行方式 | 数据位置 |
| --- | --- |
| 根目录运行 `pnpm dev:server` | 默认 `apps/server/data/`，因为 workspace 脚本工作目录在 `apps/server` |
| 根目录直接 `node apps/server/dist/index.js` | 默认仓库根 `data/`；需另设 `WEB_DIST` 和资源路径 |
| 桌面一体包本地模式 | Electron `app.getPath('userData')` 下的 `data/`，由主进程传入 |
| 桌面远程模式 | 数据在所连接的远程服务端，不在客户端迁移 |
| 默认 Compose | 容器 `/app/data` 映射仓库根 `./data` |

不要凭产品展示名猜测用户数据路径；旧产品的应用标识可能继续沿用。迁移前确认服务进程的实际 `DATA_DIR`，不要把两份同名 `app.db` 混用。

| 环境变量 | 默认/用途 |
| --- | --- |
| `PORT` | `38617`；API 监听端口，客户端地址和 CSP 须同步 |
| `HOST` | `127.0.0.1`；LAN/容器需要显式 `0.0.0.0` |
| `DATA_DIR` | 工作目录下 `data`；建议部署时设绝对路径 |
| `JWT_SECRET` | 开发默认值仅用于本机开发；部署设固定强随机值；更换后旧令牌失效 |
| `KB_BASE_URL` | `http://10.50.11.17/new-general-rag-kb`；企业知识库登录和工作台上游 |
| `SERVER_MULTI_USER` | 未设置为单机模式；`1` 时皮肤管理写入口限管理员，隐藏皮肤绝对目录 |
| `MEMORY_AUTO_CAPTURE` | 默认关闭；`1` 时成功任务轮次可自动沉淀限长经验摘要 |
| `SKIN_PACKS_DIR` | 内置皮肤源目录；未设置不自动同步示例包，桌面安装包自动传入 |
| `SKIN_NPM_REGISTRY` | `https://registry.npmmirror.com`；皮肤 npm 市场源 |
| `WEB_DIST` | 默认 `../desktop/out/renderer`，相对服务端工作目录 |
| `PI_PACKAGES_DIR`、`SKILLS_CATALOG_DIR`、`AGENT_PACKS_DIR` | 产品资源根目录；桌面一体包自动传入，源码开发有查找逻辑 |
| `PI_CODING_AGENT_DIR` | 未指定时绑定 `{DATA_DIR}/agent`；部署不要指向操作者 `~/.pi` |
| `WPS_PYTHON` | WPS 闸门/脚本的 Python；安装包有内置解释器时自动传入 |
| `OCR_ENGINE`、`OCR_MODEL`、`TEXT_IN_API_KEY` | OCR 引擎、语言/模型和 TextIn 凭证；任务运行时配置由用户供应商生成 |

JWT 默认 7 天过期，401 后重新登录。自动记忆是否启用以服务端环境为准；当前页面文案尚未反映开关，不应仅凭介绍判断已开启。

## 容器部署

```powershell
$env:JWT_SECRET = '<设置为部署专用强随机值>'
docker compose up -d --build
```

Compose 使用仓库根构建上下文和 `apps/server/Dockerfile`，显式设 `HOST=0.0.0.0`。企业知识库地址可通过部署配置加入容器环境。共享服务还应设置 `SERVER_MULTI_USER=1`；当前 Compose 不自动开启它。

当前 Dockerfile 仅构建服务端和共享包，未包含桌面渲染产物、`pi-packages/`、`skills-catalog/`、`agent-packs/` 和 `skin-packs/`。不要把默认镜像当作完整客户端交付；需要这些能力时补充镜像资源或只读挂载，并设置对应绝对路径。桌面一体包的资源由 `scripts/stage-server.mjs` 和 electron-builder 的 `extraResources` 分发，不与容器镜像混同。

## 插件与皮肤运维

- 管理员在「平台插件」启停；配置持久化在 `platform_plugins`。停用的插件入口返回 503，但已缓存会话的工具不保证立即撤销，验证时新建任务。
- `scheduler` 停用会停止调度器；`knowledge-base` 停用会停止续期；`mcp` 停用会关闭连接器客户端。
- `pi-packages` 停用仅移除平台管理的包声明；重新启用会重新登记安装，不应手工删除整个 `agent/`。
- 皮肤的选用偏好在客户端，包在服务端 `skins/`；停用 `skin-market` 只关闭市场，已有皮肤仍可读取和切换。
- 本服务器市场向全体登录用户开放上传与下载；`SERVER_MULTI_USER=1` 不关闭市场。组织不希望开放分享时由管理员停用市场插件。

## 备份与恢复

1. 等待运行中任务结束，正常退出本地服务或停止容器；远程模式操作远程服务，避免只关客户端。
2. 备份有效 `DATA_DIR` 整体，包括 SQLite、会话、专家目录、平台技能/包配置和皮肤；自选工作区在数据目录外，需要单独备份。
3. 恢复到目标路径并设置 `DATA_DIR`，保持原部署 `JWT_SECRET`；启动后检查登录、历史任务、文件预览、插件和模型配置。

SQLite 使用 WAL，运行中仅复制 `app.db` 可能漏掉事务；在线备份需使用一致性快照方案。备份含模型密钥、MCP 配置和完整任务内容，不能提交到 Git。

## 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| 端口已占用 | 确认 38617/38618 的占用进程，只复用或停止已确认属于本项目的实例 |
| API 正常、网页 404 | 确认构建产物和 `WEB_DIST`，构建后重启服务 |
| 本机 Electron 异常退出 | 2026-10-26 在 Windows 本机观察到 `EXCEPTION_BREAKPOINT`（退出码 2147483651）；未定位根因，关闭 GPU 仍复现。可先用构建后的 Web 控制台；不能据此认定所有平台或安装包均失败 |
| 知识库登录/工作台不可用 | 检查企业网络、`KB_BASE_URL`、对应插件、CSP 的 API 源；不重做或绕过企业知识库认证 |
| WPS 同步 401/403 | 先登录本机紫金协作，再由同步入口触发 `wps-env-gate` 自愈；不手拼 Cookie |
| 插件入口 503 | 查插件 enabled 与 started 状态，检查服务端 `[plugin:<id>]` 日志 |
| 自动记忆没有增加 | 确认 `memory` 已启用、`MEMORY_AUTO_CAPTURE=1`、任务轮次成功并有足够回复内容 |
| 换肤缺纹理/字体 | 检查包相对路径、文件 MIME、登录令牌与 CSP；损坏皮肤会回退默认 |

本地一体包在 Windows/Linux 关闭最后一个窗口会退出并停止内置服务；没有托盘常驻。开发模式的独立服务端与远程模式不随桌面窗口退出，不能混用这两种行为解释。
