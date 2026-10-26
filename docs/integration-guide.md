# 插件、记忆与皮肤接口

核对日期：2026-10-26。本文覆盖本批新增的产品接口；任务/模型等完整契约参阅 `packages/shared/src/index.ts` 和 `apps/server/src/routes/`。架构与路由归属见 [当前架构](design.md)。

## 认证与通用规则

API 默认 `http://127.0.0.1:38617`。除特殊资源直连外，以下接口都要求企业知识库用户登录获得的本应用 JWT：`Authorization: Bearer <token>`。令牌默认 7 天过期；`GET /auth/captcha` 只负责验证码，不是免认证登录通道。

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数或皮肤格式无效 |
| 401 | 未登录或本应用令牌失效 |
| 403 | 非管理员操作管理员入口，或无权访问对应任务 |
| 404 | 对象不存在；插件启停失败当前也可能返回 404，需结合日志判断 |
| 409 | 内置皮肤保护、包 id 冲突等 |
| 502 | 市场上游请求/安装失败 |
| 503 | 所属插件停用或未启动 |

## 平台插件

| 方法与路径 | 权限 | 请求/响应 |
| --- | --- | --- |
| `GET /plugins` | 登录用户 | `{ plugins: [{ id, version, name, description, enabled, status }] }` |
| `PATCH /admin/plugins/:id` | 管理员 | JSON `{ "enabled": false }`；成功返回 `{ ok: true, plugins }` |

`status` 为 `started` 或 `stopped`；`enabled=true` 但 `status=stopped` 可表示启动失败。没有插件代码上传或第三方模块安装 API。状态变更对整个服务实例生效，已有会话的工具不会统一重建。

## 长期记忆

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /memory?limit=50` | limit 默认 50，限制在 1–200 | `{ memories: [...] }`，包含来源任务标题（如有） |
| `POST /memory` | JSON，必填非空 `content`；可选 `kind/confidence/metadata` | 201，新增或完全相同内容去重后的记忆对象 |
| `DELETE /memory/:id` | 无请求体 | `{ ok: true }`；不属于当前用户或不存在返回 404 |

类型为 `preference / fact / experience / observation`；未识别类型默认 `fact`。内容会裁至 12,000 字符；`confidence` 保存为 0–1。用户身份强制来自令牌，传入 `userId` 不能改归属；手动接口不接收任意 `sourceTaskId`。记忆对象含 id、用户、内容、类型、置信度、元数据和创建/更新时间。

PowerShell 示例，使用当前用户自己的令牌：

```powershell
$chengHeaders = @{ Authorization = 'Bearer <当前用户令牌>' }
$chengBody = @{ content = '汇报先写结论，再写依据'; kind = 'preference' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:38617/memory -Method Post -Headers $chengHeaders -ContentType 'application/json; charset=utf-8' -Body $chengBody
Invoke-RestMethod http://127.0.0.1:38617/memory -Headers $chengHeaders
```

召回按当前用户关键词相关性筛选，最多注入 8 条参考。自动沉淀默认关闭，只有服务端 `MEMORY_AUTO_CAPTURE=1` 且任务轮次成功时才保存限长回复摘要；不代表已做稳定事实抽取。删除来源任务时，启用中的记忆插件会软删除相关记忆。停用记忆插件后 CRUD 返回 503，任务仍可执行。

## 皮肤管理通道

| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| `GET /skins` | 返回 `{ skinDir, skins, broken }`；坏包单列 | 登录用户；多用户模式 `skinDir=null` |
| `GET /skins/:id/file?path=skin.css` | 包内样式、图片和字体文件 | Bearer 或 `?token=<JWT>` |
| `POST /skins` | multipart zip 安装 | 单机登录用户；多用户模式管理员 |
| `DELETE /skins/:id` | 删除非内置包 | 同上；内置包返回 409 |
| `POST /skins/install-from-workspace` | JSON `{ taskId, path: "skin-pack" }`，安装任务工作区内成品 | 同上，并检查任务访问权限 |
| `GET /skins/:id/export` | 导出 zip | 登录用户 |

包格式为 `skin.json + skin.css + assets/`，id 必须与目录一致。相同 id 的用户包可被更新，内置包不可覆盖。上传单文件上限 20MB，zip 解压总量上限 40MB；格式和 CSS 级联规则见 [皮肤开发](../skin-packs/README.md)。CSS 子资源不能附加 Authorization 头，因此文件接口保留 query JWT；不要把包含令牌的完整 URL 写进文档或日志。

## 皮肤市场通道

市场是独立 `skin-market` 平台插件；以下操作对**全体登录用户**开放，不需要额外发布令牌；管理员可以停用插件。这里的“开放”不表示匿名访问。

| 方法与路径 | 参数/行为 |
| --- | --- |
| `GET /skins-market` | 列出本服务实例的皮肤 |
| `POST /skins-market` | multipart zip 上传，即成为实例共享皮肤 |
| `GET /skins-market/:id/download` | 下载 zip |
| `GET /skins-market/github?registry=...` | 从指定 http(s) JSON 注册表获取目录 |
| `GET /skins-market/github/install?registry=...&id=...` | 从注册表下载并安装；当前实现是有副作用的 GET，不应预取 |
| `GET /skins-market/npm/search?q=...` | npm 搜索，默认关键词 `muniu-skin` |
| `GET /skins-market/npm/install?pkg=...` | 按 `name` 或 `name@version` 下载并安装；同样不能预取 |

`SERVER_MULTI_USER=1` 只收紧皮肤管理通道，不限制上述市场上传与安装。包存于服务实例共享目录，可能影响其他使用同 id 包的用户；不需要组织共享时停用市场插件。npm 默认源由 `SKIN_NPM_REGISTRY` 控制；GitHub 注册表只是普通 HTTP JSON，可换成内网源。市场路由、管理路由、架构表和客户端入口须一起维护。
