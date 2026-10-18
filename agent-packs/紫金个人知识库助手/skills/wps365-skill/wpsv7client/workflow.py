# -*- coding: utf-8 -*-
"""
审批实例 V7 API 封装。
参考 apis/spec/internal/workflow/api_approval_instance.xidl。
"""
from typing import Any, List, Optional

from .base import WpsV7Client
from .time_util import response_timestamps_to_iso


def _normalize_resp(resp: Any) -> dict:
    if resp is None:
        return {}
    if not isinstance(resp, dict):
        return {}
    out = dict(resp)
    data = out.get("data")
    if data is not None:
        if isinstance(data, dict):
            out["data"] = response_timestamps_to_iso(data)
        elif isinstance(data, list):
            out["data"] = [response_timestamps_to_iso(item) if isinstance(item, dict) else item for item in data]
    return out


def get_approval_instance(
    instance_id: str,
    user_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    查询单个审批实例详情。
    GET /v7/workflow/approval_instances/{id}?user_id=xxx。
    """
    if not instance_id or not str(instance_id).strip():
        return _normalize_resp({"code": -1, "msg": "instance_id 不能为空", "data": None})
    if not user_id or not str(user_id).strip():
        return _normalize_resp({"code": -1, "msg": "user_id 不能为空", "data": None})
    c = client or WpsV7Client()
    params: dict[str, Any] = {"user_id": str(user_id).strip()}
    resp = c.get(f"/v7/workflow/approval_instances/{str(instance_id).strip()}", params=params)
    return _normalize_resp(resp)


def list_approval_instances(
    instance_ids: Optional[List[str]] = None,
    promoter: Optional[str] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    批量查询审批实例详情（最多 20 个实例 ID）。
    GET /v7/workflow/approval_instances?instance_ids=xxx&promoter=xxx。
    """
    c = client or WpsV7Client()
    params: dict[str, Any] = {}
    if instance_ids:
        params["instance_ids"] = instance_ids[:20]
    if promoter:
        params["promoter"] = str(promoter).strip()
    resp = c.get("/v7/workflow/approval_instances", params=params)
    return _normalize_resp(resp)


def list_approval_instances_brief(
    client: Optional[WpsV7Client] = None,
    page_size: int = 10,
    page_token: Optional[str] = None,
    approval_define_id: Optional[str] = None,
    instance_status: Optional[str] = None,
    time_from: Optional[str] = None,
    time_to: Optional[str] = None,
    promoter: Optional[str] = None,
) -> dict:
    """
    分页查询审批实例列表（简要信息）。
    GET /v7/workflow/approval_instances/batch_get。
    instance_status: auditing/approved/refused/returned/revoked/terminated。
    """
    c = client or WpsV7Client()
    params: dict[str, Any] = {
        "page_size": min(50, max(10, page_size)),
    }
    if page_token:
        params["page_token"] = page_token
    if approval_define_id:
        params["approval_define_id"] = approval_define_id
    if instance_status:
        params["instance_status"] = instance_status
    if time_from:
        params["time_from"] = time_from
    if time_to:
        params["time_to"] = time_to
    if promoter:
        params["promoter"] = promoter
    resp = c.get("/v7/workflow/approval_instances/batch_get", params=params)
    return _normalize_resp(resp)


def list_approval_ccs(
    client: Optional[WpsV7Client] = None,
    page_size: int = 10,
    page_token: Optional[str] = None,
    approval_define_id: Optional[str] = None,
    instance_id: Optional[str] = None,
    cc_user: Optional[str] = None,
    read_status: Optional[str] = None,
    time_from: Optional[str] = None,
    time_to: Optional[str] = None,
) -> dict:
    """
    分页查询审批抄送列表。
    GET /v7/workflow/approval_instances/batch_get_cc。
    read_status: already_read/not_read。
    """
    c = client or WpsV7Client()
    params: dict[str, Any] = {
        "page_size": min(50, max(10, page_size)),
    }
    if page_token:
        params["page_token"] = page_token
    if approval_define_id:
        params["approval_define_id"] = approval_define_id
    if instance_id:
        params["instance_id"] = instance_id
    if cc_user:
        params["cc_user"] = cc_user
    if read_status:
        params["read_status"] = read_status
    if time_from:
        params["time_from"] = time_from
    if time_to:
        params["time_to"] = time_to
    resp = c.get("/v7/workflow/approval_instances/batch_get_cc", params=params)
    return _normalize_resp(resp)


def list_approval_timelines(
    client: Optional[WpsV7Client] = None,
    page_size: int = 10,
    page_token: Optional[str] = None,
    approval_define_id: Optional[str] = None,
    instance_id: Optional[str] = None,
    operator: Optional[str] = None,
    type_filter: Optional[str] = None,
    time_from: Optional[str] = None,
    time_to: Optional[str] = None,
) -> dict:
    """
    分页查询审批操作记录。
    GET /v7/workflow/approval_instances/batch_get_timeline。
    type_filter: 逗号分隔，如 "passed,reject,revoke"。
    """
    c = client or WpsV7Client()
    params: dict[str, Any] = {
        "page_size": min(50, max(10, page_size)),
    }
    if page_token:
        params["page_token"] = page_token
    if approval_define_id:
        params["approval_define_id"] = approval_define_id
    if instance_id:
        params["instance_id"] = instance_id
    if operator:
        params["operator"] = operator
    if type_filter:
        params["type"] = type_filter
    if time_from:
        params["time_from"] = time_from
    if time_to:
        params["time_to"] = time_to
    resp = c.get("/v7/workflow/approval_instances/batch_get_timeline", params=params)
    return _normalize_resp(resp)
