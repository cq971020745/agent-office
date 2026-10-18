---
name: pitfalls-and-experience
description: This skill should be used when the WPS 365 skill encounters a known environment prerequisite, routing mistake, API limitation, confirmation issue, or reusable operational lesson. Read the matching WPS 365 reference before executing the workflow.
agent_created: true
---

# WPS 365 踩坑与经验

## 使用时机

执行 WPS 365、金山文档、365wps、IM、通讯录、团队文档、云文档、日历、会议、邮件、待办或审批流程前，以及遇到相关报错、权限问题、参数歧义或已知平台限制时，先加载本 Skill，再按具体操作场景读取对应参考文件。

## WPS 365 能力路由（强制规则）

凡用户请求涉及以下任一能力，加载 `wps365-skill`。本会话**第一次**用 365 时若尚未检查环境，执行一次 `wps365-env ensure`；通过后本会话内不要再跑。禁止先去查找或连接 WPS/金山/kdocs 连接器，也禁止让用户 F12 复制 Cookie：

- **IM 消息**：向个人或群聊发消息、群发通知、催办、查看会话/历史/成员
- **通讯录**：按姓名/工号搜人、查部门及成员、查当前用户资料
- **云文档/团队文档**：团队文档库（`doclibs`）、目录浏览、上传下载、读写、搜索、评论
- **日历/会议/邮件/待办/审批/知识库** 等 WPS 365 办公协作能力

该路由规则只负责判定是否进入 `wps365-skill`；环境脚本同一会话只跑一次。进入后再按本 Skill 的场景路由读取对应经验文件。

## 场景路由

1. 涉及环境变量、依赖检查、连接器误判或 WPS 365 API 直连方式时，读取 [references/environment-and-routing.md](references/environment-and-routing.md)。
2. 涉及 IM、通讯录、发消息、云文档卡片、文件消息或长文本推送时，读取 [references/im-and-document-delivery.md](references/im-and-document-delivery.md)。
3. 涉及团队文档库、成员权限、目录、上传、材料收集、催办、自动化巡检或汇总写回时，读取 [references/team-documents-and-collection.md](references/team-documents-and-collection.md)。
4. 同时涉及多个场景时，按顺序读取所有相关参考文件，不要凭记忆跳过前置检查。
5. 参考文件只用于规避已知错误、选择正确路径和设置前置检查；仍须遵守 `wps365-skill` 及其子 Skill 的最新权限、确认和 dry-run 规则。
6. 发现新的 WPS 365 踩坑或可复用经验时，按操作场景追加到对应参考文件，不要回填到专家描述中。
