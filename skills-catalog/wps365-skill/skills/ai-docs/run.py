#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 知识库：列表查询等操作，调用 V7 AI 知识库接口，输出 Markdown。
需在 wps365-skill 根目录执行，并设置环境变量 WPS_SID。
用法: python skills/ai-docs/run.py <子命令> [参数...]
"""
import argparse
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_root = Path(__file__).resolve().parent.parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from wpsv7client import list_aidocs_spaces, recall_rank  # noqa: E402
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
    lines = [""] + md_lines
    print("\n".join(lines))
    _finalize_marker()
    sys.stdout.flush()


def _err(msg):
    _set_marker(ERROR_EXIT=True, ERROR_MESSAGE=str(msg))
    _finalize_marker()
    print("## 错误\n\n" + msg, file=sys.stderr)
    sys.exit(1)


def _check_resp(resp):
    if resp.get("code") == -2:
        _err(f"[私网不可用] {resp.get('msg')}（此接口仅公网支持，请切换到公网或使用替代方案，不要重试）")
    code = resp.get("code")
    if code == 0:
        d = resp.get("data")
        return d if d is not None else {}
    _err(resp.get("msg") or resp.get("message") or "未知错误")


def cmd_list_spaces(args):
    _set_marker(ACTION_SELECTED="ai-docs.list-spaces")
    resp = list_aidocs_spaces(
        page_size=args.page_size,
        page_token=args.page_token,
        filter_status=args.filter_status,
    )
    data = _check_resp(resp)
    items = data.get("items", []) if isinstance(data, dict) else []
    next_token = data.get("next_page_token", "") if isinstance(data, dict) else ""
    md = ["## AI 知识库列表", "", f"共 {len(items)} 条（当前页）"]
    if items:
        md.append("")
        for s in items:
            name = s.get("doclib_name") or "(无名称)"
            group_id = s.get("group_id", "")
            drive_id = s.get("drive_id", "")
            md.append(f"- **{name}**  group_id=`{group_id}`  drive_id=`{drive_id}`")
    if next_token:
        md.append("")
        md.append(f"下一页 token: `{next_token}`")
    _out(md, data)


def cmd_recall(args):
    _set_marker(ACTION_SELECTED="ai-docs.recall")
    drives = [{"drive_id": d} for d in args.drive_ids]
    resp = recall_rank(
        query=args.query,
        drives=drives,
        topk=args.topk,
        scene=args.scene,
    )
    _check_resp(resp)
    data = resp.get("data", [])
    if not isinstance(data, list):
        data = []
    md = ["## 知识库召回结果", "", f"query: `{args.query}`　topk: {args.topk}　共 {len(data)} 条片段"]
    for i, chunk in enumerate(data, 1):
        fname = chunk.get("file_name", "")
        score = chunk.get("ref_score", 0)
        content = chunk.get("content", "")
        link = chunk.get("link_url", "")
        md.append("")
        md.append(f"### {i}. {fname}（score={score:.4f}）")
        if link:
            md.append(f"链接: {link}")
        md.append("")
        md.append(content)
    _out(md, data)


def main():
    parser = argparse.ArgumentParser(description="AI 知识库操作（V7）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list-spaces", help="知识库列表")
    p.add_argument("--page-size", type=int, default=300, dest="page_size", help="页面大小，默认 300")
    p.add_argument("--page-token", default=None, dest="page_token", help="翻页 token")
    p.add_argument("--filter-status", default="success", dest="filter_status", help="过滤条件，默认 success")
    p.set_defaults(func=cmd_list_spaces)

    p = sub.add_parser("recall", help="知识库召回")
    p.add_argument("query", help="查询关键字")
    p.add_argument("--drive-id", required=True, action="append", dest="drive_ids", help="驱动器 ID（可多次指定）")
    p.add_argument("--topk", type=int, default=1, help="召回片段数量，默认 1")
    p.add_argument("--scene", default=None, help="召回场景，如 full_folder_recall")
    p.set_defaults(func=cmd_recall)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
