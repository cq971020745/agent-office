# @office/pi-office-suite

AI 办公平台内置的 pi 插件包（pi package）。随服务端启动自动安装到平台数据目录的
`agent/packages/office-suite/`，由 pi 的 `DefaultResourceLoader` 在每个任务会话中加载。

## 内容

| 类型 | 资源 | 作用 |
| --- | --- | --- |
| 扩展 | `extensions/todo-list.ts` | `todo` 工具：专家接到多步骤请求时先拆解清单、逐步勾选；状态存于工具结果 details，跨轮次与会话分支自动重建 |
| 扩展 | `extensions/write-guard.ts` | 写操作护栏：拦截 `workspace_write` 覆盖 `.env`/`.git`/`node_modules`，拦截 `run_code` 中的破坏性脚本（递归删根目录、fork 炸弹、格式化磁盘等），自动拒绝并说明原因 |

原 `prompts/` 下的 /周报、/会议纪要、/邮件润色 提示词模板已迁移为平台技能
（服务端 skills.ts 首次启动时播种，带 argument-hint，`/技能名 参数` 由服务端展开），
pi 包不再携带 prompts。

## 机制

- 包是标准的 pi local package：`package.json` 以 `pi` 键声明资源路径，`keywords` 含
  `pi-package`；扩展可 import pi 提供的 `@earendil-works/pi-ai`、`typebox` 等运行时
  （peerDependencies 声明为 `*`，由 pi 注入，不随包打包）。
- 安装由服务端 `apps/server/src/packages.ts` 完成：把本目录同步到
  `{DATA_DIR}/agent/packages/office-suite/`（内容差异检测，幂等），并把
  `{ source: "./packages/office-suite" }` 写入 `{DATA_DIR}/agent/settings.json`
  的 `packages` 数组——等价于 `pi install ./local-package` 写入的全局声明。
- 相对路径 `./packages/office-suite` 相对 settings.json 所在目录解析，数据目录整体
  迁移时声明依然有效。
