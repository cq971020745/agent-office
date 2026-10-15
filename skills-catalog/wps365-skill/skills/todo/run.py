#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WPS 365 个人待办管理：查询、创建、更新、删除个人待办任务。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法: python skills/todo/run.py <子命令> [参数...]
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_root = Path(__file__).resolve().parent.parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from wpsv7client import (  # noqa: E402
    list_personal_todos,
    get_personal_todo,
    create_personal_todo,
    update_personal_todo,
    update_personal_todo_status,
    delete_personal_todos,
    get_current_user,
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
    """校验响应 code==0，否则报错退出。与 calendar skill 一致。"""
    if resp.get("code") == -2:
        _err(f"[私网不可用] {resp.get('msg')}（此接口仅公网支持，请切换到公网或使用替代方案，不要重试）")
    code = resp.get("code")
    if code == 0:
        d = resp.get("data")
        return d if d is not None else {}
    _err(resp.get("msg") or resp.get("message") or "未知错误")


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


def _parse_due_date(due_str):
    """解析截止日期，返回毫秒时间戳"""
    if not due_str:
        return None

    due_str = due_str.lower().strip()
    now = datetime.now()

    if due_str in ("today", "今天"):
        dt = now.replace(hour=23, minute=59, second=59)
    elif due_str in ("tomorrow", "明天"):
        dt = (now + timedelta(days=1)).replace(hour=23, minute=59, second=59)
    elif due_str in ("next week", "下周"):
        dt = (now + timedelta(weeks=1)).replace(hour=23, minute=59, second=59)
    else:
        try:
            dt = datetime.fromisoformat(due_str.replace("Z", "+00:00"))
        except ValueError:
            for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m-%d", "%m/%d"):
                try:
                    dt = datetime.strptime(due_str, fmt)
                    if fmt in ("%m-%d", "%m/%d"):
                        dt = dt.replace(year=now.year)
                        if dt < now:
                            dt = dt.replace(year=now.year + 1)
                    dt = dt.replace(hour=23, minute=59, second=59)
                    break
                except ValueError:
                    continue
            else:
                print(f"WARNING: 无法解析日期格式: '{due_str}'，将忽略截止时间", file=sys.stderr)
                return None

    return int(dt.timestamp() * 1000)


def _format_timestamp(ts):
    """格式化毫秒时间戳为可读字符串"""
    if not ts:
        return "-"
    try:
        dt = datetime.fromtimestamp(ts / 1000)
        return dt.strftime("%Y-%m-%d %H:%M")
    except (ValueError, OSError):
        return str(ts)


def _task_status(task):
    """从任务对象中提取状态，兼容 my_finished_status / status 字段"""
    return task.get("my_finished_status") or task.get("status") or "todo"


def _task_id(task):
    """从任务对象中提取 ID，兼容 id / task_id 字段"""
    return task.get("id") or task.get("task_id") or ""


def cmd_list(args):
    _set_marker(
        ACTION_SELECTED="todo.list",
        WRITE_OPERATION=False,
        DRY_RUN=False,
        CONFIRM_REQUIRED=False,
        ASK_USER_REQUIRED=False,
        AMBIGUOUS_RESULTS=0,
    )
    result = list_personal_todos(
        status=args.status,
        page_size=args.page_size,
        page_token=args.page_token,
    )
    data = _check_resp(result)

    tasks = data.get("tasks", []) or []
    total = data.get("total", len(tasks))
    next_offset = data.get("next_offset")

    if not tasks:
        _out(["## 个人待办列表", "", "暂无待办任务。"], result)
        return

    md = ["## 个人待办列表", "", f"共 **{total}** 条，本页 **{len(tasks)}** 条", ""]

    for i, task in enumerate(tasks, 1):
        title = task.get("title", {}).get("subject", "无标题")
        status = _task_status(task)
        status_mark = "[x]" if status == "finish" else "[ ]"
        due_time = _format_timestamp(task.get("due_time"))
        tid = _task_id(task)

        line = f"{i}. {status_mark} **{title}**"
        if due_time != "-":
            line += f" (截止: {due_time})"
        line += f"\n   > ID: `{tid}`"
        md.append(line)

    if next_offset:
        md.append("")
        md.append(f"> 更多结果可使用 `list --page-token {next_offset}` 获取下一页。")
    if len(tasks) > 1:
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])

    _set_marker(
        ASK_USER_REQUIRED=len(tasks) > 1,
        AMBIGUOUS_RESULTS=len(tasks) if len(tasks) > 1 else 0,
    )
    _out(md, result)


