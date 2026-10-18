---
name: meeting
description: WPS 365 已开始会议与会后产物管理工具。支持查询已开始会议列表、会议详情、入会链接、入会码、实际参会人，并获取会议录制/纪要的总结；也可从会后产物角度获取会议记录列表及其 AI 总结、转写、章节。用户提到已开始会议、会议详情、入会链接、入会码、实际参会人、参会记录、会议记录、会议纪要、会议总结、会议转写、会议章节，或需要提取 meeting_id、record_id 时使用。会议的预约/修改/取消以及参会人和会议室管理，请使用日历 skill。
---

# 已开始会议与会后产物

用这个 skill 处理两类任务：查询已开始会议（列表、指定会议的详情、指定会议的参会人、指定会议的总结）、管理会议记录（列表、转写、总结、章节）。

**会议预约（创建/修改/取消会议、管理参会人、预约会议室）请使用 [日历 skill](../calendar/SKILL.md)**，通过 `create-event --online-meeting` 同步预约线上会议。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 快速使用

```bash
python skills/meeting/run.py <子命令> [参数...]
```

## 决策规则

- 用户要拿某场会议的总结、纪要总结、会后总结，或问“这场会议讨论了什么”，但还没有 `meeting_id`：
  先用 `list-started` 找 `meeting_id`，再用 `meeting-summary`
- 用户已经有 `meeting_id`，要看某场会议的总结、纪要总结、会后总结，或明确要求列出这场会议**全部录制/全部纪要**的总结：
  直接用 `meeting-summary`
- 用户要看会议详情、入会链接或入会码：
  先确保有 `meeting_id`，再用 `get-meeting`
- 用户要看某场会议**实际哪些人入会参加了**（真实参会人）：
  先确保有 `meeting_id`，再用 `list-participants`
- 用户要看会议记录、录音、导入视频、智能录音等记录条目：
  先用 `list-records`
- 用户要拿会议记录的 AI 总结、转写或章节：
  先确保有 `record_id`，再用 `record-summary`、`record-transcript`、`record-chapters`

### 分页策略（重要）

- API 每页最多 20 条。首次查询**不加** `--all`，先展示第一页结果
- 若输出中出现 **"结果可能不完整"** 提示，说明后续还有更多记录被截断。此时**必须询问用户**是否需要查看全部，得到确认后再加 `--all` 重新查询
- 若用户在指令中明确要求"全部""所有""完整列表"，可直接加 `--all`，无需二次确认
- `--all` 会自动循环翻页（上限 20 页 / 400 条），无需手动传 `--page-token`
- `--all` 不可与 `--page-token` 同时使用

## 子命令分组



### 已开始会议

- `list-started`：按时间范围列已开始会议，获取 `meeting_id`（支持 `--all` 自动翻页）
- `get-meeting`：获取指定的已开始会议的详情，需要`meeting_id`，进行中会议返回入会链接和入会码（真实会议信息，注意与日程详情区别）
- `list-participants`：获取指定会议**实际入会**的参会人列表，需要`meeting_id`（真实参会记录，注意与日程参与者列表区分，日程是预邀请）
- `meeting-summary`：获取指定会议全部可用总结，需要`meeting_id`（遍历录制和纪要并返回所有总结项）

### 会议记录（会后产物）

- `list-records`：列会议记录列表，从会后产物维度直接获取列表（支持 `--all` 自动翻页），注意和先查会议列表再获取指定会议的总结的差别（录音、智能纪要、导入视频等），获取 `record_id`
- `record-summary`：取指定会议记录 AI 总结，需要`record_id`
- `record-transcript`：取指定会议记录转写，需要`record_id`
- `record-chapters`：取指定会议记录章节，需要`record_id`

## 高风险操作

本 skill 均为只读查询，**无**写入副作用子命令。

## 关键约束

- `meeting_id` 来自 `list-started`，不要臆造
- `record_id` 来自 `list-records`，不要跳过直接猜
- 时间参数统一使用 `--start-time` / `--end-time`
- 时间参数优先使用带时区的 ISO 8601，例如 `2026-03-02T16:00:00+08:00` 或 `2026-03-02T08:00:00Z`
- 不要传无时区时间，例如 `2026-03-02T14:00:00`；这会按 UTC 解析，东八区场景很容易错 8 小时
- `meeting-summary` 需要 `meeting_id`；没有时先用 `list-started`
- `record-summary`、`record-transcript`、`record-chapters` 都依赖 `record_id`；没有时先用 `list-records`
- `record-summary`、`record-transcript`、`record-chapters` 对应能力是否可用，要看记录条目的 `artifacts`

需要参数细节、输出重点时，查看：

- [references/command-details.md](references/command-details.md)
- [references/io-details.md](references/io-details.md)

## 常用示例

```bash
# 查过去一个月全部会议记录（自动翻页，不会遗漏）
python skills/meeting/run.py list-records --start-time "2026-03-01T00:00:00+08:00" --end-time "2026-04-01T23:59:59+08:00" --all

# 查最近一周记录（条数较少时也建议加 --all 保险）
python skills/meeting/run.py list-records --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-07T23:59:59+08:00" --all
python skills/meeting/run.py record-summary <record_id>

# 全量列出已开始会议再取总结
python skills/meeting/run.py list-started --start-time "2026-04-01T00:00:00+08:00" --end-time "2026-04-07T23:59:59+08:00" --all
python skills/meeting/run.py meeting-summary <meeting_id>

# 查看会议详情（进行中会议可拿入会链接）
python skills/meeting/run.py get-meeting <meeting_id>

# 查看某场会议的实际参会人
python skills/meeting/run.py list-participants <meeting_id>
```

## 输出格式

默认先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`，便于继续提取 `meeting_id`、`record_id`、`page_token` 等标识。

## 注意事项

- **分页场景必须检查完整性**：`list-records` / `list-started` 若未使用 `--all`，必须检查返回中的 `next_page_token`。存在 next_page_token 时只能下“当前页结果”结论，不能直接下“没有/唯一/全部”结论
- 只知道“上周那个评审会”时，不要臆造 `meeting_id`，先按时间范围列会议或已开始会议
- 只知道“某条会议记录”时，不要跳过 `list-records` 直接猜 `record_id`
- 需要定位单条会议或记录但命中多条时，须通过 `askUserQuestion` 让用户选择，不得自行挑选
- 需要完整参数说明或确认最新 CLI 行为时，以 `python skills/meeting/run.py <子命令> -h` 为准
