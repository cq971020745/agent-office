#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻审批（V7）：审批实例查询、批量详情、实例列表、抄送列表、操作记录。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法: python skills/workflow/run.py <子命令> [参数]
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
    get_approval_instance,
    list_approval_instances,
    list_approval_instances_brief,
    list_approval_ccs,
    list_approval_timelines,
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

_STATUS_LABEL = {
    "auditing": "审批中",
    "approved": "已通过",
    "refused": "已拒绝",
    "returned": "已退回",
    "revoked": "已撤回",
    "terminated": "已终止",
    "deleted": "已删除",
}

_TIMELINE_TYPE_LABEL = {
    "approval_created": "发起审批",
    "passed": "通过",
    "reject": "拒绝",
    "returned": "退回",
    "revoke": "撤回",
    "comment": "评论",
    "cc": "抄送",
    "create_group": "创建群聊",
    "add_sign": "加签",
    "deleted": "删除",
    "rollback": "回退",
    "auto_passed": "自动通过",
    "transfer": "转交",
    "auto_approval": "自动审批",
    "admin_transfer": "管理员转交",
    "terminate": "终止",
    "review": "审核",
}


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
    if not isinstance(resp, dict):
        return {}
    if resp.get("code") != 0:
        _err(resp.get("msg") or resp.get("message") or "未知错误")
    d = resp.get("data")
    return d if d is not None else {}


def _status_text(s):
    return _STATUS_LABEL.get(s, s or "-")


def _instance_summary(inst):
    """从完整审批实例生成单行摘要。"""
    iid = inst.get("id", "-")
    title = inst.get("title") or "-"
    serial = inst.get("serial_no") or ""
    status = _status_text(inst.get("status"))
    user_id = inst.get("user_id") or "-"
    start = inst.get("start_time") or "-"
    return f"**{title}** ({serial}) | ID: `{iid}` | 状态: {status} | 发起人: `{user_id}` | 发起时间: {start}"


def _instance_brief_summary(inst):
    """从简要审批实例生成单行摘要。"""
    iid = inst.get("id", "-")
    title = inst.get("title") or "-"
    serial = inst.get("serial_no") or ""
    status = _status_text(inst.get("status"))
    user_id = inst.get("user_id") or "-"
    return f"**{title}** ({serial}) | ID: `{iid}` | 状态: {status} | 发起人: `{user_id}`"


def _append_page_info(md, data, key="page_token"):
    if not isinstance(data, dict):
        return
    token = data.get(key)
    has_more = data.get("has_more")
    if token:
        md.extend(["", f"- **page_token**：`{token}`"])
    if has_more is True:
        md.append("- 还有更多数据，可传入 `--page-token` 获取下一页")


# ── 命令实现 ───────────────────────────────────────────────

def cmd_get_instance(args):
    """查询单个审批实例详情。"""
    _set_marker(ACTION_SELECTED="workflow.get-instance")
    instance_id = args.instance_id
    user_id = args.user_id
    if not instance_id or not str(instance_id).strip():
        _err("请指定审批实例 ID")
    if not user_id or not str(user_id).strip():
        _err("请指定用户 ID (--user-id)")
    resp = get_approval_instance(instance_id=instance_id, user_id=user_id)
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    md = ["## 轻审批·审批实例详情", ""]
    if not data.get("id"):
        md.append("未找到该审批实例。")
    else:
        md.append(_instance_summary(data))
        tasks = data.get("approval_tasks") or []
        if tasks:
            md.extend(["", "### 审批任务"])
            for t in tasks:
                tid = t.get("id", "-")
                title = t.get("title", "-")
                t_status = t.get("status", "-")
                t_user = t.get("user_id", "-")
                md.append(f"- 任务 `{tid}` ({title}): 状态={t_status}, 审批人=`{t_user}`")
        contents = data.get("contents") or []
        if contents:
            md.extend(["", "### 表单内容"])
            for c in contents:
                c_title = c.get("title", "-")
                c_value = c.get("value") or ""
                c_options = c.get("form_options") or []
                if c_options:
                    display_val = ", ".join(o.get("text", "") for o in c_options if o.get("text"))
                elif c_value:
                    display_val = c_value
                else:
                    display_val = "-"
                md.append(f"- **{c_title}**：{display_val}")
    _out(md, data)


