---
name: calendar
description: 管理 WPS 365 日历与日程，支持列出、查看、创建、修改、删除日历和日程、查询指定时间段用户或者会议室的忙闲状态，以及预约会议室。用户提到日历、日程、排期、邀请同事开会、预约会议室、修改日程参与者或按时间范围查事项时使用。注意：当用户说"帮我约下xxx"、"邀请xxx参加"、"安排一个会议"、"约个会议室"等涉及约人开会的场景时，务必使用此技能。
---

# 日历与日程

用这个 skill 处理六类任务：管理日历、管理日程、管理参与者、管理会议室、查询忙闲、管理日历权限。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 快速使用

```bash
python skills/calendar/run.py <子命令> [参数...]
```

## 决策规则

- 用户要找自己的日历或确认 `calendar_id`：
  先执行 `list-calendars`
- 用户只说“我的主日历”“默认日历”：
  优先使用 `primary` 作为 `calendar_id`
- 用户要看某段时间内的事项：
  执行 `list-events`
- 用户要查某个人或会议室什么时候有空：
  执行 `free-busy`
- 用户要创建/修改/删除日历或日程：
  **先不带 `--confirm` 执行 dry-run** → 通过 `askUserQuestion` 确认 → 再加 `--confirm` 重跑。每次新操作独立确认，不复用之前的确认。仅当用户在本条请求里说了"直接执行""无需确认"等才可跳过
- 用户提到"每天""每周""每月""重复"等重复需求：
  **在 `create-event` 时一并传 `--recurrence`**，不要先创建再用 `update-event` 补充。同理 `--reminders`、`--visibility` 等也应在创建时一并传入
- 用户想约人开会或安排多人会议（涉及「邀请参会人 + 预订会议室/安排时间」的组合需求）：
  走「邀人约会」工作流（见下方 → 工作流 → 场景 1）
- 用户只想为已有日程预订会议室（不涉及参会人忙闲协调）：
  走「预订会议室」工作流（见下方 → 工作流 → 场景 2）
- 用户要查看日程参与者列表：
  执行 `list-event-attendees`
- 用户要添加日程参与者：
  执行 `add-event-attendees`
- 用户要移除参与者但只有用户信息、没有参与者 id：
  先执行 `list-event-attendees`，从返回的 `items` 中取参与者 id，再执行 `delete-event-attendees`
- 用户要查看/预订/取消日程会议室：
  使用 `list-event-rooms`、`add-event-rooms`、`delete-event-rooms`
- 用户要浏览会议室目录或查找特定区域的会议室：
  使用 `list-room-levels` + `list-rooms` 逐级定位
- 用户要管理日历权限（共享日历）：
  使用 `list-permissions`、`create-permission`、`delete-permission`

## 工作流

开始任务之前，请先查看是否命中以下场景，倘若命中请**必须先读取 [references/workflows.md](references/workflows.md)**，然后严格按照其中的步骤执行。

### 场景 1：邀人约会

邀请用户参加线上/线下会议。匹配以下任一场景：
- 帮我约下xxx、xxx等在某某地点开个xxx主题的会
- 帮我约个会议室，邀请xxx参加讨论xxx
- 安排一个讨论xxx的会议，参会人有xxx
- 找个大家都有空的时间开个会

只要涉及「邀请参会人 + 预订会议室/安排时间」的组合需求，都应走此流程。

> 命中此场景后，**必须立即读取** [references/workflows.md](references/workflows.md) 中的「场景 1：邀人约会」并严格遵守全部 4 个阶段。不得跳过读取、不得凭记忆执行。

### 场景 2：预订会议室

为已有日程预订会议室，或仅查找空闲会议室。匹配以下任一场景：
- 帮我给这个会议预订一个会议室
- 查一下xxx区域有哪些空闲的会议室
- 帮我换一个会议室

> 命中此场景后，**必须立即读取** [references/workflows.md](references/workflows.md) 中的「场景 2：预订会议室」并严格遵守。不得跳过读取、不得凭记忆执行。

