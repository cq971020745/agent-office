# -*- coding: utf-8 -*-
"""
会议域 V7 API 封装。
参考 apis-dev/spec/internal/meeting：已开始会议（录制/纪要）、会议记录列表。

约定：
- 入参时间统一使用 UTC ISO 8601 字符串（如 2026-03-02T08:00:00Z）
- 若 API 使用时间戳（秒/毫秒），则在客户端内做入参与出参的自动兼容
"""

from typing import Any, Optional

from .base import WpsV7Client
from .time_util import iso_to_timestamp, response_timestamps_to_iso


def _normalize_resp(resp: Any) -> dict:
    """保持 {code, msg, data} 结构，仅对 data 做时间字段转换。"""
    if resp is None:
        return {}
    if not isinstance(resp, dict):
        return resp if isinstance(resp, dict) else {}
    out = dict(resp)
    if "data" in out and out["data"] is not None:
        out["data"] = response_timestamps_to_iso(out["data"])
    return out


# ----- 会议记录（meeting_records） -----


def list_meeting_records(
    page_token: Optional[str] = None,
    page_size: Optional[int] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    user_id: Optional[str] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取当前用户可访问的会议记录列表。
    GET /v7/meeting_records。
    包括会议产生的、智能录音产生的、自行导入视频产生的等多种类型，按创建时间倒序。
    start_time/end_time：Unix 秒级时间戳，也可传 ISO 8601（自动转换）。
    user_id：应用身份调用时必填。
    返回 data.items 为会议记录列表，data.next_page_token 为分页标记。
    """
    c = client or WpsV7Client()
    params: dict = {}
    if page_token:
        params["page_token"] = page_token
    if page_size is not None:
        params["page_size"] = min(20, max(1, page_size))
    if start_time is not None:
        st = iso_to_timestamp(start_time)
        params["start_time"] = str(st) if st else str(start_time)
    if end_time is not None:
        et = iso_to_timestamp(end_time)
        params["end_time"] = str(et) if et else str(end_time)
    if user_id:
        params["user_id"] = user_id
    resp = c.get("/v7/meeting_records", params=params or None)
    return _normalize_resp(resp)


def get_meeting_record_summary(
    record_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取指定会议记录的 AI 总结。
    GET /v7/meeting_records/{record_id}/summary。
    部分类型的记录可能没有总结，调用前请确认 artifacts.has_summary 为 true。
    返回 data.content 为总结文本。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/meeting_records/{record_id}/summary")
    return _normalize_resp(resp)


def get_meeting_record_transcript(
    record_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取指定会议记录的语音转写文本。
    GET /v7/meeting_records/{record_id}/transcript。
    部分类型的记录可能没有语音转写，调用前请确认 artifacts.has_transcript 为 true。
    返回 data.paragraphs 为段落列表，每段含 speaker（发言人）、sentenses（句子列表）、start_time/end_time（毫秒相对时间）。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/meeting_records/{record_id}/transcript")
    if resp is None:
        return {}
    return resp if isinstance(resp, dict) else {}


def get_meeting_record_chapters(
    record_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取指定会议记录的章节列表。
    GET /v7/meeting_records/{record_id}/chapters。
    部分类型的记录可能没有章节，调用前请确认 artifacts.has_chapters 为 true。
    返回 data.items 为章节列表，每项含 title、content、start_time/end_time（秒，相对时间）。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/meeting_records/{record_id}/chapters")
    if resp is None:
        return {}
    return resp if isinstance(resp, dict) else {}


# ----- 已开始会议（started_meetings）：会议列表、录制、纪要 -----


def list_started_meetings(
    start_time: str,
    end_time: str,
    join_code: Optional[str] = None,
    page_token: Optional[str] = None,
    page_size: int = 20,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取指定时间范围内已开始的会议简要列表（60 天内）。
    GET /v7/started_meetings。
    用户身份调用时可不传 join_code，表示查询当前用户最近参加的会议；若按入会码查则传 join_code。
    start_time/end_time：支持 ISO 8601 或 Unix 秒时间戳，接口使用 Unix 秒。
    返回 data.items 为会议简要列表（id, subject, join_code, join_url 等），data.next_page_token 为分页标记。
    """
    c = client or WpsV7Client()
    st = iso_to_timestamp(start_time)
    et = iso_to_timestamp(end_time)
    if st is None:
        st = start_time
    if et is None:
        et = end_time
    if not st or not et:
        raise ValueError("start_time 与 end_time 需为有效 ISO 8601 或 Unix 秒时间戳")
    params = {"start_time": str(st), "end_time": str(et)}
    if join_code is not None and str(join_code).strip():
        params["join_code"] = str(join_code).strip()
    if page_token:
        params["page_token"] = page_token
    params["page_size"] = min(50, max(1, page_size))
    resp = c.get("/v7/started_meetings", params=params)
    return _normalize_resp(resp)


# ----- 会议详情与参会人（依赖 meeting_id，通常从 list_started_meetings 获取） -----


def get_meeting(
    meeting_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取已开始会议的详情。
    GET /v7/started_meetings/{meeting_id}。
    若会议进行中则返回入会链接（join_url）和入会码（join_code）。
    返回 data 包含 id, subject, status, start_time, end_time, host_user, join_url, join_code 等。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/started_meetings/{meeting_id}")
    return _normalize_resp(resp)


def list_meeting_participants(
    meeting_id: str,
    page_token: Optional[str] = None,
    page_size: Optional[int] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取已开始会议的实际参会人列表。
    GET /v7/started_meetings/{meeting_id}/participants。
    page_size: 每页数量，默认 20，最大 100。
    返回 data.items 为参会人列表（user_id, type, is_host），data.next_page_token 为分页标记。
    """
    c = client or WpsV7Client()
    params: dict = {}
    if page_token:
        params["page_token"] = page_token
    if page_size is not None:
        params["page_size"] = min(100, max(1, page_size))
    resp = c.get(f"/v7/started_meetings/{meeting_id}/participants", params=params or None)
    return _normalize_resp(resp)


# ----- 录制与纪要（依赖 meeting_id） -----


def meeting_get_recordings(
    meeting_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取某场已开始会议的录制列表。
    GET /v7/started_meetings/{meeting_id}/recordings。
    返回 data.items 为录制列表（含 recording id 等），用于后续 get_recording_summary。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/started_meetings/{meeting_id}/recordings")
    return _normalize_resp(resp)


def get_recording_summary(
    meeting_id: str,
    recording_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取指定录制的 AI 总结要点文本。
    GET /v7/started_meetings/{meeting_id}/recordings/{recording_id}/summary。
    返回 data.content 为总结文本。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/started_meetings/{meeting_id}/recordings/{recording_id}/summary")
    return _normalize_resp(resp)


def meeting_get_minutes(
    meeting_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取某场已开始会议的纪要列表。
    GET /v7/started_meetings/{meeting_id}/minutes。
    返回 data.items 为纪要列表（含 minute id 等），用于后续 get_minute_summary。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/started_meetings/{meeting_id}/minutes")
    return _normalize_resp(resp)


def get_minute_summary(
    meeting_id: str,
    minute_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取指定纪要的 AI 总结要点文本。
    GET /v7/started_meetings/{meeting_id}/minutes/{minute_id}/summary。
    返回 data.content 为总结文本。
    """
    c = client or WpsV7Client()
    resp = c.get(f"/v7/started_meetings/{meeting_id}/minutes/{minute_id}/summary")
    return _normalize_resp(resp)
