# -*- coding: utf-8 -*-
"""
日历与日程 V7 API 封装。
参考 apis-dev/spec/internal/calendar：日历与日程增删改查。
时间入参支持 UTC ISO 8601 或日期；出参时间字段统一转为 UTC ISO 8601。
"""
import os
from typing import Any, Optional

from .base import WpsV7Client, private_unsupported
from .time_util import iso_to_calendar_time, response_timestamps_to_iso


def _normalize_resp(resp: Any) -> dict:
    """保持 {code, msg, data} 结构，对 data 做时间字段转换与私网字段兼容。"""
    if resp is None:
        return {}
    if not isinstance(resp, dict):
        return resp if isinstance(resp, dict) else {}
    out = dict(resp)
    if "data" in out and out["data"] is not None:
        out["data"] = response_timestamps_to_iso(out["data"])
        _compat_private_fields(out["data"])
    return out


def _compat_private_fields(data: Any) -> None:
    """私网响应兼容：PascalCase key 降级、日程时间 fallback。"""
    if not isinstance(data, dict):
        return
    # 1) Items → items：私网可能返回 PascalCase 的 Items，统一降级到 items
    if "items" not in data and "Items" in data:
        data["items"] = data.pop("Items")
    elif "Items" in data:
        del data["Items"]
    # 2) start_time/end_time fallback：私网可能为 null，从 original_xxx_time 降级
    items = data.get("items")
    if isinstance(items, list):
        for item in items:
            _fallback_event_time(item)
    else:
        _fallback_event_time(data)


def _is_empty_time(val: Any) -> bool:
    """判断时间字段是否为无效值（None / 空 dict / 空字符串）。"""
    if val is None:
        return True
    if isinstance(val, dict) and not val:
        return True
    if isinstance(val, str) and not val.strip():
        return True
    return False


def _fallback_event_time(event: Any) -> None:
    """当 start_time/end_time 为空时，从 original_start_time/original_end_time 降级填充。"""
    if not isinstance(event, dict):
        return
    for field, fallback_field in (
        ("start_time", "original_start_time"),
        ("end_time", "original_end_time"),
    ):
        if not _is_empty_time(event.get(field)):
            continue
        original = event.get(fallback_field)
        if _is_empty_time(original):
            if _is_empty_time(event.get(field)):
                event[field] = None
            continue
        if isinstance(original, dict):
            event[field] = original
        elif isinstance(original, str) and original.strip():
            event[field] = {"datetime": original.strip()}


# ---------- 日历 ----------


def list_calendars(
    client: Optional[WpsV7Client] = None,
    with_total: bool = False,
    page_token: Optional[str] = None,
    page_size: int = 20,
    fetch_all: bool = False,
) -> dict:
    """
    日历列表。GET /v7/calendars。

    接口分页返回 `items` 与下一页游标（常见字段名为 `next_page_token`，部分实现为 `page_token`）。
    fetch_all=True 时从首屏起连续请求直至无下一页，合并全部 `items`（与 Drive list --all 行为一致）。
    fetch_all=False 时仅请求一页；可传 page_token 拉取指定页。
    """
    c = client or WpsV7Client()
    ps = min(20, max(1, page_size))
    params_base = {"with_total": with_total, "page_size": ps}

    if not fetch_all:
        params = dict(params_base)
        if page_token:
            params["page_token"] = page_token
        resp = c.get("/v7/calendars", params=params)
        return _normalize_resp(resp)

    merged_items: list = []
    merged_data: Optional[dict] = None
    last_msg = ""
    token: Optional[str] = page_token
    max_pages = 500
    for _ in range(max_pages):
        params = dict(params_base)
        if token:
            params["page_token"] = token
        resp = c.get("/v7/calendars", params=params)
        out = _normalize_resp(resp)
        last_msg = out.get("msg") or ""
        if out.get("code") != 0:
            return out
        data = out.get("data")
        if not isinstance(data, dict):
            data = {}
        if merged_data is None:
            merged_data = dict(data)
        items = data.get("items") or []
        if isinstance(items, list):
            merged_items.extend(items)
        next_t = (data.get("next_page_token") or data.get("page_token") or "").strip()
        if not next_t:
            break
        token = next_t
    else:
        return {
            "code": 400,
            "msg": f"日历列表分页超过 {max_pages} 页上限",
            "data": merged_data or {},
        }

    if merged_data is None:
        merged_data = {}
    merged_data["items"] = merged_items
    merged_data["next_page_token"] = ""
    if "page_token" in merged_data and isinstance(merged_data.get("page_token"), str):
        merged_data["page_token"] = ""
    return {"code": 0, "msg": last_msg, "data": merged_data}


