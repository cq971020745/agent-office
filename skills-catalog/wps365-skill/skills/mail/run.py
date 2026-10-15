#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
邮件完整操作：搜索、浏览、查看、回复、转发、发送、附件下载/上传。
调用 V7 Mail 接口，输出 Markdown + JSON。
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_root = Path(__file__).resolve().parent.parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from wpsv7client import (  # noqa: E402
    list_mailboxes,
    list_mail_folders,
    search_mail_messages,
    get_mail_message,
    get_mail_folder,
    list_mail_folder_children,
    list_mail_messages_in_folder,
    get_mail_attachment_download_url,
    upload_mail_attachment,
    create_mail_draft,
    send_mail_message,
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

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

_OP_STORE_DIR = os.path.expanduser("~/.wps365/operations")
_set_marker, _finalize_marker = create_marker_hooks()


def _out(md_lines, data):
    lines = [""] + md_lines + ["", "## 原始数据 (JSON)", "", "```json", json.dumps(data, ensure_ascii=False, indent=2), "```"]
    print("\n".join(lines))
    _finalize_marker()
    sys.stdout.flush()


def _err(msg):
    _set_marker(ERROR_EXIT=True, ERROR_MESSAGE=str(msg))
    _finalize_marker()
    sys.stdout.flush()
    print("## 错误\n\n" + msg, file=sys.stderr)
    sys.exit(1)


def _check_resp(resp):
    if resp.get("code") == -2:
        _err(f"[私网不可用] {resp.get('msg')}（此接口仅公网支持，请切换到公网或使用替代方案，不要重试）")
    if resp.get("code") != 0:
        _err(resp.get("msg") or resp.get("message") or "未知错误")
    d = resp.get("data")
    return d if d is not None else {}


def _build_operation_payload(target_id, action, params):
    return {
        "target": target_id,
        "action": action,
        "params": params or {},
    }


def _generate_operation(payload):
    payload_text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    preview_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    op_id = str(uuid.uuid4())
    os.makedirs(_OP_STORE_DIR, exist_ok=True)
    op_path = Path(_OP_STORE_DIR) / f"{op_id}.json"
    op_path.write_text(
        json.dumps({"hash": preview_hash, "expires_at": time.time() + 600}, ensure_ascii=False),
        encoding="utf-8",
    )
    return op_id, preview_hash


def _validate_operation(op_id, payload):
    op_path = Path(_OP_STORE_DIR) / f"{op_id}.json"
    if not op_path.exists():
        raise ValueError("Operation 已过期或不存在，请重新执行 Dry Run。")
    record = json.loads(op_path.read_text(encoding="utf-8"))
    expires_at = float(record.get("expires_at", 0))
    if time.time() > expires_at:
        op_path.unlink(missing_ok=True)
        raise ValueError("Operation 已过期，请重新执行 Dry Run。")
    payload_text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    current_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    if current_hash != record.get("hash"):
        raise ValueError("安全校验失败：请求参数与 Dry Run 不一致，请重新执行 Dry Run。")
    op_path.unlink(missing_ok=True)


def _mutation_gate(action_title, detail_lines, confirmed, operation_payload=None, operation_id=None):
    md = [f"## {action_title}", ""]
    md.extend(detail_lines)
    if confirmed:
        if operation_payload is not None:
            if not operation_id:
                _err("缺少 --operation-id，请先执行 Dry Run 获取 OPERATION_ID。")
            _validate_operation(operation_id, operation_payload)
        return False, md
    if operation_payload is not None:
        op_id, preview_hash = _generate_operation(operation_payload)
        _set_marker(OPERATION_ID=op_id, PREVIEW_HASH=preview_hash)
        md.extend([
            "",
            f"- **OPERATION_ID**：`{op_id}`",
            f"- **PREVIEW_HASH**：`{preview_hash}`",
        ])
    md.extend([
        "",
        "**当前为 Dry Run，未执行实际变更。**",
        "",
        "请通过 `askUserQuestion` 向用户确认，确认后再追加 `--confirm --operation-id <OPERATION_ID>` 重新执行。",
        "注意：之前对话中对其他操作的确认不适用于本次操作，必须获得用户对本次操作的单独确认。",
    ])
    return True, md


def _split_csv(raw):
    if not raw:
        return []
    return [x.strip() for x in str(raw).split(",") if x.strip()]


def _guard_ambiguous_identifier(field_name, raw_value):
    """若输入看起来包含多个候选 ID，则强制挂起，要求先 askUserQuestion。"""
    parts = _split_csv(raw_value)
    if len(parts) <= 1:
        return
    _set_marker(AMBIGUOUS_RESULTS=len(parts), ASK_USER_REQUIRED=True)
    _err(f"{field_name} 命中 {len(parts)} 个候选项，请先通过 askUserQuestion 让用户选择唯一目标后再继续。")


def _recipient_display(recipient):
    if not isinstance(recipient, dict):
        return "-"
    name = recipient.get("name") or ""
    email = recipient.get("email_address") or ""
    if name and email:
        return f"{name} <{email}>"
    return name or email or "-"


def _recipients_display(recipients):
    if not recipients:
        return "-"
    return ", ".join(_recipient_display(r) for r in recipients)


def _bool_zh(val):
    if val is True:
        return "是"
    if val is False:
        return "否"
    return "-"


def _human_size(size_bytes):
    """将字节数转为人类可读格式。"""
    if not isinstance(size_bytes, (int, float)) or size_bytes < 0:
        return "-"
    for unit in ("B", "KB", "MB", "GB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}" if unit != "B" else f"{int(size_bytes)} B"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


_HTML_TAG_RE = re.compile(
    r"</?(?:p|div|br|span|strong|em|b|i|ul|ol|li|table|tr|td|th|a|html|body|blockquote)\b",
    re.I,
)


def _ensure_html_body(body):
    """纯文本 body 自动包为 HTML 段落，避免邮件客户端无格式显示。"""
    if body is None:
        return None
    s = str(body).strip()
    if not s:
        return body
    if _HTML_TAG_RE.search(s):
        return body
    blocks = [b.strip() for b in re.split(r"\n\s*\n", s) if b.strip()]
    if not blocks:
        return f"<p>{html.escape(s)}</p>"
    parts = []
    for block in blocks:
        escaped = html.escape(block)
        lines = escaped.split("\n")
        if len(lines) == 1:
            parts.append(f"<p>{lines[0]}</p>")
        else:
            parts.append("<p>" + "<br/>".join(lines) + "</p>")
    return "\n".join(parts)


def _resolve_mailbox_id(mailbox_id_arg):
    """若 mailbox_id 为空则自动取主邮箱。返回 (mailbox_id, mailbox_items)。"""
    if mailbox_id_arg:
        return mailbox_id_arg, []
    data = _check_resp(list_mailboxes())
    items = data.get("items") or []
    if not items:
        _err("当前账号下暂无邮箱。")
    for item in items:
        if item.get("is_primary") and item.get("id"):
            return item["id"], items
    first_id = items[0].get("id")
    if not first_id:
        _err("邮箱数据异常：缺少 ID 字段。")
    return first_id, items


_RE_NAMED_EMAIL = re.compile(r'^(.+?)\s*<([^>]+)>$')


def _parse_recipients(raw):
    """解析收件人字符串，返回 [{name, email_address}] 列表。
    支持格式：纯邮箱 / 名字 <邮箱>，逗号分隔多人。
    """
    if not raw:
        return []
    result = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        m = _RE_NAMED_EMAIL.match(part)
        if m:
            result.append({"name": m.group(1).strip(), "email_address": m.group(2).strip()})
        else:
            result.append({"name": "", "email_address": part})
    return result


# ---------------------------------------------------------------------------
# 邮件列表渲染（search 和 list 共用）
# ---------------------------------------------------------------------------

def _render_message_list(items, md):
    """将 v7_mail_message_list 的 items 渲染为 Markdown 行，追加到 md。"""
    if not items:
        md.extend(["", "未找到邮件。"])
        return
    md.append("")
    for i, item in enumerate(items[:50], 1):
        md.extend([
            (
                f"{i}. **{item.get('subject') or '(无主题)'}** | 发件人: {_recipient_display(item.get('from'))} | "
                f"时间: {item.get('ctime', '-')} | 已读: {_bool_zh(item.get('is_read'))} | 附件: {_bool_zh(item.get('has_attachments'))}"
            ),
            (
                f"   邮箱: `{item.get('mailbox_id', '-')}` | 目录: `{item.get('folder_id', '-')}` | "
                f"消息: `{item.get('id', '-')}` | 线程: `{item.get('thread_id', '-')}`"
            ),
        ])
        preview = (item.get("body_preview") or "").strip()
        if preview:
            md.append(f"   摘要: {preview}")
        link = item.get("link") or ""
        if link:
            md.append(f"   链接: {link}")


# ---------------------------------------------------------------------------
# 子命令实现
# ---------------------------------------------------------------------------

def cmd_mailboxes(_args):
    _set_marker(ACTION_SELECTED="mail.mailboxes")
    resp = list_mailboxes()
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 邮箱列表", "", f"共 **{len(items)}** 个邮箱。"]
    if not items:
        md.extend(["", "当前账号下暂无邮箱。"])
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            label = item.get("address") or item.get("id") or "-"
            extras = []
            if item.get("is_primary"):
                extras.append("主邮箱")
            if item.get("is_shared"):
                extras.append("共享")
            extra_str = f"（{'/'.join(extras)}）" if extras else ""
            md.append(f"{i}. **{label}** `{item.get('id', '-')}` {extra_str}".rstrip())
    _out(md, data)


def cmd_folders(args):
    _set_marker(ACTION_SELECTED="mail.folders")
    resp = list_mail_folders(args.mailbox_id)
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 邮件目录列表", "", f"邮箱 `{args.mailbox_id}` 下共 **{len(items)}** 个目录。"]
    if not items:
        md.extend(["", "未找到目录。"])
    else:
        md.append("")
        for i, item in enumerate(items[:100], 1):
            md.append(
                f"{i}. **{item.get('display_name') or item.get('name') or '-'}** "
                f"`{item.get('id', '-')}` | 标识: {item.get('name', '-')} | "
                f"未读: {item.get('unread_message_count', 0)} | 总数: {item.get('total_message_count', 0)}"
            )
    _out(md, data)


def cmd_folder(args):
    _set_marker(ACTION_SELECTED="mail.folder")
    resp = get_mail_folder(args.mailbox_id, args.folder_id)
    data = _check_resp(resp)
    md = [
        "## 目录详情",
        "",
        f"- **名称**：{data.get('name', '-')}",
        f"- **目录ID**：`{data.get('id', '-')}`",
        f"- **类型**：{data.get('folder_type', '-')}",
        f"- **未读**：{data.get('unread_message_count', 0)}",
        f"- **总数**：{data.get('total_message_count', 0)}",
    ]
    parent = data.get("parent_folder_id")
    if parent:
        md.append(f"- **上级目录**：`{parent}`")
    _out(md, data)


_FOLDER_ALIASES = {"inbox", "drafts", "sent", "junk", "trash"}


def _resolve_folder_alias(mailbox_id, folder_id_or_alias):
    """如果 folder_id 是别名，通过 get_mail_folder 获取真实 ID。"""
    if folder_id_or_alias.lower() in _FOLDER_ALIASES:
        resp = get_mail_folder(mailbox_id, folder_id_or_alias)
        data = _check_resp(resp)
        real_id = data.get("id")
        if real_id:
            return real_id
    return folder_id_or_alias


def cmd_folder_children(args):
    _set_marker(ACTION_SELECTED="mail.folder-children")
    parent_id = _resolve_folder_alias(args.mailbox_id, args.parent_id)
    resp = list_mail_folder_children(args.mailbox_id, parent_id)
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 子目录列表", "", f"共 **{len(items)}** 个子目录。"]
    if not items:
        md.extend(["", "无子目录。"])
    else:
        md.append("")
        for i, item in enumerate(items[:100], 1):
            md.append(
                f"{i}. **{item.get('name', '-')}** `{item.get('id', '-')}` | "
                f"未读: {item.get('unread_message_count', 0)} | 总数: {item.get('total_message_count', 0)}"
            )
    _out(md, data)


def cmd_list(args):
    _set_marker(ACTION_SELECTED="mail.list")
    mailbox_id, _ = _resolve_mailbox_id(args.mailbox_id)
    filters = _split_csv(args.filter)
    resp = list_mail_messages_in_folder(
        mailbox_id=mailbox_id,
        folder_id=args.folder_id,
        start_time=args.start_time,
        end_time=args.end_time,
        filters=filters or None,
        thread_id=args.thread_id,
        page_size=args.page_size,
        page_token=args.page_token,
    )
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 目录邮件列表", "", f"目录: `{args.folder_id}` | 邮箱: `{mailbox_id}` | 本页: **{len(items)}**"]
    if args.thread_id:
        md.append(f"线程: `{args.thread_id}`")
    next_token = data.get("next_page_token") or ""
    if next_token:
        md.append(f"下一页 token：`{next_token}`")
    _render_message_list(items, md)
    if len(items) > 1:
        _set_marker(AMBIGUOUS_RESULTS=len(items), ASK_USER_REQUIRED=True)
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def _has_any_search_condition(args):
    return any([
        args.keyword, args.from_query, args.to_query,
        args.subject, args.body, args.attachment,
        args.has_attachment, args.filter,
        args.folder_ids, args.exclude_folders,
        args.start_time, args.end_time, args.priority,
    ])


_UNFILTERED_PAGE_CAP = 5


def cmd_search(args):
    _set_marker(ACTION_SELECTED="mail.search")
    unfiltered = not _has_any_search_condition(args)

    mailbox_ids = _split_csv(args.mailbox_ids)
    if not mailbox_ids:
        mailbox_data = _check_resp(list_mailboxes())
        mailbox_items = mailbox_data.get("items") or []
        mailbox_ids = [item.get("id") for item in mailbox_items if item.get("id")]
    if not mailbox_ids:
        _err("当前账号下没有可搜索的邮箱。")

    filters = _split_csv(args.filter)
    folder_ids = _split_csv(args.folder_ids)
    exclude_folders = _split_csv(args.exclude_folders)
    page_size = min(args.page_size, _UNFILTERED_PAGE_CAP) if unfiltered else args.page_size

    resp = search_mail_messages(
        mailbox_ids=mailbox_ids,
        start_time=args.start_time,
        end_time=args.end_time,
        folder_ids=folder_ids or None,
        exclude_folder_names=exclude_folders or None,
        filters=filters or None,
        has_attachment=True if args.has_attachment else None,
        from_query=args.from_query,
        to_query=args.to_query,
        subject=args.subject,
        body=args.body,
        attachment=args.attachment,
        keyword=args.keyword,
        priority=args.priority,
        page_size=page_size,
        page_token=args.page_token,
    )
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 邮件搜索结果", ""]
    if unfiltered:
        md.append(f"> 未指定搜索条件，默认展示最近 **{page_size}** 封邮件。如需精确搜索，请使用 --keyword、--from、--subject 等参数。")
        md.append("")
    md.extend([f"搜索范围邮箱数：**{len(mailbox_ids)}**", f"本页结果数：**{len(items)}**"])
    conditions = []
    if args.keyword:
        conditions.append(f"关键字={args.keyword}")
    if args.subject:
        conditions.append(f"主题={args.subject}")
    if args.from_query:
        conditions.append(f"发件人={args.from_query}")
    if args.to_query:
        conditions.append(f"收件人={args.to_query}")
    if args.body:
        conditions.append(f"正文={args.body}")
    if args.has_attachment:
        conditions.append("仅含附件")
    if args.attachment:
        conditions.append(f"附件名={args.attachment}")
    if args.start_time or args.end_time:
        conditions.append(f"时间={args.start_time or '-'} ~ {args.end_time or '-'}")
    if conditions:
        md.append(f"搜索条件：{'；'.join(conditions)}")
    next_page_token = data.get("next_page_token") or ""
    if next_page_token:
        md.append(f"下一页 token：`{next_page_token}`")
    _render_message_list(items, md)
    if len(items) > 1:
        _set_marker(AMBIGUOUS_RESULTS=len(items), ASK_USER_REQUIRED=True)
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def cmd_get(args):
    _set_marker(ACTION_SELECTED="mail.get")
    _guard_ambiguous_identifier("message_id", args.message_id)
    resp = get_mail_message(
        args.mailbox_id,
        args.folder_id,
        args.message_id,
        with_ocr_body=args.with_ocr_body,
        with_importance_flag=args.with_importance_flag,
    )
    data = _check_resp(resp)

    to_list = data.get("to_recipient") or []
    cc_list = data.get("cc_recipient") or []
    bcc_list = data.get("bcc_recipient") or []
    attachments = data.get("attachments") or []

    md = [
        "## 邮件详情",
        "",
        f"- **主题**：{data.get('subject') or '(无主题)'}",
        f"- **发件人**：{_recipient_display(data.get('from'))}",
        f"- **收件人**：{_recipients_display(to_list)}",
    ]
    if cc_list:
        md.append(f"- **抄送**：{_recipients_display(cc_list)}")
    if bcc_list:
        md.append(f"- **密送**：{_recipients_display(bcc_list)}")
    md.extend([
        f"- **时间**：{data.get('ctime', '-')}",
        f"- **邮箱ID**：`{data.get('mailbox_id', '-')}`",
        f"- **目录ID**：`{data.get('folder_id', '-')}`",
        f"- **消息ID**：`{data.get('id', '-')}`",
        f"- **线程ID**：`{data.get('thread_id', '-')}`",
        f"- **线程邮件数**：{data.get('thread_message_count', '-')}",
        f"- **已读**：{_bool_zh(data.get('is_read'))}",
        f"- **星标**：{_bool_zh(data.get('is_flag'))}",
    ])

    if attachments:
        md.extend(["", "### 附件列表", ""])
        for j, att in enumerate(attachments, 1):
            md.append(
                f"{j}. **{att.get('filename', '-')}** | "
                f"ID: `{att.get('id', '-')}` | "
                f"大小: {_human_size(att.get('size', 0))} | "
                f"类型: {att.get('mime_type', '-')}"
            )
    else:
        md.append(f"- **附件**：无")

    body = (data.get("body") or "").strip()
    if body:
        md.extend(["", "### 正文", "", body[:4000]])
    _out(md, data)


def cmd_attachment(args):
    _set_marker(ACTION_SELECTED="mail.attachment")
    _guard_ambiguous_identifier("message_id", args.message_id)
    _guard_ambiguous_identifier("attachment_id", args.attachment_id)
    resp = get_mail_attachment_download_url(
        args.mailbox_id, args.folder_id, args.message_id, args.attachment_id,
    )
    data = _check_resp(resp)
    url = data.get("url") or ""
    md = [
        "## 附件下载",
        "",
        f"- **附件ID**：`{args.attachment_id}`",
        f"- **下载链接**：{url or '(未获取到)'}",
    ]
    _out(md, data)


def cmd_upload_attachment(args):
    _set_marker(ACTION_SELECTED="mail.upload-attachment", WRITE_OPERATION=True)
    mailbox_id, _ = _resolve_mailbox_id(args.mailbox_id)
    resp = upload_mail_attachment(mailbox_id, args.file_path)
    data = _check_resp(resp)
    url = data.get("url") or ""
    md = [
        "## 附件上传",
        "",
        f"- **文件**：{args.file_path}",
        f"- **附件URL**：`{url}`",
        "",
        "此 URL 可在创建草稿时通过 `--attachments` 参数引用。",
    ]
    _out(md, data)


def cmd_draft(args):
    _set_marker(ACTION_SELECTED="mail.draft", WRITE_OPERATION=True)
    mailbox_id, _ = _resolve_mailbox_id(args.mailbox_id)
    to_r = _parse_recipients(args.to)
    cc_r = _parse_recipients(args.cc)
    bcc_r = _parse_recipients(args.bcc)
    att_urls = _split_csv(args.attachments)
    priority = int(args.priority) if args.priority is not None else None

    resp = create_mail_draft(
        mailbox_id,
        subject=args.subject,
        body=_ensure_html_body(args.body),
        to_recipients=to_r or None,
        cc_recipients=cc_r or None,
        bcc_recipients=bcc_r or None,
        attachment_urls=att_urls or None,
        priority=priority,
    )
    data = _check_resp(resp)
    md = [
        "## 草稿已创建",
        "",
        f"- **主题**：{args.subject or '(无主题)'}",
        f"- **草稿ID**：`{data.get('id', '-')}`",
        f"- **邮箱ID**：`{mailbox_id}`",
        "",
        f"使用 `send {mailbox_id} {data.get('id', '')}` 发送此草稿。",
    ]
    _out(md, data)


def _check_send_resp(resp):
    """校验 send_mail_message 的返回值，拦截空响应和错误码。"""
    if not resp or resp.get("code") is None:
        _err("发送请求未返回有效响应")
    if resp.get("code") != 0:
        _err(resp.get("msg") or "发送失败")


def cmd_send(args):
    _set_marker(
        ACTION_SELECTED="mail.send",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    detail_lines = [
        f"- **邮箱ID**：`{args.mailbox_id}`",
        f"- **消息ID**：`{args.message_id}`",
    ]
    op_payload = _build_operation_payload(
        target_id=args.message_id,
        action="mail.send",
        params={"mailbox_id": args.mailbox_id},
    )
    dry_run, md = _mutation_gate(
        "发送已有草稿",
        detail_lines,
        args.confirm,
        operation_payload=op_payload,
        operation_id=getattr(args, "operation_id", None),
    )
    if dry_run:
        _out(md, {})
        return
    resp = send_mail_message(args.mailbox_id, args.message_id)
    _check_send_resp(resp)
    md.extend([
        "",
        "## 邮件已发送",
        "",
        f"- **邮箱ID**：`{args.mailbox_id}`",
        f"- **消息ID**：`{args.message_id}`",
    ])
    _out(md, resp.get("data") or {})


def cmd_send_direct(args):
    _set_marker(
        ACTION_SELECTED="mail.send-direct",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    mailbox_id, _ = _resolve_mailbox_id(args.mailbox_id)
    to_r = _parse_recipients(args.to)
    if not to_r:
        _err("必须指定收件人 --to")
    cc_r = _parse_recipients(args.cc)
    bcc_r = _parse_recipients(args.bcc)
    detail_lines = [
        f"- **收件人**：{_recipients_display(to_r)}",
        f"- **主题**：{args.subject or '(无主题)'}",
    ]
    if cc_r:
        detail_lines.append(f"- **抄送**：{_recipients_display(cc_r)}")
    if bcc_r:
        detail_lines.append(f"- **密送**：{_recipients_display(bcc_r)}")
    op_payload = _build_operation_payload(
        target_id=_recipients_display(to_r),
        action="mail.send-direct",
        params={
            "mailbox_id": mailbox_id,
            "to": to_r,
            "cc": cc_r,
            "bcc": bcc_r,
            "subject": args.subject,
            "body": args.body,
            "attachments": _split_csv(args.attachments),
            "priority": args.priority,
        },
    )
    dry_run, md = _mutation_gate(
        "一步发送新邮件",
        detail_lines,
        args.confirm,
        operation_payload=op_payload,
        operation_id=getattr(args, "operation_id", None),
    )
    if dry_run:
        _out(md, {})
        return
    att_urls = _split_csv(args.attachments)
    priority = int(args.priority) if args.priority is not None else None

    draft_resp = create_mail_draft(
        mailbox_id,
        subject=args.subject,
        body=_ensure_html_body(args.body),
        to_recipients=to_r,
        cc_recipients=cc_r or None,
        bcc_recipients=bcc_r or None,
        attachment_urls=att_urls or None,
        priority=priority,
    )
    draft_data = _check_resp(draft_resp)
    message_id = draft_data.get("id")
    if not message_id:
        _err("创建草稿失败，未返回消息ID")

    send_resp = send_mail_message(mailbox_id, message_id)
    _check_send_resp(send_resp)

    md.extend([
        "",
        "## 邮件已发送",
        "",
        f"- **收件人**：{_recipients_display(to_r)}",
        f"- **主题**：{args.subject or '(无主题)'}",
        f"- **邮箱ID**：`{mailbox_id}`",
        f"- **消息ID**：`{message_id}`",
    ])
    _out(md, draft_data)


def _build_quote(original_data):
    """构造引用原文块。"""
    sender = _recipient_display(original_data.get("from"))
    subject = original_data.get("subject") or "(无主题)"
    ctime = original_data.get("ctime", "-")
    body = (original_data.get("body") or "").strip()
    lines = [
        "",
        "---------- 原始邮件 ----------",
        f"发件人: {sender}",
        f"时间: {ctime}",
        f"主题: {subject}",
        "",
    ]
    if body:
        lines.append(body[:4000])
    return "\n".join(lines)


def cmd_reply(args):
    _set_marker(
        ACTION_SELECTED="mail.reply",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    _guard_ambiguous_identifier("message_id", args.message_id)
    mailbox_id, _ = _resolve_mailbox_id(args.mailbox_id)

    orig_resp = get_mail_message(mailbox_id, args.folder_id, args.message_id)
    orig = _check_resp(orig_resp)

    orig_from = orig.get("from") or {}
    to_r = [{"name": orig_from.get("name", ""), "email_address": orig_from.get("email_address", "")}]

    cc_r = []
    if args.reply_all:
        seen = {orig_from.get("email_address", "").lower()}
        my_mailboxes = {item.get("address", "").lower() for item in (_check_resp(list_mailboxes()).get("items") or [])}
        for r in (orig.get("to_recipient") or []):
            addr = (r.get("email_address") or "").lower()
            if addr and addr not in seen and addr not in my_mailboxes:
                cc_r.append(r)
                seen.add(addr)
        for r in (orig.get("cc_recipient") or []):
            addr = (r.get("email_address") or "").lower()
            if addr and addr not in seen and addr not in my_mailboxes:
                cc_r.append(r)
                seen.add(addr)

    extra_cc = _parse_recipients(args.cc)
    if extra_cc:
        cc_r.extend(extra_cc)

    orig_subject = orig.get("subject") or ""
    subject = orig_subject if orig_subject.lower().startswith("re:") else f"Re: {orig_subject}"
    body_preview = (args.body or "")[:100]
    detail_lines = [
        f"- **目录ID**：`{args.folder_id}`",
        f"- **消息ID**：`{args.message_id}`",
        f"- **回复全部**：{_bool_zh(args.reply_all)}",
        f"- **正文预览**：{body_preview if body_preview else '(空)'}",
        f"- **原主题**：{orig_subject or '(无主题)'}",
        f"- **原发件人**：{_recipient_display(orig.get('from'))}",
        f"- **将回复至**：{_recipients_display(to_r)}",
    ]
    if cc_r:
        detail_lines.append(f"- **将抄送**：{_recipients_display(cc_r)}")
    op_payload = _build_operation_payload(
        target_id=args.message_id,
        action="mail.reply",
        params={
            "mailbox_id": mailbox_id,
            "folder_id": args.folder_id,
            "body": args.body,
            "reply_all": bool(args.reply_all),
            "cc": _parse_recipients(args.cc),
            "attachments": _split_csv(args.attachments),
        },
    )
    dry_run, md = _mutation_gate(
        "回复邮件",
        detail_lines,
        args.confirm,
        operation_payload=op_payload,
        operation_id=getattr(args, "operation_id", None),
    )
    if dry_run:
        _out(md, {})
        return

    quote = _build_quote(orig)
    body = (_ensure_html_body(args.body) or "") + "\n" + quote

    att_urls = _split_csv(args.attachments)

    draft_resp = create_mail_draft(
        mailbox_id,
        subject=subject,
        body=body,
        to_recipients=to_r,
        cc_recipients=cc_r or None,
        attachment_urls=att_urls or None,
    )
    draft_data = _check_resp(draft_resp)
    message_id = draft_data.get("id")
    if not message_id:
        _err("创建回复草稿失败")

    send_resp = send_mail_message(mailbox_id, message_id)
    _check_send_resp(send_resp)

    md.extend([
        "",
        "## 回复已发送",
        "",
        f"- **收件人**：{_recipients_display(to_r)}",
    ])
    if cc_r:
        md.append(f"- **抄送**：{_recipients_display(cc_r)}")
    md.extend([
        f"- **主题**：{subject}",
        f"- **消息ID**：`{message_id}`",
    ])
    _out(md, draft_data)


def cmd_forward(args):
    _set_marker(
        ACTION_SELECTED="mail.forward",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    _guard_ambiguous_identifier("message_id", args.message_id)
    mailbox_id, _ = _resolve_mailbox_id(args.mailbox_id)

    to_r = _parse_recipients(args.to)
    if not to_r:
        _err("转发必须指定收件人 --to")

    orig_resp = get_mail_message(mailbox_id, args.folder_id, args.message_id)
    orig = _check_resp(orig_resp)

    orig_subject = orig.get("subject") or ""
    detail_lines = [
        f"- **收件人**：{_recipients_display(to_r)}",
        f"- **原主题**：{orig_subject or '(无主题)'}",
        f"- **目录ID**：`{args.folder_id}`",
        f"- **消息ID**：`{args.message_id}`",
    ]
    op_payload = _build_operation_payload(
        target_id=args.message_id,
        action="mail.forward",
        params={
            "mailbox_id": mailbox_id,
            "folder_id": args.folder_id,
            "to": to_r,
            "body": args.body,
            "attachments": _split_csv(args.attachments),
        },
    )
    dry_run, md = _mutation_gate(
        "转发邮件",
        detail_lines,
        args.confirm,
        operation_payload=op_payload,
        operation_id=getattr(args, "operation_id", None),
    )
    if dry_run:
        _out(md, {})
        return

    subject = orig_subject if orig_subject.lower().startswith("fwd:") else f"Fwd: {orig_subject}"

    quote = _build_quote(orig)
    body = (_ensure_html_body(args.body) or "") + "\n" + quote

    att_urls = _split_csv(args.attachments)

    draft_resp = create_mail_draft(
        mailbox_id,
        subject=subject,
        body=body,
        to_recipients=to_r,
        attachment_urls=att_urls or None,
    )
    draft_data = _check_resp(draft_resp)
    message_id = draft_data.get("id")
    if not message_id:
        _err("创建转发草稿失败")

    send_resp = send_mail_message(mailbox_id, message_id)
    _check_send_resp(send_resp)

    md.extend([
        "",
        "## 转发已发送",
        "",
        f"- **收件人**：{_recipients_display(to_r)}",
        f"- **主题**：{subject}",
        f"- **消息ID**：`{message_id}`",
    ])
    _out(md, draft_data)


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="邮件完整操作（V7）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    # -- mailboxes --
    p = sub.add_parser("mailboxes", help="获取当前账号邮箱列表")
    p.set_defaults(func=cmd_mailboxes)

    # -- folders --
    p = sub.add_parser("folders", help="获取指定邮箱的目录列表")
    p.add_argument("mailbox_id", help="邮箱 ID")
    p.set_defaults(func=cmd_folders)

    # -- folder --
    p = sub.add_parser("folder", help="获取指定目录详情（支持别名 inbox/drafts/sent/junk/trash）")
    p.add_argument("mailbox_id", help="邮箱 ID")
    p.add_argument("folder_id", help="目录 ID 或别名")
    p.set_defaults(func=cmd_folder)

    # -- folder-children --
    p = sub.add_parser("folder-children", help="获取子目录列表")
    p.add_argument("mailbox_id", help="邮箱 ID")
    p.add_argument("parent_id", help="父目录 ID")
    p.set_defaults(func=cmd_folder_children)

    # -- list --
    p = sub.add_parser("list", help="列出目录下邮件（支持线程过滤）")
    p.add_argument("folder_id", help="目录 ID 或别名（inbox/drafts/sent/junk/trash）")
    p.add_argument("--mailbox-id", default=None, help="邮箱 ID；不传则自动取主邮箱")
    p.add_argument("--thread-id", default=None, help="按线程 ID 过滤")
    p.add_argument("--filter", default=None, help="筛选条件，逗号分隔，例如 unread,flagged")
    p.add_argument("--start-time", default=None, help="开始时间，ISO 8601")
    p.add_argument("--end-time", default=None, help="结束时间，ISO 8601")
    p.add_argument("--page-size", type=int, default=10, help="每页数量，1-50")
    p.add_argument("--page-token", default=None, help="翻页 token")
    p.set_defaults(func=cmd_list)

    # -- search --
    p = sub.add_parser("search", help="统一邮件搜索（高级搜索）")
    p.add_argument("--keyword", default=None, help="关键字搜索")
    p.add_argument("--mailbox-ids", default=None, help="邮箱 ID 列表，逗号分隔；不传则搜索全部邮箱")
    p.add_argument("--folder-ids", default=None, help="目录 ID 列表，逗号分隔")
    p.add_argument("--exclude-folders", default=None, help="排除目录名称，例如 Sent,Drafts")
    p.add_argument("--filter", default=None, help="筛选条件，例如 unread,flagged")
    p.add_argument("--from", dest="from_query", default=None, help="发件人")
    p.add_argument("--to", dest="to_query", default=None, help="收件人")
    p.add_argument("--subject", default=None, help="按主题搜索")
    p.add_argument("--body", default=None, help="按正文搜索")
    p.add_argument("--attachment", default=None, help="按附件名搜索")
    p.add_argument("--has-attachment", action="store_true", help="仅搜索包含附件的邮件")
    p.add_argument("--priority", default=None, help="优先级：0 普通 / 1 高 / 5 低")
    p.add_argument("--start-time", default=None, help="开始时间，ISO 8601")
    p.add_argument("--end-time", default=None, help="结束时间，ISO 8601")
    p.add_argument("--page-size", type=int, default=10, help="每页数量，1-50")
    p.add_argument("--page-token", default=None, help="翻页 token")
    p.set_defaults(func=cmd_search)

    # -- get --
    p = sub.add_parser("get", help="获取邮件详情（含收件人、附件列表）")
    p.add_argument("mailbox_id", help="邮箱 ID")
    p.add_argument("folder_id", help="目录 ID")
    p.add_argument("message_id", help="邮件 ID")
    p.add_argument("--with-ocr-body", action="store_true", help="返回 OCR 后正文")
    p.add_argument("--with-importance-flag", action="store_true", help="返回重要性标识")
    p.set_defaults(func=cmd_get)

    # -- attachment --
    p = sub.add_parser("attachment", help="获取附件下载链接")
    p.add_argument("mailbox_id", help="邮箱 ID")
    p.add_argument("folder_id", help="目录 ID")
    p.add_argument("message_id", help="邮件 ID")
    p.add_argument("attachment_id", help="附件 ID（从 get 命令的附件列表获取）")
    p.set_defaults(func=cmd_attachment)

    # -- upload-attachment --
    p = sub.add_parser("upload-attachment", help="上传附件获取 URL")
    p.add_argument("file_path", help="本地文件路径")
    p.add_argument("--mailbox-id", default=None, help="邮箱 ID；不传则自动取主邮箱")
    p.set_defaults(func=cmd_upload_attachment)

    # -- draft --
    p = sub.add_parser("draft", help="创建草稿（不发送）")
    p.add_argument("--mailbox-id", default=None, help="邮箱 ID；不传则自动取主邮箱")
    p.add_argument("--to", default=None, help="收件人，逗号分隔")
    p.add_argument("--cc", default=None, help="抄送，逗号分隔")
    p.add_argument("--bcc", default=None, help="密送，逗号分隔")
    p.add_argument("--subject", default=None, help="主题")
    p.add_argument("--body", default=None, help="正文")
    p.add_argument("--attachments", default=None, help="附件 URL 列表，逗号分隔")
    p.add_argument("--priority", default=None, help="优先级：0 普通 / 1 高 / 5 低")
    p.set_defaults(func=cmd_draft)

    # -- send --
    p = sub.add_parser("send", help="发送已有草稿（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("mailbox_id", help="邮箱 ID")
    p.add_argument("message_id", help="草稿消息 ID")
    p.add_argument("--confirm", action="store_true", help="确认执行发送；默认仅预览（dry-run）")
    p.add_argument("--operation-id", default=None, help="Dry Run 返回的 OPERATION_ID（确认执行时必填）")
    p.set_defaults(func=cmd_send)

    # -- send-direct --
    p = sub.add_parser("send-direct", help="一步发送新邮件（自动创建草稿并发送）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("--mailbox-id", default=None, help="邮箱 ID；不传则自动取主邮箱")
    p.add_argument("--to", required=True, help="收件人，逗号分隔")
    p.add_argument("--cc", default=None, help="抄送，逗号分隔")
    p.add_argument("--bcc", default=None, help="密送，逗号分隔")
    p.add_argument("--subject", default=None, help="主题")
    p.add_argument("--body", default=None, help="正文")
    p.add_argument("--attachments", default=None, help="附件 URL 列表，逗号分隔")
    p.add_argument("--priority", default=None, help="优先级：0 普通 / 1 高 / 5 低")
    p.add_argument("--confirm", action="store_true", help="确认执行发送；默认仅预览（dry-run）")
    p.add_argument("--operation-id", default=None, help="Dry Run 返回的 OPERATION_ID（确认执行时必填）")
    p.set_defaults(func=cmd_send_direct)

    # -- reply --
    p = sub.add_parser("reply", help="回复邮件（自动填充收件人、引用原文）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("folder_id", help="目录 ID")
    p.add_argument("message_id", help="原邮件 ID")
    p.add_argument("--mailbox-id", default=None, help="邮箱 ID；不传则自动取主邮箱")
    p.add_argument("--body", default=None, help="回复正文")
    p.add_argument("--cc", default=None, help="额外抄送，逗号分隔")
    p.add_argument("--attachments", default=None, help="附件 URL 列表，逗号分隔")
    p.add_argument("--all", dest="reply_all", action="store_true", help="回复全部（发件人+原收件人+原抄送）")
    p.add_argument("--confirm", action="store_true", help="确认执行发送；默认仅预览（dry-run）")
    p.add_argument("--operation-id", default=None, help="Dry Run 返回的 OPERATION_ID（确认执行时必填）")
    p.set_defaults(func=cmd_reply)

    # -- forward --
    p = sub.add_parser("forward", help="转发邮件（自动引用原文）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("folder_id", help="目录 ID")
    p.add_argument("message_id", help="原邮件 ID")
    p.add_argument("--mailbox-id", default=None, help="邮箱 ID；不传则自动取主邮箱")
    p.add_argument("--to", required=True, help="转发收件人，逗号分隔")
    p.add_argument("--body", default=None, help="转发说明")
    p.add_argument("--attachments", default=None, help="附件 URL 列表，逗号分隔")
    p.add_argument("--confirm", action="store_true", help="确认执行发送；默认仅预览（dry-run）")
    p.add_argument("--operation-id", default=None, help="Dry Run 返回的 OPERATION_ID（确认执行时必填）")
    p.set_defaults(func=cmd_forward)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