## 子命令分组



### 日历

- `list-calendars`：列日历，支持分页与 `--all`
- `get-calendar`：查看单个日历详情
- `create-calendar`：创建日历
- `update-calendar`：修改日历
- `delete-calendar`：删除日历

### 日程

- `list-events`：按日历和时间区间列日程，支持分页
  - 必填：`calendar_id`、`--start-time`、`--end-time`（ISO 8601 带时区，区间 ≤ 31 天）
  - 可选：`--keyword`（在代码中按 `summary` 标题关键字过滤）、`--page-size`（最多 100，默认 50）、`--page-token`、`--all`（自动翻页取完整结果）
  - 使用建议：找某条/浏览先用默认；若按标题找日程，优先加 `--keyword`；统计数量、判断“没有/唯一/全部”这类结论时必须加 `--all`
- `get-event`：查看单个日程详情（`calendar_id event_id`）
- `create-event`：创建日程，可同时写入地点、附件、参与者、重复规则、提醒，也可同步创建会议
  - 必填：`calendar_id`、`--start-time`、`--end-time`
  - 常用：`--title`、`--location`、`--attendees "user_id1,user_id2"`、`--online-meeting`、`--recurrence`
- `update-event`：修改日程，也可追加或移除参与者、修改重复规则、同步修改会议
  - 必填：`calendar_id event_id`
  - 常用：`--title`、`--start-time`、`--end-time`、`--attendees`、`--remove-attendees`
- `delete-event`：删除日程、同步删除会议（`calendar_id event_id`）

### 忙闲

- `free-busy`：查询用户或会议室在时间区间内的忙闲状态
  - 必填：`--start-time`、`--end-time`（区间 ≤ 7 天），至少传 `--user-ids` 或 `--room-ids` 之一

### 参与者

- `list-event-attendees`：在 `calendar_id`、`event_id` 指定日程下查询参与者列表，`--page-size` 分页
- `add-event-attendees`：批量添加日程参与者（每次最多 200 个），常用参数：`--user-ids`
- `delete-event-attendees`：批量删除日程参与者（每次最多 50 个，需参与者 id），常用参数：`--attendee-ids`

### 会议室

- `list-room-levels`：查询会议室层级（树形目录），逐级向下定位
- `list-rooms`：查询会议室列表，可按层级筛选，常用参数：`--room-level-id`
- `list-event-rooms`：查看日程已预订的会议室
- `add-event-rooms`：为日程预订会议室（1–40 个），常用参数：`--room-ids`
- `delete-event-rooms`：取消日程已预订的会议室（1–50 个），常用参数：`--room-ids`

### 日历权限

- `list-permissions`：查询日历权限列表
- `create-permission`：为用户授予日历权限
- `delete-permission`：移除用户的日历权限

## 高风险操作

- `create-calendar`
- `update-calendar`
- `create-event`
- `update-event`
- `delete-event`
- `delete-calendar`
- `delete-event-attendees`
- `delete-event-rooms`
- `create-permission`
- `delete-permission`

这些命令默认都是 dry-run（不带 `--confirm`）。

### 默认行为：dry-run + askUserQuestion 确认

1. 先执行不带 `--confirm` 的 dry-run，输出预览
2. 通过 `askUserQuestion` 向用户确认**本次操作**（选项如"确认执行""取消"）
3. 确认后，再追加 `--confirm` 重新执行
4. 不能因为预览结果正常，就自动补跑 `--confirm`
5. 每次新的变更操作都必须重新走此流程；之前操作的确认不能复用到下一次操作

### 跳过确认

当用户在**当前请求**中使用了明确的跳过意图表达时，可直接带 `--confirm` 执行，跳过 dry-run：

- "直接执行" "无需确认" "不用确认" "立即创建" "立即删除"

注意：之前对话中的笼统授权（如"以后都不用确认"）不适用于后续新的高风险操作，每次仍需在当前请求中明确表达。

## 关键约束

