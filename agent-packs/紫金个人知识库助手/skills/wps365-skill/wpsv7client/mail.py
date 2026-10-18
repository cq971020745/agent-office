# -*- coding: utf-8 -*-
"""
邮件 V7 API 封装。
覆盖邮箱/目录/搜索/详情/附件/草稿/发送等完整邮件操作。
"""
import os
from typing import Any, Dict, Iterable, List, Optional

from .base import WpsV7Client, private_unsupported
from .time_util import iso_to_timestamp, response_timestamps_to_iso


def _normalize_resp(resp: Any) -> dict:
    """保持 {code, msg, data} 结构，仅对 data 做时间字段转换。"""
    if resp is None:
        return {}
    if not isinstance(resp, dict):
        return {}
    out = dict(resp)
    if "data" in out and out["data"] is not None:
        out["data"] = response_timestamps_to_iso(out["data"])
    return out


def _join_csv(values: Optional[Iterable[str]]) -> Optional[str]:
    if values is None:
        return None
    items = [str(x).strip() for x in values if str(x).strip()]
    return ",".join(items) if items else None


def list_mailboxes(
    client: Optional[WpsV7Client] = None,
    user_id: Optional[str] = None,
) -> dict:
    """获取当前用户邮箱列表。GET /v7/mailboxes"""
    c = client or WpsV7Client()
    params = {"user_id": user_id} if user_id else None
    resp = c.get("/v7/mailboxes", params=params)
    return _normalize_resp(resp)


