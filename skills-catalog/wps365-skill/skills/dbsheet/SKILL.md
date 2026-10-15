---
name: dbsheet
description: 在 WPS 365 多维表中查看 Schema、列记录、按 record_id 查询记录、按 JSON 批量创建更新删除记录，以及创建或管理数据表、视图和表单元数据。用户提到多维表、DbSheet、表结构、记录增删改查、清理空记录、创建 sheet 或 view 时使用。
---

# 多维表

用这个 skill 处理三类任务：看结构、管记录、管数据表与视图。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 快速使用

```bash
python skills/dbsheet/run.py <子命令> [参数...]
# 示例：python skills/dbsheet/run.py schema <file_id>
```

## 决策规则

- 用户要先了解多维表有哪些数据表、字段、视图：
  先执行 `schema`
- 用户只知道 `file_id`，还不知道 `sheet_id`、`view_id` 或字段名：
  先执行 `schema`，不要猜
- 用户给的是多维表文件名、标题或 `.dbt` 文档名，而不是 `file_id`：
  不要在本地工作区找文件；先用 drive 能力定位对应云文档，再拿到 `file_id`
- 用户要按条件筛选记录：
  优先执行 `list-records --filter '<json>'`
- 用户要按一个或多个 `record_id` 精确读取记录：
  执行 `get-record` 或 `search-records`
- 用户要批量写入、修改、删除记录，或创建/修改/删除数据表、视图、表单元数据：
  **先不带 `--confirm` 执行 dry-run** → 通过 `askUserQuestion` 确认 → 再加 `--confirm` 重跑。每次新操作独立确认，不复用之前的确认。仅当用户在本条请求里说了"直接创建""直接执行""无需确认"等才可跳过。批量写入通过 `--json` 传结构化数据
- 用户要写入联系人、单选、多选等复杂字段：
  先执行 `schema`，必要时再读取一条已有记录作为样例；不要先怀疑编码
- 用户明确要按字段 ID 而不是字段名读写：
  使用 `--prefer-id`，并保证 payload key 与 schema 中的 field_id 一致
- 用户新建了 `.dbt` 后发现前面有很多空行：
  先执行 `delete-empty-records`，再继续创建记录
- 用户要新建数据表或视图：
  用 `create-sheet` 或 `create-view`
- 用户要求的字段名、视图 id、记录 id 不明确：
  先补齐上下文，不要凭空构造

## 子命令分组


### 结构

- `schema`：查看数据表、字段、视图结构
- `get-form-meta`：查看表单视图元数据
- `update-form-meta`：更新表单视图名称或描述

### 记录

- `list-records`：列记录，可带 `--filter`
- `get-record`：查单条记录
- `search-records`：按一个或多个 `record_id` 批量查询记录（**不是**条件筛选）
- `create-records`：批量创建记录
- `update-records`：批量更新记录
- `delete-records`：批量删除记录
- `delete-empty-records`：清理空记录

### 数据表与视图

- `create-sheet`：创建数据表
- `update-sheet`：修改数据表名
- `delete-sheet`：删除数据表
- `create-view`：创建视图

## 高风险操作

- `create-records`
- `update-records`
- `delete-records`
- `create-sheet`
- `update-sheet`
- `delete-sheet`
- `create-view`
- `update-form-meta`
- `delete-empty-records`

这些命令默认都是 dry-run（不带 `--confirm`）。

### 默认行为：dry-run + askUserQuestion 确认

1. 先执行不带 `--confirm` 的 dry-run，输出预览
2. 通过 `askUserQuestion` 向用户确认**本次操作**（选项如"确认执行""取消"）
3. 确认后，再追加 `--confirm` 重新执行
4. 不能因为预览结果正常，就自动补跑 `--confirm`
5. 每次新的变更操作都必须重新走此流程；之前操作的确认不能复用到下一次操作

### 跳过确认

当用户在**当前请求**中使用了明确的跳过意图表达时，可直接带 `--confirm` 执行，跳过 dry-run：

- "直接创建" "直接删除" "直接执行" "无需确认" "不用确认"

注意：之前对话中的笼统授权（如"以后都不用确认"）不适用于后续新的高风险操作，每次仍需在当前请求中明确表达。

## 关键约束

- `search-records` 是按 `record_id` 检索，不是条件筛选
- 条件筛选应使用 `list-records --filter '<json>'`
- `create-records` 与 `update-records` 的 `--json` 必须是合法 JSON
- 复杂字段不要先猜 payload；优先参考 schema 和同表已有记录的返回结构
- `--prefer-id` 打开后，字段 key 应改为 field_id，不能继续混用字段名
- DbSheet 的 `<file_id>` 指的是云文档 file_id，不是本地文件路径，也不是 `.dbt` 文件名
- 字段名必须与实际 schema 完全匹配，区分大小写
- `update-records` 每项记录都需要带 `id`
- 新建 `.dbt` 常会带预置空记录；如果想让新记录显示在前排，先执行 `delete-empty-records`

需要命令示例、`--filter` JSON 格式或字段值写法时，查看 [references/command-details.md](references/command-details.md) 与 [references/payload-details.md](references/payload-details.md)。

## 输出格式

先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`，便于继续提取 `sheet_id`、`view_id`、`record_id`、`page_token`、字段结构等信息。

## 注意事项

- 用户没有对本次操作给出明确确认或跳过意图时，不要对 `create-records`、`update-records`、`delete-records`、`create-sheet`、`update-sheet`、`delete-sheet`、`create-view`、`update-form-meta`、`delete-empty-records` 追加 `--confirm`
- 先看 schema 再写记录，能减少字段名和字段类型错误
- 字段值复杂时，优先把 JSON 准备完整后再传给 `--json`
- 如果用户只给了文件名，例如 `值班表（试行）.dbt`，先解析云文档 `file_id`，不要在当前仓库中查找同名本地文件
- 只有在需要命令示例、筛选 JSON 或写入 payload 细节时，才继续读取 [references/command-details.md](references/command-details.md) 与 [references/payload-details.md](references/payload-details.md)
