# 文档索引

核对日期：2026-10-26。初次接手先读仓库 [README](../README.md)，再按职责查阅：

| 需求 | 文档 |
| --- | --- |
| 启动、部署、环境变量、备份和排障 | [运行手册](runbook.md) |
| 执行架构、资源归属、数据表和插件边界 | [当前架构](design.md) |
| 插件启停、记忆和皮肤 API 接入 | [集成说明](integration-guide.md) |
| 已完成、验证结果、已知限制和交接 | [交接状态](handoff.md) |
| 0.1.5 云端部署入口、目录与回滚 | [部署记录](deployment-0.1.5.md) |
| 候选功能与 UI 改进，尚未承诺实施 | [产品与 UI 待办](product-roadmap.md) |
| 领域用语、AI 改代码必须遵守的规则 | [CONTEXT](../CONTEXT.md)、[AGENTS](../AGENTS.md) |
| 迭代历史与架构取舍 | [CHANGELOG](../CHANGELOG.md)、[ADR](adr/) |
| 插件与记忆本轮需求、设计范围 | [REQUIREMENT](../REQUIREMENT.md)、[DESIGN](../DESIGN.md) |
| 皮肤开发、分享、注册表生成 | [皮肤包](../skin-packs/README.md)、[GitHub 市场](../skin-packs/github-market/README.md) |
| 内置 Pi 扩展机制 | [office-suite](../pi-packages/office-suite/README.md) |
| 官网、安装包与发布流程 | [官网部署](../apps/website/muniu-liuma/DEPLOY.md) |

## 历史评审

- [2026-10-14 专家、技能与 MCP 评审](review-2026-10-14-experts-skills-mcp.md)：当日问题与路线的快照，已落地能力以当前架构和 CHANGELOG 为准。
- [2026-10-23 架构评审](review-2026-10-23-architecture.md)：保留原始证据和当日复核；其中“未修”不表示 2026-10-26 仍未修，当前状态见交接文档。

根目录 `DESIGN.md` 只描述平台插件与记忆改造，不是全项目 UI 规范。历史评审不作为新任务的现状清单；新增事实应修改现行文档对应条目，避免连续追加状态注记。