def list_mail_folders(
    mailbox_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """获取指定邮箱下的目录列表。GET /v7/mailboxes/{mailbox_id}/folders"""
    c = client or WpsV7Client()
    resp = c.get(f"/v7/mailboxes/{mailbox_id}/folders")
    return _normalize_resp(resp)


def search_mail_messages(
    mailbox_ids: Iterable[str],
    client: Optional[WpsV7Client] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    folder_ids: Optional[Iterable[str]] = None,
    exclude_folder_names: Optional[Iterable[str]] = None,
    filters: Optional[Iterable[str]] = None,
    has_attachment: Optional[bool] = None,
    category_id: Optional[str] = None,
    from_query: Optional[str] = None,
    to_query: Optional[str] = None,
    subject: Optional[str] = None,
    body: Optional[str] = None,
    attachment: Optional[str] = None,
    keyword: Optional[str] = None,
    priority: Optional[str] = None,
    page_size: int = 10,
    page_token: Optional[str] = None,
) -> dict:
    """高级搜索邮件。GET /v7/mail_messages/search"""
    mailbox_ids_csv = _join_csv(mailbox_ids)
    if not mailbox_ids_csv:
        return _normalize_resp({"code": 0, "msg": "", "data": {"items": [], "next_page_token": ""}})

    c = client or WpsV7Client()
    params = {
        "mailbox_ids": mailbox_ids_csv,
        "page_size": min(50, max(1, page_size)),
    }

    ts = iso_to_timestamp(start_time) if start_time else None
    if ts:
        params["start_time"] = ts
    ts = iso_to_timestamp(end_time) if end_time else None
    if ts:
        params["end_time"] = ts

    folders_csv = _join_csv(folder_ids)
    if folders_csv:
        params["folders"] = folders_csv
    excluded_csv = _join_csv(exclude_folder_names)
    if excluded_csv:
        params["exclude_folder_names"] = excluded_csv
    filters_csv = _join_csv(filters)
    if filters_csv:
        params["filter"] = filters_csv
    if has_attachment is not None:
        params["has_attachment"] = "true" if has_attachment else "false"
    if category_id:
        params["category_id"] = str(category_id).strip()
    if from_query:
        params["from"] = str(from_query).strip()
    if to_query:
        params["to"] = str(to_query).strip()
    if subject:
        params["subject"] = str(subject).strip()
    if body:
        params["body"] = str(body).strip()
    if attachment:
        params["attachment"] = str(attachment).strip()
    if keyword:
        params["keyword"] = str(keyword).strip()
    if priority:
        params["priority"] = str(priority).strip()
    if page_token:
        params["page_token"] = str(page_token).strip()

    resp = c.get("/v7/mail_messages/search", params=params)
    return _normalize_resp(resp)


def get_mail_message(
    mailbox_id: str,
    folder_id: str,
    message_id: str,
    client: Optional[WpsV7Client] = None,
    with_ocr_body: bool = False,
    with_importance_flag: bool = False,
    user_id: Optional[str] = None,
) -> dict:
    """获取指定邮件详情。GET /v7/mailboxes/{mailbox_id}/folders/{folder_id}/messages/{message_id}"""
    c = client or WpsV7Client()
    params = {}
    if with_ocr_body:
        params["with_ocr_body"] = True
    if with_importance_flag:
        params["with_importance_flag"] = True
    if user_id:
        params["user_id"] = user_id
    resp = c.get(
        f"/v7/mailboxes/{mailbox_id}/folders/{folder_id}/messages/{message_id}",
        params=params or None,
    )
    return _normalize_resp(resp)


# ---------------------------------------------------------------------------
# 目录 / 子目录
# ---------------------------------------------------------------------------

def get_mail_folder(
    mailbox_id: str,
    folder_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """获取指定目录详情。folder_id 支持别名 inbox/drafts/sent/junk/trash。"""
    c = client or WpsV7Client()
    resp = c.get(f"/v7/mailboxes/{mailbox_id}/folders/{folder_id}")
    return _normalize_resp(resp)


def list_mail_folder_children(
    mailbox_id: str,
    parent_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """获取指定目录下的子目录列表。"""
    c = client or WpsV7Client()
    resp = c.get(f"/v7/mailboxes/{mailbox_id}/folders/{parent_id}/children")
    return _normalize_resp(resp)


# ---------------------------------------------------------------------------
# 目录内邮件列表（含线程过滤）
# ---------------------------------------------------------------------------

def list_mail_messages_in_folder(
    mailbox_id: str,
    folder_id: str,
    client: Optional[WpsV7Client] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    filters: Optional[Iterable[str]] = None,
    thread_id: Optional[str] = None,
    page_size: int = 10,
    page_token: Optional[str] = None,
) -> dict:
    """获取目录下邮件列表。folder_id 支持别名 inbox/drafts/sent/junk/trash。"""
    c = client or WpsV7Client()
    params: Dict[str, Any] = {
        "page_size": min(50, max(1, page_size)),
    }
    ts = iso_to_timestamp(start_time) if start_time else None
    if ts:
        params["start_time"] = ts
    ts = iso_to_timestamp(end_time) if end_time else None
    if ts:
        params["end_time"] = ts
    filters_csv = _join_csv(filters)
    if filters_csv:
        params["filter"] = filters_csv
    if thread_id:
        params["thread_id"] = str(thread_id).strip()
    if page_token:
        params["page_token"] = str(page_token).strip()
    resp = c.get(
        f"/v7/mailboxes/{mailbox_id}/folders/{folder_id}/messages",
        params=params,
    )
    return _normalize_resp(resp)


# ---------------------------------------------------------------------------
# 附件
# ---------------------------------------------------------------------------

def get_mail_attachment_download_url(
    mailbox_id: str,
    folder_id: str,
    message_id: str,
    attachment_id: str,
    client: Optional[WpsV7Client] = None,
    user_id: Optional[str] = None,
) -> dict:
    """获取附件下载链接。返回 {code, msg, data: {url}}。"""
    c = client or WpsV7Client()
    params = {}
    if user_id:
        params["user_id"] = user_id
    resp = c.get(
        f"/v7/mailboxes/{mailbox_id}/folders/{folder_id}/messages/{message_id}"
        f"/attachments/{attachment_id}/download",
        params=params or None,
    )
    return _normalize_resp(resp)


def upload_mail_attachment(
    mailbox_id: str,
    file_path: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """上传附件，返回 {code, msg, data: {url}}。url 可在创建草稿时引用。"""
    c = client or WpsV7Client()
    file_size = os.path.getsize(file_path)
    filename = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        resp = c.post_multipart(
            f"/v7/mailboxes/{mailbox_id}/attachments/create",
            files={"content": (filename, f)},
            data={"size": str(file_size)},
        )
    return _normalize_resp(resp)


# ---------------------------------------------------------------------------
# 草稿 / 发送
# ---------------------------------------------------------------------------

def create_mail_draft(
    mailbox_id: str,
    client: Optional[WpsV7Client] = None,
    subject: Optional[str] = None,
    body: Optional[str] = None,
    to_recipients: Optional[List[Dict[str, str]]] = None,
    cc_recipients: Optional[List[Dict[str, str]]] = None,
    bcc_recipients: Optional[List[Dict[str, str]]] = None,
    attachment_urls: Optional[List[str]] = None,
    priority: Optional[int] = None,
) -> dict:
    """创建草稿。返回 {code, msg, data: {id}}。"""
    c = client or WpsV7Client()
    payload: Dict[str, Any] = {}
    if subject is not None:
        payload["subject"] = subject
    if body is not None:
        payload["body"] = body
    if to_recipients:
        payload["to_recipients"] = to_recipients
    if cc_recipients:
        payload["cc_recipients"] = cc_recipients
    if bcc_recipients:
        payload["bcc_recipients"] = bcc_recipients
    if attachment_urls:
        payload["attachment_urls"] = attachment_urls
    if priority is not None:
        payload["priority"] = priority
    resp = c.post(f"/v7/mailboxes/{mailbox_id}/messages/create", json=payload)
    return _normalize_resp(resp)


def send_mail_message(
    mailbox_id: str,
    message_id: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """发送草稿箱中的邮件。"""
    c = client or WpsV7Client()
    resp = c.post(f"/v7/mailboxes/{mailbox_id}/messages/{message_id}/send")
    return _normalize_resp(resp)
