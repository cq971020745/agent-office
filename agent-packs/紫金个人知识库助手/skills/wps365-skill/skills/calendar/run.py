#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日历与日程增删改查：调用 V7 日历/日程接口，输出 Markdown + JSON。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法: python skills/calendar/run.py <子命令> [参数...]
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
    list_calendars,
    get_calendar,
    create_calendar,
    update_calendar,
    delete_calendar,
    list_events,
    get_event,
    create_event,
    update_event,
    delete_event,
    list_event_attendees,
    batch_create_event_attendees,
    batch_delete_event_attendees,
    list_room_levels,
    list_rooms,
    list_event_meeting_rooms,
    add_event_rooms,
    delete_event_rooms,
    list_free_busy,
    list_calendar_permissions,
    create_calendar_permission,
    delete_calendar_permission,
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
    compact_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    lines = [""] + md_lines + ["", "## 原始数据 (JSON)", "", "```json", compact_json, "```"]
    print("\n".join(lines))
    _finalize_marker()
    sys.stdout.flush()


def _err(msg):
    _set_marker(ERROR_EXIT=True, ERROR_MESSAGE=str(msg))
    _finalize_marker()
    sys.stdout.flush()
    print("## 错误\n\n" + msg, file=sys.stderr)
    sys.exit(1)


def _normalize_multiline_text(text):
    """将字面量转义换行还原为真实换行，提升描述字段可读性。"""
    if text is None or not isinstance(text, str):
        return text
    return (
        text.replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .replace("\\t", "\t")
    )


# 日程更新时若内容无变化，接口返回此码，视为成功
EVENT_NO_CHANGE_CODE = 400411340


def _mutation_gate(action_title, detail_lines, confirmed):
    md = [f"## {action_title}", ""]
    md.extend(detail_lines)
    if confirmed:
        return False, md
    md.extend([
        "",
        "**当前为 Dry Run，未执行实际变更。**",
        "",
        "请通过 `askUserQuestion` 向用户确认，确认后再追加 `--confirm` 重新执行。",
        "注意：之前对话中对其他操作的确认不适用于本次操作，必须获得用户对本次操作的单独确认。",
    ])
    return True, md


def _set_mutation_marker(action_selected: str, confirmed: bool) -> None:
    """与 todo/mail 对齐：变更类子命令须在 MARKER 中体现 dry-run / 需单独确认，供 L3 finalize 采信。"""
    _set_marker(
        ACTION_SELECTED=action_selected,
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not confirmed,
        ASK_USER_REQUIRED=not confirmed,
    )


def _check_resp(resp, ignore_codes=None):
    """先判断 code 正常（或属于可忽略码），再返回 data。与用户信息 skill 一致。"""
    if resp.get("code") == -2:
        _err(f"[私网不可用] {resp.get('msg')}（此接口仅公网支持，请切换到公网或使用替代方案，不要重试）")
    code = resp.get("code")
    if code == 0:
        d = resp.get("data")
        return d if d is not None else {}
    if ignore_codes and code in ignore_codes:
        return resp.get("data") if resp.get("data") is not None else {}
    _err(resp.get("msg") or resp.get("message") or "未知错误")


def cmd_list_calendars(args):
    _set_marker(ACTION_SELECTED="calendar.list-calendars")
    resp = list_calendars(
        page_token=getattr(args, "page_token", None),
        page_size=getattr(args, "page_size", 20),
        fetch_all=getattr(args, "fetch_all", False),
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    scope = "全部结果" if getattr(args, "fetch_all", False) else "当前结果"
    md = ["## 日历列表", "", f"共 {len(items)} 条（{scope}）"]
    if items:
        md.append("")
        for c in items[:20]:
            md.append(f"- **{c.get('summary', '-')}** `{c.get('id', '')}`")
    _append_next_page(md, data)
    if len(items) > 1:
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def cmd_get_calendar(args):
    _set_marker(ACTION_SELECTED="calendar.get-calendar")
    resp = get_calendar(args.calendar_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    s = data.get("summary") or "-"
    desc = _normalize_multiline_text(data.get("description")) or "-"
    md = ["## 日历详情", "", f"- **标题**：{s}", f"- **ID**：{data.get('id', '-')}", f"- **颜色**：{data.get('color', '-')}"]
    md.extend(["- **描述**：", "", desc])
    _out(md, data)


def cmd_create_calendar(args):
    _set_mutation_marker("calendar.create-calendar", args.confirm)
    desc = _normalize_multiline_text(args.desc or "")
    detail = [
        f"- **标题**：{args.title}",
        f"- **颜色**：{args.color}",
    ]
    if desc:
        detail.extend(["- **描述**：", "", desc])
    else:
        detail.append("- **描述**：-")
    is_dry_run, md = _mutation_gate("创建日历", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "title": args.title, "color": args.color, "description": desc or None})
        return
    resp = create_calendar(summary=args.title, color=args.color, description=desc)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append(f"- **标题**：{data.get('summary', '-')}")
    md.append(f"- **ID**：{data.get('id', '-')}")
    if desc:
        md.extend(["- **描述**：", "", desc])
    _out(md, data)


def cmd_update_calendar(args):
    _set_mutation_marker("calendar.update-calendar", args.confirm)
    kwargs = {}
    if args.title is not None:
        kwargs["summary"] = args.title
    if args.color is not None:
        kwargs["color"] = args.color
    if args.desc is not None:
        kwargs["description"] = _normalize_multiline_text(args.desc)
    if not kwargs:
        _err("请至少指定 --title、--color 或 --desc 之一")
    detail = [f"- **日历ID**：`{args.calendar_id}`"]
    if "summary" in kwargs:
        detail.append(f"- **标题**：{kwargs['summary']}")
    if "color" in kwargs:
        detail.append(f"- **颜色**：{kwargs['color']}")
    if "description" in kwargs:
        d = kwargs["description"]
        if d:
            detail.extend(["- **描述**：", "", d])
        else:
            detail.append("- **描述**：-")
    is_dry_run, md = _mutation_gate("更新日历", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id, **kwargs})
        return
    resp = update_calendar(args.calendar_id, **kwargs)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append(f"日历 `{args.calendar_id}` 已更新。")
    _out(md, data)


