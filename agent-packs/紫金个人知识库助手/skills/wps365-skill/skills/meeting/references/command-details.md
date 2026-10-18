# Meeting Command Details

## 目录

- 已开始会议管理
- 会议记录与总结
- 时间与标识约束

## 会议记录与总结

### `list-records`

列会议记录、录音、导入视频等条目。

常用参数：

- `--start-time`
- `--end-time`
- `--all` — 自动循环翻页拉取全部记录（上限 20 页 / 400 条）。**查询范围 ≥ 7 天或需要完整列表时务必加此参数**，否则 API 每页最多 20 条会截断
- `--page-size`
- `--page-token`（不可与 `--all` 同时使用）
- `--user-id`

```bash
# 拉取全部记录（推荐）
python skills/meeting/run.py list-records --start-time "2026-03-01T00:00:00+08:00" --end-time "2026-04-01T23:59:59+08:00" --all

# 仅查第一页
python skills/meeting/run.py list-records --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-07T23:59:59+08:00"
```

### `record-summary <record_id>`

获取会议记录 AI 总结。通常先确认对应记录 `artifacts.has_summary` 为 `true`。

### `record-transcript <record_id>`

获取会议记录语音转写。通常先确认 `artifacts.has_transcript` 为 `true`。

### `record-chapters <record_id>`

获取会议记录章节。通常先确认 `artifacts.has_chapters` 为 `true`。

### `list-started`

按时间范围列已开始或已结束会议，支持分页，适合先拿 `meeting_id` 再继续取总结。

常用参数：

- `--start-time`（必填）
- `--end-time`（必填）
- `--all` — 自动循环翻页拉取全部会议。**查询范围 ≥ 7 天或需要完整列表时务必加此参数**
- `--page-size`
- `--page-token`（不可与 `--all` 同时使用）

```bash
# 拉取全部已开始会议（推荐）
python skills/meeting/run.py list-started --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-07T23:59:59+08:00" --all

# 手动翻页
python skills/meeting/run.py list-started --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-07T23:59:59+08:00" --page-token <token>
```

### `meeting-summary <meeting_id>`

一条命令获取会议的全部总结：遍历所有录制和纪要，逐个拉取总结内容并一起输出。输出会列出每项的来源类型（录制/纪要）、ID 和总结内容，方便对比或提取。

### `get-meeting <meeting_id>`

获取会议详情，若会议进行中则返回入会链接（`join_url`）和入会码（`join_code`）。

```bash
python skills/meeting/run.py get-meeting <meeting_id>
```

### `list-participants <meeting_id>`

获取会议的实际参会人列表。

常用参数：

- `--page-size`（默认 20，最大 100）
- `--page-token`

```bash
python skills/meeting/run.py list-participants <meeting_id>
```

## 时间与标识约束

- 时间参数优先传带时区的 ISO 8601
- 不要传无时区时间字符串
- `meeting_id` 来自 `list-started`
- `record_id` 来自 `list-records`