def cmd_list_instances(args):
    """批量查询审批实例详情（最多 20 个 ID）。"""
    _set_marker(ACTION_SELECTED="workflow.list-instances")
    instance_ids = [s.strip() for s in args.instance_ids.split(",") if s.strip()]
    if not instance_ids:
        _err("请指定审批实例 ID 列表，逗号分隔，最多 20 个")
    resp = list_approval_instances(
        instance_ids=instance_ids,
        promoter=args.promoter,
    )
    data = _check_resp(resp)
    if isinstance(data, list):
        items = data
        data = {"items": items, "total": len(items)}
    elif isinstance(data, dict):
        items = data.get("items") or []
    else:
        items = []
        data = {}
    total = data.get("total", len(items))
    md = ["## 轻审批·批量查询审批实例详情", "", f"共返回 **{total}** 个审批实例。"]
    if not items:
        md.append("")
        md.append("未找到匹配的审批实例。")
    else:
        md.append("")
        for i, inst in enumerate(items, 1):
            md.append(f"{i}. {_instance_summary(inst)}")
    _out(md, data)


def cmd_list_instances_brief(args):
    """分页查询审批实例列表（简要信息）。"""
    _set_marker(ACTION_SELECTED="workflow.list-instances-brief")
    resp = list_approval_instances_brief(
        page_size=args.page_size,
        page_token=args.page_token,
        approval_define_id=args.approval_define_id,
        instance_status=args.instance_status,
        time_from=args.time_from,
        time_to=args.time_to,
        promoter=args.promoter,
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("instance_list") or []
    md = ["## 轻审批·审批实例列表", "", f"本页返回 **{len(items)}** 个审批实例。"]
    if args.instance_status:
        md.append(f"（筛选状态: {_status_text(args.instance_status)}）")
    if not items:
        md.append("")
        md.append("没有审批实例。")
    else:
        md.append("")
        for i, inst in enumerate(items, 1):
            md.append(f"{i}. {_instance_brief_summary(inst)}")
    _append_page_info(md, data)
    _out(md, data)


def cmd_list_ccs(args):
    """分页查询审批抄送列表。"""
    _set_marker(ACTION_SELECTED="workflow.list-ccs")
    resp = list_approval_ccs(
        page_size=args.page_size,
        page_token=args.page_token,
        approval_define_id=args.approval_define_id,
        instance_id=args.instance_id,
        cc_user=args.cc_user,
        read_status=args.read_status,
        time_from=args.time_from,
        time_to=args.time_to,
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("cc_list") or []
    md = ["## 轻审批·抄送列表", "", f"本页返回 **{len(items)}** 条抄送记录。"]
    if not items:
        md.append("")
        md.append("没有抄送记录。")
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            cc = item.get("cc") or {}
            inst = item.get("instance") or {}
            cc_user = cc.get("user_id", "-")
            read = cc.get("read_status", "-")
            inst_title = inst.get("title") or "-"
            inst_id = inst.get("id") or "-"
            md.append(f"{i}. 实例「{inst_title}」(`{inst_id}`) → 抄送人: `{cc_user}` | 状态: {read}")
    _append_page_info(md, data)
    _out(md, data)


def cmd_list_timelines(args):
    """分页查询审批操作记录。"""
    _set_marker(ACTION_SELECTED="workflow.list-timelines")
    resp = list_approval_timelines(
        page_size=args.page_size,
        page_token=args.page_token,
        approval_define_id=args.approval_define_id,
        instance_id=args.instance_id,
        operator=args.operator,
        type_filter=args.type,
        time_from=args.time_from,
        time_to=args.time_to,
    )
    data = _check_resp(resp)
    if not isinstance(data, dict):
        data = {}
    items = data.get("timeline_list") or []
    md = ["## 轻审批·操作记录", "", f"本页返回 **{len(items)}** 条操作记录。"]
    if not items:
        md.append("")
        md.append("没有操作记录。")
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            tl = item.get("time_line") or {}
            inst = item.get("instance") or {}
            tl_type = _TIMELINE_TYPE_LABEL.get(tl.get("type", ""), tl.get("type", "-"))
            operator = tl.get("operator", "-")
            node_name = tl.get("node_name", "-")
            comment = tl.get("comment", "")
            inst_title = inst.get("title") or "-"
            inst_id = inst.get("id") or "-"
            line = f"{i}. [{tl_type}] 实例「{inst_title}」(`{inst_id}`) | 节点: {node_name} | 操作人: `{operator}`"
            if comment:
                line += f" | 评论: {comment}"
            md.append(line)
    _append_page_info(md, data)
    _out(md, data)


# ── CLI 入口 ───────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="轻审批（V7）：审批实例查询 / 批量详情 / 实例列表 / 抄送列表 / 操作记录")
    sub = parser.add_subparsers(dest="cmd", required=True)

    # get-instance
    p_gi = sub.add_parser("get-instance", help="查询单个审批实例详情")
    p_gi.add_argument("instance_id", help="审批实例 ID")
    p_gi.add_argument("--user-id", required=True, help="用户 ID，用于查询该用户的任务")
    p_gi.set_defaults(func=cmd_get_instance)

    # list-instances
    p_li = sub.add_parser("list-instances", help="批量查询审批实例详情（最多 20 个 ID）")
    p_li.add_argument("instance_ids", help="审批实例 ID 列表，逗号分隔，最多 20 个")
    p_li.add_argument("--promoter", default=None, help="发起人 user_id，过滤该用户可见的审批实例")
    p_li.set_defaults(func=cmd_list_instances)

    # list-instances-brief
    p_lb = sub.add_parser("list-instances-brief", help="分页查询审批实例列表（简要）")
    p_lb.add_argument("--page-size", type=int, default=10, help="分页大小，10~50，默认 10")
    p_lb.add_argument("--page-token", default=None, help="分页游标")
    p_lb.add_argument("--approval-define-id", default=None, help="审批定义 ID，过滤特定审批类型")
    p_lb.add_argument("--instance-status", default=None,
                       choices=["auditing", "approved", "refused", "returned", "revoked", "terminated"],
                       help="审批实例状态过滤")
    p_lb.add_argument("--time-from", default=None, help="开始时间，Unix 秒时间戳")
    p_lb.add_argument("--time-to", default=None, help="结束时间，Unix 秒时间戳")
    p_lb.add_argument("--promoter", default=None, help="发起人 user_id")
    p_lb.set_defaults(func=cmd_list_instances_brief)

    # list-ccs
    p_cc = sub.add_parser("list-ccs", help="分页查询审批抄送列表")
    p_cc.add_argument("--page-size", type=int, default=10, help="分页大小，10~50，默认 10")
    p_cc.add_argument("--page-token", default=None, help="分页游标")
    p_cc.add_argument("--approval-define-id", default=None, help="审批定义 ID")
    p_cc.add_argument("--instance-id", default=None, help="审批实例 ID")
    p_cc.add_argument("--cc-user", default=None, help="抄送人 user_id")
    p_cc.add_argument("--read-status", default=None, choices=["already_read", "not_read"], help="已读/未读")
    p_cc.add_argument("--time-from", default=None, help="开始时间，Unix 秒时间戳")
    p_cc.add_argument("--time-to", default=None, help="结束时间，Unix 秒时间戳")
    p_cc.set_defaults(func=cmd_list_ccs)

    # list-timelines
    p_tl = sub.add_parser("list-timelines", help="分页查询审批操作记录")
    p_tl.add_argument("--page-size", type=int, default=10, help="分页大小，10~50，默认 10")
    p_tl.add_argument("--page-token", default=None, help="分页游标")
    p_tl.add_argument("--approval-define-id", default=None, help="审批定义 ID")
    p_tl.add_argument("--instance-id", default=None, help="审批实例 ID")
    p_tl.add_argument("--operator", default=None, help="操作人 user_id")
    p_tl.add_argument("--type", default=None,
                       help="操作类型，逗号分隔。可选: approval_created,passed,reject,returned,revoke,comment,cc,create_group,add_sign,rollback,auto_passed,transfer,auto_approval")
    p_tl.add_argument("--time-from", default=None, help="开始时间，Unix 秒时间戳")
    p_tl.add_argument("--time-to", default=None, help="结束时间，Unix 秒时间戳")
    p_tl.set_defaults(func=cmd_list_timelines)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
