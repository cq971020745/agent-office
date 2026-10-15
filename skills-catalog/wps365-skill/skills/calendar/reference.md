# run.py 子命令详细参考

> 每个子命令对应一个 V7 API 接口。本文档列出 CLI 参数含义及响应体 `data` 中的关键字段。
> 响应外层统一为 `{ code, msg, data }`，`code=0` 表示成功；下文仅说明 `data` 内部结构。

---

## 一、日历

### 1. `list-calendars`

**API**：`GET /v7/calendars`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| （无 CLI 参数） | — | — | 获取当前用户的日历列表，默认每页 20 条 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 日历列表 |
| items[].id | `string` | 日历 ID（后续操作用作 `calendar_id`） |
| items[].summary | `string` | 日历标题 |
| description | `string` | 日历备注 |
| items[].type | `string` | `primary`（主日历）/ `normal`（用户创建） |
| items[].role | `string` | 当前身份的权限：`free_busy_reader` / `reader` / `writer` / `owner` |
| next_page_token | `string` | 下一页标记，为空表示无更多数据 |

---

### 2. `get-calendar <calendar_id>`

**API**：`GET /v7/calendars/{calendar_id}`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | `string` | 日历 ID |
| summary | `string` | 日历标题 |
| description | `string` | 日历备注 |
| type | `string` | `primary` / `normal` |
| role | `string` | 权限：`free_busy_reader` / `reader` / `writer` / `owner` |
| is_deleted | `boolean` | 是否已删除 |
| open_status | `string` | 日历开放状态（仅主日历）：`private` / `show_only_free_busy` / `public` |

---

### 3. `create-calendar`

**API**：`POST /v7/calendars/create`（用户身份最多创建 100 个日历）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--title` | `string` | 是 | 日历标题（对应 API `summary` 字段） |
| `--color` | `string` | 是 | 颜色，如 `#FF0000FF` |
| `--desc` | `string` | 否 | 日历描述 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | `string` | 新建日历 ID |
| summary | `string` | 日历标题 |
| description | `string` | 日历备注 |
| type | `string` | `normal` |
| role | `string` | 权限（创建者为 `owner`） |

---

### 4. `update-calendar <calendar_id>`

**API**：`POST /v7/calendars/{calendar_id}/update`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `--title` | `string` | 否 | 新标题（对应 API `summary`） |
| `--color` | `string` | 否 | 新颜色 |
| `--desc` | `string` | 否 | 新描述 |

> 至少指定 `--title`、`--color`、`--desc` 之一。

**响应**：标准 `code`/`msg`，`code=0` 表示成功。

---

### 5. `delete-calendar <calendar_id>`

**API**：`POST /v7/calendars/{calendar_id}/delete`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID（主日历不可删除） |

**响应**：标准 `code`/`msg`，`code=0` 表示成功。

---

## 二、日程

### 6. `list-events <calendar_id> --start-time --end-time`

**API**：`GET /v7/calendars/{calendar_id}/events`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `--start-time` | `string` | 是 | 查询起始时间，RFC3339/ISO 8601 格式 |
| `--end-time` | `string` | 是 | 查询结束时间，RFC3339/ISO 8601 格式 |
| `--keyword` | `string` | 否 | 在代码中按标题关键字过滤，匹配返回结果中的 `summary` 字段 |
| `--page-token` | `string` | 否 | 分页游标 |
| `--page-size` | `integer` | 否 | 单页条数上限，最大 100，默认 50 |
| `--all` | `boolean` | 否 | 自动翻页并返回完整区间结果 |

