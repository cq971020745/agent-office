#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
聊天会话 IM：调用 V7 IM 接口，实现会话列表、消息、历史消息、发送消息等功能。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法:
  python skills/im/run.py list
  python skills/im/run.py get <chat_id>
  python skills/im/run.py history <chat_id>
  python skills/im/run.py send <chat_id> <text>     # 默认 text 类型并指定 markdown
  python skills/im/run.py send --to-user <user_id> <text>  # 自动定位/创建 P2P 单聊后发送
  python skills/im/run.py send <chat_id> <text> --plain    # 以纯文本发送（不指定 markdown）
  python skills/im/run.py sendme <text>             # 自动定位自己的单聊会话并发送
  python skills/im/run.py recall <chat_id> <message_id>
  python skills/im/run.py create-chat --member <id1>,<id2> --type group --name "群名"
  python skills/im/run.py add-member <chat_id> --member <id1>,<id2>  # 已有群批量拉人（POST .../members/batch_create）
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

_root = Path(__file__).resolve().parent.parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from wpsv7client import (
    get_current_user,
    get_chat_list,
    get_chat,
    list_chat_messages,
    get_message_resource_download_url,
    get_chat_bookmarks,
    upload_resource,
    update_chat,
    has_at_tag,
    send_message,
    recall_message,
    list_recent_chats,
    search_chats,
    search_messages,
    list_chat_members,
    create_chat,
    batch_create_chat_members,
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


def _chat_display(chat):
    chat_type = chat.get("type", "-")
    name = chat.get("name", "-")
    chat_id = chat.get("id", "-")
    ctime = chat.get("ctime", "-")
    status = chat.get("status", "-")
    return f"[{chat_type}] {name} | ID: `{chat_id}` | 创建: {ctime} | 状态: {status}"


def _get_chat_for_preview(chat_id):
    if not chat_id:
        _err("缺少会话ID，无法获取会话详情")
    resp = get_chat(chat_id)
    return _check_resp(resp)


def _resolve_p2p_chat_id(target_user_id: str):
    """定位或创建与目标用户的 P2P 单聊会话，返回 (chat_id, chat_data)。"""
    user_resp = get_current_user()
    user_data = _check_resp(user_resp)
    current_user_id = str(user_data.get("id") or "").strip()
    if not current_user_id:
        _err("获取当前用户信息失败")
    resp = create_chat(
        account_id_list=[current_user_id, str(target_user_id).strip()],
        chat_type="p2p",
    )
    data = _check_resp(resp)
    chat_id = str(data.get("id") or "").strip()
    if not chat_id:
        _err(f"无法定位与用户 {target_user_id} 的单聊会话")
    return chat_id, data


def _mutation_gate(action_title, chat, detail_lines, confirmed):
    md = [
        f"## {action_title}",
        "",
        f"会话详情：{_chat_display(chat)}",
        "",
    ]
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


def cmd_list(args):
    _set_marker(ACTION_SELECTED="im.list")
    resp = get_chat_list(page_size=args.page_size or 50)
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 会话列表", "", f"共 **{len(items)}** 个会话。"]
    if not items:
        md.append("")
        md.append("暂无会话。")
    else:
        md.append("")
        for i, chat in enumerate(items, 1):
            md.append(f"{i}. {_chat_display(chat)}")
    _out(md, data)


def _member_display(m: dict) -> str:
    """格式化单个会话成员的显示文本。"""
    identity = m.get("identity") or {}
    name = identity.get("name") or identity.get("id") or m.get("id") or "未知"
    uid = identity.get("id") or m.get("id") or ""
    role_label = ""
    ext = m.get("group_ext_attrs") or {}
    role = ext.get("role")
    status = ext.get("status")
    if role == "owner":
        role_label = " [群主]"
    elif role == "admin":
        role_label = " [管理员]"
    status_label = ""
    if status == "resigned":
        status_label = " (已离职)"
    elif status == "banned":
        status_label = " (已禁言)"
    return f"**{name}**{role_label}{status_label}（ID: `{uid}`）"


def cmd_list_members(args):
    _set_marker(ACTION_SELECTED="im.list-members")
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py list-members <chat_id>")
    all_items = []
    page_token = None
    page_size = args.page_size or 100
    while True:
        resp = list_chat_members(
            chat_id=args.chat_id,
            page_size=page_size,
            page_token=page_token,
            member_type=args.type or "user",
            with_total=True,
            with_group_ext_attrs=True,
            with_member_detail=True,
        )
        data = _check_resp(resp)
        items = data.get("items") or []
        all_items.extend(items)
        page_token = data.get("next_page_token")
        if not page_token:
            break
    total = len(all_items)
    md = ["## 会话成员列表", "", f"共 **{total}** 个成员。"]
    if not all_items:
        md.append("")
        md.append("暂无成员。")
    else:
        md.append("")
        for i, m in enumerate(all_items, 1):
            md.append(f"{i}. {_member_display(m)}")
    _out(md, {"total": total, "items": all_items})


def cmd_get(args):
    _set_marker(ACTION_SELECTED="im.get")
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py get <chat_id>")
    resp = get_chat(args.chat_id)
    data = _check_resp(resp)
    chat = data
    md = ["## 会话详情", "", _chat_display(chat)]
    _out(md, data)


def cmd_history(args):
    _set_marker(ACTION_SELECTED="im.history")
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py history <chat_id>")
    resp = list_chat_messages(
        args.chat_id,
        page_size=args.page_size or 20,
        start_time=args.start_time,
        end_time=args.end_time,
        order=args.order or "desc",
    )
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 会话消息历史", "", f"会话 `{args.chat_id}` 共有 **{len(items)}** 条消息。"]
    if not items:
        md.append("")
        md.append("暂无消息。")
    else:
        md.append("")
        for i, msg in enumerate(items, 1):
            msg_type = msg.get("type", "-")
            msg_id = msg.get("id", "-")[:16] + "..." if len(msg.get("id", "")) > 16 else msg.get("id", "-")
            sender = msg.get("sender", {})
            sender_name = sender.get("name") or sender.get("id") or "-"
            ctime = msg.get("ctime", "-")
            content = msg.get("content", {})
            text = content.get("text", {}).get("content", "-") if content else "-"
            if text and len(text) > 50:
                text = text[:50] + "..."
            md.append(f"{i}. [{msg_type}] {sender_name} | {ctime}")
            if text != "-":
                md.append(f"   > {text}")
    _out(md, data)


def cmd_download_url(args):
    _set_marker(ACTION_SELECTED="im.download-url")
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py download-url <chat_id> <message_id> <storage_key> <file_name>")
    if not args.message_id:
        _err("请指定消息ID，例如: run.py download-url <chat_id> <message_id> <storage_key> <file_name>")
    if not args.storage_key:
        _err("请指定资源 storage_key，例如: run.py download-url <chat_id> <message_id> <storage_key> <file_name>")
    if not args.file_name:
        _err("请指定文件名，例如: run.py download-url <chat_id> <message_id> <storage_key> <file_name>")
    resp = get_message_resource_download_url(
        chat_id=args.chat_id,
        message_id=args.message_id,
        storage_key=args.storage_key,
        file_name=args.file_name,
    )
    data = _check_resp(resp)
    md = ["## 文件下载链接", ""]
    md.append(f"- 会话ID: `{args.chat_id}`")
    md.append(f"- 消息ID: `{args.message_id}`")
    md.append(f"- 资源Key: `{args.storage_key}`")
    md.append(f"- 文件名: `{args.file_name}`")
    md.append(f"- 下载链接: {data.get('url') or data.get('download_url') or '-'}")
    _out(md, data)


def _parse_mentions(mention_list, zero_based=False):
    """
    将 --mention 参数列表解析为 API mentions 数组。
    支持 user_id 或 "all"（@所有人）。符合 internal/im schema v7_chat_message_mention。
    - id：与正文 <at id="N"> 匹配。zero_based=True 时为 "0","1",...（与 schema 示例一致）；否则为 "1","2",...
    - type：user | all；identity 仅 type=user 时必填。
    """
    if not mention_list:
        return None
    out = []
    for m in mention_list:
        m = (m or "").strip()
        if not m:
            continue
        index_str = str(len(out) if zero_based else len(out) + 1)
        if m.lower() == "all":
            out.append({"id": index_str, "type": "all"})
        else:
            out.append({
                "id": index_str,
                "type": "user",
                "identity": {"id": m, "type": "user"},
            })
    return out if out else None


def _content_and_mentions_to_zero_based(content, mentions):
    """
    将正文中的 <at id="1">、<at id="2"> 与 mentions 的 id 转为 0-based（schema 示例为 id="0"），
    便于客户端正确展示 @。返回 (new_content, new_mentions)。
    使用占位符避免先替换成较小数字时产生冲突（如 id="2"->"1" 后再 id="1"->"0" 会误改两处）。
    """
    if not content or not mentions:
        return content, mentions
    id_map = {m["id"]: str(i) for i, m in enumerate(mentions)}
    new_content = content
    placeholders = {}
    for old_id in sorted(id_map.keys(), key=lambda x: int(x), reverse=True):
        new_id = id_map[old_id]
        if old_id == new_id:
            continue
        ph = f"__AT_PH_{old_id}__"
        placeholders[ph] = new_id
        new_content = re.sub(r'<at\s+id="' + re.escape(old_id) + r'"', '<at id="' + ph + '"', new_content)
    for ph, new_id in placeholders.items():
        new_content = new_content.replace(ph, new_id)
    new_mentions = []
    for i, m in enumerate(mentions):
        item = {"id": str(i), "type": m["type"]}
        if m.get("identity"):
            item["identity"] = m["identity"]
        new_mentions.append(item)
    return new_content, new_mentions


_BOOKMARK_TYPE_LABEL = {
    "url": "自定义链接",
    "cloud_file": "云文档",
}


def cmd_bookmarks(args):
    """获取会话书签。"""
    _set_marker(ACTION_SELECTED="im.bookmarks")
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py bookmarks <chat_id>")
    resp = get_chat_bookmarks(args.chat_id)
    data = _check_resp(resp)
    bookmarks = data.get("bookmarks") or []
    md = ["## 会话书签", "", f"会话 `{args.chat_id}` 共 **{len(bookmarks)}** 个书签。"]
    if not bookmarks:
        md.append("")
        md.append("暂无书签。")
    else:
        md.append("")
        for i, bm in enumerate(bookmarks, 1):
            name = bm.get("name") or "(未命名)"
            bm_id = bm.get("id", "")
            bm_type = _BOOKMARK_TYPE_LABEL.get(bm.get("type", ""), bm.get("type", "-"))
            content = bm.get("content") or {}
            link = content.get("url") or content.get("cloud_file") or "-"
            md.append(f"> **{name}** `{bm_id}`")
            md.append(f"> 类型：{bm_type} | 链接：{link}")
            md.append("")
    _out(md, data)


def cmd_upload(args):
    """上传本地文件到会话资源存储（自动计算校验、获取上传地址、上传文件）。"""
    _set_marker(ACTION_SELECTED="im.upload", WRITE_OPERATION=True)
    if not args.file_path:
        _err("请指定文件路径，例如: run.py upload /path/to/image.png")
    resp = upload_resource(
        file_path=args.file_path,
        is_avatar=getattr(args, "is_avatar", False),
    )
    data = _check_resp(resp)
    md = ["## 文件上传完成", ""]
    md.append(f"- 文件名: `{data.get('file_name', '-')}`")
    md.append(f"- 文件大小: {data.get('file_size', '-')} 字节")
    md.append(f"- SHA-256: `{data.get('checksum', '-')}`")
    md.append(f"- storage_key: `{data.get('storage_key', '-')}`")
    _out(md, data)


def cmd_update(args):
    """更新群信息（名称、头像、设置等）。"""
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py update <chat_id> --name '新名称'")
    chat = _get_chat_for_preview(args.chat_id)
    _set_marker(
        ACTION_SELECTED="im.update",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    kwargs = {}
    if args.name is not None:
        kwargs["name"] = args.name
    if args.avatar is not None:
        kwargs["avatar"] = args.avatar
    if args.owner_id is not None:
        kwargs["owner_id"] = args.owner_id
    bool_fields = [
        ("disable_all_send", "is_disable_all_send"),
        ("enable_history", "is_enable_history_messages"),
        ("enable_nickname", "is_enable_nickname"),
        ("external_join_approve", "is_external_join_approve"),
        ("join_approve", "is_join_approve"),
        ("owner_admin_bookmark", "is_owner_admin_add_bookmark"),
        ("owner_admin_modify", "is_owner_admin_modify"),
    ]
    for arg_name, api_name in bool_fields:
        val = getattr(args, arg_name, None)
        if val is not None:
            kwargs[api_name] = val
    if args.operation_permissions:
        try:
            kwargs["operation_permissions"] = json.loads(args.operation_permissions)
        except json.JSONDecodeError:
            _err("operation-permissions 必须是有效的 JSON 格式")
    if not kwargs:
        _err("至少需要指定一个要更新的字段（如 --name、--avatar 等）")
    preview_lines = ["**拟更新字段**："]
    for k, v in kwargs.items():
        preview_lines.append(f"- {k}: `{v}`")
    is_dry_run, md = _mutation_gate("更新群信息", chat, preview_lines, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "chat": chat, "updates": kwargs})
        return
    resp = update_chat(chat_id=args.chat_id, **kwargs)
    if resp.get("code") != 0:
        _err(resp.get("msg") or resp.get("message") or "更新失败")
    md.append("")
    md.append(f"会话 `{args.chat_id}` 已更新。")
    md.append("")
    md.append("**已更新字段**：")
    for k, v in kwargs.items():
        md.append(f"- {k}: `{v}`")
    _out(md, resp)


def _resolve_text_file(args):
    """--text-file 优先于位置参数 text；读取后删除临时文件。"""
    tf = getattr(args, "text_file", None)
    if not tf:
        return
    import os
    tf = os.path.expanduser(tf)
    if not os.path.isfile(tf):
        _err(f"--text-file 指定的文件不存在: {tf}")
    with open(tf, "r", encoding="utf-8") as f:
        args.text = f.read()


def _cmd_send_body(args):
    if not args.chat_id:
        _err("请指定会话ID或 --to-user，例如: run.py send <chat_id> <text>")
    if not args.msg_type:
        args.msg_type = "text"

    chat = _get_chat_for_preview(args.chat_id)
    msg_type = args.msg_type.lower()
    use_plain_text = getattr(args, "plain", False)
    mentions = _parse_mentions(getattr(args, "mention", None) or [])
    preview_lines = [f"- 消息类型: `{msg_type}`"]
    if mentions:
        preview_lines.append(f"- mentions: `{json.dumps(mentions, ensure_ascii=False)}`")
    send_kwargs = {
        "chat_id": args.chat_id,
        "msg_type": msg_type,
        "mentions": mentions,
    }

    if msg_type == "text":
        if not args.text:
            _err("请指定消息内容")
        text_type = None if use_plain_text else "markdown"
        preview_lines.append(f"- 文本格式: `{text_type or 'plain'}`")
        preview_lines.append(f"- 文本内容预览: `{args.text}`")
        if mentions and has_at_tag(args.text):
            if getattr(args, "at_markdown", False):
                content_0, mentions_0 = _content_and_mentions_to_zero_based(args.text, mentions)
                send_kwargs.update({
                    "text": content_0,
                    "text_type": "markdown",
                    "mentions": mentions_0,
                })
            else:
                content_0, mentions_0 = _content_and_mentions_to_zero_based(args.text, mentions)
                send_kwargs.update({
                    "text": content_0,
                    "text_type": "plain",
                    "mentions": mentions_0,
                })
        else:
            send_kwargs.update({
                "text": args.text,
                "text_type": text_type,
            })
    elif msg_type == "rich_text":
        if not args.rich_text:
            _err("请指定富文本内容 (--rich-text)")
        try:
            rich_text_data = json.loads(args.rich_text)
        except json.JSONDecodeError:
            _err("富文本内容必须是有效的 JSON 格式")
        preview_lines.append(f"- 富文本预览: `{json.dumps(rich_text_data, ensure_ascii=False)}`")
        send_kwargs["rich_text"] = rich_text_data
    elif msg_type == "image":
        if not args.image_key:
            _err("请指定图片存储key (--image-key)")
        try:
            image_data = json.loads(args.image_key)
        except json.JSONDecodeError:
            _err("图片内容必须是有效的 JSON 格式")
        preview_lines.append(f"- 图片消息预览: `{json.dumps(image_data, ensure_ascii=False)}`")
        send_kwargs["image"] = image_data
    elif msg_type == "card":
        if not args.card:
            _err("请指定卡片内容 (--card)")
        try:
            card_data = json.loads(args.card)
        except json.JSONDecodeError:
            _err("卡片内容必须是有效的 JSON 格式")
        preview_lines.append(f"- 卡片消息预览: `{json.dumps(card_data, ensure_ascii=False)}`")
        send_kwargs["card"] = card_data
    elif msg_type == "file":
        if not args.file:
            _err("请指定文件内容 (--file)")
        try:
            file_data = json.loads(args.file)
        except json.JSONDecodeError:
            _err("文件内容必须是有效的 JSON 格式")

        if file_data.get("type") == "cloud" and "cloud" in file_data:
            cloud_data = file_data.get("cloud", {})
            if cloud_data.get("link_id") and not cloud_data.get("id"):
                cloud_data["id"] = cloud_data["link_id"]

        preview_lines.append(f"- 文件消息预览: `{json.dumps(file_data, ensure_ascii=False)}`")
        send_kwargs["file"] = file_data
    else:
        _err(f"不支持的消息类型: {msg_type}，支持的类型: text, rich_text, image, file, card")

    is_dry_run, md = _mutation_gate("发送消息", chat, preview_lines, args.confirm)
    if is_dry_run:
        preview_data = {
            "dry_run": True,
            "chat": chat,
            "msg_type": msg_type,
            "mentions": send_kwargs.get("mentions"),
        }
        if "text" in send_kwargs:
            preview_data["text"] = send_kwargs["text"]
            preview_data["text_type"] = send_kwargs.get("text_type") or "plain"
        if "rich_text" in send_kwargs:
            preview_data["rich_text"] = send_kwargs["rich_text"]
        if "image" in send_kwargs:
            preview_data["image"] = send_kwargs["image"]
        if "card" in send_kwargs:
            preview_data["card"] = send_kwargs["card"]
        if "file" in send_kwargs:
            preview_data["file"] = send_kwargs["file"]
        _out(md, preview_data)
        return

    resp = send_message(**send_kwargs)

    data = _check_resp(resp)
    msg = data
    md.append("")
    md.append(f"消息已发送至会话 `{args.chat_id}`。")
    md.append("")
    md.append(f"- 消息ID: `{msg.get('id', '-')}`")
    md.append(f"- 类型: {msg.get('type', '-')}")
    md.append(f"- 发送者: {msg.get('sender', {}).get('name', '-')}")
    _out(md, data)


def cmd_send(args):
    _resolve_text_file(args)
    if getattr(args, "to_user", None):
        # --to-user 模式：argparse 会把第一个位置参数塞给 chat_id，需归位到 text
        if args.chat_id and args.text:
            _err("使用 --to-user 时不需要指定 chat_id")
        if args.chat_id and not args.text:
            args.text = args.chat_id
            args.chat_id = None
        chat_id, _chat_data = _resolve_p2p_chat_id(args.to_user)
        args.chat_id = chat_id
    _set_marker(
        ACTION_SELECTED="im.send",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    _cmd_send_body(args)


def _resolve_self_chat_id():
    """
    基于当前用户信息定位“与自己”的单聊会话。
    匹配规则：chat.type == p2p 且 p2p_ext_attrs.peer 的 id 与 name 同时匹配当前用户。
    返回: (chat_id, user_data)。
    """
    user_resp = get_current_user()
    user_data = _check_resp(user_resp)
    user_id = str(user_data.get("id") or "").strip()
    user_name = str(user_data.get("user_name") or user_data.get("nick_name") or "").strip()
    if not user_id or not user_name:
        _err("获取当前用户信息失败：缺少 id 或姓名（user_name/nick_name）")

    resp = search_chats(
        keyword=user_name,
        page_size=50,
        with_total=True,
        with_p2p_ext_attrs=True,
    )
    data = _check_resp(resp)
    items = data.get("items") or []

    matched_chat = None
    for item in items:
        chat = item.get("chat") or {}
        if chat.get("type") != "p2p":
            continue
        peer = (chat.get("p2p_ext_attrs") or {}).get("peer") or {}
        peer_id = str(peer.get("id") or "").strip()
        peer_name = str(peer.get("name") or "").strip()
        if peer_id == user_id and peer_name == user_name:
            matched_chat = chat
            break

    if not matched_chat:
        _err(f"未找到“发送给自己”的单聊会话（姓名: {user_name}, 用户ID: {user_id}）")

    chat_id = matched_chat.get("id")
    if not chat_id:
        _err("已匹配到自己的单聊会话，但会话ID为空")
    return str(chat_id), user_data


def cmd_sendme(args):
    """发送消息给自己：自动定位当前用户对应的单聊会话后调用 send。"""
    _resolve_text_file(args)
    chat_id, _user_data = _resolve_self_chat_id()
    args.chat_id = chat_id
    _set_marker(
        ACTION_SELECTED="im.sendme",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    _cmd_send_body(args)


def cmd_recall(args):
    _set_marker(
        ACTION_SELECTED="im.recall",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=False,
        DRY_RUN=False,
        ASK_USER_REQUIRED=False,
    )
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py recall <chat_id> <message_id>")
    if not args.message_id:
        _err("请指定消息ID，例如: run.py recall <chat_id> <message_id>")
    resp = recall_message(args.chat_id, args.message_id)
    _check_resp(resp)
    md = ["## 撤回消息", "", f"消息 `{args.message_id}` 已从会话 `{args.chat_id}` 撤回。"]
    _out(md, {"chat_id": args.chat_id, "message_id": args.message_id, "recalled": True})


def cmd_create_chat(args):
    """创建会话（P2P 单聊或群聊），默认 dry-run。"""
    if not args.member:
        _err("请指定成员列表 --member")
    _set_marker(
        ACTION_SELECTED="im.create-chat",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    member_list = [m.strip() for m in args.member.split(",") if m.strip()]
    chat_type = args.chat_type or "p2p"

    user_resp = get_current_user()
    user_data = _check_resp(user_resp)
    current_user_id = str(user_data.get("id") or "").strip()
    if current_user_id and current_user_id not in member_list:
        member_list.insert(0, current_user_id)

    preview_lines = [
        f"- 会话类型: `{chat_type}`",
        f"- 成员: `{', '.join(member_list)}`",
    ]
    if args.name:
        preview_lines.append(f"- 群名: `{args.name}`")

    if not args.confirm:
        md = ["## 创建会话（Dry Run）", ""]
        md.extend(preview_lines)
        md.extend([
            "",
            "**当前为 Dry Run，未执行实际变更。**",
            "",
            "请通过 `askUserQuestion` 向用户确认，确认后再追加 `--confirm` 重新执行。",
            "注意：之前对话中对其他操作的确认不适用于本次操作，必须获得用户对本次操作的单独确认。",
        ])
        _out(md, {"dry_run": True, "type": chat_type, "members": member_list, "name": args.name})
        return

    resp = create_chat(account_id_list=member_list, chat_type=chat_type, name=args.name)
    data = _check_resp(resp)
    md = ["## 创建会话", "", _chat_display(data)]
    _out(md, data)


def cmd_add_member(args):
    """向已有会话批量添加成员，默认 dry-run。"""
    if not args.chat_id:
        _err("请指定会话ID，例如: run.py add-member <chat_id> --member <id1>,<id2>")
    if not args.member:
        _err("请指定要加入的成员 --member")
    member_list = [m.strip() for m in args.member.split(",") if m.strip()]
    _set_marker(
        ACTION_SELECTED="im.add-member",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    preview_lines = [
        f"- 会话ID: `{args.chat_id}`",
        f"- 待加入成员 user_id: `{', '.join(member_list)}`",
    ]
    if not args.confirm:
        md = ["## 批量添加成员（Dry Run）", "", "对应接口: `POST /v7/chats/{chat_id}/members/batch_create`", ""]
        md.extend(preview_lines)
        md.extend([
            "",
            "**当前为 Dry Run，未执行实际变更。**",
            "",
            "确认后追加 `--confirm` 再执行。",
        ])
        _out(md, {"dry_run": True, "chat_id": args.chat_id, "members": member_list})
        return
    resp = batch_create_chat_members(chat_id=args.chat_id, account_id_list=member_list)
    data = _check_resp(resp)
    md = ["## 批量添加成员", "", f"会话 `{args.chat_id}` 已请求拉入成员。"]
    _out(md, data)


def cmd_recent(args):
    _set_marker(ACTION_SELECTED="im.recent")
    resp = list_recent_chats(
        page_size=args.page_size or 50,
        start_time=args.start_time,
        end_time=args.end_time,
        filter_unread=args.filter_unread,
        filter_mention_me=args.filter_mention_me,
    )
    data = _check_resp(resp)
    items = data.get("items") or []
    md = ["## 最近会话", "", f"共 **{len(items)}** 个最近会话。"]
    if not items:
        md.append("")
        md.append("暂无最近会话。")
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            chat = item.get("chat") or {}
            chat_type = chat.get("type", "-")
            name = chat.get("name", "-")
            chat_id = chat.get("id", "-")
            unread = item.get("unread_count", 0)
            md.append(f"{i}. [{chat_type}] {name} | ID: `{chat_id}` | 未读: {unread}")
    _out(md, data)


def cmd_search(args):
    if not args.keyword:
        _err("请指定搜索关键字，例如: run.py search \"关键词\"")
    resp = search_chats(
        keyword=args.keyword,
        page_size=args.page_size or 20,
        with_total=True,
    )
    data = _check_resp(resp)
    items = data.get("items") or []
    total = data.get("total", len(items))
    _set_marker(ACTION_SELECTED="im.search")
    if len(items) > 1:
        _set_marker(AMBIGUOUS_RESULTS=len(items), ASK_USER_REQUIRED=True)
    md = ["## 搜索会话", "", f"关键字「{args.keyword}」共找到 **{total}** 个会话。"]
    if not items:
        md.append("")
        md.append("未找到匹配会话。")
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            chat = item.get("chat") or {}
            chat_type = chat.get("type", "-")
            name = chat.get("name", "-")
            chat_id = chat.get("id", "-")
            md.append(f"{i}. [{chat_type}] {name} | ID: `{chat_id}`")
    if len(items) > 1:
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data)


def cmd_search_messages(args):
    if not args.keyword and not args.chat_ids and not args.sender_ids and not args.start_time:
        _err("请指定搜索条件（关键字、会话ID列表、发送者ID列表或时间范围之一）")
    resp = search_messages(
        keyword=args.keyword,
        page_size=args.page_size or 20,
        chat_id_list=args.chat_ids.split(",") if args.chat_ids else None,
        sender_id_list=args.sender_ids.split(",") if args.sender_ids else None,
        filter_msg_tag_list=args.msg_types.split(",") if args.msg_types else None,
        start_time=args.start_time,
        end_time=args.end_time,
        order=args.order or "desc",
        with_sender_details=True,
        with_chat=True,
    )
    data = _check_resp(resp)
    items = data.get("items") or []
    _set_marker(ACTION_SELECTED="im.search-messages")
    if len(items) > 1:
        _set_marker(AMBIGUOUS_RESULTS=len(items), ASK_USER_REQUIRED=True)
    md = ["## 全局搜索消息", "", f"共找到 **{len(items)}** 条消息。"]
    if not items:
        md.append("")
        md.append("未找到匹配消息。")
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            chat = item.get("chat") or {}
            chat_name = chat.get("name", "-")
            chat_id = chat.get("id", "-")
            msg = item.get("message") or {}
            msg_type = msg.get("type", "-")
            msg_id = msg.get("id", "-")[:16] + "..." if len(msg.get("id", "")) > 16 else msg.get("id", "-")
            sender = msg.get("sender") or {}
            sender_name = sender.get("name") or sender.get("id") or "-"
            ctime = msg.get("ctime", "-")
            content = msg.get("content", {})
            text = content.get("text", {}).get("content", "-") if content else "-"
            if text and len(text) > 40:
                text = text[:40] + "..."
            md.append(f"{i}. [{msg_type}] {sender_name} | {ctime}")
            md.append(f"   > 会话: {chat_name} | ID: `{chat_id}`")
            if text != "-":
                md.append(f"   > {text}")
    _out(md, data)


def main():
    parser = argparse.ArgumentParser(description="聊天会话 IM（V7）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="获取当前用户会话列表")
    p.add_argument("--page-size", "-p", type=int, default=50, help="分页大小，默认50")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", help="获取指定会话详情")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("list-members", help="获取会话成员列表（自动翻页）")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.add_argument("--page-size", "-p", type=int, default=100, help="每页大小，默认100")
    p.add_argument("--type", "-t", default="user", choices=["user", "app"], help="成员类型，默认user")
    p.set_defaults(func=cmd_list_members)

    p = sub.add_parser("history", help="获取会话历史消息")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.add_argument("--page-size", "-p", type=int, default=20, help="分页大小，默认20")
    p.add_argument("--start-time", "-s", default=None, help="起始时间，UTC ISO 8601 格式")
    p.add_argument("--end-time", "-e", default=None, help="结束时间，UTC ISO 8601 格式")
    p.add_argument("--order", "-o", default="desc", choices=("desc", "asc"), help="排序（V7 im_order）: desc 降序（默认）或 asc 升序")
    p.set_defaults(func=cmd_history)

    p = sub.add_parser("download-url", help="获取消息中文件或图片资源的下载链接")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.add_argument("message_id", nargs="?", default=None, help="消息ID")
    p.add_argument("storage_key", nargs="?", default=None, help="资源 storage_key")
    p.add_argument("file_name", nargs="?", default=None, help="下载文件名")
    p.set_defaults(func=cmd_download_url)

    p = sub.add_parser("bookmarks", help="获取会话书签（自定义链接和云文档）")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.set_defaults(func=cmd_bookmarks)

    p = sub.add_parser("upload", help="上传本地文件到会话资源存储（自动计算校验、获取上传地址、上传文件，返回 storage_key）")
    p.add_argument("file_path", nargs="?", default=None, help="本地文件路径")
    p.add_argument("--is-avatar", action="store_true", default=False, help="是否用作头像（仅 png/jpeg/gif/svg/tiff）")
    p.set_defaults(func=cmd_upload)

    p = sub.add_parser("update", help="更新群信息（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.add_argument("--name", default=None, help="会话名称")
    p.add_argument("--avatar", default=None, help="群聊头像 storage_key（通过 upload 获取）")
    p.add_argument("--owner-id", default=None, help="新群主 user_id")
    p.add_argument("--disable-all-send", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="disable_all_send", help="是否全员禁言（true/false）")
    p.add_argument("--enable-history", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="enable_history", help="新入群成员是否可查看历史消息（true/false）")
    p.add_argument("--enable-nickname", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="enable_nickname", help="是否群昵称优先展示（true/false）")
    p.add_argument("--external-join-approve", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="external_join_approve", help="非群主企业人员进群是否需审核（true/false）")
    p.add_argument("--join-approve", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="join_approve", help="群主企业人员进群是否需审核（true/false）")
    p.add_argument("--owner-admin-bookmark", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="owner_admin_bookmark", help="是否仅群主和管理员可添加群书签（true/false）")
    p.add_argument("--owner-admin-modify", type=lambda x: x.lower() in ("true", "1", "yes"), default=None, dest="owner_admin_modify", help="是否仅群主和管理员可修改群信息（true/false）")
    p.add_argument("--operation-permissions", default=None, dest="operation_permissions", help="操作权限设置 (JSON 格式)")
    p.add_argument("--confirm", action="store_true", help="确认执行更新；默认仅回显会话详情和拟更新内容（dry-run）")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("send", help="发送消息到指定会话（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID（与 --to-user 二选一）")
    p.add_argument("text", nargs="?", default=None, help="消息内容（默认以 text+markdown 发送）")
    p.add_argument("--text-file", "-T", default=None, dest="text_file", help="从文件读取消息内容（优先于 text 位置参数）。消息含特殊字符、emoji 或过长时推荐使用")
    p.add_argument("--to-user", "-u", default=None, dest="to_user", help="目标用户 user_id，自动定位或创建与该用户的单聊会话后发送（与 chat_id 二选一）")
    p.add_argument("--type", "-t", dest="msg_type", default="text", help="消息类型: text, rich_text, image, file, card (默认 text，即 text+markdown)")
    p.add_argument("--plain", "-P", action="store_true", help="仅当 type=text 时有效：以纯文本发送，不指定 markdown")
    p.add_argument("--rich-text", "-r", default=None, help="富文本内容 (JSON 格式)")
    p.add_argument("--image-key", "-i", default=None, help="图片存储key (图片消息需要)")
    p.add_argument("--card", "-c", default=None, help="卡片消息内容 (JSON 格式)")
    p.add_argument("--file", "-f", default=None, help="文件消息内容 (JSON 格式，支持云文档)")
    p.add_argument("--mention", "-M", action="append", default=None, dest="mention", help="@某人：传 user_id；@所有人：传 all。正文须写闭合标签如 <at id=\"1\">展示名</at>，可多次")
    p.add_argument("--at-markdown", action="store_true", dest="at_markdown", help="与 --mention 同用时：以 rich_text 发送，文本段为 markdown、@ 为 mention 元素，以同时展示 @ 与 Markdown")
    p.add_argument("--confirm", action="store_true", help="确认执行发送；默认仅回显会话详情和消息预览（dry-run）")
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("sendme", help="发送消息给自己（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("text", nargs="?", default=None, help="消息内容（默认以 text+markdown 发送）")
    p.add_argument("--text-file", "-T", default=None, dest="text_file", help="从文件读取消息内容（优先于 text 位置参数）。消息含特殊字符、emoji 或过长时推荐使用")
    p.add_argument("--type", "-t", dest="msg_type", default="text", help="消息类型: text, rich_text, image, file, card (默认 text，即 text+markdown)")
    p.add_argument("--plain", "-P", action="store_true", help="仅当 type=text 时有效：以纯文本发送，不指定 markdown")
    p.add_argument("--rich-text", "-r", default=None, help="富文本内容 (JSON 格式)")
    p.add_argument("--image-key", "-i", default=None, help="图片存储key (图片消息需要)")
    p.add_argument("--card", "-c", default=None, help="卡片消息内容 (JSON 格式)")
    p.add_argument("--file", "-f", default=None, help="文件消息内容 (JSON 格式，支持云文档)")
    p.add_argument("--mention", "-M", action="append", default=None, dest="mention", help="@某人：传 user_id；@所有人：传 all。正文须写闭合标签如 <at id=\"1\">展示名</at>，可多次")
    p.add_argument("--at-markdown", action="store_true", dest="at_markdown", help="与 --mention 同用时：以 rich_text 发送，文本段为 markdown、@ 为 mention 元素，以同时展示 @ 与 Markdown")
    p.add_argument("--confirm", action="store_true", help="确认执行发送；默认仅回显会话详情和消息预览（dry-run）")
    p.set_defaults(func=cmd_sendme)

    p = sub.add_parser("recall", help="撤回指定消息")
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID")
    p.add_argument("message_id", nargs="?", default=None, help="消息ID")
    p.set_defaults(func=cmd_recall)

    p = sub.add_parser("create-chat", help="创建会话（P2P 单聊或群聊，默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("--member", "-m", required=True, help="成员 user_id 列表，逗号分隔（会自动加入当前用户）")
    p.add_argument("--type", "-t", dest="chat_type", default="p2p", choices=["p2p", "group"], help="会话类型：p2p（单聊，默认）或 group（群聊）")
    p.add_argument("--name", "-n", default=None, help="群聊名称（仅群聊时有效）")
    p.add_argument("--confirm", action="store_true", help="确认执行创建；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_create_chat)

    p = sub.add_parser(
        "add-member",
        help="向已有会话批量添加成员（POST /v7/chats/{chat_id}/members/batch_create，默认 dry-run）",
    )
    p.add_argument("chat_id", nargs="?", default=None, help="会话ID（群聊）")
    p.add_argument("--member", "-m", required=True, help="要加入的 user_id 列表，逗号分隔")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_add_member)

    p = sub.add_parser("recent", help="获取最近会话列表")
    p.add_argument("--page-size", "-p", type=int, default=50, help="分页大小，默认50")
    p.add_argument("--start-time", "-s", default=None, help="起始时间，UTC ISO 8601 格式")
    p.add_argument("--end-time", "-e", default=None, help="结束时间，UTC ISO 8601 格式")
    p.add_argument("--filter-unread", action="store_true", help="只返回未读会话")
    p.add_argument("--filter-mention-me", action="store_true", help="只返回@我的会话")
    p.set_defaults(func=cmd_recent)

    p = sub.add_parser("search", help="搜索会话")
    p.add_argument("keyword", nargs="?", default=None, help="搜索关键字")
    p.add_argument("--page-size", "-p", type=int, default=20, help="分页大小，默认20")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("search-messages", help="全局搜索消息")
    p.add_argument("--keyword", "-k", default=None, help="搜索关键字")
    p.add_argument("--chat-ids", "-c", default=None, help="会话ID列表，逗号分隔")
    p.add_argument("--sender-ids", "-s", default=None, help="发送者ID列表，逗号分隔")
    p.add_argument("--msg-types", "-t", default=None, help="消息类型过滤，如 text,file,image,cloud_file")
    p.add_argument("--page-size", "-p", type=int, default=20, help="分页大小，默认20")
    p.add_argument("--start-time", default=None, help="起始时间，UTC ISO 8601 格式")
    p.add_argument("--end-time", default=None, help="结束时间，UTC ISO 8601 格式")
    p.add_argument("--order", "-o", default="desc", choices=("desc", "asc"), help="排序（V7 im_order）: desc 降序（默认）或 asc 升序")
    p.set_defaults(func=cmd_search_messages)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
