# Command Details

按需读取这个文件；只有在需要参数细节、分页方式或示例命令时再加载。

## 日历命令

> 详细参数与响应字段见 [reference.md](../reference.md) 一、日历（命令 1–5）。

### `list-calendars`

列出日历列表。

```bash
python skills/calendar/run.py list-calendars
python skills/calendar/run.py list-calendars --page-size 20
python skills/calendar/run.py list-calendars --page-token "<token>"
python skills/calendar/run.py list-calendars --all
```

- `--page-size`：单页条数，脚本会透传给客户端
- `--page-token`：拉取指定页
- `--all`：自动翻页并合并结果

返回中如果存在 `next_page_token`，可用于继续翻页。

### `get-calendar`

```bash
python skills/calendar/run.py get-calendar primary
python skills/calendar/run.py get-calendar <calendar_id>
```

### `create-calendar`

```bash
python skills/calendar/run.py create-calendar --title "项目排期" --color "#FF0000FF"
python skills/calendar/run.py create-calendar --title "项目排期" --color "#FF0000FF" --desc "里程碑\\n每周同步"
```

### `update-calendar`

```bash
python skills/calendar/run.py update-calendar <calendar_id> --title "新标题"
python skills/calendar/run.py update-calendar <calendar_id> --desc "新描述"
```

### `delete-calendar`

```bash
python skills/calendar/run.py delete-calendar <calendar_id>
```

## 日程命令

> 详细参数与响应字段见 [reference.md](../reference.md) 二、日程（命令 6–10）。

### `list-events`

按时间区间列出某个日历下的日程。

```bash
python skills/calendar/run.py list-events primary --start-time "2026-04-06T00:00:00+08:00" --end-time "2026-04-07T00:00:00+08:00"
python skills/calendar/run.py list-events primary --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-30T23:59:59+08:00" --keyword "周会"
python skills/calendar/run.py list-events <calendar_id> --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-30T23:59:59+08:00" --page-size 50
python skills/calendar/run.py list-events <calendar_id> --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-30T23:59:59+08:00" --page-token "<token>"
python skills/calendar/run.py list-events <calendar_id> --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-30T23:59:59+08:00" --all
```

- `--keyword`：在代码中按返回结果的 `summary` 标题关键字过滤，适合搜索某类事项
- 传入 `--keyword` 时会忽略 `--page-token`，以保证搜索覆盖整个时间区间
- `--page-size`：最多 100，默认 50（找某条/浏览建议用默认）
- `--page-token`：继续读取后续页
- `--all`：自动翻页并合并完整区间结果（统计、判空、唯一性结论等场景必须使用）

### `get-event`

```bash
python skills/calendar/run.py get-event <calendar_id> <event_id>
```

如果后续要移除参与者，先从返回的 `attendees[].id` 中取参与者 id。

### `create-event`

```bash
python skills/calendar/run.py create-event primary \
  --start-time "2026-04-06T10:00:00+08:00" \
  --end-time "2026-04-06T11:00:00+08:00" \
  --title "项目同步"
```

```bash
python skills/calendar/run.py create-event primary \
  --start-time "2026-04-06T10:00:00+08:00" \
  --end-time "2026-04-06T11:00:00+08:00" \
  --title "项目同步" \
  --desc "议程\\n1. 进度\\n2. 风险" \
  --location "A-301" \
  --attach file_id_1 \
  --attach file_id_2 \
  --attendees "user_id_1,user_id_2"
```

预约线上会议（创建带 online_meeting 的日程，默认 provider=kso）：

```bash
python skills/calendar/run.py create-event primary \
  --start-time "2026-04-06T15:00:00+08:00" \
  --end-time "2026-04-06T16:00:00+08:00" \
  --title "项目周会" \
  --online-meeting \
  --attendees "user_id_1,user_id_2"
```

- `--location`：地点名称，最多 1 个
- `--attach`：可重复传入
- `--attendees`：逗号分隔的用户 id；创建成功后会自动调用参与者添加接口
- `--online-meeting`：启用后自动填充 `{"provider": "kso"}`，返回入会链接等信息
- `--recurrence`：重复规则 JSON（详见下方）
- `--reminders`：提醒 JSON 数组，如 `[{"minutes":15}]`，最多 10 个
- `--visibility`：可见范围，可选 `default` / `public` / `private`
- `--free-busy-status`：忙闲状态，可选 `busy` / `free`
- `--attendee-ability`：参与者权限，可选 `can_see_others` / `can_invite_others`

#### 重复规则 (`--recurrence`)