def get_calendar(calendar_id: str, client: Optional[WpsV7Client] = None) -> dict:
    """查看日历。GET /v7/calendars/{calendar_id}"""
    c = client or WpsV7Client()
    resp = c.get("/v7/calendars/" + calendar_id)
    return _normalize_resp(resp)


def create_calendar(
    summary: str,
    color: str,
    description: str = "",
    client: Optional[WpsV7Client] = None,
) -> dict:
    """创建日历。POST /v7/calendars/create。color 示例: #FF0000FF"""
    c = client or WpsV7Client()
    body = {"summary": summary, "color": color, "description": description or ""}
    resp = c.post("/v7/calendars/create", json=body)
    return _normalize_resp(resp)


def update_calendar(
    calendar_id: str,
    summary: Optional[str] = None,
    color: Optional[str] = None,
    description: Optional[str] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """修改日历。POST /v7/calendars/{calendar_id}/update"""
    c = client or WpsV7Client()
    body = {}
    if summary is not None:
        body["summary"] = summary
    if color is not None:
        body["color"] = color
    if description is not None:
        body["description"] = description
    resp = c.post(f"/v7/calendars/{calendar_id}/update", json=body)
    return _normalize_resp(resp)


def delete_calendar(calendar_id: str, client: Optional[WpsV7Client] = None) -> dict:
    """删除日历。POST /v7/calendars/{calendar_id}/delete"""
    c = client or WpsV7Client()
    resp = c.post(f"/v7/calendars/{calendar_id}/delete")
    return _normalize_resp(resp)


# ---------- 日程 ----------


def list_events(
    calendar_id: str,
    start_time: str,
    end_time: str,
    client: Optional[WpsV7Client] = None,
    page_token: Optional[str] = None,
    page_size: int = 30,
) -> dict:
    """
    查询单个日历的日程列表。GET /v7/calendars/{id}/events。
    start_time/end_time 为 UTC ISO 8601 或 RFC3339，区间不超过 31 天。

    单页返回条数若少于期望的 page_size 且存在 next_page_token，则自动继续请求，
    合并 items，直至累计条数达到 page_size 或无下一页（与 list_calendars 的 fetch_all 类似，但有条数上限）。
    """
    c = client or WpsV7Client()
    target = min(100, max(1, page_size))
    merged_items: list = []
    merged_data: Optional[dict] = None
    last_msg = ""
    last_next_t = ""
    token: Optional[str] = page_token
    max_pages = 500

    for _ in range(max_pages):
        params = {
            "start_time": start_time,
            "end_time": end_time,
            "page_size": target,
        }
        if token:
            params["page_token"] = token
        resp = c.get(f"/v7/calendars/{calendar_id}/events", params=params)
        out = _normalize_resp(resp)
        last_msg = out.get("msg") or ""
        if out.get("code") != 0:
            return out
        data = out.get("data")
        if not isinstance(data, dict):
            data = {}
        if merged_data is None:
            merged_data = dict(data)
        items = data.get("items") or []
        if isinstance(items, list):
            merged_items.extend(items)
        last_next_t = (data.get("next_page_token") or data.get("page_token") or "").strip()
        if len(merged_items) >= target:
            break
        if not last_next_t:
            break
        token = last_next_t
    else:
        return {
            "code": 400,
            "msg": f"日程列表分页超过 {max_pages} 页上限",
            "data": merged_data or {},
        }

    if merged_data is None:
        merged_data = {}
    if len(merged_items) > target:
        merged_items = merged_items[:target]
        last_next_t = ""
    merged_data["items"] = merged_items
    merged_data["next_page_token"] = last_next_t if last_next_t else ""
    if "page_token" in merged_data and isinstance(merged_data.get("page_token"), str):
        merged_data["page_token"] = merged_data["next_page_token"]
    return {"code": 0, "msg": last_msg, "data": merged_data}


def get_event(
    calendar_id: str,
    event_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """查询日程。GET /v7/calendars/{calendar_id}/events/{event_id}"""
    c = client or WpsV7Client()
    resp = c.get(f"/v7/calendars/{calendar_id}/events/{event_id}")
    return _normalize_resp(resp)


def _build_locations(location: Optional[str] = None, locations: Optional[list] = None) -> list:
    """构建 locations 数组，最多 1 个。v7_calendar_location: { name: string }"""
    if locations is not None and isinstance(locations, list) and len(locations) > 0:
        return [{"name": str(loc.get("name", loc))} if isinstance(loc, dict) else {"name": str(loc)} for loc in locations[:1]]
    if location:
        return [{"name": str(location)}]
    return []


def _build_attachments(attachment_file_ids: Optional[list] = None) -> list:
    """构建 attachments 数组，最多 20 个。v7_calendar_attachment_file: { file_id: string }"""
    if not attachment_file_ids:
        return []
    out = []
    for x in attachment_file_ids[:20]:
        if isinstance(x, dict) and x.get("file_id"):
            out.append({"file_id": str(x["file_id"])})
        elif isinstance(x, str) and x:
            out.append({"file_id": x})
    return out


def create_event(
    calendar_id: str,
    start_time: str,
    end_time: str,
    summary: Optional[str] = None,
    description: Optional[str] = None,
    location: Optional[str] = None,
    locations: Optional[list] = None,
    attachment_file_ids: Optional[list] = None,
    attendee_user_ids: Optional[list] = None,
    online_meeting: Optional[dict] = None,
    recurrence: Optional[dict] = None,
    reminders: Optional[list] = None,
    visibility: Optional[str] = None,
    free_busy_status: Optional[str] = None,
    attendee_ability: Optional[str] = None,
    client: Optional[WpsV7Client] = None,
    **kwargs: Any,
) -> dict:
    """
    创建日程。POST /v7/calendars/{id}/events/create。
    start_time/end_time 支持 ISO 8601 或日期 yyyy-mm-dd；东8区建议带 Z 或 +08:00 避免 8 小时偏差。
    location/locations: 地点，最多 1 个（传名称字符串或 [{"name": "..."}]）。
    attachment_file_ids: 附件 file_id 列表，最多 20 个（v7_file.id）。
    attendee_user_ids: 参与者用户 id 列表，创建成功后会调用添加参与者接口。
    online_meeting: 线上会议信息，如 {"provider": "kso"}，创建后返回入会链接等。
    recurrence: 重复规则，如 {"freq": "WEEKLY", "interval": 1, "by_day": ["MO", "WE", "FR"]}。
    reminders: 提醒列表，如 [{"minutes": 15}]，最多 10 个。
    visibility: 可见范围：default / public / private。
    free_busy_status: 忙闲状态：busy / free。
    attendee_ability: 参与者权限：can_see_others / can_invite_others。
    """
    c = client or WpsV7Client()
    st = iso_to_calendar_time(start_time)
    et = iso_to_calendar_time(end_time)
    if not st or not et:
        raise ValueError("start_time 与 end_time 需为有效 ISO 8601 或 yyyy-mm-dd")
    body = {"start_time": st, "end_time": et, **kwargs}
    if summary is not None:
        body["summary"] = summary
    if description is not None:
        body["description"] = description
    locs = _build_locations(location=location, locations=locations)
    if locs:
        body["locations"] = locs
    atts = _build_attachments(attachment_file_ids)
    if atts:
        body["attachments"] = atts
    if online_meeting is not None:
        body["online_meeting"] = online_meeting
    if recurrence is not None:
        body["recurrence"] = recurrence
    if reminders is not None:
        body["reminders"] = reminders
    if visibility is not None:
        body["visibility"] = visibility
    if free_busy_status is not None:
        body["free_busy_status"] = free_busy_status
    if attendee_ability is not None:
        body["attendee_ability"] = attendee_ability
    resp = c.post(f"/v7/calendars/{calendar_id}/events/create", json=body)
    out = _normalize_resp(resp)
    if out.get("code") == 0 and attendee_user_ids and out.get("data") and out["data"].get("id"):
        batch_create_event_attendees(calendar_id, out["data"]["id"], attendee_user_ids, client=c)
    return out


def update_event(
    calendar_id: str,
    event_id: str,
    client: Optional[WpsV7Client] = None,
    summary: Optional[str] = None,
    description: Optional[str] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    location: Optional[str] = None,
    locations: Optional[list] = None,
    attachment_file_ids: Optional[list] = None,
    online_meeting: Optional[dict] = None,
    recurrence: Optional[dict] = None,
    reminders: Optional[list] = None,
    visibility: Optional[str] = None,
    free_busy_status: Optional[str] = None,
    attendee_ability: Optional[str] = None,
    **kwargs: Any,
) -> dict:
    """
    修改日程。POST /v7/calendars/{id}/events/{event_id}/update。
    时间参数为 ISO 8601。location/locations 最多 1 个；attachment_file_ids 最多 20 个。
    online_meeting: 线上会议信息，如 {"provider": "kso"}，用于补充或覆盖线上会议设置。
    recurrence: 重复规则，如 {"freq": "WEEKLY", "interval": 1, "by_day": ["MO", "WE", "FR"]}。
    reminders: 提醒列表，如 [{"minutes": 15}]，最多 10 个。
    visibility: 可见范围：default / public / private。
    free_busy_status: 忙闲状态：busy / free。
    attendee_ability: 参与者权限：can_see_others / can_invite_others。
    """
    c = client or WpsV7Client()
    body = dict(kwargs)
    if summary is not None:
        body["summary"] = summary
    if description is not None:
        body["description"] = description
    if start_time is not None:
        st = iso_to_calendar_time(start_time)
        if st:
            body["start_time"] = st
    if end_time is not None:
        et = iso_to_calendar_time(end_time)
        if et:
            body["end_time"] = et
    locs = _build_locations(location=location, locations=locations)
    if locs:
        body["locations"] = locs
    if attachment_file_ids is not None:
        body["attachments"] = _build_attachments(attachment_file_ids)
    if online_meeting is not None:
        body["online_meeting"] = online_meeting
    if recurrence is not None:
        body["recurrence"] = recurrence
    if reminders is not None:
        body["reminders"] = reminders
    if visibility is not None:
        body["visibility"] = visibility
    if free_busy_status is not None:
        body["free_busy_status"] = free_busy_status
    if attendee_ability is not None:
        body["attendee_ability"] = attendee_ability
    resp = c.post(f"/v7/calendars/{calendar_id}/events/{event_id}/update", json=body)
    return _normalize_resp(resp)


def delete_event(
    calendar_id: str,
    event_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """删除日程。POST /v7/calendars/{calendar_id}/events/{event_id}/delete"""
    c = client or WpsV7Client()
    resp = c.post(f"/v7/calendars/{calendar_id}/events/{event_id}/delete")
    return _normalize_resp(resp)


# ---------- 日程参与者 ----------


def list_event_attendees(
    calendar_id: str,
    event_id: str,
    page_token: Optional[str] = None,
    page_size: Optional[int] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询日程参与者列表。GET /v7/calendars/{calendar_id}/events/{event_id}/attendees。
    返回 data.items 含参与者列表（id, type, name, user_id, response_status）。
    """
    c = client or WpsV7Client()
    params: dict = {}
    if page_token:
        params["page_token"] = page_token
    if page_size is not None:
        params["page_size"] = min(100, max(1, page_size))
    resp = c.get(f"/v7/calendars/{calendar_id}/events/{event_id}/attendees", params=params or None)
    return _normalize_resp(resp)


def batch_create_event_attendees(
    calendar_id: str,
    event_id: str,
    user_ids: list,
    client: Optional[WpsV7Client] = None,
    is_notification: Optional[bool] = None,
) -> dict:
    """
    添加日程参与者。POST /v7/calendars/{id}/events/{event_id}/attendees/batch_create。
    user_ids: 用户 id 列表（通讯录获取），每次最多 200，日程参与者总数最多 1000。
    """
    c = client or WpsV7Client()
    attendees = [{"type": "user", "user_id": str(uid)} for uid in user_ids[:200] if uid]
    if not attendees:
        return _normalize_resp({"code": 0, "msg": "", "data": {"items": []}})
    body = {"attendees": attendees}
    if is_notification is not None:
        body["is_notification"] = is_notification
    resp = c.post(f"/v7/calendars/{calendar_id}/events/{event_id}/attendees/batch_create", json=body)
    return _normalize_resp(resp)


def batch_delete_event_attendees(
    calendar_id: str,
    event_id: str,
    attendee_ids: list,
    client: Optional[WpsV7Client] = None,
    is_notification: Optional[bool] = None,
) -> dict:
    """
    删除日程参与者。POST /v7/calendars/{id}/events/{event_id}/attendees/batch_delete。
    attendee_ids: 参与者 id 列表（从参与者列表接口获取），每次最多 50。
    """
    c = client or WpsV7Client()
    ids = [str(aid) for aid in attendee_ids[:50] if aid]
    if not ids:
        return _normalize_resp({"code": 0, "msg": "", "data": None})
    body = {"attendee_ids": ids}
    if is_notification is not None:
        body["is_notification"] = is_notification
    resp = c.post(f"/v7/calendars/{calendar_id}/events/{event_id}/attendees/batch_delete", json=body)
    return _normalize_resp(resp)


# ---------- 日程会议室 ----------
def list_room_levels(
    room_level_id: Optional[str] = None,
    page_size: Optional[int] = None,
    page_token: Optional[str] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询会议室层级列表。GET /v7/meeting_room_levels。
    room_level_id: 层级 ID，传空获取根节点。
    page_size: 每页数量，默认 20。
    page_token: 分页凭证，首次不传。
    返回 data.items 为层级列表（id, name, parent_id, path, has_child）。
    """
    c = client or WpsV7Client()
    params: dict = {}
    if room_level_id is not None:
        params["room_level_id"] = room_level_id
    if page_size is not None:
        params["page_size"] = max(1, page_size)
    if page_token:
        params["page_token"] = page_token
    resp = c.get("/v7/meeting_room_levels", params=params or None)
    return _normalize_resp(resp)


def list_rooms(
    room_level_id: Optional[str] = None,
    page_size: Optional[int] = None,
    page_token: Optional[str] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询会议室列表。GET /v7/meeting_rooms。
    room_level_id: 会议室层级 ID，按层级筛选会议室。
    page_size: 每页数量，默认 20，最大 50。
    page_token: 分页凭证，首次不传。
    返回 data.items 为会议室列表。
    """
    c = client or WpsV7Client()
    params: dict = {}
    if room_level_id is not None:
        params["room_level_id"] = room_level_id
    if page_size is not None:
        params["page_size"] = min(50, max(1, page_size))
    if page_token:
        params["page_token"] = page_token
    resp = c.get("/v7/meeting_rooms", params=params or None)
    return _normalize_resp(resp)


def list_event_meeting_rooms(
    calendar_id: str,
    event_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询日程会议室列表。GET /v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms。
    返回 data.items 含会议室列表（room_id, booking_id, name, result, fail_reason）。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms")
    return _normalize_resp(resp)


def add_event_rooms(
    calendar_id: str,
    event_id: str,
    room_ids: list,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    批量添加日程会议室。POST /v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms/batch_create。
    room_ids: 会议室 ID 列表，1~40 个。
    返回 data.items 含每个会议室的预订结果（room_id, name, result, fail_reason）。
    """
    c = client or WpsV7Client()
    ids = [str(rid) for rid in room_ids[:40] if rid]
    if not ids:
        return _normalize_resp({"code": 0, "msg": "", "data": {"items": []}})
    body = {"room_ids": ids}
    resp = c.post(f"/v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms/batch_create", json=body)
    return _normalize_resp(resp)


def delete_event_rooms(
    calendar_id: str,
    event_id: str,
    room_ids: list,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    批量删除日程会议室。POST /v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms/batch_delete。
    room_ids: 会议室 ID 列表，1~50 个。
    """
    c = client or WpsV7Client()
    ids = [str(rid) for rid in room_ids[:50] if rid]
    if not ids:
        return _normalize_resp({"code": 0, "msg": "", "data": None})
    body = {"room_ids": ids}
    resp = c.post(f"/v7/calendars/{calendar_id}/events/{event_id}/meeting_rooms/batch_delete", json=body)
    return _normalize_resp(resp)

# ---------- 查看忙闲 ----------

def list_free_busy(
    start_time: str,
    end_time: str,
    user_ids: Optional[list] = None,
    room_ids: Optional[list] = None,
    calendar_type: str = "primary",
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询用户或会议室的日程忙闲。GET /v7/free_busy_list。
    查询时间区间需满足 end_time - start_time <= 7 天。
    user_ids 与 room_ids 二选一，至少传一个；user_ids/room_ids 为 id 列表，最多 50 个。
    返回各对象在区间内的忙时间段（busy_times），其余即为空闲。
    """
    c = client or WpsV7Client()
    if not user_ids and not room_ids:
        return _normalize_resp({"code": 400, "msg": "user_ids 与 room_ids 至少传一个", "data": None})
    params = {"start_time": start_time, "end_time": end_time, "calendar_type": calendar_type}
    if user_ids:
        params["user_ids"] = user_ids[:50] if isinstance(user_ids, list) else [str(user_ids)]
    if room_ids:
        params["room_ids"] = room_ids[:50] if isinstance(room_ids, list) else [str(room_ids)]
    resp = c.get("/v7/free_busy_list", params=params)
    return _normalize_resp(resp)

# ---------- 日历权限 ----------


def list_calendar_permissions(
    calendar_id: str,
    page_token: Optional[str] = None,
    page_size: Optional[int] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询日历权限列表。GET /v7/calendars/{calendar_id}/permissions。
    返回 data.items 含权限列表（id, calendar_id, user_id, role）。
    """
    c = client or WpsV7Client()
    params: dict = {}
    if page_token:
        params["page_token"] = page_token
    if page_size is not None:
        params["page_size"] = min(20, max(1, page_size))
    resp = c.get(f"/v7/calendars/{calendar_id}/permissions", params=params or None)
    return _normalize_resp(resp)


def create_calendar_permission(
    calendar_id: str,
    user_id: str,
    role: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    创建日历权限。POST /v7/calendars/{calendar_id}/permissions/create。
    role: free_busy_reader / reader / writer / owner。
    """
    c = client or WpsV7Client()
    body = {"user_id": user_id, "role": role}
    resp = c.post(f"/v7/calendars/{calendar_id}/permissions/create", json=body)
    return _normalize_resp(resp)


def delete_calendar_permission(
    calendar_id: str,
    permission_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    删除日历权限。POST /v7/calendars/{calendar_id}/permissions/{permission_id}/delete。
    """
    c = client or WpsV7Client()
    resp = c.post(f"/v7/calendars/{calendar_id}/permissions/{permission_id}/delete")
    return _normalize_resp(resp)