说明：使用 `--keyword` 时会忽略 `--page-token`，以保证过滤范围覆盖整个时间区间。

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 日程列表 |
| items[].id | `string` | 日程 ID（后续操作用作 `event_id`） |
| items[].calendar_id | `string` | 所属日历 ID |
| items[].summary | `string` | 日程标题 |
| items[].description | `string` | 日程备注 |
| items[].start_time.datetime | `string` | 开始时间，RFC3339 格式 |
| items[].start_time.date | `string` | 全天日程的开始日期（与 datetime 二选一） |
| items[].end_time.datetime | `string` | 结束时间，RFC3339 格式 |
| items[].end_time.date | `string` | 全天日程的结束日期（与 datetime 二选一） |
| items[].locations | `array` | 地点列表，每项含 `name` |
| items[].free_busy_status | `string` | 忙闲状态：`busy` / `free` |
| items[].status | `string` | 日程状态：`normal` / `cancelled` |
| items[].visibility | `string` | 可见性：`default` / `public` / `private` |
| items[].organizer.type | `string` | 组织者类型（`user`） |
| items[].organizer.user_id | `string` | 组织者用户 ID |
| items[].online_meeting.provider | `string` | 在线会议提供方（如 `kso`） |
| items[].online_meeting.url | `string` | 在线会议链接 |
| items[].online_meeting.description | `string` | 在线会议描述 |
| items[].recurrence | `object` | 重复规则 |
| items[].recurrence.freq | `string` | 重复频率：`DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY` |
| items[].recurrence.interval | `integer` | 重复间隔 |
| items[].recurrence.count | `integer` | 重复次数 |
| items[].recurrence.by_day | `array[string]` | 按星期几重复（如 `MO`、`TU`） |
| items[].recurrence.by_month | `array[integer]` | 按月份重复 |
| items[].recurrence.by_month_day | `array[integer]` | 按月中第几天重复 |
| items[].recurrence.until_date | `object` | 重复截止日期（含 `date` 或 `datetime`） |
| items[].recurrence.exdate | `array[object]` | 排除的日期列表（每项含 `date` 或 `datetime`） |
| items[].recurring_event_id | `string` | 重复日程的父日程 ID |
| items[].original_start_time | `object` | 重复日程中被单独编辑的那一天的原始开始时间（含 `date` 或 `datetime`） |
| items[].reminders | `array` | 提醒列表 |
| items[].reminders[].minutes | `integer` | 提前多少分钟提醒 |
| next_page_token | `string` | 下一页标记 |
| next_sync_token | `string` | 增量同步令牌（用于后续增量拉取变更的日程） |

---

### 7. `get-event <calendar_id> <event_id>`

**API**：`GET /v7/calendars/{calendar_id}/events/{event_id}`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `event_id` | 位置参数 | 是 | 日程 ID，可从日程列表获取 |

**响应 `data` 字段**：同 `list-events` 中 `items[]` 的字段结构（单个日程对象）。

---

### 8. `create-event <calendar_id>`

**API**：`POST /v7/calendars/{calendar_id}/events/create`（用户身份每日最多创建 500 个日程）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `--start-time` | `string` | 是 | 开始时间，ISO 8601 或 `yyyy-mm-dd`（全天日程） |
| `--end-time` | `string` | 是 | 结束时间，ISO 8601 或 `yyyy-mm-dd` |
| `--title` | `string` | 否 | 日程标题（对应 API `summary`） |
| `--desc` | `string` | 否 | 日程备注（对应 API `description`） |
| `--location` | `string` | 否 | 地点名称，最多 1 个（对应 API `locations[].name`） |
| `--attach` | `string` | 否 | 附件 file_id（v7_file.id），可多次传入，最多 20 个 |
| `--attendees` | `string` | 否 | 参与者 user_id，逗号分隔；创建成功后自动调用添加参与者接口 |

**响应 `data` 字段**：新创建的日程对象，字段同 `list-events` 中 `items[]`，关键串联字段为 `id`（event_id）。

---

### 9. `update-event <calendar_id> <event_id>`

**API**：`POST /v7/calendars/{calendar_id}/events/{event_id}/update`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `event_id` | 位置参数 | 是 | 日程 ID |
| `--title` | `string` | 否 | 新标题（对应 API `summary`） |
| `--desc` | `string` | 否 | 新备注（对应 API `description`） |
| `--start-time` | `string` | 否 | 新开始时间，ISO 8601 |
| `--end-time` | `string` | 否 | 新结束时间，ISO 8601 |
| `--location` | `string` | 否 | 新地点名称 |
| `--attach` | `string` | 否 | 附件 file_id，可多次传入（覆盖原有附件） |
| `--attendees` | `string` | 否 | 追加的参与者 user_id，逗号分隔 |
| `--remove-attendees` | `string` | 否 | 要移除的参与者 id（从参与者列表获取），逗号分隔 |