- 时间参数统一使用 `--start-time` / `--end-time`
- 位置参数统一为 `calendar_id`、`event_id`
- 带时间的参数必须使用带时区的 ISO 8601，例如 `2026-03-02T16:00:00+08:00` 或 `2026-03-02T08:00:00Z`
- 不要使用无时区后缀的 `2026-03-02T14:00:00`，否则容易出现东 8 区偏移
- 全天事项可使用 `yyyy-mm-dd`
- `list-events` 的时间区间不超过 31 天
- `free-busy` 的时间区间不超过 7 天
- `free-busy` 至少传 `--user-ids` 或 `--room-ids` 之一
- `create-event` 与 `update-event` 的 `--attach` 可重复传入；附件最多 20 个
- `--recurrence` 传 JSON 字符串，freq 可选 YEARLY / MONTHLY / WEEKLY / DAILY；count 与 until_date 二选一；by_day 值如 MO、TU、WE、TH、FR、SA、SU
- `--reminders` 传 JSON 数组，如 `[{"minutes":15}]`，最多 10 个
- `update-event --remove-attendees` 需要传参与者 id，不是用户 id
- `delete-event-attendees` 需要参与者 id（非用户 id），从 `list-event-attendees` 获取
- `add-event-attendees` 每次最多 200 人，日程参与者总数上限 1000
- `add-event-rooms` 每次最多 40 个会议室 ID
- `delete-event-rooms` 每次最多 50 个会议室 ID
- `list-room-levels` 首次不传 `--room-level-id` 获取根节点；传入层级 ID 获取子层级
- `list-rooms` 每页最大 50 条

需要参数细节、分页字段和完整示例时，查看 [references/command-details.md](references/command-details.md)。

## 输出格式

先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`（compact 格式，节省 token），便于继续提取 `calendar_id`、`event_id`、`next_page_token`、`attendees[].id` 等字段。

JSON 区块为**当前子命令对应接口返回的完整 `data` 对象**（未做字段裁剪）。若需按标题、关键词或其它条件筛选，在读取 `items` 等字段后**由模型在结构化数据中自行过滤与归纳**；时间区间较大、结果可能很多时，结合下节分页与 `--all` 控制体量，必要时拆成多段查询。

## 注意事项

- **分页场景必须检查完整性**：`list-events` 默认页大小为 50（最大 100）。找某条/浏览可用默认；若用户要搜索或统计某段时间内的所有日程，优先使用 `--all` 自动翻页；若未使用 `--all`，必须检查 `next_page_token`，有则继续翻页，不能假设首页就是全部结果
- **按标题搜索优先使用 `--keyword`**：`list-events --keyword` 会在代码中按整个时间区间内的日程 `summary` 做过滤，适合定位包含某个关键词的事项
- **`--keyword` 不与 `--page-token` 组合使用**：传入 `--keyword` 时会忽略 `--page-token`，以保证过滤范围覆盖整个时间区间
- 用户没有对本次操作给出明确确认或跳过意图时，不要对高风险操作追加 `--confirm`
- 描述字段中的字面量 `\\n`、`\\r\\n` 会在写入前自动还原为真实换行
- 认证或权限报错时，优先检查 `WPS_SID`
- 如果用户缺少 `calendar_id`、`event_id` 或参与者 id，先执行只读命令补齐参数，不要猜测
- 只有在需要子命令示例、分页参数或字段说明时，才继续读取 [references/command-details.md](references/command-details.md)
- 预订会议室前必须先用 `free-busy` 确认会议室空闲，且日程时间与查 free-busy 时使用的时间完全一致
- 会议室**只能**通过 `list-room-levels` → `list-rooms` 层级树逐级定位，严禁凭名称猜测 room_id 或不带 `--room-level-id` 直接 `list-rooms`
- 邀人约会场景中，用户未指定地点时**必须通过 `askUserQuestion` 向用户确认地点**，严禁自行假设或跳过
- 需要定位单条日程但命中多条时，须通过 `askUserQuestion` 让用户选择，不得自行挑选
- 邀人约会场景中，日程必须在阶段 4 才能创建，不能提前创建
