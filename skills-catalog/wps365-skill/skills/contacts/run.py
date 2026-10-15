#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通讯录用户搜索：调用 V7 企业用户搜索，输出 Markdown + JSON。
按关键字搜索；同名用户会全部返回。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法: python skills/contacts/run.py search <关键字>
      或 python skills/contacts/run.py search --keyword "<关键字>"
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
    search_users,
    search_depts,
    get_root_dept,
    list_dept_children,
    list_user_depts,
    batch_get_depts,
    list_dept_members,
    list_dept_members_all,
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


def _user_display_name(u):
    return u.get("user_name") or u.get("nick_name") or u.get("name") or u.get("id") or "-"


def _user_dept_str(u):
    depts = u.get("dept_path")
    if depts:
        return depts.split("/")[-1]
    return u.get("def_dept_name") or "-"


def _append_next_page(md_lines, data):
    if not isinstance(data, dict):
        return
    token = data.get("next_page_token") or data.get("page_token")
    if token:
        md_lines.extend(["", f"- **next_page_token**：`{token}`"])


def cmd_search(args):
    keyword = args.keyword or (args.name if getattr(args, "name", None) else "")
    if not keyword or not str(keyword).strip():
        _err("请指定要搜索的关键字，例如: run.py search 张三")
    resp = search_users(
        keyword=keyword.strip(),
        page_size=args.page_size,
        page_token=args.page_token,
        with_total=args.with_total,
        status=args.status,
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("items") or []
    _set_marker(ACTION_SELECTED="contacts.search")
    if len(items) > 1:
        _set_marker(AMBIGUOUS_RESULTS=len(items), ASK_USER_REQUIRED=True)
    md = ["## 通讯录·搜索用户", "", f"根据「{keyword}」找到 **{len(items)}** 个用户。"]
    if not items:
        md.append("")
        md.append("未找到匹配用户。")
    else:
        md.append("")
        for i, u in enumerate(items[:50], 1):
            name = _user_display_name(u)
            uid = u.get("id", "-")
            dept = _user_dept_str(u)
            email = u.get("email") or "-"
            employee_id = u.get("employee_id") or "-"
            md.append(
                f"{i}. **{name}** | 用户ID: `{uid}` | 工号: {employee_id} | 部门: {dept} | 邮箱: {email}"
            )
        if len(items) > 50:
            md.append("")
            md.append(f"（仅展示前 50 条，共 {len(items)} 条）")
    _append_next_page(md, data)
    _out(md, data)


def _member_display_name(m):
    """从部门成员中提取展示名称，优先从 user_info 取。"""
    info = m.get("user_info") or {}
    return info.get("user_name") or info.get("nick_name") or info.get("name") or m.get("user_id") or "-"


def _member_email(m):
    info = m.get("user_info") or {}
    return info.get("email") or "-"


def cmd_list_dept_members(args):
    dept_id = args.dept_id
    if not dept_id or not str(dept_id).strip():
        _err("请指定部门 ID，例如: run.py list-dept-members 12345")

    if args.all:
        items = list_dept_members_all(
            dept_id=dept_id,
            recursive=args.recursive,
            status=args.status,
            max_pages=args.max_pages,
        )
        data = {"items": items, "total": len(items)}
        resp_for_json = {"code": 0, "msg": "", "data": data}
    else:
        resp = list_dept_members(
            dept_id=dept_id,
            page_size=args.page_size,
            page_token=args.page_token,
            recursive=args.recursive,
            with_user_detail=True,
            with_total=args.with_total,
            status=args.status,
        )
        data = _check_resp(resp)
        if not isinstance(data, dict):
            data = {}
        items = data.get("items") or []
        resp_for_json = resp

    _set_marker(ACTION_SELECTED="contacts.list-dept-members")
    md = ["## 通讯录·部门成员列表", "", f"部门 `{dept_id}` 下共找到 **{len(items)}** 个成员。"]
    if args.recursive:
        md.append("（已递归包含子部门成员）")
    if not items:
        md.append("")
        md.append("该部门下没有成员。")
    else:
        md.append("")
        for i, m in enumerate(items[:100], 1):
            name = _member_display_name(m)
            uid = m.get("user_id", "-")
            email = _member_email(m)
            is_leader = "[部门负责人]" if m.get("is_leader") else ""
            md.append(f"{i}. **{name}** | 用户ID: `{uid}` | 邮箱: {email} {is_leader}")
        if len(items) > 100:
            md.append("")
            md.append(f"（仅展示前 100 条，共 {len(items)} 条）")
    _append_next_page(md, data)
    _out(md, resp_for_json.get("data", data) if isinstance(resp_for_json, dict) else data)


def _dept_display(d):
    """格式化一条部门信息用于 Markdown 展示。"""
    did = d.get("id", "-")
    name = d.get("name") or d.get("alias") or "-"
    abs_path = d.get("abs_path") or ""
    parent_id = d.get("parent_id", "-")
    return did, name, abs_path, parent_id


def cmd_search_depts(args):
    search_name = args.search_name
    if not search_name or not str(search_name).strip():
        _err("请指定部门名称关键字，例如: run.py search-depts 产品")
    resp = search_depts(
        search_name=search_name.strip(),
        page_size=args.page_size,
        page_token=args.page_token,
        with_total=args.with_total,
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("items") or []
    _set_marker(ACTION_SELECTED="contacts.search-depts")
    md = ["## 通讯录·搜索部门", "", f"根据「{search_name}」找到 **{len(items)}** 个部门。"]
    if not items:
        md.append("")
        md.append("未找到匹配部门。")
    else:
        md.append("")
        for i, d in enumerate(items[:50], 1):
            did, name, abs_path, parent_id = _dept_display(d)
            md.append(f"{i}. **{name}** | 部门ID: `{did}` | 路径: {abs_path}")
        if len(items) > 50:
            md.append("")
            md.append(f"（仅展示前 50 条，共 {len(items)} 条）")
    _append_next_page(md, data)
    _out(md, data)


def cmd_get_root_dept(_args):
    resp = get_root_dept()
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    _set_marker(ACTION_SELECTED="contacts.get-root-dept")
    did = data.get("id", "-")
    name = data.get("name") or "-"
    abs_path = data.get("abs_path") or ""
    md = ["## 通讯录·根部门", "", f"- **部门名称**：{name}", f"- **部门ID**：`{did}`", f"- **路径**：{abs_path}"]
    _out(md, data)


def cmd_list_dept_children(args):
    dept_id = args.dept_id
    if not dept_id or not str(dept_id).strip():
        _err("请指定父部门 ID，传 0 可获取顶级部门列表")
    resp = list_dept_children(
        dept_id=dept_id,
        page_size=args.page_size,
        page_token=args.page_token,
        with_total=args.with_total,
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("items") or []
    _set_marker(ACTION_SELECTED="contacts.list-dept-children")
    md = ["## 通讯录·子部门列表", "", f"部门 `{dept_id}` 下共有 **{len(items)}** 个子部门。"]
    if not items:
        md.append("")
        md.append("该部门下没有子部门。")
    else:
        md.append("")
        for i, d in enumerate(items[:50], 1):
            did, name, abs_path, parent_id = _dept_display(d)
            md.append(f"{i}. **{name}** | 部门ID: `{did}` | 路径: {abs_path}")
        if len(items) > 50:
            md.append("")
            md.append(f"（仅展示前 50 条，共 {len(items)} 条）")
    _append_next_page(md, data)
    _out(md, data)


def cmd_list_user_depts(args):
    user_id = args.user_id
    if not user_id or not str(user_id).strip():
        _err("请指定用户 ID，例如: run.py list-user-depts 1609923915")
    resp = list_user_depts(user_id=user_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("items") or []
    _set_marker(ACTION_SELECTED="contacts.list-user-depts")
    md = ["## 通讯录·用户所在部门", "", f"用户 `{user_id}` 所在 **{len(items)}** 个部门："]
    if not items:
        md.append("")
        md.append("未查到该用户的部门信息。")
    else:
        md.append("")
        for i, d in enumerate(items, 1):
            did, name, abs_path, parent_id = _dept_display(d)
            md.append(f"{i}. **{name}** | 部门ID: `{did}` | 路径: {abs_path}")
    _out(md, data)


def cmd_batch_get_depts(args):
    dept_ids = [s.strip() for s in args.dept_ids.split(",") if s.strip()]
    if not dept_ids:
        _err("请指定部门 ID 列表（逗号分隔），例如: run.py batch-get-depts 123,456,789")
    resp = batch_get_depts(dept_ids=dept_ids)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("items") or []
    _set_marker(ACTION_SELECTED="contacts.batch-get-depts")
    md = ["## 通讯录·批量查询部门", "", f"共返回 **{len(items)}** 个部门信息。"]
    if not items:
        md.append("")
        md.append("未查到匹配的部门。")
    else:
        md.append("")
        for i, d in enumerate(items, 1):
            did, name, abs_path, parent_id = _dept_display(d)
            md.append(f"{i}. **{name}** | 部门ID: `{did}` | 路径: {abs_path} | 上级: `{parent_id}`")
    _out(md, data)


def main():
    parser = argparse.ArgumentParser(description="通讯录（V7）：搜索用户 / 部门管理 / 查询部门成员")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("search", help="按关键字搜索用户，同名返回多条")
    p.add_argument("name", nargs="?", default=None, help="要搜索的人名")
    p.add_argument("--keyword", "-k", default=None, help="要搜索的人名（与 positional 二选一）")
    p.add_argument("--page-size", type=int, default=50, help="单页条数")
    p.add_argument("--page-token", default=None, help="分页游标")
    p.add_argument("--status", default="active", help="用户状态过滤，默认 active")
    p.add_argument("--with-total", action="store_true", help="请求接口返回总数信息")
    p.set_defaults(func=cmd_search)

    p_sd = sub.add_parser("search-depts", help="按名称搜索部门")
    p_sd.add_argument("search_name", help="部门名称关键字")
    p_sd.add_argument("--page-size", type=int, default=50, help="单页条数，最大 50")
    p_sd.add_argument("--page-token", default=None, help="分页游标")
    p_sd.add_argument("--with-total", action="store_true", help="请求接口返回总数信息")
    p_sd.set_defaults(func=cmd_search_depts)

    p_root = sub.add_parser("get-root-dept", help="获取组织架构根部门")
    p_root.set_defaults(func=cmd_get_root_dept)

    p_ch = sub.add_parser("list-dept-children", help="获取指定部门的子部门列表")
    p_ch.add_argument("dept_id", help="父部门 ID（传 0 获取顶级部门）")
    p_ch.add_argument("--page-size", type=int, default=50, help="单页条数，最大 50")
    p_ch.add_argument("--page-token", default=None, help="分页游标")
    p_ch.add_argument("--with-total", action="store_true", help="请求接口返回总数信息")
    p_ch.set_defaults(func=cmd_list_dept_children)

    p_ud = sub.add_parser("list-user-depts", help="获取用户所在的部门列表")
    p_ud.add_argument("user_id", help="用户 ID")
    p_ud.set_defaults(func=cmd_list_user_depts)

    p_bg = sub.add_parser("batch-get-depts", help="批量获取部门信息")
    p_bg.add_argument("dept_ids", help="部门 ID 列表，逗号分隔，如 123,456,789")
    p_bg.set_defaults(func=cmd_batch_get_depts)

    p2 = sub.add_parser("list-dept-members", help="根据部门 ID 获取部门成员列表")
    p2.add_argument("dept_id", help="部门 ID")
    p2.add_argument("--page-size", type=int, default=50, help="单页条数，最大 50")
    p2.add_argument("--page-token", default=None, help="分页游标")
    p2.add_argument("--recursive", action="store_true", help="是否递归查询子部门成员")
    p2.add_argument("--status", default="active", help="用户状态过滤，默认 active")
    p2.add_argument("--with-total", action="store_true", help="请求接口返回总数信息")
    p2.add_argument("--all", action="store_true", help="自动翻页获取全部成员（去重）")
    p2.add_argument("--max-pages", type=int, default=20, help="--all 模式最大翻页次数，默认 20")
    p2.set_defaults(func=cmd_list_dept_members)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