> 至少指定一个参数。内容无变化时 API 返回 `400411340`，run.py 视为成功。

**响应 `data` 字段**：更新后的日程对象，字段同 `list-events` 中 `items[]`。

---

### 10. `delete-event <calendar_id> <event_id>`

**API**：`POST /v7/calendars/{calendar_id}/events/{event_id}/delete`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `event_id` | 位置参数 | 是 | 日程 ID |

**响应**：标准 `code`/`msg`，`code=0` 表示成功。

---

## 三、参与者

### 11. `list-event-attendees <calendar_id> <event_id>`

**API**：`GET /v7/calendars/{calendar_id}/events/{event_id}/attendees`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `event_id` | 位置参数 | 是 | 日程 ID |
| `--page-size` | `int` | 否 | 每页数量，1–100，默认 30 |
| `--page-token` | `string` | 否 | 分页凭证，首次不传 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 参与者列表 |
| items[].id | `string` | 参与者 ID（用于移除参与者时传入） |
| items[].type | `string` | 参与者类型：`user`（用户）/ `group`（群组）/ `third_party_email`（外部） |
| items[].name | `string` | 参与者名称 |
| items[].user_id | `string` | 用户 ID（type 为 user 时） |
| items[].group_id | `string` | 群组 ID（type 为 group 时） |
| items[].is_optional | `boolean` | 是否为可选参与者 |
| items[].is_organizer | `boolean` | 是否为组织者 |
| items[].response_status | `string` | 回复状态：`not_responded`（未回复）/ `declined`（已拒绝）/ `accepted`（已接受）/ `tentative`（暂定） |
| items[].third_party_email | `string` | 第三方邮箱（外部参与者） |
| next_page_token | `string` | 下一页标记 |

---

### 12. `add-event-attendees <calendar_id> <event_id> --user-ids`

**API**：`POST /v7/calendars/{calendar_id}/events/{event_id}/attendees/batch_create`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `event_id` | 位置参数 | 是 | 日程 ID |
| `--user-ids` | `string` | 是 | 用户 ID 列表，逗号分隔，每次最多 200 个；日程参与者总数最多 1000 |
| `--notify` | `bool` | 否 | 是否发送通知 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 添加后的参与者列表 |
| items[].id | `string` | 参与者 ID（用于移除参与者时传入）|
| items[].type | `string` | 参与者类型：`user` / `group` / `third_party_email` |
| items[].name | `string` | 参与者名称 |
| items[].user_id | `string` | 用户 ID |
| items[].response_status | `string` | 回复状态：`not_responded` / `declined` / `accepted` / `tentative` |

---

### 13. `delete-event-attendees <calendar_id> <event_id> --attendee-ids`

**API**：`POST /v7/calendars/{calendar_id}/events/{event_id}/attendees/batch_delete`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `event_id` | 位置参数 | 是 | 日程 ID |
| `--attendee-ids` | `string` | 是 | 参与者 ID 列表，逗号分隔，每次最多 50 个；ID 从 `list-event-attendees` 获取 |
| `--notify` | `bool` | 否 | 是否发送通知 |

**响应**：标准 `code`/`msg`，`code=0` 表示成功。

---

## 四、会议室

### 14. `list-room-levels`