def cmd_delete_calendar(args):
    _set_mutation_marker("calendar.delete-calendar", args.confirm)
    detail = [f"- **日历ID**：`{args.calendar_id}`"]
    is_dry_run, md = _mutation_gate("删除日历", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id})
        return
    resp = delete_calendar(args.calendar_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append(f"日历 `{args.calendar_id}` 已删除。")
    _out(md, data)


def cmd_list_events(args):
    _set_marker(ACTION_SELECTED="calendar.list-events")
    fetch_all = getattr(args, "fetch_all", False)
    page_size = getattr(args, "page_size", 50)
    page_token = getattr(args, "page_token", None)
    keyword = (getattr(args, "keyword", None) or "").strip() or None
    filter_whole_range = bool(keyword)

    if not fetch_all and not filter_whole_range:
        resp = list_events(
            args.calendar_id,
            start_time=args.start_time,
            end_time=args.end_time,
            page_token=page_token,
            page_size=page_size,
        )
        data = _check_resp(resp)
    else:
        merged_items = []
        next_token = None if filter_whole_range else page_token
        base_data = {}
        max_pages = 200
        for _ in range(max_pages):
            resp = list_events(
                args.calendar_id,
                start_time=args.start_time,
                end_time=args.end_time,
                page_token=next_token,
                page_size=100,
            )
            page_data = _check_resp(resp)
            if isinstance(page_data, dict):
                if not base_data:
                    base_data = dict(page_data)
                items = page_data.get("items", [])
                if isinstance(items, list):
                    merged_items.extend(items)
                next_token = (page_data.get("next_page_token") or page_data.get("page_token") or "").strip() or None
            else:
                next_token = None
            if not next_token:
                break
        else:
            _err(f"list-events 自动翻页超过 {max_pages} 页上限，请缩小时间范围后重试")

        data = base_data if isinstance(base_data, dict) else {}
        data["items"] = merged_items
        data["next_page_token"] = next_token or ""
        data["page_token"] = data["next_page_token"]
        data["items"] = _filter_events_by_keyword(merged_items, keyword)

    items = data.get("items", []) if isinstance(data, dict) else []
    scope = "全部结果" if (fetch_all or filter_whole_range) else "当前结果"
    md = ["## 日程列表", "", f"时间区间：{args.start_time} ~ {args.end_time}"]
    if keyword:
        md.append(f"标题过滤：`summary` 包含 `{keyword}`")
    md.append(f"共 {len(items)} 条（{scope}）")
    if items:
        md.append("")
        for e in items[:30]:
            title = e.get("summary") or "(无标题)"
            eid = e.get("id", "")
            md.append(f"- **{title}** `{eid}`")
    _append_next_page(md, data)
    if not fetch_all and not filter_whole_range and isinstance(data, dict) and (data.get("next_page_token") or data.get("page_token")):
        md.extend([
            "",
            "> 当前仅返回部分结果。若需完整区间，请追加 `--all` 自动翻页，或用 `--page-token` 继续分页。",
        ])
    if keyword:
        md.extend([
            "",
            "> 已在代码中按整个时间区间内的 `summary` 做关键字过滤，避免因分页遗漏匹配结果。",
        ])
        if page_token:
            md.extend([
                "",
                "> 使用 `--keyword` 时会忽略 `--page-token`，以保证过滤范围覆盖整个时间区间。",
            ])
    if len(items) > 1:
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def _format_free_busy_time(t):
    """忙闲接口返回的 start/end 可能是字符串或 dict。"""
    if t is None:
        return "-"
    if isinstance(t, dict):
        return t.get("datetime") or t.get("date") or str(t)
    return str(t)


def _format_calendar_time(t):
    if t is None:
        return "-"
    if isinstance(t, dict):
        return t.get("datetime") or t.get("date") or "-"
    return str(t)


def _filter_events_by_keyword(items, keyword):
    if not keyword:
        return items
    keyword_lower = keyword.lower()
    return [
        item for item in items
        if keyword_lower in str((item or {}).get("summary") or "").lower()
    ]


def cmd_get_event(args):
    _set_marker(ACTION_SELECTED="calendar.get-event")
    resp = get_event(args.calendar_id, args.event_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    st = _format_calendar_time(data.get("start_time"))
    et = _format_calendar_time(data.get("end_time"))
    desc = _normalize_multiline_text(data.get("description")) or "-"
    attendees = data.get("attendees") or []
    locations = data.get("locations") or []
    location_names = [str(item.get("name", "-")) for item in locations[:3] if isinstance(item, dict)]
    location_text = "、".join(location_names) if location_names else "-"
    md = [
        "## 日程详情",
        "",
        f"- **标题**：{data.get('summary', '-')}",
        f"- **ID**：{data.get('id', '-')}",
        f"- **开始**：{st}",
        f"- **结束**：{et}",
        f"- **地点**：{location_text}",
        f"- **参与者数**：{len(attendees)}",
        "- **描述**：",
        "",
        desc,
    ]
    _out(md, data)


def _split_ids(s):
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


def _append_next_page(md_lines, data):
    if not isinstance(data, dict):
        return
    token = data.get("next_page_token") or data.get("page_token")
    if token:
        md_lines.extend(["", f"- **next_page_token**：`{token}`"])


def _build_online_meeting(args):
    """根据 --online-meeting 开关构建 online_meeting dict，默认 provider=kso。"""
    if not getattr(args, "online_meeting", False):
        return None
    return {"provider": "kso"}


def _build_recurrence(args):
    """解析 --recurrence JSON 字符串为 dict；未传则返回 None。"""
    raw = getattr(args, "recurrence", None)
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        _err(f"--recurrence 必须是合法 JSON：{raw}")


def _build_reminders(args):
    """解析 --reminders 为列表；未传则返回 None。"""
    raw = getattr(args, "reminders", None)
    if not raw:
        return None
    if isinstance(raw, list):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else [parsed]
    except (json.JSONDecodeError, TypeError):
        _err(f"--reminders 必须是合法 JSON 数组：{raw}")


def cmd_create_event(args):
    _set_mutation_marker("calendar.create-event", args.confirm)
    attendee_ids = _split_ids(args.attendees) if getattr(args, "attendees", None) else None
    attach_ids = getattr(args, "attach", None) or []
    if isinstance(attach_ids, str):
        attach_ids = [attach_ids]
    desc = _normalize_multiline_text(args.desc)
    online_meeting = _build_online_meeting(args)
    recurrence = _build_recurrence(args)
    reminders = _build_reminders(args)
    detail = [
        f"- **日历ID**：`{args.calendar_id}`",
        f"- **标题**：{args.title or '(无标题)'}",
        f"- **时间**：{args.start_time} ~ {args.end_time}",
    ]
    if getattr(args, "location", None):
        detail.append(f"- **地点**：{args.location}")
    if attendee_ids:
        detail.append(f"- **参与者**：{len(attendee_ids)} 人")
    if attach_ids:
        detail.append(f"- **附件数**：{len(attach_ids)}")
    if recurrence:
        detail.append(f"- **重复规则**：`{json.dumps(recurrence, ensure_ascii=False)}`")
    if reminders:
        detail.append(f"- **提醒**：{json.dumps(reminders, ensure_ascii=False)}")
    is_dry_run, md = _mutation_gate("创建日程", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id, "title": args.title, "start": args.start_time, "end": args.end_time})
        return
    resp = create_event(
        args.calendar_id,
        start_time=args.start_time,
        end_time=args.end_time,
        summary=args.title,
        description=desc,
        location=getattr(args, "location", None) or None,
        attachment_file_ids=attach_ids if attach_ids else None,
        attendee_user_ids=attendee_ids,
        online_meeting=online_meeting,
        recurrence=recurrence,
        reminders=reminders,
        visibility=getattr(args, "visibility", None),
        free_busy_status=getattr(args, "free_busy_status", None),
        attendee_ability=getattr(args, "attendee_ability", None),
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append(f"- **ID**：{data.get('id', '-')}")
    md.append("日程已创建。")
    _out(md, data)


def cmd_update_event(args):
    _set_mutation_marker("calendar.update-event", args.confirm)
    kwargs = {}
    if args.title is not None:
        kwargs["summary"] = args.title
    if args.desc is not None:
        kwargs["description"] = _normalize_multiline_text(args.desc)
    if args.start_time is not None:
        kwargs["start_time"] = args.start_time
    if args.end_time is not None:
        kwargs["end_time"] = args.end_time
    if getattr(args, "location", None) is not None:
        kwargs["location"] = args.location
    attach = getattr(args, "attach", None)
    if attach is not None and (attach if isinstance(attach, list) else [attach]):
        kwargs["attachment_file_ids"] = attach if isinstance(attach, list) else [attach]
    online_meeting = _build_online_meeting(args)
    if online_meeting is not None:
        kwargs["online_meeting"] = online_meeting
    recurrence = _build_recurrence(args)
    if recurrence is not None:
        kwargs["recurrence"] = recurrence
    reminders = _build_reminders(args)
    if reminders is not None:
        kwargs["reminders"] = reminders
    if getattr(args, "visibility", None) is not None:
        kwargs["visibility"] = args.visibility
    if getattr(args, "free_busy_status", None) is not None:
        kwargs["free_busy_status"] = args.free_busy_status
    if getattr(args, "attendee_ability", None) is not None:
        kwargs["attendee_ability"] = args.attendee_ability
    attendee_ids = _split_ids(getattr(args, "attendees", None) or "")
    remove_attendee_ids = _split_ids(getattr(args, "remove_attendees", None) or "")
    if not kwargs and not attendee_ids and not remove_attendee_ids:
        _err("请至少指定 --title、--desc、--start、--end、--location、--attach、--attendees、--remove-attendees、--recurrence 等之一")
    detail = [f"- **日历ID**：`{args.calendar_id}`", f"- **日程ID**：`{args.event_id}`"]
    for k, v in kwargs.items():
        detail.append(f"- **{k}**：`{v}`")
    if attendee_ids:
        detail.append(f"- **追加参与者**：{len(attendee_ids)} 人")
    if remove_attendee_ids:
        detail.append(f"- **移除参与者**：{len(remove_attendee_ids)} 人")
    is_dry_run, md = _mutation_gate("更新日程", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id, "event_id": args.event_id, "updates": kwargs})
        return
    if kwargs:
        resp = update_event(args.calendar_id, args.event_id, **kwargs)
        data = _check_resp(resp, ignore_codes={EVENT_NO_CHANGE_CODE})
    else:
        data = {}
    if attendee_ids:
        add_resp = batch_create_event_attendees(args.calendar_id, args.event_id, attendee_ids)
        _check_resp(add_resp)
    if remove_attendee_ids:
        del_resp = batch_delete_event_attendees(args.calendar_id, args.event_id, remove_attendee_ids)
        _check_resp(del_resp)
    md.append("")
    md.append(f"日程 `{args.event_id}` 已更新。")
    _out(md, data)


def cmd_delete_event(args):
    _set_mutation_marker("calendar.delete-event", args.confirm)
    detail = [f"- **日历ID**：`{args.calendar_id}`", f"- **日程ID**：`{args.event_id}`"]
    is_dry_run, md = _mutation_gate("删除日程", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id, "event_id": args.event_id})
        return
    resp = delete_event(args.calendar_id, args.event_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append(f"日程 `{args.event_id}` 已删除。")
    _out(md, data)


def cmd_list_event_attendees(args):
    """查询日程参与者列表。"""
    _set_marker(ACTION_SELECTED="calendar.list-event-attendees")
    resp = list_event_attendees(
        args.calendar_id,
        args.event_id,
        page_token=getattr(args, "page_token", None) or None,
        page_size=getattr(args, "page_size", None),
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")
    md = [
        "## 日程参与者列表",
        "",
        f"- **日历**：`{args.calendar_id}`",
        f"- **日程**：`{args.event_id}`",
        f"- **本页**：{len(items)} 条",
    ]
    if next_token:
        md.append(f"- **下一页**：`--page-token {next_token}`")
    md.append("")
    for i, att in enumerate(items[:50], 1):
        name = att.get("name") or "(未知)"
        status = att.get("response_status", "-")
        uid = att.get("user_id") or att.get("id") or ""
        md.append(f"{i}. **{name}** `{uid}` — {status}")
    _out(md, data)


def cmd_add_event_attendees(args):
    """批量添加日程参与者。"""
    _set_marker(ACTION_SELECTED="calendar.add-event-attendees")
    user_ids = _split_ids(args.user_ids)
    if not user_ids:
        _err("请通过 --user-ids 提供用户ID（逗号分隔，最多200个）")
    resp = batch_create_event_attendees(
        args.calendar_id,
        args.event_id,
        user_ids,
        is_notification=args.notify if hasattr(args, "notify") else None,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    md = [
        "## 已添加日程参与者",
        "",
        f"- **日历**：`{args.calendar_id}`",
        f"- **日程**：`{args.event_id}`",
        f"- **共 {len(items)} 位参与者**",
        "",
    ]
    for i, att in enumerate(items[:50], 1):
        name = att.get("name") or "(未知)"
        uid = att.get("user_id") or att.get("id") or ""
        md.append(f"{i}. **{name}** `{uid}`")
    _out(md, data)


def cmd_delete_event_attendees(args):
    """批量删除日程参与者。"""
    _set_mutation_marker("calendar.delete-event-attendees", args.confirm)
    attendee_ids = _split_ids(args.attendee_ids)
    if not attendee_ids:
        _err("请通过 --attendee-ids 提供参与者ID（逗号分隔，最多50个，从参与者列表获取）")
    detail = [
        f"- **日历**：`{args.calendar_id}`",
        f"- **日程**：`{args.event_id}`",
        f"- **待删除参与者**：{len(attendee_ids)} 位",
    ]
    is_dry_run, md = _mutation_gate("删除日程参与者", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "attendee_ids": attendee_ids})
        return
    resp = batch_delete_event_attendees(
        args.calendar_id,
        args.event_id,
        attendee_ids,
        is_notification=args.notify if hasattr(args, "notify") else None,
    )
    data = _check_resp(resp)
    md.append("")
    md.append(f"已删除 {len(attendee_ids)} 位参与者。")
    _out(md, data)


def cmd_list_room_levels(args):
    """查询会议室层级列表。"""
    _set_marker(ACTION_SELECTED="calendar.list-room-levels")
    resp = list_room_levels(
        room_level_id=getattr(args, "room_level_id", None) or None,
        page_size=getattr(args, "page_size", None),
        page_token=getattr(args, "page_token", None) or None,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")
    md = ["## 会议室层级列表", ""]
    if getattr(args, "room_level_id", None):
        md.append(f"- **父层级ID**：`{args.room_level_id}`")
    md.append(f"- **本页**：{len(items)} 条")
    if next_token:
        md.append(f"- **下一页**：`--page-token {next_token}`")
    md.append("")
    for i, level in enumerate(items[:50], 1):
        path = level.get("path") or []
        path_str = " / ".join(path) if path else level.get("name", "-")
        md.append(f"{i}. **{level.get('name', '-')}** `{level.get('id', '')}` — {path_str}")
    _out(md, data)


def cmd_list_rooms(args):
    """查询会议室列表。"""
    _set_marker(ACTION_SELECTED="calendar.list-rooms")
    resp = list_rooms(
        room_level_id=getattr(args, "room_level_id", None) or None,
        page_size=getattr(args, "page_size", None),
        page_token=getattr(args, "page_token", None) or None,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")
    md = ["## 会议室列表", ""]
    if getattr(args, "room_level_id", None):
        md.append(f"- **层级ID**：`{args.room_level_id}`")
    md.append(f"- **本页**：{len(items)} 条")
    if next_token:
        md.append(f"- **下一页**：`--page-token {next_token}`")
    md.append("")
    for i, room in enumerate(items[:50], 1):
        name = room.get("name") or "(未命名)"
        rid = room.get("id", "")
        capacity = room.get("capacity")
        cap_str = f"（容纳 {capacity} 人）" if capacity else ""
        md.append(f"{i}. **{name}** `{rid}`{cap_str}")
    _out(md, data)


def cmd_list_event_rooms(args):
    """查询日程会议室列表。"""
    _set_marker(ACTION_SELECTED="calendar.list-event-rooms")
    resp = list_event_meeting_rooms(args.calendar_id, args.event_id)
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    md = [
        "## 日程会议室列表",
        "",
        f"- **日历**：`{args.calendar_id}`",
        f"- **日程**：`{args.event_id}`",
        f"- **共 {len(items)} 个会议室**",
        "",
    ]
    for i, room in enumerate(items[:50], 1):
        result = room.get("result", "-")
        reason = room.get("fail_reason", "")
        md.append(f"{i}. **{room.get('name', '-')}** `{room.get('room_id', '')}` — {result}" + (f"（{reason}）" if reason else ""))
    _out(md, data)

def cmd_add_event_rooms(args):
    """批量添加日程会议室。"""
    _set_marker(ACTION_SELECTED="calendar.add-event-rooms")
    room_ids = _split_ids(args.room_ids)
    if not room_ids:
        _err("请通过 --room-ids 提供会议室ID（逗号分隔，最多40个）")
    resp = add_event_rooms(args.calendar_id, args.event_id, room_ids)
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    md = [
        "## 已添加日程会议室",
        "",
        f"- **日历**：`{args.calendar_id}`",
        f"- **日程**：`{args.event_id}`",
        f"- **共 {len(items)} 个会议室**",
        "",
    ]
    for i, room in enumerate(items[:40], 1):
        result = room.get("result", "-")
        reason = room.get("fail_reason", "")
        md.append(f"{i}. **{room.get('name', '-')}** `{room.get('room_id', '')}` — {result}" + (f"（{reason}）" if reason else ""))
    _out(md, data)


def cmd_delete_event_rooms(args):
    """批量删除日程会议室。"""
    _set_mutation_marker("calendar.delete-event-rooms", args.confirm)
    room_ids = _split_ids(args.room_ids)
    if not room_ids:
        _err("请通过 --room-ids 提供要删除的会议室ID（逗号分隔，最多50个）")
    detail = [
        f"- **日历**：`{args.calendar_id}`",
        f"- **日程**：`{args.event_id}`",
        f"- **待删除会议室**：{len(room_ids)} 个",
    ]
    is_dry_run, md = _mutation_gate("删除日程会议室", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "room_ids": room_ids})
        return
    resp = delete_event_rooms(args.calendar_id, args.event_id, room_ids)
    data = _check_resp(resp)
    md.append("")
    md.append(f"已删除 {len(room_ids)} 个会议室。")
    _out(md, data)


def cmd_free_busy(args):
    _set_marker(ACTION_SELECTED="calendar.free-busy")
    user_ids = _split_ids(getattr(args, "user_ids", None) or "")
    room_ids = _split_ids(getattr(args, "room_ids", None) or "")
    if not user_ids and not room_ids:
        _err("请指定 --user-ids 或 --room-ids 至少其一（逗号分隔），查询时间区间不超过 7 天")
    resp = list_free_busy(
        start_time=args.start_time,
        end_time=args.end_time,
        user_ids=user_ids if user_ids else None,
        room_ids=room_ids if room_ids else None,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    md = [
        "## 日程忙闲",
        "",
        f"时间区间：{args.start_time} ~ {args.end_time}（不超过 7 天）",
        "",
        "以下为**忙**时间段，区间内其余时间为**空闲**。",
        "",
    ]
    for item in items:
        uid = item.get("user_id") or item.get("room_id") or "-"
        kind = "用户" if item.get("user_id") else "会议室"
        md.append(f"### {kind} `{uid}`")
        busy = item.get("busy_times") or []
        if busy:
            for bt in busy[:20]:
                st = _format_free_busy_time(bt.get("start"))
                et = _format_free_busy_time(bt.get("end"))
                md.append(f"- 忙：{st} ~ {et}")
        else:
            md.append("- 该区间内无忙时段（全部空闲）")
        md.append("")
    _out(md, data)


def cmd_list_permissions(args):
    """查询日历权限列表。"""
    _set_marker(ACTION_SELECTED="calendar.list-permissions")
    resp = list_calendar_permissions(
        args.calendar_id,
        page_token=getattr(args, "page_token", None) or None,
        page_size=getattr(args, "page_size", None),
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = (data or {}).get("next_page_token", "")
    md = [
        "## 日历权限列表",
        "",
        f"- **日历**：`{args.calendar_id}`",
        f"- **本页**：{len(items)} 条",
    ]
    if next_token:
        md.append(f"- **下一页**：`--page-token {next_token}`")
    md.append("")
    for i, perm in enumerate(items[:50], 1):
        role = perm.get("role", "-")
        uid = perm.get("user_id", "-")
        pid = perm.get("id", "")
        md.append(f"{i}. `{pid}` — 用户 `{uid}` — 角色 **{role}**")
    _out(md, data)


def cmd_create_permission(args):
    """创建日历权限。"""
    _set_mutation_marker("calendar.create-permission", args.confirm)
    detail = [
        f"- **日历**：`{args.calendar_id}`",
        f"- **用户**：`{args.user_id}`",
        f"- **角色**：{args.role}",
    ]
    is_dry_run, md = _mutation_gate("创建日历权限", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id, "user_id": args.user_id, "role": args.role})
        return
    resp = create_calendar_permission(args.calendar_id, args.user_id, args.role)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append(f"已创建权限，权限ID：`{data.get('id', '-')}`")
    _out(md, data)


def cmd_delete_permission(args):
    """删除日历权限。"""
    _set_mutation_marker("calendar.delete-permission", args.confirm)
    detail = [
        f"- **日历**：`{args.calendar_id}`",
        f"- **权限ID**：`{args.permission_id}`",
    ]
    is_dry_run, md = _mutation_gate("删除日历权限", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "calendar_id": args.calendar_id, "permission_id": args.permission_id})
        return
    resp = delete_calendar_permission(args.calendar_id, args.permission_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md.append("")
    md.append("已删除日历权限。")
    _out(md, data)



def main():
    parser = argparse.ArgumentParser(description="日历与日程增删改查（V7）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    # 日历
    p = sub.add_parser("list-calendars")
    p.add_argument("--page-token", default=None, help="分页游标")
    p.add_argument("--page-size", type=int, default=20, help="单页条数")
    p.add_argument("--all", action="store_true", dest="fetch_all", help="自动翻页并返回全部结果")
    p.set_defaults(func=cmd_list_calendars)
    p = sub.add_parser("get-calendar")
    p.add_argument("calendar_id")
    p.set_defaults(func=cmd_get_calendar)
    p = sub.add_parser("create-calendar", help="创建日历（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("--title", required=True, help="日历标题")
    p.add_argument("--color", required=True, help="颜色，如 #FF0000FF")
    p.add_argument("--desc", default="", help="描述")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_create_calendar)
    p = sub.add_parser("update-calendar", help="更新日历（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id")
    p.add_argument("--title", default=None)
    p.add_argument("--color", default=None)
    p.add_argument("--desc", default=None)
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_update_calendar)
    p = sub.add_parser("delete-calendar", help="删除日历（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id")
    p.add_argument("--confirm", action="store_true", help="确认执行删除")
    p.set_defaults(func=cmd_delete_calendar)

    # 日程
    p = sub.add_parser("list-events", help="按时间区间列出日程")
    p.add_argument("calendar_id")
    p.add_argument("--start-time", required=True, help="开始时间 ISO 8601，如 2026-04-01T00:00:00+08:00")
    p.add_argument("--end-time", required=True, help="结束时间 ISO 8601，区间不超过 31 天")
    p.add_argument("--keyword", default=None, help="按标题关键字过滤，匹配 summary")
    p.add_argument("--page-token", default=None, help="分页游标")
    p.add_argument("--page-size", type=int, default=50, help="返回条数上限，最多 100；默认 50")
    p.add_argument("--all", action="store_true", dest="fetch_all", help="自动翻页并返回完整区间结果")
    p.set_defaults(func=cmd_list_events)
    p = sub.add_parser("get-event")
    p.add_argument("calendar_id")
    p.add_argument("event_id")
    p.set_defaults(func=cmd_get_event)
    p = sub.add_parser("create-event", help="创建日程（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id")
    p.add_argument("--start-time", required=True, help="开始时间 ISO 8601 或 yyyy-mm-dd")
    p.add_argument("--end-time", required=True, help="结束时间 ISO 8601 或 yyyy-mm-dd")
    p.add_argument("--title", default=None)
    p.add_argument("--desc", default=None)
    p.add_argument("--location", default=None, help="地点名称，最多 1 个")
    p.add_argument("--attach", action="append", default=None, dest="attach", help="附件 file_id，可多次传入，最多 20 个")
    p.add_argument("--attendees", default=None, help="参与者 user_id，逗号分隔")
    p.add_argument("--online-meeting", action="store_true", dest="online_meeting", help="创建线上会议（默认 provider=kso），返回入会链接")
    p.add_argument("--recurrence", default=None, help='重复规则 JSON，如 \'{"freq":"WEEKLY","interval":1,"by_day":["MO","WE","FR"]}\'')
    p.add_argument("--reminders", default=None, help='提醒 JSON 数组，如 \'[{"minutes":15}]\'，最多 10 个')
    p.add_argument("--visibility", default=None, choices=("default", "public", "private"), help="可见范围")
    p.add_argument("--free-busy-status", default=None, dest="free_busy_status", choices=("busy", "free"), help="忙闲状态")
    p.add_argument("--attendee-ability", default=None, dest="attendee_ability", choices=("can_see_others", "can_invite_others"), help="参与者权限")
    p.add_argument("--confirm", action="store_true", help="确认执行创建")
    p.set_defaults(func=cmd_create_event)
    p = sub.add_parser("update-event", help="修改日程（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id")
    p.add_argument("event_id")
    p.add_argument("--title", default=None)
    p.add_argument("--desc", default=None)
    p.add_argument("--start-time", default=None)
    p.add_argument("--end-time", default=None)
    p.add_argument("--location", default=None, help="地点名称")
    p.add_argument("--attach", action="append", default=None, dest="attach", help="附件 file_id，可多次传入")
    p.add_argument("--attendees", default=None, help="参与者 user_id，逗号分隔，将追加到日程")
    p.add_argument("--remove-attendees", default=None, dest="remove_attendees", help="要移除的参与者 id（从参与者列表获取），逗号分隔")
    p.add_argument("--online-meeting", action="store_true", dest="online_meeting", help="补充/覆盖线上会议信息（provider=kso）")
    p.add_argument("--recurrence", default=None, help='重复规则 JSON，如 \'{"freq":"DAILY","count":5}\'')
    p.add_argument("--reminders", default=None, help='提醒 JSON 数组，如 \'[{"minutes":30}]\'')
    p.add_argument("--visibility", default=None, choices=("default", "public", "private"), help="可见范围")
    p.add_argument("--free-busy-status", default=None, dest="free_busy_status", choices=("busy", "free"), help="忙闲状态")
    p.add_argument("--attendee-ability", default=None, dest="attendee_ability", choices=("can_see_others", "can_invite_others"), help="参与者权限")
    p.add_argument("--confirm", action="store_true", help="确认执行更新")
    p.set_defaults(func=cmd_update_event)
    p = sub.add_parser("delete-event", help="删除日程（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id")
    p.add_argument("event_id")
    p.add_argument("--confirm", action="store_true", help="确认执行删除")
    p.set_defaults(func=cmd_delete_event)

    # 日程参与者
    p = sub.add_parser("list-event-attendees", help="查询日程参与者列表")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("event_id", help="日程id")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，1-100，默认30")
    p.add_argument("--page-token", default=None, help="分页凭证")
    p.set_defaults(func=cmd_list_event_attendees)

    p = sub.add_parser("add-event-attendees", help="批量添加日程参与者")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("event_id", help="日程id")
    p.add_argument("--user-ids", required=True, dest="user_ids", help="用户id，逗号分隔，最多200个")
    p.add_argument("--notify", type=bool, default=None, help="是否发送通知（可选）")
    p.set_defaults(func=cmd_add_event_attendees)

    p = sub.add_parser("delete-event-attendees", help="批量删除日程参与者（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("event_id", help="日程id")
    p.add_argument("--attendee-ids", required=True, dest="attendee_ids", help="参与者id，逗号分隔，最多50个（从参与者列表获取）")
    p.add_argument("--notify", type=bool, default=None, help="是否发送通知（可选）")
    p.add_argument("--confirm", action="store_true", help="确认执行删除")
    p.set_defaults(func=cmd_delete_event_attendees)

    # 会议室层级
    p = sub.add_parser("list-room-levels", help="查询会议室层级列表")
    p.add_argument("--room-level-id", default=None, help="层级ID，不传则获取根节点")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，默认20")
    p.add_argument("--page-token", default=None, help="	分页凭证，首次不传，后续需要")
    p.set_defaults(func=cmd_list_room_levels)

    p = sub.add_parser("list-rooms", help="查询会议室列表")
    p.add_argument("--room-level-id", default=None, help="会议室层级ID")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，默认20")
    p.add_argument("--page-token", default=None, help="分页凭证，首次不传，后续需要")
    p.set_defaults(func=cmd_list_rooms)

    p = sub.add_parser("list-event-rooms", help="查询日程会议室列表")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("event_id", help="日程id")
    p.set_defaults(func=cmd_list_event_rooms)

    p = sub.add_parser("add-event-rooms", help="批量添加某个日程的会议室")
    p.add_argument("calendar_id", help="日历id，可从日历列表、主日历详情获取，或使用primary指代用户的主日历")
    p.add_argument("event_id", help="日程id，可从日程列表获取")
    p.add_argument("--room-ids", required=True, dest="room_ids", help="会议室id列表，可从会议室列表接口获取")
    p.set_defaults(func=cmd_add_event_rooms)

    p = sub.add_parser("delete-event-rooms", help="批量删除日程会议室（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("event_id", help="日程id")
    p.add_argument("--room-ids", required=True, dest="room_ids", help="要删除的会议室id，逗号分隔，最多50个")
    p.add_argument("--confirm", action="store_true", help="确认执行删除")
    p.set_defaults(func=cmd_delete_event_rooms)

    # 忙闲
    p = sub.add_parser("free-busy", help="查询用户或会议室忙闲状态")
    p.add_argument("--start-time", required=True, help="开始时间 ISO 8601，区间不超过 7 天")
    p.add_argument("--end-time", required=True, help="结束时间 ISO 8601")
    p.add_argument("--user-ids", default=None, dest="user_ids", help="用户 id，逗号分隔，与 --room-ids 二选一或同时传")
    p.add_argument("--room-ids", default=None, dest="room_ids", help="会议室 id，逗号分隔")
    p.set_defaults(func=cmd_free_busy)


    # 日历权限
    p = sub.add_parser("list-permissions", help="查询日历权限列表")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("--page-size", type=int, default=None, help="每页数量，1-20")
    p.add_argument("--page-token", default=None, help="分页凭证")
    p.set_defaults(func=cmd_list_permissions)

    p = sub.add_parser("create-permission", help="创建日历权限（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("--user-id", required=True, dest="user_id", help="用户id")
    p.add_argument("--role", required=True, choices=["free_busy_reader", "reader", "writer", "owner"], help="权限角色")
    p.add_argument("--confirm", action="store_true", help="确认执行创建")
    p.set_defaults(func=cmd_create_permission)

    p = sub.add_parser("delete-permission", help="删除日历权限（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("calendar_id", help="日历id")
    p.add_argument("permission_id", help="权限id，可从权限列表获取")
    p.add_argument("--confirm", action="store_true", help="确认执行删除")
    p.set_defaults(func=cmd_delete_permission)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
