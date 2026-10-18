# Meeting I/O Details

## 输出约定

默认输出分两段：

1. Markdown 摘要
2. `## 原始数据 (JSON)` 下的完整 JSON

后续代理通常要从 JSON 里继续提取：

- `meeting_id`
- `record_id`
- `next_page_token`

## 关键命令的返回重点

### `list-records`

关注：

- `id`
- `title`
- `source_type`
- `status`
- `duration`
- `artifacts.has_summary`
- `artifacts.has_transcript`
- `artifacts.has_chapters`
- `next_page_token`

### `record-summary`

关注：

- `content`

### `record-transcript`

关注：

- `paragraphs`
- `speaker`
- `sentenses`
- `start_time`
- `end_time`

### `record-chapters`

关注：

- `items[].title`
- `items[].content`
- `items[].start_time`
- `items[].end_time`

### `list-started`

关注：

- `items[].id`
- `items[].subject`
- `next_page_token`

这里的 `id` 就是后续 `meeting-summary` 需要的 `meeting_id`。时间窗较大时注意检查 `next_page_token`，有值则表示还有下一页，需继续翻页。

### `meeting-summary`

关注：

- `summaries[]`：所有录制和纪要总结的数组
- `summaries[].source`（`recording` 或 `minute`）
- `summaries[].id`（录制或纪要的 ID）
- `summaries[].content`（总结文本，无总结时为空字符串）

该命令会遍历所有录制和纪要并逐个拉取总结，全部返回。

### `get-meeting`

关注：

- `id`
- `subject`
- `status`（`ongoing` / `ended`）
- `start_time`
- `end_time`
- `host_user.user_id`
- `join_url`（进行中会议）
- `join_code`（进行中会议）

### `list-participants`

关注：

- `items[].user_id`
- `items[].type`
- `items[].is_host`
- `next_page_token`

## 错误模式

- 缺少 `WPS_SID`：先补环境变量
- 401 / 403：凭证失效或权限不足
- 无时区时间：很容易被按 UTC 解析，导致会议时间偏移
- `meeting-summary` 无结果：通常表示无录制、无纪要，或接口未返回内容
- `record-summary` / `record-transcript` / `record-chapters` 无结果：通常表示对应 artifact 尚未生成