**API**：`GET /v7/meeting_room_levels`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--room-level-id` | `string` | 否 | 层级 ID，不传则获取根节点 |
| `--page-size` | `int` | 否 | 每页数量，默认 20 |
| `--page-token` | `string` | 否 | 分页凭证，首次不传 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 层级列表 |
| items[].id | `string` | 层级 ID |
| items[].name | `string` | 层级名称 |
| items[].parent_id | `string` | 父层级 ID，企业根目录时为 `0` |
| items[].path | `array[string]` | 从根层级到本层级的 ID 路径 |
| items[].has_child | `boolean` | 是否有子层级 |
| next_page_token | `string` | 下一页标记 |

---

### 15. `list-rooms`

**API**：`GET /v7/meeting_rooms`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--room-level-id` | `string` | 否 | 会议室层级 ID，按层级筛选 |
| `--page-size` | `int` | 否 | 每页数量，默认 20，最大 50 |
| `--page-token` | `string` | 否 | 分页凭证，首次不传 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 会议室列表 |
| items[].id | `string` | 会议室 ID（用于预订会议室时传入 `--room-ids`） |
| items[].name | `string` | 会议室名称 |
| items[].capacity | `integer` | 可容纳最大人数 |
| items[].level_id | `string` | 所属层级 ID |
| items[].remark | `string` | 备注信息 |
| items[].disable | `boolean` | 是否已禁用 |
| items[].device_list | `array` | 设备列表，每项含 `name`（设备名称） |
| items[].tag_list | `array` | 会议室标签列表 |
| next_page_token | `string` | 下一页标记 |

---

### 16. `list-event-rooms <calendar_id> <event_id>`

**API**：`GET /v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `event_id` | 位置参数 | 是 | 日程 ID |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 日程会议室列表 |
| items[].room_id | `string` | 会议室 ID |
| items[].booking_id | `string` | 预约 ID |
| items[].name | `string` | 会议室名称 |
| items[].result | `string` | 预约结果：`success`（成功）/ `failed`（失败）/ `approving`（审批中） |
| items[].fail_reason | `string` | 失败原因（result 为 failed 时） |

---

### 17. `add-event-rooms <calendar_id> <event_id> --room-ids`

**API**：`POST /v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms/batch_create`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID，主日历可传 `primary` |
| `event_id` | 位置参数 | 是 | 日程 ID |
| `--room-ids` | `string` | 是 | 会议室 ID 列表，逗号分隔，1–40 个；ID 从 `list-rooms` 获取 |

**响应 `data` 字段**：同 `list-event-rooms`（每个会议室的预订结果）。

---

### 18. `delete-event-rooms <calendar_id> <event_id> --room-ids`

**API**：`POST /v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms/batch_delete`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `event_id` | 位置参数 | 是 | 日程 ID |
| `--room-ids` | `string` | 是 | 要删除的会议室 ID，逗号分隔，1–50 个；ID 从 `list-event-rooms` 获取 |

**响应**：标准 `code`/`msg`，`code=0` 表示成功。

---

## 五、忙闲

### 19. `free-busy`

**API**：`GET /v7/free_busy_list`（查询时间区间需满足 ≤ 7 天）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--start-time` | `string` | 是 | 查询起始时间，ISO 8601，须带时区后缀（`Z` 或 `+08:00`） |
| `--end-time` | `string` | 是 | 查询结束时间，ISO 8601，须带时区后缀 |
| `--user-ids` | `string` | 否 | 用户 ID 列表，逗号分隔，最多 50 人；与 `--room-ids` 至少传一个 |
| `--room-ids` | `string` | 否 | 会议室 ID 列表，逗号分隔；与 `--user-ids` 至少传一个 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 忙闲列表（每个用户/会议室一条） |
| items[].user_id | `string` | 用户 ID（查用户忙闲时） |
| items[].room_id | `string` | 会议室 ID（查会议室忙闲时） |
| items[].busy_times | `array` | 忙碌时间段列表，区间内其余为空闲 |
| items[].busy_times[].start | `string` | 忙碌开始时间 |
| items[].busy_times[].end | `string` | 忙碌结束时间 |

---

## 六、日历权限

### 20. `list-permissions <calendar_id>`

**API**：`GET /v7/calendars/{calendar_id}/permissions`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `--page-size` | `int` | 否 | 每页数量，1–20，默认 20 |
| `--page-token` | `string` | 否 | 分页凭证，首次不传 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| items | `array` | 权限列表 |
| items[].id | `string` | 权限 ID（用于删除权限时传入 `permission_id`） |
| items[].calendar_id | `string` | 日历 ID |
| items[].user_id | `string` | 用户 ID |
| items[].role | `string` | 权限角色：`free_busy_reader`（游客）/ `reader`（订阅者）/ `writer`（编辑者）/ `owner`（所有者） |
| next_page_token | `string` | 下一页标记 |

---

