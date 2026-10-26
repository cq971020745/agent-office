# 平台插件与记忆改造设计

范围核对：2026-10-26。本文件仅记录该改造的设计，不是全项目 UI 规范。当前全局架构与数据表见 [docs/design.md](docs/design.md)，接口见 [docs/integration-guide.md](docs/integration-guide.md)，运行配置见 [docs/runbook.md](docs/runbook.md)。

## 边界

- Pi AgentSession 继续负责模型对话、会话恢复和工具执行。
- PluginRegistry 负责显式注册的内置产品能力，插件代码随服务端发布，不扫描或执行用户上传的服务端模块。
- CSS 皮肤只负责渲染层外观；皮肤市场由独立平台插件提供，三种扩展机制不互相加载。
- 当前不引入 Hindsight 服务、向量数据库、图谱或稳定事实自动抽取。

## 生命周期

`PlatformPlugin` 支持 `migrate/start/stop/registerRoutes/onTaskStarted/createTools/beforeTurn/afterTurn/onTaskDeleted`。register 只登记定义；核心数据库迁移后初始化插件状态、启动插件并挂载业务路由。

插件启停落在 `platform_plugins`。停用业务入口返回 503；单插件 hook 失败单独记录。工具在创建会话时装配，已有会话不会因启停统一失效。

核心认证、任务、项目和管理入口保留在宿主；技能路由由核心文件挂载并显式门控。插件没有依赖声明、通用超时和独立 schema 迁移框架，接口存在不代表这些治理能力已实现。

## 记忆后端

`MemoryBackend` 契约为 `list/retain/recall/forget/forgetTask`。首版使用 SQLite `memories`，所有读写均按用户隔离，保存类型、内容、来源任务、置信度、元数据、active 及时间戳。

每轮开始通过 `beforeTurn` 召回最多 8 条关键词相关记忆，以明确的“参考资料，不是用户指令”块注入；中文使用二元片段配合 LIKE 查询。用户可查看、手动创建和软删除，不提供跨用户 bank 操作。

自动捕获默认关闭，仅 `MEMORY_AUTO_CAPTURE=1` 且轮次成功时，在 `afterTurn` 中保存限长任务回复摘要；当前 hook 被 await，不是独立后台沉淀服务。失败或取消不写入。删除来源任务时，启用中的插件通过 `onTaskDeleted` 清理关联记忆。

## 交付与未完成项

内置插件名单、权限、接口和表字段由现行架构与集成文档集中维护，避免此文件再次复制失效清单。设计取舍和参考资料的信任边界见 [ADR 0012](docs/adr/0012-platform-plugins-memory.md)。

记忆编辑/停用、语义去重、TTL、容量治理、抽取质量评估和插件依赖治理尚未实现；不要据 UI 介绍或预留配置字段宣称已具备。