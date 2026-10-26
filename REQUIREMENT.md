# 平台插件化与记忆系统改造

范围核对：2026-10-26。此文件是该改造的需求记录；全项目当前状态见 [docs/design.md](docs/design.md)，运行与交接见 [docs/handoff.md](docs/handoff.md)。

## Goals

- 将产品能力以木牛流马平台插件形式管理，插件由服务端加载，不依赖用户安装 Pi CLI。
- 保留 Pi 作为嵌入式 Agent Runtime，插件通过平台接口和 Pi 适配层接入。
- 增加可替换的长期记忆后端，第一版提供本地 SQLite 实现。
- 在任务轮次开始前召回相关记忆；显式启用自动捕获后，在成功轮次结束的 hook 中保存限长经验摘要，不承诺自动提取稳定事实或独立后台作业。
- 提供用户可查看、删除记忆的接口，并保证记忆按用户隔离。

## Scope

### In scope

- `PlatformPlugin`、`PluginRegistry` 和插件生命周期接口。
- 插件启停状态持久化，服务启动时只加载项目内置插件。
- `memory` 插件及 `MemoryBackend` 抽象。
- SQLite 记忆存储、关键词召回、来源任务关联和删除。
- Runner 的 recall/retain 生命周期接入。
- 用户记忆查询、创建、删除 API。

### Out of scope

- 本次不引入 Hindsight 服务、PostgreSQL 或外部 Pi CLI。
- 本次不做自动 LLM 事实抽取、图谱和 mental model；后端接口预留扩展。
- 本次不重写现有 Pi 包和所有业务模块，只建立迁移边界。

## User Stories

- 用户在新任务中可以获得自己过往任务中沉淀的相关经验。
- 用户可以查看和删除自己的长期记忆。
- 插件不可用时任务仍可运行，记忆能力降级为空实现。
- 管理员可以启用或停用平台插件。
- 后续可在不改 Runner 和前端契约的情况下替换为 Hindsight 后端。

## Edge Cases & Constraints

- 记忆必须以 `user_id` 隔离，不能通过可猜测的 bank id 绕过权限。
- 失败、取消或未完成任务不自动沉淀长期记忆。
- 自动沉淀默认关闭，只有 `MEMORY_AUTO_CAPTURE=1` 才开启；记忆注入必须标为参考资料，不能变成更高优先级指令。
- 记忆召回失败不能阻断任务执行。
- 自动沉淀内容必须限长，并保存 `source_task_id`。
- 插件启动、迁移和停止失败要单独记录，不能阻断其他插件。
- 运行时不修改用户全局 npm、Pi CLI 或 `~/.pi`。
