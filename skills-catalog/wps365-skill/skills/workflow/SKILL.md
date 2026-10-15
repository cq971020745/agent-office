---
name: workflow
description: 轻审批（V7 Internal）：查询审批实例详情、批量查询审批实例、分页查询审批实例列表、查询抄送列表、查询操作记录。用户提到轻审批、审批申请、我的审批、审批记录、审批详情、审批状态、审批抄送、审批流程时使用。
---

# 轻审批 Skill

对 WPS 365 V7 **Internal** 审批实例相关接口的封装。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 子命令

- `get-instance`：查询单个审批实例详情
- `list-instances`：批量查询审批实例详情（逗号分隔 ID，最多 20 个）
- `list-instances-brief`：分页查询审批实例列表（按状态/时间/发起人筛选）
- `list-ccs`：分页查询审批抄送列表
- `list-timelines`：分页查询审批操作记录

## 决策规则

| 用户意图 | 推荐命令 |
|----------|----------|
| "读取我的轻审批申请""查看我的审批记录" | 先通过 `user-current` 获取当前用户 `user_id`，再 `list-instances-brief --promoter <user_id>` |
| 知道审批实例 ID，想看详情 | `get-instance` |
| 有多个审批实例 ID，想批量拉取 | `list-instances` |
| 想浏览我发起的/所有审批 | `list-instances-brief --promoter <user_id>` |
| 想筛选某种状态的审批（审批中/已通过等） | `list-instances-brief --instance-status auditing` |
| 想看某审批的抄送人 | `list-ccs --instance-id <id>` |
| 想看某审批的操作历史 | `list-timelines --instance-id <id>` |

## 审批实例状态

| 状态值 | 说明 |
|--------|------|
| `auditing` | 审批中 |
| `approved` | 已通过 |
| `refused` | 已拒绝 |
| `returned` | 已退回 |
| `revoked` | 已撤回 |
| `terminated` | 已终止 |

## 高风险操作

本 skill 均为只读查询，**无**写入副作用子命令，无需 `--confirm` / dry-run。

## 注意事项

- 所有接口均为 **Internal** 接口（`/v7/workflow/`），需要 `WPS_SID` 认证
- `list-instances` 批量查询最多支持 **20 个** 实例 ID
- `list-instances-brief`、`list-ccs`、`list-timelines` 分页大小范围 **10~50**
- 时间参数 `--time-from` / `--time-to` 使用 **Unix 秒时间戳**
- 详细参数说明参见 [references/command-details.md](references/command-details.md)