传入 JSON 字符串，字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| freq | string | **必填**，频率：`YEARLY` / `MONTHLY` / `WEEKLY` / `DAILY` |
| interval | int | 间隔，默认 1（如每 2 周 → `"interval": 2`） |
| by_day | string[] | 星期几，值为 `MO` `TU` `WE` `TH` `FR` `SA` `SU` |
| by_month | int[] | 月份，1-12 |
| by_month_day | int[] | 月中第几天，1-31 |
| count | int | 重复次数（与 `until_date` 二选一） |
| until_date | object | 截止日期（与 `count` 二选一），格式 `{"datetime": "2026-12-31T23:59:59+08:00"}` 或 `{"date": "2026-12-31"}` |
| exdate | object[] | 排除的日期列表，格式同 `until_date` |

示例 — 每周一三五重复，共 10 次：

```bash
python skills/calendar/run.py create-event primary \
  --start-time "2026-04-13T09:00:00+08:00" \
  --end-time "2026-04-13T10:00:00+08:00" \
  --title "晨会" \
  --recurrence '{"freq":"WEEKLY","interval":1,"by_day":["MO","WE","FR"],"count":10}'
```

示例 — 每天重复到 2026-06-30：

```bash
python skills/calendar/run.py create-event primary \
  --start-time "2026-04-13T08:30:00+08:00" \
  --end-time "2026-04-13T09:00:00+08:00" \
  --title "日报提醒" \
  --recurrence '{"freq":"DAILY","until_date":{"datetime":"2026-06-30T23:59:59+08:00"}}'
```

示例 — 每月 15 号重复，共 6 次：

```bash
python skills/calendar/run.py create-event primary \
  --start-time "2026-04-15T14:00:00+08:00" \
  --end-time "2026-04-15T15:00:00+08:00" \
  --title "月度复盘" \
  --recurrence '{"freq":"MONTHLY","by_month_day":[15],"count":6}'
```

### `update-event`

```bash
python skills/calendar/run.py update-event <calendar_id> <event_id> --title "新标题"
python skills/calendar/run.py update-event <calendar_id> <event_id> --attendees "user_id_3,user_id_4"
python skills/calendar/run.py update-event <calendar_id> <event_id> --remove-attendees "attendee_id_1,attendee_id_2"
```

为已有日程补充线上会议信息：

```bash
python skills/calendar/run.py update-event <calendar_id> <event_id> --online-meeting
```

修改重复规则：

```bash
python skills/calendar/run.py update-event <calendar_id> <event_id> \
  --recurrence '{"freq":"WEEKLY","by_day":["TU","TH"],"count":8}'
```

- `--attendees`：向已有日程追加参与者，传用户 id
- `--remove-attendees`：移除已有参与者，传参与者 id
- `--online-meeting`：补充/覆盖线上会议信息（provider=kso），不支持通过 CLI 清空
- `--recurrence`：修改重复规则，传 JSON 字符串
- `--reminders`：修改提醒，传 JSON 数组
- `--visibility`：修改可见范围
- `--free-busy-status`：修改忙闲状态
- `--attendee-ability`：修改参与者权限

### `delete-event`

```bash
python skills/calendar/run.py delete-event <calendar_id> <event_id>
```

## 忙闲命令

> 详细参数与响应字段见 [reference.md](../reference.md) 五、忙闲（命令 19）。

### `free-busy`

```bash
python skills/calendar/run.py free-busy --user-ids "user_id_1,user_id_2" --start-time "2026-04-06T09:00:00+08:00" --end-time "2026-04-06T18:00:00+08:00"
python skills/calendar/run.py free-busy --room-ids "room_id_1" --start-time "2026-04-06T09:00:00+08:00" --end-time "2026-04-06T18:00:00+08:00"
```

- 至少提供 `--user-ids` 或 `--room-ids` 之一
- 时间区间不超过 7 天

## 参与者命令

> 详细参数与响应字段见 [reference.md](../reference.md) 三、参与者（命令 11–13）。

### `list-event-attendees`

查询日程的参与者列表。

```bash
python skills/calendar/run.py list-event-attendees primary <event_id>
python skills/calendar/run.py list-event-attendees <calendar_id> <event_id> --page-size 50
python skills/calendar/run.py list-event-attendees <calendar_id> <event_id> --page-token "<token>"
```

- `--page-size`：每页数量，1–100，默认 30
- `--page-token`：继续读取后续页

### `add-event-attendees`

批量添加日程参与者。