### 21. `create-permission <calendar_id>`

**API**：`POST /v7/calendars/{calendar_id}/permissions/create`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `--user-id` | `string` | 是 | 要授权的用户 ID |
| `--role` | `string` | 是 | 权限角色，可选值：`free_busy_reader` / `reader` / `writer` / `owner` |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | `string` | 新建权限 ID |
| calendar_id | `string` | 日历 ID |
| user_id | `string` | 用户 ID |
| role | `string` | 权限角色 |

---

### 22. `delete-permission <calendar_id> <permission_id>`

**API**：`POST /v7/calendars/{calendar_id}/permissions/{permission_id}/delete`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `calendar_id` | 位置参数 | 是 | 日历 ID |
| `permission_id` | 位置参数 | 是 | 权限 ID，从 `list-permissions` 获取 |

**响应**：标准 `code`/`msg`，`code=0` 表示成功。

---

## 附录：枚举值参考

以下枚举类型在多个子命令的参数或响应中复用，集中说明各值含义。

### `role`（日历权限角色）

| 值 | 含义 |
|-----|------|
| `free_busy_reader` | 游客权限，仅能查看日历的忙闲状态，无法查看详细日程内容 |
| `reader` | 订阅者权限，可查看日历下的日程详情，但不能创建或修改日程 |
| `writer` | 编辑者权限，可创建及修改日程 |
| `owner` | 所有者/管理员权限，可管理日历及共享设置 |

### `type`（日历类型）

| 值 | 含义 |
|-----|------|
| `primary` | 主日历，系统为每个用户自动创建的默认日历，不可删除 |
| `normal` | 用户创建的日历 |

### `open_status`（日历开放状态，仅主日历）

| 值 | 含义 |
|-----|------|
| `private` | 私密，其他用户无法查看 |
| `show_only_free_busy` | 仅展示忙闲，其他用户可看到忙碌/空闲但看不到日程详情 |
| `public` | 公开，其他用户可查看日程详情 |

### `free_busy_status`（日程忙闲状态）

| 值 | 含义 |
|-----|------|
| `busy` | 忙碌，该时段被占用 |
| `free` | 空闲，该时段可用 |

### `status`（日程状态）

| 值 | 含义 |
|-----|------|
| `normal` | 正常 |
| `cancelled` | 已取消 |

### `visibility`（日程可见性）

| 值 | 含义 |
|-----|------|
| `default` | 默认，遵循日历的默认可见性设置 |
| `public` | 公开，日程详情对所有可访问日历的用户可见 |
| `private` | 私密，仅自己可见 |

### `type`（参与者类型）

| 值 | 含义 |
|-----|------|
| `user` | 企业内部用户 |
| `group` | 群组 |
| `third_party_email` | 外部参与者，通过邮箱邀请 |

### `response_status`（参与者回复状态）

| 值 | 含义 |
|-----|------|
| `not_responded` | 未回复，参与者尚未对日程邀请做出回应 |
| `declined` | 已拒绝 |
| `accepted` | 已接受 |
| `tentative` | 暂定，参与者不确定是否参加 |

### `result`（会议室预约结果）

| 值 | 含义 |
|-----|------|
| `success` | 预约成功 |
| `failed` | 预约失败（具体原因见 `fail_reason` 字段） |
| `approving` | 审批中，需等待审批通过后才生效 |

### `recurrence.freq`（重复日程频率）

| 值 | 含义 |
|-----|------|
| `DAILY` | 每天重复 |
| `WEEKLY` | 每周重复（可配合 `by_day` 指定星期几，如 `MO`、`TU`、`WE`、`TH`、`FR`、`SA`、`SU`） |
| `MONTHLY` | 每月重复（可配合 `by_month_day` 指定第几天） |
| `YEARLY` | 每年重复（可配合 `by_month` 和 `by_month_day`） |

### `attendee_ability`（参与者权限，创建/更新日程时可选）

| 值 | 含义 |
|-----|------|
| `can_see_others` | 不能编辑日程，不能邀请其他参与者，可查看参与者列表 |
| `can_invite_others` | 不能编辑日程，可以邀请其他参与者，可查看参与者列表 |
