#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
已开始会议和会议记录管理：调用 V7 会议接口，输出 Markdown + JSON。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法: python skills/meeting/run.py <子命令> [参数...]
"""

import argparse
import json
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_root = Path(__file__).resolve().parent.parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from wpsv7client import (  # noqa: E402
    list_meeting_records,
    get_meeting_record_summary,
    get_meeting_record_transcript,
    get_meeting_record_chapters,
    list_started_meetings,
    get_meeting,
    list_meeting_participants,
    meeting_get_recordings,
    get_recording_summary,
    meeting_get_minutes,
    get_minute_summary,
)
if os.environ.get("WPS_DISABLE_EVAL_MARKER") == "1":
    def create_marker_hooks():
        return (lambda **kwargs: None), (lambda: None)
else:
    try:
        from eval_marker import create_marker_hooks  # noqa: E402
    except ImportError:
        def create_marker_hooks():
            return (lambda **kwargs: None), (lambda: None)

_set_marker, _finalize_marker = create_marker_hooks()


def _out(md_lines, data):
    lines = [
        "",
        *md_lines,
        "",
        "## 原始数据 (JSON)",
        "",
        "```json",
        json.dumps(data, ensure_ascii=False, indent=2),
        "```",
    ]
    print("\n".join(lines))
    _finalize_marker()
    sys.stdout.flush()


def _err(msg):
    _set_marker(ERROR_EXIT=True, ERROR_MESSAGE=str(msg))
    _finalize_marker()
    print("## 错误\n\n" + msg, file=sys.stderr)
    sys.exit(1)


def _check_resp(resp):
    if resp.get("code") == -2:
        _err(f"[私网不可用] {resp.get('msg')}（此接口仅公网支持，请切换到公网或使用替代方案，不要重试）")
    if resp.get("code") != 0:
        _err(resp.get("msg") or resp.get("message") or "未知错误")
    d = resp.get("data")
    return d if d is not None else {}


_SOURCE_TYPE_LABEL = {
    "recording": "会议录制",
    "minute": "会议纪要",
    "voice_memo": "智能录音",
    "imported": "导入视频",
}
_STATUS_LABEL = {
    "processing": "处理中",
    "completed": "已完成",
    "failed": "失败",
}


_MAX_AUTO_PAGES = 20


def _fmt_record_line(i, rec):
    """格式化单条会议记录为 Markdown 行。"""
    title = rec.get("title") or "(无标题)"
    rid = rec.get("id", "")
    source = _SOURCE_TYPE_LABEL.get(rec.get("source_type", ""), rec.get("source_type", "-"))
    status = _STATUS_LABEL.get(rec.get("status", ""), rec.get("status", "-"))
    duration = rec.get("duration", 0)
    dur_str = f"{duration // 60}分{duration % 60}秒" if duration else "-"
    artifacts = rec.get("artifacts") or {}
    tags = []
    if artifacts.get("has_summary"):
        tags.append("AI总结")
    if artifacts.get("has_transcript"):
        tags.append("转写")
    if artifacts.get("has_chapters"):
        tags.append("章节")
    tag_str = "、".join(tags) if tags else "无"
    return [
        f"{i}. **{title}** `{rid}`",
        f"   来源：{source} | 状态：{status} | 时长：{dur_str} | 可用内容：{tag_str}",
    ]


def cmd_list_records(args):
    """获取会议记录列表。支持 --all 自动翻页拉取全部结果。"""
    _set_marker(ACTION_SELECTED="meeting.list-records")
    fetch_all = getattr(args, "all", False)

    if fetch_all and getattr(args, "page_token", None):
        _err("--all 与 --page-token 不能同时使用")

    start_time = getattr(args, "start_time", None) or getattr(args, "start", None) or None
    end_time = getattr(args, "end_time", None) or getattr(args, "end", None) or None
    resp = list_meeting_records(
        page_token=getattr(args, "page_token", None) or None,
        page_size=getattr(args, "page_size", None),
        start_time=start_time,
        end_time=end_time,
        user_id=getattr(args, "user_id", None) or None,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")

    if fetch_all and next_token:
        all_items = list(items)
        pages = 1
        while next_token and pages < _MAX_AUTO_PAGES:
            resp2 = list_meeting_records(
                page_token=next_token,
                page_size=getattr(args, "page_size", None),
                start_time=start_time,
                end_time=end_time,
                user_id=getattr(args, "user_id", None) or None,
            )
            d2 = resp2.get("data") or {}
            all_items.extend(d2.get("items", []))
            next_token = d2.get("next_page_token", "")
            pages += 1
        items = all_items
        data = {"items": items, "total_pages": pages}
        if next_token:
            data["next_page_token"] = next_token

    md = ["## 会议记录列表", ""]
    if fetch_all:
        md.append(f"- **总计**：{len(items)} 条（自动翻页 {data.get('total_pages', 1)} 页）")
    else:
        md.append(f"- **本页**：{len(items)} 条")
    if next_token and not fetch_all:
        md.append("")
        md.append(f"> **结果可能不完整**：当前仅展示第 1 页（{len(items)} 条），后续仍有更多记录。"
                   f"如需查看全部，请加 `--all` 参数重新查询。")
    elif next_token and fetch_all:
        md.append(f"- 记录过多，已达翻页上限，仍有后续：`--page-token {next_token}`")
    md.append("")
    for i, rec in enumerate(items, 1):
        md.extend(_fmt_record_line(i, rec))
    if len(items) > 1:
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def cmd_record_summary(args):
    """获取会议记录的 AI 总结。"""
    _set_marker(ACTION_SELECTED="meeting.record-summary")
    resp = get_meeting_record_summary(args.record_id)
    data = _check_resp(resp)
    content = data.get("content", "") if isinstance(data, dict) else ""
    md = [
        "## 会议记录总结",
        "",
        f"- **记录ID**：`{args.record_id}`",
        "",
    ]
    if content:
        md.append(content)
    else:
        md.append("暂无总结内容（该记录可能尚未生成 AI 总结）。")
    _out(md, data)


def _fmt_ms(ms) -> str:
    """将毫秒相对时间格式化为 mm:ss。"""
    if ms is None:
        return "--:--"
    total_sec = int(ms) // 1000
    return f"{total_sec // 60:02d}:{total_sec % 60:02d}"


def cmd_record_transcript(args):
    """获取会议记录的语音转写。"""
    _set_marker(ACTION_SELECTED="meeting.record-transcript")
    resp = get_meeting_record_transcript(args.record_id)
    data = _check_resp(resp)
    paragraphs = data.get("paragraphs", []) if isinstance(data, dict) else []
    md = [
        "## 会议记录转写",
        "",
        f"- **记录ID**：`{args.record_id}`",
        f"- **段落数**：{len(paragraphs)}",
        "",
    ]
    for para in paragraphs[:50]:
        speaker = para.get("speaker") or {}
        name = speaker.get("name") or "(未知发言人)"
        st = _fmt_ms(para.get("start_time", 0))
        et = _fmt_ms(para.get("end_time", 0))
        sentences = para.get("sentenses") or []
        text = "".join(s.get("text", "") for s in sentences)
        md.append(f"**{name}** ({st}~{et})：{text}")
        md.append("")
    if not paragraphs:
        md.append("暂无转写数据（该记录可能尚未生成语音转写）。")
    _out(md, data)


def cmd_record_chapters(args):
    """获取会议记录的章节列表。"""
    _set_marker(ACTION_SELECTED="meeting.record-chapters")
    resp = get_meeting_record_chapters(args.record_id)
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    md = [
        "## 会议记录章节",
        "",
        f"- **记录ID**：`{args.record_id}`",
        f"- **章节数**：{len(items)}",
        "",
    ]
    for i, ch in enumerate(items[:50], 1):
        title = ch.get("title") or "(无标题)"
        st = ch.get("start_time") or 0
        et = ch.get("end_time") or 0
        st_str = f"{int(st) // 60:02d}:{int(st) % 60:02d}"
        et_str = f"{int(et) // 60:02d}:{int(et) % 60:02d}"
        content = ch.get("content", "")
        md.append(f"### {i}. {title}（{st_str}~{et_str}）")
        md.append("")
        if content:
            md.append(content)
            md.append("")
    if not items:
        md.append("暂无章节数据（该记录可能尚未生成章节）。")
    _out(md, data)


# ----- 已开始会议 -----


def cmd_list_started(args):
    """按时间范围列出已开始的会议。支持 --all 自动翻页拉取全部结果。"""
    _set_marker(ACTION_SELECTED="meeting.list-started")
    fetch_all = getattr(args, "all", False)

    if fetch_all and getattr(args, "page_token", None):
        _err("--all 与 --page-token 不能同时使用")

    resp = list_started_meetings(
        start_time=args.start_time,
        end_time=args.end_time,
        page_token=getattr(args, "page_token", None) or None,
        page_size=getattr(args, "page_size", None) or 20,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")

    if fetch_all and next_token:
        all_items = list(items)
        pages = 1
        while next_token and pages < _MAX_AUTO_PAGES:
            resp2 = list_started_meetings(
                start_time=args.start_time,
                end_time=args.end_time,
                page_token=next_token,
                page_size=getattr(args, "page_size", None) or 20,
            )
            d2 = resp2.get("data") or {}
            all_items.extend(d2.get("items", []))
            next_token = d2.get("next_page_token", "")
            pages += 1
        items = all_items
        data = {"items": items, "total_pages": pages}
        if next_token:
            data["next_page_token"] = next_token

    md = ["## 已开始会议列表", "", f"时间：{args.start_time} ~ {args.end_time}"]
    if fetch_all:
        md.append(f"- **总计**：{len(items)} 条（自动翻页 {data.get('total_pages', 1)} 页）")
    else:
        md.append(f"- **本页**：{len(items)} 条")
    if next_token and not fetch_all:
        md.append("")
        md.append(f"> **结果可能不完整**：当前仅展示第 1 页（{len(items)} 条），后续仍有更多会议。"
                   f"如需查看全部，请加 `--all` 参数重新查询。")
    elif next_token and fetch_all:
        md.append(f"- 记录过多，已达翻页上限，仍有后续：`--page-token {next_token}`")
    md.append("")
    for m in items:
        md.append(f"- **{m.get('subject') or '(无主题)'}** `{m.get('id', '')}`")
    if len(items) > 1:
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def cmd_get_meeting(args):
    """获取会议详情。"""
    _set_marker(ACTION_SELECTED="meeting.get-meeting")
    resp = get_meeting(args.meeting_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    status_label = {"ongoing": "进行中", "ended": "已结束"}.get(data.get("status", ""), data.get("status", "-"))
    host = data.get("host_user") or {}
    md = [
        "## 会议详情",
        "",
        f"- **主题**：{data.get('subject') or '(无主题)'}",
        f"- **会议ID**：`{data.get('id', '-')}`",
        f"- **状态**：{status_label}",
        f"- **开始时间**：{data.get('start_time', '-')}",
        f"- **结束时间**：{data.get('end_time', '-')}",
        f"- **主持人**：user_id `{host.get('user_id', '-')}`",
    ]
    if data.get("join_url"):
        md.append(f"- **入会链接**：{data['join_url']}")
    if data.get("join_code"):
        md.append(f"- **入会码**：{data['join_code']}")
    _out(md, data)


def cmd_list_participants(args):
    """获取会议的实际参会人列表。"""
    _set_marker(ACTION_SELECTED="meeting.list-participants")
    resp = list_meeting_participants(
        args.meeting_id,
        page_token=getattr(args, "page_token", None) or None,
        page_size=getattr(args, "page_size", None),
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")
    md = [
        "## 会议参会人列表",
        "",
        f"- **会议ID**：`{args.meeting_id}`",
        f"- **本页**：{len(items)} 人",
    ]
    if next_token:
        md.append(f"- **下一页**：`--page-token {next_token}`")
    md.append("")
    for i, p in enumerate(items[:100], 1):
        role = "主持人" if p.get("is_host") else "参会人"
        uid = p.get("user_id", "-")
        ptype = p.get("type", "-")
        md.append(f"{i}. **{role}** — user_id: `{uid}` (type: {ptype})")
    if not items:
        md.append("暂无参会人数据。")
    _out(md, data)


def _collect_all_summaries(meeting_id: str):
    """收集该会议所有录制和纪要的总结。返回 (summaries_list, raw_payload)。

    summaries_list 每项: {"source": "recording"|"minute", "id": str, "content": str}
    """
    summaries = []
    raw = {"recordings": [], "minutes": []}

    resp = meeting_get_recordings(meeting_id)
    if resp.get("code") == 0:
        items = (resp.get("data") or {}).get("items") or []
        for item in items:
            rec_id = item.get("id") or item.get("recording_id")
            if not rec_id:
                continue
            r = get_recording_summary(meeting_id, str(rec_id))
            content = ""
            if r.get("code") == 0:
                content = (r.get("data") or {}).get("content") or ""
            summaries.append({"source": "recording", "id": str(rec_id), "content": content})
        raw["recordings"] = items

    resp = meeting_get_minutes(meeting_id)
    if resp.get("code") == 0:
        items = (resp.get("data") or {}).get("items") or []
        for item in items:
            minute_id = item.get("id")
            if not minute_id:
                continue
            r = get_minute_summary(meeting_id, str(minute_id))
            content = ""
            if r.get("code") == 0:
                content = (r.get("data") or {}).get("content") or ""
            summaries.append({"source": "minute", "id": str(minute_id), "content": content})
        raw["minutes"] = items

    return summaries, raw


def cmd_meeting_summary(args):
    """一条命令获取会议全部总结：遍历所有录制和纪要，返回每项的总结。"""
    _set_marker(ACTION_SELECTED="meeting.meeting-summary")
    meeting_id = args.meeting_id
    summaries, raw = _collect_all_summaries(meeting_id)
    if not summaries:
        _err("该会议暂无可用总结（无录制且无纪要，或接口未返回内容）")

    has_content = [s for s in summaries if s["content"]]
    source_label = {"recording": "录制", "minute": "纪要"}
    md = [
        "## 会议总结",
        "",
        f"- **会议ID**：`{meeting_id}`",
        f"- **录制**：{sum(1 for s in summaries if s['source'] == 'recording')} 个",
        f"- **纪要**：{sum(1 for s in summaries if s['source'] == 'minute')} 个",
        f"- **有总结内容**：{len(has_content)} 个",
        "",
    ]
    for i, s in enumerate(summaries, 1):
        label = source_label.get(s["source"], s["source"])
        md.append(f"### {i}. {label} `{s['id']}`")
        md.append("")
        if s["content"]:
            md.append(s["content"])
        else:
            md.append("（该项暂无总结内容）")
        md.append("")

    payload = {"meeting_id": meeting_id, "summaries": summaries}
    _out(md, payload)


def main():
    parser = argparse.ArgumentParser(description="会议（V7）：已开始会议与会议记录")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list-records", help="获取会议记录列表（含会议/录音/导入等多种类型）")
    p.add_argument("--start-time", "--start", dest="start_time", default=None,
                   help="查询开始时间 ISO 8601 或 Unix 秒")
    p.add_argument("--end-time", "--end", dest="end_time", default=None,
                   help="查询结束时间 ISO 8601 或 Unix 秒")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，默认20，最大20")
    p.add_argument("--page-token", default=None, help="分页凭证")
    p.add_argument("--all", action="store_true", default=False,
                   help="自动翻页拉取全部记录（不可与 --page-token 同时使用）")
    p.add_argument("--user-id", default=None, help="指定 user_id（应用身份调用时必填）")
    p.set_defaults(func=cmd_list_records)

    p = sub.add_parser("record-summary", help="获取会议记录的 AI 总结")
    p.add_argument("record_id", help="会议记录ID（从 list-records 获取）")
    p.set_defaults(func=cmd_record_summary)

    p = sub.add_parser("record-transcript", help="获取会议记录的语音转写")
    p.add_argument("record_id", help="会议记录ID（从 list-records 获取）")
    p.set_defaults(func=cmd_record_transcript)

    p = sub.add_parser("record-chapters", help="获取会议记录的章节列表")
    p.add_argument("record_id", help="会议记录ID（从 list-records 获取）")
    p.set_defaults(func=cmd_record_chapters)

    p = sub.add_parser("list-started", help="按时间范围列出已开始会议（取 meeting_id）")
    p.add_argument("--start-time", "--start", dest="start_time", required=True,
                   help="开始时间 ISO 8601 或 Unix 秒")
    p.add_argument("--end-time", "--end", dest="end_time", required=True,
                   help="结束时间 ISO 8601 或 Unix 秒")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，默认20，最大50")
    p.add_argument("--page-token", default=None, help="分页凭证")
    p.add_argument("--all", action="store_true", default=False,
                   help="自动翻页拉取全部会议（不可与 --page-token 同时使用）")
    p.set_defaults(func=cmd_list_started)

    p = sub.add_parser("get-meeting", help="获取会议详情（进行中会议返回入会链接）")
    p.add_argument("meeting_id", help="会议ID（从 list-started 获取）")
    p.set_defaults(func=cmd_get_meeting)

    p = sub.add_parser("list-participants", help="获取会议的实际参会人列表")
    p.add_argument("meeting_id", help="会议ID（从 list-started 获取）")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，默认20，最大100")
    p.add_argument("--page-token", default=None, help="分页凭证")
    p.set_defaults(func=cmd_list_participants)

    p = sub.add_parser("meeting-summary", help="获取会议全部总结（遍历所有录制与纪要）")
    p.add_argument("meeting_id", help="会议ID（已开始/已结束）")
    p.set_defaults(func=cmd_meeting_summary)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
