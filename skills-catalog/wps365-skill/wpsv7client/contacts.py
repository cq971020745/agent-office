# -*- coding: utf-8 -*-
"""
通讯录 V7 API 封装。
参考 apis-dev/spec/internal/iam：GET /v7/users/search 企业用户搜索。
按关键字（keyword）搜索；同名时返回多条。
私网自动传 search_field_config_enabled=true，按管理后台配置的搜索字段匹配（可能含自定义字段）。
出参时间字段统一转为 UTC ISO 8601。
"""
from typing import Any, List, Optional

from .base import WpsV7Client
from .time_util import response_timestamps_to_iso
from .users import get_current_user


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


def search_users(
    keyword: str,
    client: Optional[WpsV7Client] = None,
    page_size: int = 50,
    page_token: Optional[str] = None,
    offset: int = 0,
    with_total: bool = False,
    status: Optional[str] = None,
) -> dict:
    """
    按关键字搜索企业用户（通讯录）。
    GET /v7/users/search。
    keyword: 搜索关键字；具体可匹配哪些字段由企业/私网搜索配置决定。
    offset: 分页偏移量（私网必传，公网可选），默认 0。
    status: 用户状态，如 active；公网建议传 active，私网可选。
    """
    if not keyword or not str(keyword).strip():
        return _normalize_resp({"code": 0, "msg": "", "data": {"items": [], "next_page_token": ""}})
    c = client or WpsV7Client()
    size = min(1000, max(1, page_size))
    params: dict = {
        "keyword": str(keyword).strip(),
        "page_size": size,
        "offset": offset,
        "limit": size,
    }
    if page_token:
        params["page_token"] = page_token
    if with_total:
        params["with_total"] = True
    if status:
        params["status"] = status
    elif not c.is_private:
        params["status"] = "active"
    if c.is_private:
        params["search_field_config_enabled"] = True
    resp = c.get("/v7/users/search", params=params)
    return _normalize_resp(resp)


def _get_company_id(client: WpsV7Client) -> str:
    """从当前用户信息中获取 company_id（私网部分接口必传）。"""
    resp = get_current_user(client)
    data = resp.get("data") or {}
    return data.get("company_id") or ""


def search_depts(
    search_name: str,
    client: Optional[WpsV7Client] = None,
    page_size: int = 50,
    page_token: Optional[str] = None,
    offset: int = 0,
    with_total: bool = False,
) -> dict:
    """
    按名称搜索部门。
    GET /v7/depts/search。
    search_name: 搜索关键字（部门名称）。
    offset: 分页偏移量（私网必传），默认 0。
    """
    if not search_name or not str(search_name).strip():
        return _normalize_resp({"code": 0, "msg": "", "data": {"items": [], "next_page_token": ""}})
    c = client or WpsV7Client()
    size = min(50, max(1, page_size))
    params: dict[str, Any] = {
        "search_name": str(search_name).strip(),
        "page_size": size,
        "offset": offset,
        "limit": size,
    }
    if c.is_private:
        params["company_id"] = _get_company_id(c)
    if page_token:
        params["page_token"] = page_token
    if with_total:
        params["with_total"] = True
    resp = c.get("/v7/depts/search", params=params)
    return _normalize_resp(resp)

