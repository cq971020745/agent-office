---
name: todo
description: WPS 365 个人待办管理，支持列出、查看、创建、更新、完成、恢复和删除个人待办任务。用户提到待办、todo、任务清单、截止时间、完成任务，或需要继续提取 `task_id`、`next_offset/page_token` 时使用。
---

# 个人待办·Todo
用这个 skill 管理个人待办，并在后续步骤里继续提取 `task_id`、分页标识等上下文。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 快速使用

```bash
python skills/todo/run.py <子命令> [参数...]
```

## 决策规则

- 用户要看当前有哪些待办，或只知道模糊条件还没有 `task_id`：
  先用 `list`
- 用户已经有 `task_id`，想看标题、描述、截止时间或状态：
  用 `get`
- 用户要创建、更新、完成、恢复或删除待办：
  **先不带 `--confirm` 执行 dry-run** → 通过 `askUserQuestion` 确认 → 再加 `--confirm` 重跑。每次新操作独立确认，不复用之前的确认。仅当用户在本条请求里说了"直接创建""直接删除""无需确认"等才可跳过

## 子命令



- `list` 获取个人待办列表
  场景参数：`--status/-s`（`todo|finish`）、`--page-size`、`--page-token`，位置参数 : 无
- `get` 获取单个待办详情
  位置参数 : `task_id`
- `create` 创建待办
  场景参数：`--desc/-d`、`--due`、`--status/-s`（`todo|finish`）、`--confirm`，位置参数 : `title`
- `update` 更新标题、描述、截止时间
  场景参数：`--title`、`--desc`、`--due`、`--confirm`，位置参数 : `task_id`
- `done` 标记已完成
  场景参数：`--confirm`，位置参数 : `task_id`
- `undone` 恢复为未完成
  场景参数：`--confirm`，位置参数 : `task_id`
- `delete` 删除待办
  场景参数：`--confirm`，位置参数 : `task_id`

## 高风险操作

- `create`
- `update`
- `done`
- `undone`
- `delete`

这些命令默认都是 dry-run（不带 `--confirm`）。

### 默认行为：dry-run + askUserQuestion 确认

1. 先执行不带 `--confirm` 的 dry-run，输出预览
2. 通过 `askUserQuestion` 向用户确认**本次操作**（选项如"确认执行""取消"）
3. 确认后，再追加 `--confirm` 重新执行
4. 不能因为预览结果正常，就自动补跑 `--confirm`

### 跳过确认

当用户在**当前请求**中使用了明确的跳过意图表达时，可直接带 `--confirm` 执行，跳过 dry-run：

- "直接创建" "直接删除" "直接执行" "无需确认" "不用确认"

注意：之前对话中的笼统授权（如"以后都不用确认"）不适用于后续新的高风险操作，每次仍需在当前请求中明确表达。

## 关键约束

- `task_id` 是远端待办对象标识；没有时不要猜，先用 `list`
- `list` 的状态筛选只接受 `todo` 或 `finish`
- `create` 的 `--status` 只接受 `todo` 或 `finish`；默认 `todo`
- `update` 至少要传 `--title`、`--desc`、`--due` 之一，否则命令会报错
- `--due` 支持 ISO 8601、`YYYY-MM-DD`、`YYYY/MM/DD`、`MM-DD`、`MM/DD`，也支持 `today`、`tomorrow`、`next week` 以及 `今天`、`明天`、`下周`
- 无时区的完整时间会按本地解析；若需要跨时区准确性，优先传带时区的 ISO 8601
- `update` 当前只支持更新字段，不支持显式清空描述或截止时间
- 需要确认最新参数细节时，以 `python skills/todo/run.py <子命令> -h` 为准

## 输出格式

先输出 Markdown 摘要，再输出完整 JSON（`## 原始数据 (JSON)`）。

需要确认最新参数细节时，以 `python skills/todo/run.py <子命令> -h` 为准。

## 示例

```bash
# 查看待办列表
python skills/todo/run.py list

# 只看未完成的
python skills/todo/run.py list --status todo

# 创建待办
python skills/todo/run.py create "完成周报" --due "2026-03-10" --desc "本周工作总结"

# 标记完成
python skills/todo/run.py done abc123

# 更新待办
python skills/todo/run.py update abc123 --title "新标题" --due "2026-03-15"
```

## 注意事项

- 用户没有对本次操作给出明确确认或跳过意图时，不要对 `create`、`update`、`done`、`undone`、`delete` 追加 `--confirm`
- 需要定位单条待办但 `list` 命中多条时，须通过 `askUserQuestion` 让用户选择，不得自行挑选

## 错误处理

- 缺少 `WPS_SID`：请先设置环境变量后重试
- 401/403：凭证无效或权限不足
- 404：待办不存在