def cmd_get(args):
    _set_marker(
        ACTION_SELECTED="todo.get",
        WRITE_OPERATION=False,
        DRY_RUN=False,
        CONFIRM_REQUIRED=False,
        ASK_USER_REQUIRED=False,
        AMBIGUOUS_RESULTS=0,
    )
    result = get_personal_todo(args.task_id)
    task = _check_resp(result)

    if not task:
        _err(f"未找到待办: {args.task_id}")

    title = task.get("title", {}).get("subject", "无标题")
    status = _task_status(task)
    status_mark = "[x]" if status == "finish" else "[ ]"
    description = task.get("description", "-")
    due_time = _format_timestamp(task.get("due_time"))
    create_time = _format_timestamp(task.get("create_time"))

    md = [
        "## 待办详情",
        "",
        f"- **ID**: `{_task_id(task)}`",
        f"- **标题**: {title}",
        f"- **状态**: {status_mark} {status}",
        f"- **描述**: {description}",
        f"- **截止时间**: {due_time}",
        f"- **创建时间**: {create_time}",
    ]

    _out(md, result)


def _get_current_user_id():
    """获取当前用户 ID，用于将创建者自动设为执行人"""
    try:
        resp = get_current_user()
        if resp.get("code") == 0:
            return resp.get("data", {}).get("id")
    except Exception:
        pass
    return None


def cmd_create(args):
    _set_marker(
        ACTION_SELECTED="todo.create",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    due_time = _parse_due_date(args.due)
    detail = [f"- **标题**：{args.title}"]
    if args.desc:
        detail.append(f"- **描述**：{args.desc}")
    if due_time:
        detail.append(f"- **截止时间**：{_format_timestamp(due_time)}")
    is_dry_run, md = _mutation_gate("创建待办", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "title": args.title})
        return

    user_id = _get_current_user_id()
    executors = [user_id] if user_id else None
    result = create_personal_todo(
        title=args.title,
        description=args.desc,
        due_time=due_time,
        status=args.status or "todo",
        executors=executors,
    )
    task = _check_resp(result)
    task_id = task.get("task_id", "")
    md.append("")
    md.append(f"- **ID**: `{task_id}`")
    md.append("待办已创建。")
    _out(md, result)


def cmd_update(args):
    _set_marker(
        ACTION_SELECTED="todo.update",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    if not any([args.title, args.desc, args.due]):
        _err("请至少指定 --title、--desc 或 --due 之一")

    due_time = _parse_due_date(args.due) if args.due else None
    detail = [f"- **待办ID**：`{args.task_id}`"]
    if args.title:
        detail.append(f"- **新标题**：{args.title}")
    if args.desc:
        detail.append(f"- **新描述**：{args.desc}")
    if due_time:
        detail.append(f"- **新截止时间**：{_format_timestamp(due_time)}")
    is_dry_run, md = _mutation_gate("更新待办", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "task_id": args.task_id})
        return

    result = update_personal_todo(
        task_id=args.task_id,
        title=args.title,
        description=args.desc,
        due_time=due_time,
    )
    _check_resp(result)
    md.append("")
    md.append("待办已更新。")
    _out(md, result)


def cmd_done(args):
    _set_marker(
        ACTION_SELECTED="todo.done",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    detail = [f"- **待办ID**：`{args.task_id}`", "- **操作**：标记为已完成"]
    is_dry_run, md = _mutation_gate("完成待办", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "task_id": args.task_id})
        return

    result = update_personal_todo_status(args.task_id, "finish")
    _check_resp(result)
    md.append("")
    md.append("待办已标记完成。")
    _out(md, result)


