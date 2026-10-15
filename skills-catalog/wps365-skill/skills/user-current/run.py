#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
查询当前用户信息。

- me_base: 直接调用 /v7/users/current，返回当前登录用户基础信息
- me: 先查当前登录用户基础信息，再按当前姓名搜索补齐更详细资料

需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
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

from wpsv7client import get_current_user, search_users  # noqa: E402
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


def _err(msg: str) -> None:
    _set_marker(ERROR_EXIT=True, ERROR_MESSAGE=str(msg))
    _finalize_marker()
    sys.stdout.flush()
    print("## 错误\n\n" + msg, file=sys.stderr)
    sys.exit(1)


def _check_resp(resp: dict) -> dict:
    if resp.get("code") != 0:
        _err(resp.get("msg") or resp.get("message") or "未知错误")
    data = resp.get("data")
    return data if isinstance(data, dict) else {}


def _out(md_lines, data) -> None:
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


def _current_name(data: dict) -> str:
    return (
        data.get("user_name")
        or data.get("alias_name")
        or data.get("nick_name")
        or data.get("name")
        or ""
    )


def _user_display_name(user: dict) -> str:
    return (
        user.get("user_name")
        or user.get("alias_name")
        or user.get("nick_name")
        or user.get("name")
        or user.get("id")
        or "-"
    )


def _user_dept_str(user: dict) -> str:
    dept_path = user.get("dept_path")
    if dept_path:
        return dept_path.split("/")[-1]
    depts = user.get("depts")
    if isinstance(depts, list) and depts:
        return "、".join((d.get("name") or d.get("id") or "") for d in depts[:3]) or "-"
    return "-"


def _user_summary_lines(title: str, data: dict) -> list[str]:
    name = _current_name(data) or "-"
    uid = data.get("id", "-")
    cid = data.get("company_id", "-")
    phone = data.get("phone") or "-"
    status = data.get("status") or "-"
    login_mode = data.get("login_mode") or "-"
    return [
        title,
        "",
        f"- **用户**：{name}",
        f"- **用户ID**：{uid}",
        f"- **企业ID**：{cid}",
        f"- **手机号**：{phone}",
        f"- **状态**：{status}",
        f"- **登录方式**：{login_mode}",
    ]


def _id_matches(user_id: str, items: list[dict]) -> list[dict]:
    if not user_id:
        return []
    return [item for item in items if str(item.get("id") or "") == str(user_id)]


def _format_detail_user(user: dict) -> list[str]:
    return [
        f"- **用户**：{_user_display_name(user)}",
        f"- **用户ID**：`{user.get('id', '-')}`",
        f"- **部门**：{_user_dept_str(user)}",
        f"- **邮箱**：{user.get('email') or '-'}",
        f"- **手机号**：{user.get('phone') or '-'}",
        f"- **企业ID**：{user.get('company_id') or '-'}",
        f"- **状态**：{user.get('status') or '-'}",
    ]


def cmd_me_base(_args) -> None:
    base_resp = get_current_user()
    base_data = _check_resp(base_resp)
    _out(_user_summary_lines("## 当前用户基础信息", base_data), base_data)


def cmd_me(args) -> None:
    base_resp = get_current_user()
    base_data = _check_resp(base_resp)
    current_name = _current_name(base_data).strip()
    current_user_id = str(base_data.get("id") or "").strip()
    if not current_name:
        _err("当前用户基础信息中缺少可用于补齐详情的姓名字段")
    if not current_user_id:
        _err("当前用户基础信息中缺少可用于精确过滤详情的用户ID字段")

    search_resp = search_users(
        keyword=current_name,
        page_size=args.page_size,
        page_token=None,
        with_total=True,
        status="active",
    )
    search_data = _check_resp(search_resp)
    items = search_data.get("items") or []
    id_matches = _id_matches(current_user_id, items)

    md = _user_summary_lines("## 当前用户基础信息", base_data)
    md.extend(
        [
            "",
            "## 详情补齐结果",
            "",
            f"- **候选召回方式**：按当前姓名 `{current_name}` 搜索通讯录详情",
            f"- **精确过滤方式**：使用当前用户ID `{current_user_id}` 过滤候选结果",
            "- **说明**：当前阶段先按姓名召回候选，再按当前用户ID精确匹配；TODO：后续改为直接按用户ID查询详情",
        ]
    )

    output_data = {
        "mode": "me",
        "todo": "后续改为直接按用户ID查询详情",
        "current_user": base_data,
        "search_result": search_data,
    }

    if not items:
        md.extend(
            [
                "- **详情状态**：未命中通讯录详情",
                "",
                "当前基础信息已返回，但未找到可补齐的通讯录详情。",
            ]
        )
        _out(md, output_data)
        return

    if len(id_matches) == 1:
        detail_user = id_matches[0]
        md.extend(["- **详情状态**：已补齐", ""])
        md.extend(_format_detail_user(detail_user))
        output_data["detail_user"] = detail_user
        _out(md, output_data)
        return

    if not id_matches:
        md.extend(
            [
                "- **详情状态**：未匹配到与当前用户ID一致的通讯录详情",
                "",
                "已按当前姓名召回候选，但没有找到与当前登录用户 `id` 一致的详情记录。",
            ]
        )
        if items:
            md.extend(["", "以下是同名或近似候选：", ""])
            for idx, user in enumerate(items[:20], start=1):
                md.append(
                    f"{idx}. **{_user_display_name(user)}** | 用户ID: `{user.get('id', '-')}` | 部门: {_user_dept_str(user)} | 邮箱: {user.get('email') or '-'}"
                )
            if len(items) > 20:
                md.extend(["", f"（仅展示前 20 条，共 {len(items)} 条）"])
        _out(md, output_data)
        return

    md.extend(
        [
            f"- **详情状态**：命中多条同ID候选（{len(id_matches)} 条），当前不自动选择",
            "",
            "以下是候选详情：",
            "",
        ]
    )
    for idx, user in enumerate(id_matches[:20], start=1):
        md.append(
            f"{idx}. **{_user_display_name(user)}** | 用户ID: `{user.get('id', '-')}` | 部门: {_user_dept_str(user)} | 邮箱: {user.get('email') or '-'}"
        )
    if len(id_matches) > 20:
        md.extend(["", f"（仅展示前 20 条，共 {len(id_matches)} 条）"])
    _out(md, output_data)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="查询当前登录用户信息")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("me_base", help="查询当前登录用户基础信息")
    p.set_defaults(func=cmd_me_base)

    p = sub.add_parser("me", help="查询当前登录用户基础信息并尝试补齐详情")
    p.add_argument("--page-size", type=int, default=10, help="按姓名补齐详情时的搜索条数上限，默认 10")
    p.set_defaults(func=cmd_me)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    _set_marker(ACTION_SELECTED=f"user-current.{args.cmd}")
    try:
        args.func(args)
    except ValueError as exc:
        _err(str(exc))
    except Exception as exc:
        _err("请求失败: " + str(exc))


if __name__ == "__main__":
    main()