def get_root_dept(
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取组织架构根部门信息。
    公网: GET /v7/depts/root。
    私网: /v7/depts/root 不支持用户授权，降级为 GET /v7/depts/0/children 取第一条。
    """
    c = client or WpsV7Client()
    if c.is_private:
        resp = list_dept_children(dept_id="0", client=c)
        if resp.get("code", 0) != 0:
            return resp
        data = resp.get("data") or {}
        items = data.get("items") or []
        root = items[0] if items else {}
        return _normalize_resp({"code": 0, "msg": "", "data": root})
    resp = c.get("/v7/depts/root")
    return _normalize_resp(resp)


def list_dept_children(
    dept_id: str,
    client: Optional[WpsV7Client] = None,
    page_size: int = 50,
    page_token: Optional[str] = None,
    with_total: bool = False,
) -> dict:
    """
    获取指定部门的子部门列表。
    GET /v7/depts/{dept_id}/children。
    dept_id: 部门 ID，传 "0" 表示获取顶级部门。
    """
    if not dept_id or not str(dept_id).strip():
        return _normalize_resp({"code": -1, "msg": "dept_id 不能为空", "data": None})
    c = client or WpsV7Client()
    size = min(50, max(1, page_size))
    params: dict[str, Any] = {
        "page_size": size,
        "offset": 0,
        "limit": size,
    }
    if page_token:
        params["page_token"] = page_token
    if with_total:
        params["with_total"] = True
    resp = c.get(f"/v7/depts/{str(dept_id).strip()}/children", params=params)
    return _normalize_resp(resp)


def list_user_depts(
    user_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取用户所在的部门列表。
    GET /v7/users/{user_id}/depts。
    """
    if not user_id or not str(user_id).strip():
        return _normalize_resp({"code": -1, "msg": "user_id 不能为空", "data": None})
    c = client or WpsV7Client()
    resp = c.get(f"/v7/users/{str(user_id).strip()}/depts")
    return _normalize_resp(resp)


def batch_get_depts(
    dept_ids: List[str],
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    批量获取部门信息。
    POST /v7/depts/batch_read。
    dept_ids: 部门 ID 列表，最多 100 个。
    """
    if not dept_ids:
        return _normalize_resp({"code": -1, "msg": "dept_ids 不能为空", "data": None})
    c = client or WpsV7Client()
    body: dict[str, Any] = {
        "dept_ids": dept_ids[:100],
    }
    resp = c.post("/v7/depts/batch_read", json=body)
    return _normalize_resp(resp)


def list_dept_members(
    dept_id: str,
    client: Optional[WpsV7Client] = None,
    page_size: int = 50,
    page_token: Optional[str] = None,
    recursive: bool = False,
    with_user_detail: bool = True,
    with_total: bool = False,
    status: Optional[str] = None,
) -> dict:
    """
    根据部门 ID 获取部门下的成员列表。
    GET /v7/depts/{dept_id}/members。
    dept_id: 部门 ID。
    recursive: 是否递归查询子部门成员，默认 False。
    with_user_detail: 是否返回用户详细信息（user_name、email 等），默认 True。
    """
    if not dept_id or not str(dept_id).strip():
        return _normalize_resp({"code": -1, "msg": "dept_id 不能为空", "data": None})
    c = client or WpsV7Client()
    size = min(50, max(1, page_size))
    params: dict[str, Any] = {
        "page_size": size,
        "offset": 0,
        "limit": size,
        "with_user_detail": with_user_detail,
    }
    if page_token:
        params["page_token"] = page_token
    if recursive:
        params["recursive"] = True
    if with_total:
        params["with_total"] = True
    if status:
        params["status"] = status
    else:
        params["status"] = "active"
    resp = c.get(f"/v7/depts/{str(dept_id).strip()}/members", params=params)
    return _normalize_resp(resp)


def list_dept_members_all(
    dept_id: str,
    client: Optional[WpsV7Client] = None,
    recursive: bool = False,
    with_user_detail: bool = True,
    status: Optional[str] = None,
    max_pages: int = 20,
) -> List[dict]:
    """
    自动翻页获取部门下所有成员，返回去重后的成员列表。
    max_pages: 最大翻页次数，防止死循环，默认 20（约 1000 人）。
    注意：/v7/depts/{id}/members 为 offset 分页，服务端不返回 next_page_token，
    必须按 offset 递增翻页，否则永远只能拿到第一页。
    """
    all_members: List[dict] = []
    seen_user_ids: set = set()
    offset = 0
    page_size = 50
    c = client or WpsV7Client()

    for _ in range(max_pages):
        resp = c.get(
            f"/v7/depts/{str(dept_id).strip()}/members",
            params={
                "page_size": page_size,
                "offset": offset,
                "limit": page_size,
                "with_user_detail": with_user_detail,
                "recursive": recursive,
                "status": status or "active",
            },
        )
        resp = _normalize_resp(resp)
        if resp.get("code") != 0:
            if not all_members:
                return []
            break
        data = resp.get("data") or {}
        items = data.get("items") or []
        for m in items:
            uid = m.get("user_id", "")
            if uid and uid not in seen_user_ids:
                seen_user_ids.add(uid)
                all_members.append(m)
        if len(items) < page_size:
            break
        offset += len(items)
    return all_members