```bash
python skills/calendar/run.py add-event-attendees primary <event_id> --user-ids "user_id_1,user_id_2"
python skills/calendar/run.py add-event-attendees <calendar_id> <event_id> --user-ids "user_id_1,user_id_2" --notify true
```

- `--user-ids`：用户 ID 列表，逗号分隔，每次最多 200 个
- `--notify`：是否发送通知

### `delete-event-attendees`

批量移除日程参与者。

```bash
python skills/calendar/run.py delete-event-attendees primary <event_id> --attendee-ids "att_id_1,att_id_2"
python skills/calendar/run.py delete-event-attendees <calendar_id> <event_id> --attendee-ids "att_id_1" --notify true
```

- `--attendee-ids`：参与者 ID 列表（非用户 ID），从 `list-event-attendees` 获取，逗号分隔，每次最多 50 个
- `--notify`：是否发送通知

## 会议室命令

> 详细参数与响应字段见 [reference.md](../reference.md) 四、会议室（命令 14–18）。

### `list-room-levels`

查询会议室层级（树形目录）。

```bash
python skills/calendar/run.py list-room-levels
python skills/calendar/run.py list-room-levels --room-level-id "<level_id>"
python skills/calendar/run.py list-room-levels --room-level-id "<level_id>" --page-size 50
```

- 不传 `--room-level-id`：获取根节点
- 传入层级 ID：获取该层级的子层级
- 返回的 `has_child` 为 `true` 时，可继续向下查询

### `list-rooms`

查询会议室列表。

```bash
python skills/calendar/run.py list-rooms --room-level-id "<level_id>"
python skills/calendar/run.py list-rooms --room-level-id "<level_id>" --page-size 50
python skills/calendar/run.py list-rooms --page-token "<token>"
```

- `--room-level-id`：按层级筛选会议室
- `--page-size`：每页数量，默认 20，最大 50

### `list-event-rooms`

查看日程已预订的会议室。

```bash
python skills/calendar/run.py list-event-rooms primary <event_id>
python skills/calendar/run.py list-event-rooms <calendar_id> <event_id>
```

### `add-event-rooms`

为日程预订会议室。

```bash
python skills/calendar/run.py add-event-rooms primary <event_id> --room-ids "room_id_1"
python skills/calendar/run.py add-event-rooms <calendar_id> <event_id> --room-ids "room_id_1,room_id_2"
```

- `--room-ids`：会议室 ID 列表，逗号分隔，1–40 个；ID 从 `list-rooms` 获取
- 返回中检查 `result` 字段：`success`（成功）/ `failed`（失败，查看 `fail_reason`）/ `approving`（审批中）

### `delete-event-rooms`

取消日程已预订的会议室。

```bash
python skills/calendar/run.py delete-event-rooms <calendar_id> <event_id> --room-ids "room_id_1"
python skills/calendar/run.py delete-event-rooms <calendar_id> <event_id> --room-ids "room_id_1,room_id_2"
```

- `--room-ids`：要删除的会议室 ID，逗号分隔，1–50 个；ID 从 `list-event-rooms` 获取

## 日历权限命令

> 详细参数与响应字段见 [reference.md](../reference.md) 六、日历权限（命令 20–22）。

### `list-permissions`

查询日历的权限列表。

```bash
python skills/calendar/run.py list-permissions <calendar_id>
python skills/calendar/run.py list-permissions <calendar_id> --page-size 10
python skills/calendar/run.py list-permissions <calendar_id> --page-token "<token>"
```

- `--page-size`：每页数量，1–20，默认 20

### `create-permission`

为用户授予日历权限。

```bash
python skills/calendar/run.py create-permission <calendar_id> --user-id "user_id_1" --role writer
python skills/calendar/run.py create-permission <calendar_id> --user-id "user_id_1" --role reader
```

- `--role`：可选值 `free_busy_reader` / `reader` / `writer` / `owner`

### `delete-permission`

移除用户的日历权限。

```bash
python skills/calendar/run.py delete-permission <calendar_id> <permission_id>
```

- `permission_id` 从 `list-permissions` 获取

## 常见字段

- `calendar_id`：日历 id；主日历可直接用 `primary`
- `event_id`：日程 id
- `next_page_token`：下一页游标
- `attendees[].id`：参与者 id，用于 `--attendee-ids`
- `attendees[].user_id`：参与者对应的用户 id
- `room_id`：会议室 id，用于 `--room-ids`
- `level_id`：会议室层级 id，用于 `--room-level-id`
- `permission_id`：权限 id，用于 `delete-permission`
