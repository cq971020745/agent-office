# 澄台（CHENG）

领域术语以 [CONTEXT.md](CONTEXT.md) 为准，已确认的取舍以 [docs/adr/](docs/adr/) 为准。这里只写下次改代码时必须遵守的边界。

## 登录与权限

- 登录身份是企业知识库用户。不要恢复自助注册、本地改密或管理员重置密码。
- 本应用管理员只等于知识库角色 `superadmin`。部门管理员不是本应用管理员。
- 环境变量 `KB_BASE_URL` 默认 `http://10.50.11.17/new-general-rag-kb`。

## 模型

- `model_providers.user_id` 归属当前用户。不要做全员共用供应商，也不要把密钥复制给所有人。
- 专家不保存 `provider_id` / `model_id`。派发必须使用当前用户自己启用的供应商和模型。
- Base URL 由用户填写，拉取列表只请求 `{baseUrl}/models`。不要在代码里自动补 `/v1`。
- 对话协议由用户在供应商上选择（Chat Completions / Anthropic Messages / Responses）。不要写死 Chat Completions，也不要按协议改 Base URL。

## 企业知识库工作台

- 侧栏嵌入既有工作台（知识空间、文档、问答）。不要重做这些页面，也不要嵌入 `/system/user`。
- 知识库页面把 `Admin-Token` 放在 localStorage，所以必须由本服务代理 `/new-general-rag-kb`。
- `apps/desktop/src/renderer/index.html` 的 CSP：`frame-src` 与 `img-src` 都必须放行 API 源（否则知识库工作台空白；对话气泡里的工作区图片裂图）。

## 专家、技能与连接器

- 登录用户都可以新建和管理专家、技能。平台指令仍只有管理员可改。
- 专家包里的技能只挂在该专家的私有目录。不要把它们装进全员技能库。
- `mcp_servers.user_id` 归属当前用户。任务只注入这个用户自己启用的连接器。

## 紫金协作

- 两边都是完整 11 位手机号且不一致时，拒绝关联。空号或脱敏时仍保存用户同步来的紫金协作用户编号。
- WPS 同步遇 401/403 会话失效，走 `apps/server/src/wps-env-gate.ts` 执行内置包 wps365-env 的 `ensure --refresh` 重导后重试，重试时边车凭证必须压过进程环境。不要绕过闸门手工拼 Cookie，也不要让用户 F12 复制。取舍见 [docs/adr/0009-wps-env-gate-self-heal.md](docs/adr/0009-wps-env-gate-self-heal.md)。

## 任务工作区与项目

- `custom_workspace` 仅在用户显式选择工作目录时为 1。不要把专家常驻目录或平台隔离区标成侧栏「项目」。
- 文档解析产物只写 `.parsed/`。不要 rename / move / overwrite 用户上传原件。
- 追问切换模型走 `PATCH /tasks/:id/model` 并 `invalidateSession`；仍只用当前用户自己启用的供应商/模型。

## 桌面预览与标注

- 内嵌 `<webview>` 不要开 `allowpopups`（guest 弹窗会变成空白窗）。页面截图走主进程 `captureWebContents`。
- 对话/预览里的工作区图片走 `GET /tasks/:id/workspace/file`：按扩展名设 `image/*`，`Content-Disposition: inline`。MIME 错误或接口 500 都会让气泡 `<img>` 裂图。

## Pi 插件与对外客户端

- 澄台对外发客户端：任务用的 Pi 包必须进平台 `{DATA_DIR}/agent`（见 `apps/server/src/packages.ts`），随服务启动安装。不要依赖操作者本机 `~/.pi`。
- 仅终端 TUI 的扩展（statusbar / sidebar / pi-git-ui 等）不要当产品依赖；可见能力做进桌面（会话上下文占用、任务顶栏 Git 面板等）。
- 取舍见 [docs/adr/0008-product-shipped-pi-packages.md](docs/adr/0008-product-shipped-pi-packages.md)。