def cmd_undone(args):
    _set_marker(
        ACTION_SELECTED="todo.undone",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    detail = [f"- **待办ID**：`{args.task_id}`", "- **操作**：恢复为未完成"]
    is_dry_run, md = _mutation_gate("恢复待办", detail, args.confirm)
    if is_dry_run:
        _out(md, {"dry_run": True, "task_id": args.task_id})
        return

    result = update_personal_todo_status(args.task_id, "unfinish")
    _check_resp(result)
    md.append("")
    md.append("待办已恢复为未完成。")
    _out(md, result)


def cmd_delete(args):
    _set_marker(
        ACTION_SELECTED="todo.delete",
        WRITE_OPERATION=True,
        CONFIRM_REQUIRED=True,
        DRY_RUN=not args.confirm,
        ASK_USER_REQUIRED=not args.confirm,
    )
    detail = [f"- **待办ID**：`{args.task_id}`"]
    dry_run, md = _mutation_gate("删除待办", detail, args.confirm)
    if dry_run:
        _out(md, {"dry_run": True, "task_id": args.task_id})
        return

    result = delete_personal_todos([args.task_id])
    _check_resp(result)

    md.extend([
        "",
        "## 待办已删除",
        "",
        f"- **ID**: `{args.task_id}`",
    ])

    _out(md, result)


def main():
    parser = argparse.ArgumentParser(description="WPS 365 个人待办管理")
    subparsers = parser.add_subparsers(dest="command", required=True, help="子命令")

    # list
    p_list = subparsers.add_parser("list", help="获取待办列表")
    p_list.add_argument("--status", "-s", choices=["todo", "finish"], help="状态筛选")
    p_list.add_argument("--page-size", type=int, default=50, help="每页数量")
    p_list.add_argument("--page-token", help="分页 token")
    p_list.set_defaults(func=cmd_list)

    # get
    p_get = subparsers.add_parser("get", help="获取待办详情")
    p_get.add_argument("task_id", help="待办 ID")
    p_get.set_defaults(func=cmd_get)

    # create
    p_create = subparsers.add_parser("create", help="创建待办（默认 dry-run，追加 --confirm 才会执行）")
    p_create.add_argument("title", help="待办标题")
    p_create.add_argument("--desc", "-d", help="描述")
    p_create.add_argument("--due", help="截止时间")
    p_create.add_argument("--status", "-s", choices=["todo", "finish"], help="状态")
    p_create.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p_create.set_defaults(func=cmd_create)

    # update
    p_update = subparsers.add_parser("update", help="更新待办（默认 dry-run，追加 --confirm 才会执行）")
    p_update.add_argument("task_id", help="待办 ID")
    p_update.add_argument("--title", help="新标题")
    p_update.add_argument("--desc", help="新描述")
    p_update.add_argument("--due", help="新截止时间")
    p_update.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p_update.set_defaults(func=cmd_update)

    # done
    p_done = subparsers.add_parser("done", help="标记完成（默认 dry-run，追加 --confirm 才会执行）")
    p_done.add_argument("task_id", help="待办 ID")
    p_done.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p_done.set_defaults(func=cmd_done)

    # undone
    p_undone = subparsers.add_parser("undone", help="取消完成（默认 dry-run，追加 --confirm 才会执行）")
    p_undone.add_argument("task_id", help="待办 ID")
    p_undone.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p_undone.set_defaults(func=cmd_undone)

    # delete
    p_delete = subparsers.add_parser("delete", help="删除待办（默认 dry-run，追加 --confirm 才会执行）")
    p_delete.add_argument("task_id", help="待办 ID")
    p_delete.add_argument("--confirm", action="store_true", help="确认执行删除；默认仅预览（dry-run）")
    p_delete.set_defaults(func=cmd_delete)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err(f"请求失败: {e}")


if __name__ == "__main__":
    main()
