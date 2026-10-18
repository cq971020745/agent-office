#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云文档 Drive：调用 V7 Drive 接口，实现文件上传、列表、详情等功能。
需设置环境变量 WPS_SID。可用 `SKILL.md` 同目录 `run.py` 的绝对路径执行（不依赖 cwd）。
用法:
  python skills/drive/run.py upload <文件路径>
  python skills/drive/run.py list
  python skills/drive/run.py get <file_id>
  python skills/drive/run.py get-file-content <file_id|link_id>  # 云文档内容提取
  python skills/drive/run.py get-file-content /path/to/file.docx  # 本地文件解析（KDC Server）
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

_ERROR_MESSAGE_MAX_CHARS = 2048
_EXTRACT_STDOUT_MAX_BYTES = 32 * 1024

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_root = Path(__file__).resolve().parent.parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from wpsv7client import (
    upload_simple,
    update_file,
    list_files,
    get_file,
    get_file_directly,
    get_link_meta,
    get_file_download_url,
    download_file_to_local,
    download_file_version_to_local,
    get_file_content_extract,
    extract_file_content,
    export_file_content_async,
    create_file,
    create_otl_document,
    write_airpage_content,
    search_files,
    convert_file,
    list_latest_items,
    list_file_versions,
    list_star_items,
    batch_create_star_items,
    batch_delete_star_items,
    list_drive_labels,
    get_drive_label_meta,
    list_drive_label_objects,
    create_drive_label,
    batch_add_drive_label_objects,
    batch_remove_drive_label_objects,
    list_deleted_files,
    restore_deleted_file,
    delete_file,
    move_file,
    copy_file,
    rename_file,
    save_as_file,
    check_name_exists,
    open_file_link,
    close_file_link,
    ai_search,
    list_document_comments,
    create_document_comment,
    update_document_comment,
    delete_document_comment,
    list_doclibs,
    get_doclib_meta,
    WpsV7Client,
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


def _out(md_lines, data=None):
    """输出 Markdown 摘要；data 非 None 时追加「原始数据 (JSON)」块。"""
    lines = [""] + md_lines
    if data is not None:
        lines += ["", "## 原始数据 (JSON)", "", "```json", json.dumps(data, ensure_ascii=False, indent=2), "```"]
    print("\n".join(lines))
    _finalize_marker()
    sys.stdout.flush()


def _write_sidecar_log(text: str, prefix: str = "wps365-error") -> str:
    """将超长文本写入临时 sidecar 文件，返回绝对路径。"""
    path = os.path.join(
        tempfile.gettempdir(),
        f"{prefix}-{os.getpid()}-{int(time.time())}.log",
    )
    Path(path).write_text(text, encoding="utf-8")
    return path


def _truncate_for_agent(text, limit: int = _ERROR_MESSAGE_MAX_CHARS, sidecar_prefix: str = "wps365-error"):
    """截断进入 Agent 上下文的文本；完整内容写入 sidecar。"""
    s = "" if text is None else str(text)
    if len(s) <= limit:
        return s, None
    sidecar = _write_sidecar_log(s, sidecar_prefix)
    note = f"\n\n...[已截断，共 {len(s)} 字符，完整日志: {sidecar}]"
    return s[: max(0, limit - len(note))] + note, sidecar


def _err(msg):
    display, _sidecar = _truncate_for_agent(msg)
    _set_marker(ERROR_EXIT=True, ERROR_MESSAGE=display)
    _finalize_marker()
    sys.stdout.flush()
    print("## 错误\n\n" + display, file=sys.stderr)
    sys.exit(1)


def _airpage_effective(resp) -> dict:
    """合并顶层与 data/detail 层 WebOffice 响应，内层 errno/result 优先。"""
    if not isinstance(resp, dict):
        return {}
    out = dict(resp)
    for layer in (resp.get("data"), resp.get("detail")):
        if isinstance(layer, dict):
            for key in ("errno", "result", "msg", "message", "reason", "error"):
                if key in layer:
                    out[key] = layer[key]
    return out


def _airpage_write_success(resp) -> bool:
    eff = _airpage_effective(resp)
    if eff.get("errno"):
        return False
    if eff.get("code") not in (None, 0):
        return False
    result = eff.get("result")
    if result in ("ok", "OK"):
        return True
    if result and result not in ("ok", "OK"):
        return False
    if eff.get("error"):
        return False
    return eff.get("code") == 0


def _airpage_write_error(resp, default="写入智能文档失败") -> str:
    eff = _airpage_effective(resp)
    msg = (
        eff.get("msg")
        or eff.get("message")
        or eff.get("reason")
        or eff.get("result")
        or eff.get("error")
    )
    if msg is None:
        return default
    if isinstance(msg, dict):
        msg = json.dumps(msg, ensure_ascii=False)
    text = str(msg)
    if eff.get("errno"):
        text = f"{text} (errno={eff['errno']})"
    return text or default


def _resp_error(resp, default="未知错误"):
    """统一提取接口错误信息，兼容 msg / message / result / error。"""
    if not isinstance(resp, dict):
        return default
    msg = (
        resp.get("msg")
        or resp.get("message")
        or resp.get("result")
        or resp.get("error")
    )
    if msg is None:
        return default
    if isinstance(msg, dict):
        msg = json.dumps(msg, ensure_ascii=False)
    text = str(msg)
    if resp.get("text") and len(text) < 80:
        text = f"{text} | {str(resp.get('text'))[:200]}"
    return text or default


_KDOCS_LINK_RE = re.compile(r"https?://[^/]*kdocs\.cn/l/([A-Za-z0-9_-]+)")
_CLOUD_DOC_LINK_RE = re.compile(
    r"https?://[^\s?#]+/(?:weboffice/)?l/([A-Za-z0-9_-]+)"
)


def _extract_link_id(raw: str) -> str:
    """从云文档分享/预览 URL 提取 link_id；非 URL 原样返回。"""
    raw = (raw or "").strip()
    for pattern in (_KDOCS_LINK_RE, _CLOUD_DOC_LINK_RE):
        m = pattern.search(raw)
        if m:
            return m.group(1)
    return raw


_INCLUDE_ELEMENTS_ALLOWED = frozenset({"para", "table", "component", "textbox", "all"})
_INCLUDE_ELEMENTS_ORDER = ("para", "table", "component", "textbox")


def _parse_include_elements_cli(value):
    """
    指定抽取元素，对应查询参数 include_elements（多个元素用半角逗号连接，如 para,textbox）。
    传入 None 或空串时返回 None（extract/read 会在上层默认使用 all）。
    一旦指定非 all 的组合，会自动补上必导出的 para。all 需单独使用，不可与其它元素组合。
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    parts = [p.strip().lower() for p in s.split(",") if p.strip()]
    if not parts:
        return None
    bad = [p for p in parts if p not in _INCLUDE_ELEMENTS_ALLOWED]
    if bad:
        raise argparse.ArgumentTypeError(
            f"非法元素 {bad!r}，允许: {', '.join(sorted(_INCLUDE_ELEMENTS_ALLOWED))}"
        )
    if "all" in parts:
        if len(parts) > 1:
            raise argparse.ArgumentTypeError("指定 all 时不能与 para、table 等其它元素组合")
        return "all"
    out = []
    seen = set()
    for key in _INCLUDE_ELEMENTS_ORDER:
        if key in parts and key not in seen:
            out.append(key)
            seen.add(key)
    if "para" not in seen:
        out.insert(0, "para")
    return ",".join(out)


_WORKBOOK_RANGE_KEYS = frozenset(
    {"sheetFrom", "sheetTo", "rowFrom", "rowTo", "colFrom", "colTo"}
)
# KDC 表格抽取：未指定范围时用 Excel 规格上限（0-based 闭区间 rowTo/colTo）
_WORKBOOK_RANGE_EXCEL_MAX_ROW_TO = 1_048_575   # 1,048,576 行
_WORKBOOK_RANGE_EXCEL_MAX_COL_TO = 16_383      # 16,384 列（XFD）
_WORKBOOK_RANGE_EXCEL_MAX_SHEET_TO = 254       # 255 个工作表


def _default_workbook_range() -> dict:
    return {
        "sheetFrom": 0,
        "sheetTo": _WORKBOOK_RANGE_EXCEL_MAX_SHEET_TO,
        "rowFrom": 0,
        "rowTo": _WORKBOOK_RANGE_EXCEL_MAX_ROW_TO,
        "colFrom": 0,
        "colTo": _WORKBOOK_RANGE_EXCEL_MAX_COL_TO,
    }


def _parse_workbook_range_cli(value):
    """
    表格解析范围，对应 convert_options.workbook_range。
    支持 JSON 或简写：sheetFrom:sheetTo,rowFrom:rowTo,colFrom:colTo（如 1:1,0:29,0:15）。
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if s.startswith("{"):
        try:
            obj = json.loads(s)
        except json.JSONDecodeError as e:
            raise argparse.ArgumentTypeError(f"workbook_range JSON 无效: {e}") from e
        if not isinstance(obj, dict):
            raise argparse.ArgumentTypeError("workbook_range 必须是 JSON 对象")
        bad = [k for k in obj if k not in _WORKBOOK_RANGE_KEYS]
        if bad:
            raise argparse.ArgumentTypeError(
                f"workbook_range 含未知键 {bad!r}，允许: {', '.join(sorted(_WORKBOOK_RANGE_KEYS))}"
            )
        return obj
    parts = [p.strip() for p in s.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(
            "workbook_range 简写格式应为 sheetFrom:sheetTo,rowFrom:rowTo,colFrom:colTo，"
            "例如 1:1,0:29,0:15"
        )

    def _pair(label, text):
        if ":" not in text:
            raise argparse.ArgumentTypeError(f"workbook_range {label} 段应为 A:B 形式，收到 {text!r}")
        a, b = text.split(":", 1)
        try:
            return int(a.strip()), int(b.strip())
        except ValueError as e:
            raise argparse.ArgumentTypeError(f"workbook_range {label} 须为整数: {e}") from e

    sheet_from, sheet_to = _pair("sheet", parts[0])
    row_from, row_to = _pair("row", parts[1])
    col_from, col_to = _pair("col", parts[2])
    return {
        "sheetFrom": sheet_from,
        "sheetTo": sheet_to,
        "rowFrom": row_from,
        "rowTo": row_to,
        "colFrom": col_from,
        "colTo": col_to,
    }


def _parse_convert_options_cli(value):
    """额外 convert_options（JSON 对象），与 workbook_range 等合并。"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        obj = json.loads(s)
    except json.JSONDecodeError as e:
        raise argparse.ArgumentTypeError(f"convert_options JSON 无效: {e}") from e
    if not isinstance(obj, dict):
        raise argparse.ArgumentTypeError("convert_options 必须是 JSON 对象")
    return obj


def _build_convert_options(args, file_name: str | None = None):
    """合并 CLI 中的 workbook_range / convert_options，供 POST 或本地 exporter 使用。"""
    opts = {}
    wr = getattr(args, "workbook_range", None)
    if wr is not None:
        opts["workbook_range"] = wr
    elif _user_specified_workbook_range(args):
        pass
    elif file_name and _is_sheet_file(file_name):
        opts["workbook_range"] = _default_workbook_range()
    extra = getattr(args, "convert_options", None)
    if extra:
        opts.update(extra)
    if opts.get("enable_upload_medias") is None:
        opts["enable_upload_medias"] = True
    return opts


# 轻维表/轻表格/ET（含附录常见后缀）；未列出的 .log 多为文本日志，不自动塞 workbook_range
_SHEET_EXTS = {
    ".xlsx", ".xls", ".xlt", ".et", ".ett", ".ets", ".eto", ".xltx", ".csv",
    ".xlsm", ".xltm", ".xlsb", ".tpxls", ".uos", ".uos3", ".uost3",
    ".ksheet", ".dbt",
}


def _default_extract_mode(file_name: str) -> str:
    """云文档默认 async（POST 创建任务 + 轮询，完整透传 convert_options）。"""
    return "async"


def _cell_display_text(cell: dict) -> str:
    """从 kdc 单元格取可读文本，display_text 为空时回退 value/text/formula。"""
    if not isinstance(cell, dict):
        return ""
    for key in ("display_text", "text", "value"):
        val = cell.get(key)
        if val is not None and str(val).strip() != "":
            return str(val)
    formula = cell.get("formula")
    if formula is not None and str(formula).strip():
        return str(formula)
    for key in ("shared_string", "sharedString", "string"):
        val = cell.get(key)
        if val is not None and str(val).strip():
            return str(val)
    return ""


def _kdc_sheet_used_range_hint(sheet: dict) -> str:
    """从 sheet / sheetsInfo 条目中提取占用范围描述。"""
    if not isinstance(sheet, dict):
        return ""
    ur = sheet.get("used_range") or sheet.get("usedRange") or {}
    if isinstance(ur, dict):
        row = ur.get("row_spans") or ur.get("rowSpans") or {}
        col = ur.get("col_spans") or ur.get("colSpans") or {}
        if row or col:
            r_from = row.get("from", "?")
            r_to = row.get("to", "?")
            c_from = col.get("from", "?")
            c_to = col.get("to", "?")
            return f"rows {r_from}-{r_to}, cols {c_from}-{c_to}"
    for key in ("range", "used_range_str"):
        if sheet.get(key):
            return str(sheet[key])
    return ""


def _kdc_normalize_sheets(doc: dict) -> list:
    """合并 doc.sheets 与 doc.sheetsInfo，统一为 sheets 列表供解析。"""
    if not isinstance(doc, dict):
        return []
    sheets = list(doc.get("sheets") or [])
    sheets_info = doc.get("sheetsInfo") or doc.get("sheets_info") or []
    if not sheets_info:
        return sheets
    if not sheets:
        return list(sheets_info)
    by_name = {s.get("name"): s for s in sheets if isinstance(s, dict) and s.get("name")}
    merged = []
    for info in sheets_info:
        if not isinstance(info, dict):
            continue
        name = info.get("name")
        base = dict(by_name.get(name) or {})
        for key, val in info.items():
            if key not in base or base.get(key) in (None, [], {}):
                base[key] = val
        if "data" not in base and info.get("data"):
            base["data"] = info.get("data")
        merged.append(base)
    for s in sheets:
        if isinstance(s, dict) and s.get("name") not in {m.get("name") for m in merged}:
            merged.append(s)
    return merged or sheets


def _kdc_sheet_diagnostics(doc: dict) -> dict:
    """统计 KDC 表格导出是否稀疏，供 --json 的 extract_meta 使用。"""
    sheets = _kdc_normalize_sheets(doc if isinstance(doc, dict) else {})
    stats = []
    total_data_rows = 0
    total_cells = 0
    for sheet in sheets:
        data_rows = sheet.get("data") or []
        row_count = len(data_rows)
        cell_count = 0
        for row in data_rows:
            if isinstance(row, dict):
                cell_count += len(row.get("cells") or [])
        total_data_rows += row_count
        total_cells += cell_count
        stats.append({
            "name": sheet.get("name", ""),
            "data_rows": row_count,
            "cells": cell_count,
            "used_range": _kdc_sheet_used_range_hint(sheet),
        })
    hint = None
    if sheets and total_data_rows == 0:
        hint = (
            "KDC 有 sheet 元数据但 data 为空：.ksheet 单元格可能在基础存储附件，"
            "需 --component-file-id 且平台配置 weboffice aksk；或改用 airsheet/sheets range_data API"
        )
    elif sheets and total_data_rows <= 1 and any(s.get("used_range") for s in stats):
        hint = (
            "KDC 仅导出少量行：workbook_range 无法补全缺失单元格；"
            "建议试 --component-file-id、link_id 替代数值 file_id，或 airsheet API"
        )
    return {
        "sheet_count": len(sheets),
        "total_data_rows": total_data_rows,
        "total_cells": total_cells,
        "sheets": stats,
        "has_sheets_info": bool(doc.get("sheetsInfo") or doc.get("sheets_info")) if isinstance(doc, dict) else False,
        "hint": hint,
    }




def _is_sheet_file(file_name: str) -> bool:
    ext = os.path.splitext(file_name or "")[-1].lower()
    return ext in _SHEET_EXTS


def _user_specified_workbook_range(args) -> bool:
    if getattr(args, "workbook_range", None) is not None:
        return True
    extra = getattr(args, "convert_options", None) or {}
    return "workbook_range" in extra


def _extract_sheets_info_from_response_data(data: dict) -> list:
    """从 content 轮询结果的 data 中读取 sheetsInfo（file_info 或 doc 内）。"""
    if not isinstance(data, dict):
        return []
    file_info = data.get("file_info") or {}
    info = file_info.get("sheetsInfo") or file_info.get("sheets_info") or []
    if info:
        return [i for i in info if isinstance(i, dict)]
    kdc = data.get("kdc") if isinstance(data.get("kdc"), dict) else data
    doc = (kdc.get("doc") if isinstance(kdc, dict) else {}) or {}
    info = doc.get("sheetsInfo") or doc.get("sheets_info") or []
    return [i for i in info if isinstance(i, dict)]


def _workbook_range_from_sheets_info(sheets_info: list) -> dict | None:
    """根据 sheetsInfo 生成 workbook_range（ksheet 常用 sheetIdx 0-based）。"""
    if not sheets_info:
        return None
    sheet_indices = []
    row_from, row_to = None, None
    col_from, col_to = None, None
    for info in sheets_info:
        if not isinstance(info, dict):
            continue
        idx = info.get("sheetIdx")
        if idx is None:
            idx = info.get("sheetFrom", 0)
        sheet_indices.append(int(idx))
        rf, rt = info.get("rowFrom"), info.get("rowTo")
        cf, ct = info.get("colFrom"), info.get("colTo")
        if rf is not None and rt is not None:
            row_from = rf if row_from is None else min(row_from, rf)
            row_to = rt if row_to is None else max(row_to, rt)
        if cf is not None and ct is not None:
            col_from = cf if col_from is None else min(col_from, cf)
            col_to = ct if col_to is None else max(col_to, ct)
    if row_from is None or row_to is None or col_from is None or col_to is None:
        return None
    return {
        "sheetFrom": min(sheet_indices),
        "sheetTo": max(sheet_indices),
        "rowFrom": row_from,
        "rowTo": row_to,
        "colFrom": col_from,
        "colTo": col_to,
    }


def _kdc_response_doc_root(data: dict) -> dict:
    if not isinstance(data, dict):
        return {}
    kdc = data.get("kdc") if isinstance(data.get("kdc"), dict) else data
    if isinstance(kdc, dict) and isinstance(kdc.get("doc"), dict):
        return kdc["doc"]
    return kdc if isinstance(kdc, dict) else {}


def _find_sheet_for_info(sheets: list, info: dict, info_index: int) -> dict | None:
    """按 name 或顺序将 sheetsInfo 条目对应到 doc.sheets 项。"""
    if not sheets:
        return None
    name = info.get("name")
    if name:
        for sheet in sheets:
            if isinstance(sheet, dict) and sheet.get("name") == name:
                return sheet
    if len(sheets) == 1:
        return sheets[0]
    sheet_idx = info.get("sheetIdx")
    if sheet_idx is None:
        sheet_idx = info.get("sheetFrom", info_index)
    try:
        idx = int(sheet_idx)
    except (TypeError, ValueError):
        idx = info_index
    if 0 <= idx < len(sheets) and isinstance(sheets[idx], dict):
        return sheets[idx]
    return sheets[info_index] if info_index < len(sheets) else None


def _sheet_data_row_col_counts(sheet: dict) -> tuple[int, int]:
    """统计 sheet.data 的行数与最大列索引（0-based index + 1）。"""
    rows = sheet.get("data") or [] if isinstance(sheet, dict) else []
    max_col = -1
    for row in rows:
        if not isinstance(row, dict):
            continue
        for cell in row.get("cells") or []:
            if isinstance(cell, dict):
                max_col = max(max_col, int(cell.get("index", 0)))
    row_count = len(rows)
    col_count = max_col + 1 if max_col >= 0 else 0
    return row_count, col_count


def _sheet_extract_covers_workbook_range(data: dict, sheets_info: list) -> bool:
    """探测结果是否已覆盖 sheetsInfo 声明的全表范围（行/列均达标则视为完整）。"""
    if not sheets_info:
        return True
    doc = _kdc_response_doc_root(data)
    sheets = _kdc_normalize_sheets(doc if isinstance(doc, dict) else {})
    for idx, info in enumerate(sheets_info):
        if not isinstance(info, dict):
            continue
        rf, rt = info.get("rowFrom"), info.get("rowTo")
        cf, ct = info.get("colFrom"), info.get("colTo")
        if rf is None or rt is None:
            continue
        expected_rows = int(rt) - int(rf) + 1
        expected_cols = None
        if cf is not None and ct is not None:
            expected_cols = int(ct) - int(cf) + 1
        sheet = _find_sheet_for_info(sheets, info, idx)
        if not sheet:
            return False
        actual_rows, actual_cols = _sheet_data_row_col_counts(sheet)
        if actual_rows < expected_rows:
            return False
        if expected_cols is not None and actual_cols < expected_cols:
            return False
    return True


def _should_retry_sheet_extract_with_workbook_range(data: dict, sheets_info: list) -> bool:
    """探测结果未覆盖 sheetsInfo 全表范围时，才用 workbook_range 再抽一次。"""
    if not sheets_info:
        return False
    if _sheet_extract_covers_workbook_range(data, sheets_info):
        return False
    return _workbook_range_from_sheets_info(sheets_info) is not None


def _extract_cloud_file_content(
    *,
    drive_id,
    file_id,
    fmt,
    include_elements,
    convert_options,
    extract_mode,
    component_file_id,
    extract_query,
):
    resp = extract_file_content(
        drive_id=drive_id,
        file_id=file_id,
        format=fmt,
        include_elements=include_elements,
        convert_options=convert_options,
        extract_mode=extract_mode,
        component_file_id=component_file_id,
        **extract_query,
    )
    return _check_resp(resp)


def _extract_cloud_with_auto_workbook_range(
    *,
    drive_id,
    file_id,
    file_name,
    fmt,
    include_elements,
    convert_options,
    extract_mode,
    component_file_id,
    extract_query,
    args,
):
    """云文档内容抽取；表格类未指定 workbook_range 时 convert_options 已含默认全表范围。"""
    data = _extract_cloud_file_content(
        drive_id=drive_id,
        file_id=file_id,
        fmt=fmt,
        include_elements=include_elements,
        convert_options=convert_options,
        extract_mode=extract_mode,
        component_file_id=component_file_id,
        extract_query=extract_query,
    )
    applied_wr = None
    if _is_sheet_file(file_name) and not _user_specified_workbook_range(args):
        applied_wr = (convert_options or {}).get("workbook_range")
    return data, applied_wr

def _check_resp(resp):
    if resp.get("code") == -2:
        _err(f"[私网不可用] {resp.get('msg')}（此接口仅公网支持，请切换到公网或使用替代方案，不要重试）")
    if resp.get("code") != 0:
        _err(_resp_error(resp))
    d = resp.get("data")
    return d if d is not None else {}


def _mutation_gate(action_title, detail_lines, confirmed):
    _set_marker(
        DRY_RUN=not confirmed,
        CONFIRM_REQUIRED=True,
        ASK_USER_REQUIRED=not confirmed,
    )
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


def _get_drive_id(drive_name):
    """将drive名称转换为实际的drive ID"""
    if drive_name in ["private", "roaming", "special"]:
        # 获取实际的drive ID
        c = WpsV7Client()
        resp = c.get("/v7/drives", params={"allotee_type": "user", "page_size": 10})
        if resp.get("code") != 0:
            _err(f"获取云盘列表失败: {_resp_error(resp)}")
        
        items = resp.get("data", {}).get("items", [])
        for item in items:
            if item.get("source") == drive_name:
                return item.get("id")
        
        # 如果没有找到，返回第一个drive
        if items:
            return items[0].get("id")
        
        _err(f"未找到云盘: {drive_name}")
    else:
        # 已经是实际的drive ID
        return drive_name


def _get_file_type(drive_id, file_id):
    """根据文件名扩展判断类型（用于 extract/read/write 展示）。优先用 get_file_directly。"""
    resp = get_file_directly(file_id)
    if resp.get("code") != 0 or not resp.get("data"):
        resp = get_file(drive_id=drive_id, file_id=file_id)
    data = _check_resp(resp)
    name = (data.get("name") or "").lower()
    if name.endswith(".otl"):
        return "ap"
    if name.endswith(".dbt"):
        return "dbsheet"
    if name.endswith((".docx", ".doc", ".wps")):
        return "doc"
    if name.endswith(".pdf"):
        return "pdf"
    if name.endswith((".pptx", ".ppt", ".wpp")):
        return "ppt"
    if name.endswith((".xlsx", ".xls", ".et")):
        return "sheet"
    return "unknown"


def _read_local_file(file_path):
    """读取本地文件内容（用于 write --file）。"""
    p = Path(file_path)
    if not p.exists():
        _err(f"文件不存在: {file_path}")
    return p.read_text(encoding="utf-8")


def _validate_markdown_input_args(content, file_path):
    """write 命令要求在 --content 与 --file 中二选一，避免输入来源歧义。"""
    if content and file_path:
        _err("`write` 不能同时传 --content 和 --file，请二选一")
    if not content and not file_path:
        _err("请通过 --content 或 --file 指定要写入的内容")


def _resolve_file_and_drive(id_or_link_id, default_drive="private"):
    """
    将 file_id 或 link_id 解析为 (file_id, drive_id)。
    若传入的是 link_id，则调用 GET /v7/links/{link_id}/meta 取 file_id/drive_id；否则视为 file_id，drive 用默认值。
    """
    raw = _extract_link_id(id_or_link_id)
    if not raw:
        return None, None
    resp = get_link_meta(link_id=raw)
    if resp.get("code") == 0 and resp.get("data"):
        data = resp["data"]
        if data.get("file_id"):
            did = data.get("drive_id")
            if did is None or did == "":
                did = _get_drive_id(default_drive)
            else:
                did = str(did)
            return data["file_id"], did
    # 视为 file_id
    return raw, _get_drive_id(default_drive)


def _is_single_md_file(file_path):
    """判断是否为单个 .md 文件（不区分大小写）。"""
    p = Path(file_path)
    return p.is_file() and p.suffix.lower() == ".md"


def _parent_path_list(s):
    """将 'folder1/folder2' 转为 ['folder1', 'folder2']。空字符串返回 None（使用根目录）。"""
    if not (s or "").strip():
        return None
    parts = [p.strip() for p in s.strip().split("/") if p.strip()]
    return parts or None


def _build_file_versions_continue_cmd(file_id, next_token, args, with_comment):
    """构造 file-versions 下一页续跑命令。"""
    parts = [
        "python skills/drive/run.py file-versions",
        str(file_id),
        "--page-token",
        str(next_token),
    ]
    drive = getattr(args, "drive", None)
    if drive:
        parts.extend(["--drive", str(drive)])
    parts.append("--with-comment" if with_comment else "--without-comment")
    if getattr(args, "with_ext_attrs", None):
        parts.append("--with-ext-attrs")
    return " ".join(parts)


def _parse_version_number(raw):
    """将版本号解析为 int；空值返回 None。"""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if not s.isdigit():
        _err(f"版本号必须是正整数，当前收到: {raw}")
    return int(s)


def _normalize_version_pair(version_a, version_b):
    """返回 (old_version, new_version)，其中更大的版本号视为新版本。"""
    va = _parse_version_number(version_a)
    vb = _parse_version_number(version_b)
    if va is None or vb is None:
        return None, None
    if va == vb:
        _err("两个版本号不能相同，请提供两个不同的版本号")
    return (va, vb) if va < vb else (vb, va)


def _ask_for_versions(file_id, drive):
    _set_marker(ASK_USER_REQUIRED=True)
    md = [
        "## 需要用户提供版本号",
        "",
        f"请先通过 `askUserQuestion` 让用户提供要比较的两个版本号，再重新执行版本比较。",
        "",
        f"- **文件**: `{file_id}`",
        f"- **云盘**: `{drive}`",
        "- **规则**: 版本号更大的那个视为新版本",
        "",
        "可让用户直接回复两个版本号，例如：`12 和 18`。",
        "",
        f"重新执行示例：`python skills/drive/run.py file-version-diff {file_id} 12 18 --drive {drive}`",
    ]
    _out(md, {"success": False, "ask_user_required": True, "file_id": file_id, "drive_id": drive})


def _extract_content_from_local_file(file_path):
    """提取本地文件为 Markdown 文本，优先取结构化 content。"""
    file_name = os.path.basename(file_path)
    ext = os.path.splitext(file_name)[-1].lower()
    no_ie_exts = {".pdf", ".ofd"}
    include_elements = None if ext in no_ie_exts else "all"
    fmt = _pick_extract_format(file_name)

    kwargs = dict(format=fmt, file_path=file_path, filename=file_name)
    if include_elements is not None:
        kwargs["include_elements"] = include_elements
    resp = export_file_content_async(**kwargs)
    data = _check_resp(resp)

    if fmt == "kdc":
        kdc_content = data.get("kdc") if isinstance(data.get("kdc"), (dict, list)) else data
        content_md = _kdc_to_markdown(kdc_content)
    else:
        content_md = (data.get(fmt) or "").strip()
    return _strip_base64_images(content_md or "")


def _write_diff_input(path, content):
    Path(path).write_text((content or "").strip() + "\n", encoding="utf-8")


def _run_unified_diff(old_path, new_path):
    """使用系统 diff 生成统一 diff；有差异时 diff 返回码通常为 1。"""
    proc = subprocess.run(
        ["diff", "-u", old_path, new_path],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode not in (0, 1):
        raise ValueError(proc.stderr.strip() or "diff 执行失败")
    return proc.stdout or ""


def _summarize_diff_text(diff_text, limit=8):
    """从 unified diff 中提炼简要变更摘要。"""
    added = []
    removed = []
    for line in diff_text.splitlines():
        if line.startswith(("+++", "---", "@@")):
            continue
        if line.startswith("+"):
            text = line[1:].strip()
            if text:
                added.append(text)
        elif line.startswith("-"):
            text = line[1:].strip()
            if text:
                removed.append(text)

    def _dedupe(items):
        out = []
        seen = set()
        for item in items:
            if item in seen:
                continue
            seen.add(item)
            out.append(item)
        return out

    added = _dedupe(added)
    removed = _dedupe(removed)
    lines = [
        f"- **新增行数**: {len(added)}",
        f"- **删除/调整行数**: {len(removed)}",
    ]
    if not added and not removed:
        lines.append("- 未检测到正文差异。")
        return lines
    if added:
        lines.append("- **新增要点**:")
        for item in added[:limit]:
            lines.append(f"  - {item}")
    if removed:
        lines.append("- **删除/调整要点**:")
        for item in removed[:limit]:
            lines.append(f"  - {item}")
    return lines


def _fmt_file_version_item(item, index):
    """格式化单条版本记录为 Markdown 行列表。"""
    version_id = item.get("version", "-")
    history_id = item.get("id", "-")
    size = item.get("size", "-")
    mtime = item.get("mtime", "-")
    modifier = (item.get("modified_by") or {}).get("name") or "-"
    lines = [
        f"{index}. **版本记录**",
        f"   > version_id: `{version_id}`",
        f"   > history_id: `{history_id}` | size: `{size}` | mtime: `{mtime}`",
        f"   > modified_by: {modifier}",
    ]
    comment = item.get("comment")
    if comment:
        lines.append(f"   > 备注: {comment}")
    ext_attrs = item.get("ext_attrs")
    if ext_attrs:
        lines.append(f"   > ext_attrs: `{json.dumps(ext_attrs, ensure_ascii=False)}`")
    return lines


def _upload_md_as_airpage(file_path, args):
    """将 .md 文件上传为智能文档（.otl）：创建文档并写入内容（365 内容 API）。"""
    p = Path(file_path)
    content = p.read_text(encoding="utf-8", errors="replace")
    title = (getattr(args, "filename", None) or "").strip() or (p.stem or "文档")
    drive_id = _get_drive_id(args.drive or "private")
    parent_path = _parent_path_list(args.path)

    create_resp = create_otl_document(
        drive_id=drive_id,
        file_name=title,
        parent_path=parent_path,
        on_name_conflict="rename",
    )
    data = _check_resp(create_resp)
    file_id = (data or {}).get("id")
    if not file_id:
        _err("创建智能文档失败：未返回文件 id")

    write_resp = write_airpage_content(file_id, title, content, pos="begin")
    if not _airpage_write_success(write_resp):
        _err(_airpage_write_error(write_resp))
    link_url = (data or {}).get("link_url") or ""
    link_id = (data or {}).get("link_id") or ""

    md = [
        "## 已上传为智能文档",
        "",
        f"已将 Markdown 写入智能文档 **{title}**。",
        "",
        f"- **文件 ID**：`{file_id}`",
        f"- **链接**：{link_url}",
    ]
    if link_id:
        md.append("")
        md.append("发送云文档消息所需信息：")
        md.append("```json")
        md.append(f'{{"type": "cloud", "cloud": {{"id": "{link_id}", "link_url": "{link_url}", "link_id": "{link_id}"}}}}')
        md.append("```")
    _out(md, {"success": True, "file_id": file_id, "title": title, "link_url": link_url, "link_id": link_id})


def cmd_upload(args):
    if not args.file_path:
        _err("请指定文件路径，例如: run.py upload /path/to/file.md")
    
    file_path = args.file_path
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)
    
    if not os.path.exists(file_path):
        _err(f"文件不存在: {file_path}")
    
    drive_label = args.drive or "private"
    parent_id = args.parent or "root"
    detail_lines = [
        f"- **本地路径**：`{file_path}`",
        f"- **云盘**：{drive_label}",
        f"- **父目录 ID**：`{parent_id}`",
    ]
    if args.path:
        detail_lines.append(f"- **目标路径**：{args.path}")
    is_dry_run, gate_md = _mutation_gate("上传文件（预览）", detail_lines, getattr(args, "confirm", False))
    if is_dry_run:
        _out(gate_md, None)
        return

    # 单文件为 .md 时，上传为智能文档（.otl）
    if _is_single_md_file(file_path):
        _upload_md_as_airpage(file_path, args)
        return
    
    try:
        # 获取实际的drive ID
        drive_id = _get_drive_id(args.drive or "private")
        
        resp = upload_simple(
            file_path=file_path,
            drive_id=drive_id,
            parent_id=args.parent or "root",
            parent_path=[p for p in args.path.split("/") if p] if args.path else None,
            file_name=getattr(args, "filename", None),
        )
    except Exception as e:
        _err(f"上传失败: {str(e)}")

    file_data = _check_resp(resp)
    if isinstance(file_data, dict) and "file" in file_data:
        file_info = file_data.get("file", {})
    else:
        file_info = file_data if isinstance(file_data, dict) else {}
    
    md = ["## 文件上传成功", "", f"文件已上传至云端：", "",
          f"- **文件名**: {file_info.get('name', '-')}",
          f"- **文件ID**: `{file_info.get('id', '-')}`",
          f"- **链接**: {file_info.get('link_url', '-')}",
          f"- **大小**: {file_info.get('size', '-')} 字节",
          "",
          f"发送云文档消息所需信息：",
          f"```json",
          f'{{"type": "cloud", "cloud": {{"id": "{file_info.get("link_id", file_info.get("id", ""))}", "link_url": "{file_info.get("link_url", "")}", "link_id": "{file_info.get("link_id", "")}"}}}}',
          f"```"]
    _out(md, resp)


_UPDATE_DANGEROUS_TARGETS = {".otl", ".dbt"}
_UPDATE_DANGEROUS_SOURCES = {".md", ".txt", ".markdown", ".mdown"}


def cmd_update(args):
    """更新现有云文档文件（上传新版本覆盖）"""
    if not args.file_path:
        _err("请指定文件路径，例如: run.py update <file_id> /path/to/file.docx")
    
    file_path = args.file_path
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)
    
    if not os.path.exists(file_path):
        _err(f"文件不存在: {file_path}")
    
    # 解析 file_id（支持 link_id）
    file_id, drive_id = _resolve_file_and_drive(args.file_id, args.drive or "private")
    if not file_id:
        _err("无法解析 file_id")

    local_ext = os.path.splitext(file_path)[-1].lower()
    if local_ext in _UPDATE_DANGEROUS_SOURCES:
        try:
            meta_resp = get_file(drive_id=drive_id, file_id=file_id)
            target_name = (meta_resp.get("data") or {}).get("name", "")
            target_ext = os.path.splitext(target_name)[-1].lower()
        except Exception:
            target_ext = ""
        if target_ext in _UPDATE_DANGEROUS_TARGETS:
            _err(
                f"目标云文档是 `{target_ext}` 格式（智能文档），不能用 `update` 以二进制方式覆盖，否则会导致文档损坏无法打开。\n\n"
                f"  请改用 `write` 命令将 Markdown 内容写入智能文档：\n"
                f"  python skills/drive/run.py write {file_id} --file {file_path}"
            )

    is_dry_run, gate_md = _mutation_gate(
        "更新文件（预览）",
        [
            f"- **file_id**：`{file_id}`",
            f"- **本地路径**：`{file_path}`",
        ],
        getattr(args, "confirm", False),
    )
    if is_dry_run:
        _out(gate_md, None)
        return

    try:
        resp = update_file(
            file_id=file_id,
            file_path=file_path,
            drive_id=drive_id,
        )
    except Exception as e:
        _err(f"更新失败: {str(e)}")

    file_info = _check_resp(resp)
    if not isinstance(file_info, dict):
        file_info = {}
    
    md = [
        "## 文件更新成功", 
        "", 
        f"文件已更新为新版本：", 
        "",
        f"- **文件名**: {file_info.get('name', '-')}",
        f"- **文件ID**: `{file_info.get('id', '-')}`",
        f"- **版本**: {file_info.get('version', '-')}",
        f"- **链接**: {file_info.get('link_url', '-')}",
        f"- **大小**: {file_info.get('size', '-')} 字节",
        f"- **修改时间**: {file_info.get('mtime', '-')}",
    ]
    _out(md, resp)


def cmd_write(args):
    """将 Markdown 内容写入文档：智能文档用 insertContent，文字/PDF 用转换+覆盖（复用 update_file）。"""
    file_id, drive_id = _resolve_file_and_drive(
        args.file_id, getattr(args, "drive", None) or "private"
    )
    if not file_id:
        _err("无法解析 file_id")

    content = getattr(args, "content", None)
    _validate_markdown_input_args(content, getattr(args, "file", None))
    if getattr(args, "file", None):
        content = _read_local_file(args.file)

    file_resp = get_file_directly(file_id, with_drive=True)
    if file_resp.get("code") == 0 and file_resp.get("data"):
        file_data = file_resp.get("data", {})
        drive_id = file_data.get("drive_id") or drive_id
    else:
        file_resp = get_file(drive_id=drive_id, file_id=file_id)
        file_data = file_resp.get("data") or {}
    file_name = file_data.get("name", "-")
    file_type = _get_file_type(drive_id, file_id)

    mode = getattr(args, "mode", "overwrite") or "overwrite"
    mode_label = "覆盖（overwrite）" if mode == "overwrite" else "追加（append）"
    stop, gate_md = _mutation_gate(
        "Markdown 写入（预览）",
        [
            f"- **文件 ID**：`{file_id}`",
            f"- **模式**：{mode_label}",
            f"- **内容长度**：{len(content)} 字符",
        ],
        getattr(args, "confirm", False),
    )
    if stop:
        _out(gate_md, None)
        return

    if file_type in ("ap", "unknown"):
        pos = "end" if getattr(args, "mode", "overwrite") == "append" else "begin"
        title = getattr(args, "title", None) or file_name.replace(".otl", "")
        resp = write_airpage_content(
            file_id=file_id,
            title=title,
            content=content,
            pos=pos,
        )
        success = _airpage_write_success(resp)
        if getattr(args, "json", False):
            out = {"success": success, "file_id": file_id, "file_name": file_name, "pos": pos, "content_length": len(content)}
            if not success:
                out["message"] = _airpage_write_error(resp)
            print(json.dumps(out, ensure_ascii=False, indent=2))
            sys.stdout.flush()
            if not success:
                sys.exit(1)
            return
        if not success:
            _err(_airpage_write_error(resp))
        md = [
            "## Markdown 写入（智能文档）",
            "",
            f"- **文件名**: {file_name}",
            f"- **文件ID**: `{file_id}`",
            f"- **写入位置**: {pos}",
            f"- **内容长度**: {len(content)} 字符",
            f"- **状态**: 成功",
        ]
        _out(md, resp)

    elif file_type in ("doc", "pdf"):
        target_format = "pdf" if file_type == "pdf" else "docx"
        temp_md_file = None
        temp_target_file = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False, encoding="utf-8") as f:
                f.write(content)
                temp_md_file = f.name
            convert_resp = convert_file(
                source_file_path=temp_md_file,
                target_format=target_format,
                template_file_path=getattr(args, "template", None) if target_format == "docx" else None,
            )
            if convert_resp.get("code") != 0:
                _err(f"Markdown 转换失败: {_resp_error(convert_resp)}")
            target_content = convert_resp.get("data")
            if not target_content:
                _err("转换结果为空")
            with tempfile.NamedTemporaryFile(mode="wb", suffix=f".{target_format}", delete=False) as f:
                f.write(target_content)
                temp_target_file = f.name
            update_resp = update_file(
                file_id=file_id,
                file_path=temp_target_file,
                drive_id=drive_id,
            )
            update_data = update_resp.get("data") or {}
            success = update_resp.get("code") == 0
            type_name = "PDF文档" if file_type == "pdf" else "文字文档"
            if getattr(args, "json", False):
                out = {"success": success, "file_id": file_id, "file_name": file_name, "version": update_data.get("version"), "content_length": len(content)}
                if not success:
                    out["message"] = _resp_error(update_resp)
                print(json.dumps(out, ensure_ascii=False, indent=2))
                sys.stdout.flush()
                return
            md = [
                f"## Markdown 写入（{type_name}）",
                "",
                f"- **文件名**: {file_name}",
                f"- **文件ID**: `{file_id}`",
                f"- **转换大小**: {len(target_content)} 字节",
                f"- **新版本**: {update_data.get('version', '-')}",
                f"- **内容长度**: {len(content)} 字符",
                f"- **状态**: {'成功' if success else '失败'}",
            ]
            if not success:
                md.append("")
                md.append(f"错误信息: {_resp_error(update_resp)}")
            _out(md, update_resp)
        finally:
            if temp_md_file and os.path.exists(temp_md_file):
                os.unlink(temp_md_file)
            if temp_target_file and os.path.exists(temp_target_file):
                os.unlink(temp_target_file)
    else:
        _err(f"不支持的文件类型: {file_type}（当前仅支持智能文档 .otl、文字文档 .docx 和 PDF文档 .pdf）")


def cmd_list(args):
    # 获取实际的drive ID
    drive_id = _get_drive_id(args.drive or "private")

    all_items = []
    page_token = (getattr(args, "page_token", None) or "").strip() or None
    last_data = {}

    while True:
        resp = list_files(
            drive_id=drive_id,
            parent_id=args.parent or "root",
            page_size=args.page_size or 50,
            page_token=page_token,
        )
        data = _check_resp(resp)
        last_data = data or {}

        items = (data or {}).get("items") or []
        all_items.extend(items)

        next_token = (data or {}).get("next_page_token") or ""
        if not getattr(args, "all", False) or not next_token:
            page_token = next_token or ""
            break
        page_token = next_token

    md = ["## 文件列表", "", f"当前目录共有 **{len(all_items)}** 个文件/文件夹。"]
    if not all_items:
        md.append("")
        md.append("目录为空。")
    else:
        md.append("")
        for i, item in enumerate(all_items, 1):
            item_type = "文件夹" if item.get("type") == "folder" else "文件"
            name = item.get("name", "-")
            file_id = item.get("id", "-")
            size = item.get("size", "-")
            md.append(f"{i}. {item_type} **{name}**")
            md.append(f"   > ID: `{file_id}` | 大小: {size} 字节")

    if (last_data or {}).get("next_page_token") and not getattr(args, "all", False):
        md.append("")
        md.append(f"> 还有更多条目，可使用 `list --page-token {last_data.get('next_page_token')}` 获取下一页，或使用 `list --all` 拉取全部。")

    out_data = dict(last_data or {})
    out_data["items"] = all_items
    _out(md, out_data)


def cmd_get(args):
    if not args.file_id:
        _err("请指定文件ID或 link_id，例如: run.py get <file_id|link_id>")
    file_id, drive_id = _resolve_file_and_drive(args.file_id, args.drive or "private")
    if not file_id:
        _err("无法解析 file_id")
    resp = get_file_directly(file_id, with_link=True, with_drive=True)
    if resp.get("code") != 0 or not resp.get("data"):
        resp = get_file(drive_id=drive_id, file_id=file_id)
    data = _check_resp(resp)
    md = ["## 文件详情", "",
          f"- **文件名**: {data.get('name', '-')}",
          f"- **文件ID**: `{data.get('id', '-')}`",
          f"- **链接**: {data.get('link_url', '-')}",
          f"- **大小**: {data.get('size', '-')} 字节",
          f"- **类型**: {data.get('type', '-')}"]
    _out(md, data)


def cmd_download(args):
    if not args.file_id:
        _err("请指定文件ID或 link_id，例如: run.py download <file_id|link_id>")
    file_id, drive_id = _resolve_file_and_drive(args.file_id, args.drive or "private")
    if not file_id:
        _err("无法解析 file_id")
    meta = get_file_directly(file_id, with_drive=True)
    meta_data = meta.get("data") or {}
    if meta.get("code") == 0 and meta_data:
        drive_id = meta_data.get("drive_id") or drive_id

    workspace_dir = os.path.abspath(os.getcwd())
    downloads_dir = os.path.abspath(os.path.expanduser("~/Downloads"))
    output_dir = getattr(args, "dir", None)
    if not output_dir:
        _set_marker(ASK_USER_REQUIRED=True)
        _err(
            "未指定下载目录。请先通过 `askUserQuestion` 让用户选择保存目录："
            f"工作空间目录（`{workspace_dir}`）、"
            f"系统下载目录（`{downloads_dir}`），"
            "或用户自定义目录；"
            "确认后再使用 `download --dir <绝对目录>` 执行下载。"
        )
    os.makedirs(output_dir, exist_ok=True)
    resp = download_file_to_local(
        drive_id=drive_id,
        file_id=file_id,
        output_dir=output_dir,
        file_name=meta_data.get("name"),
    )
    data = _check_resp(resp)
    md = ["## 文件已下载", "",
          f"- **文件名**: {data.get('name', '-')}",
          f"- **保存路径**: `{data.get('path', '-')}`",
          f"- **大小**: {data.get('size', 0)} 字节"]
    _out(md, data)


_KS3_INTERNAL_SUFFIX = "-internal.ksyun.com"
_KS3_EXTERNAL_SUFFIX = ".ksyuncs.com"


def _normalise_ks3_url(url: str) -> str:
    """KS3 URL 规范化：公网转外网域名；私网沙箱保留 internal 短域名。"""
    if not url or _KS3_INTERNAL_SUFFIX not in url:
        return url
    if os.environ.get("PRIVATE"):
        return url
    return url.replace(_KS3_INTERNAL_SUFFIX, _KS3_EXTERNAL_SUFFIX)


def _kdc_extract_medias(kdc) -> list:
    """从 kdc 提取 doc.medias，返回含 id/url/mime_type 的列表（过滤无 url 和无 data 的条目）。"""
    if not isinstance(kdc, dict):
        return []
    doc = kdc.get("doc")
    if not isinstance(doc, dict):
        return []
    medias = doc.get("medias")
    if not medias or not isinstance(medias, list):
        return []
    result = []
    for m in medias:
        url = (m.get("url") or "").strip()
        data = (m.get("data") or "").strip()
        if not url and not data:
            continue
        entry = {"id": m.get("id", ""), "mime_type": m.get("mime_type", "")}
        if url:
            entry["url"] = _normalise_ks3_url(url)
        if data:
            entry["data_length"] = len(data)
        result.append(entry)
    return result


def _kdc_inline_comments(kdc):
    """
    从 kdc 根对象读取 doc.comments：正文划选/锚定批注（截图侧栏「评论」），
    与协作区「留言」comment-list API 不是同一套数据。
    仅当服务端在 doc 下导出 `comments` 键时才有值。
    """
    if not isinstance(kdc, dict):
        return None
    doc = kdc.get("doc")
    if not isinstance(doc, dict) or "comments" not in doc:
        return None
    c = doc.get("comments")
    return c if isinstance(c, list) else None


def _kdc_to_markdown(kdc: dict) -> str:
    """将 kdc 结构化内容转为可读的 Markdown。
    支持 sheets（表格文档）和文档型（body.blocks / tree 等，统一 block walker）。
    """
    if not isinstance(kdc, dict):
        return ""
    doc = kdc.get("doc") or {}

    sheets = _kdc_normalize_sheets(doc)
    if sheets:
        return _sheets_to_markdown(sheets)

    slides_text = _kdc_ppt_slides_text(doc)
    if slides_text:
        md = _slides_text_to_markdown(slides_text)
        if md:
            return md

    blocks = _collect_doc_blocks(doc)
    return _blocks_to_markdown(blocks) if blocks else ""


def _sheets_to_markdown(sheets: list) -> str:
    """将 kdc sheets（表格文档）转为 Markdown 表格。"""
    parts = []
    for sheet in sheets:
        name = sheet.get("name", "")
        rows = sheet.get("data") or []
        if not rows:
            continue
        max_col = 0
        parsed_rows = []
        for row in rows:
            cells = row.get("cells") or []
            if not cells:
                continue
            row_dict = {}
            for cell in cells:
                col_idx = cell.get("index", 0)
                row_dict[col_idx] = _cell_display_text(cell)
                if col_idx > max_col:
                    max_col = col_idx
            parsed_rows.append(row_dict)
        if not parsed_rows:
            continue
        col_count = max_col + 1
        header = parsed_rows[0] if parsed_rows else {}
        header_cells = [header.get(i, "") for i in range(col_count)]
        lines = []
        if len(sheets) > 1 or name:
            lines.append(f"### {name}")
            lines.append("")
        lines.append("| " + " | ".join(header_cells) + " |")
        lines.append("| " + " | ".join(["---"] * col_count) + " |")
        for row_dict in parsed_rows[1:]:
            row_cells = [row_dict.get(i, "") for i in range(col_count)]
            lines.append("| " + " | ".join(row_cells) + " |")
        parts.append("\n".join(lines))
    return "\n\n".join(parts) if parts else ""


def _collect_doc_blocks(doc: dict) -> list:
    """从 doc 中提取统一的 block 列表，兼容 tree（.otl）和 body（.docx）结构。"""
    tree = doc.get("tree") or {}
    tree_children = tree.get("children") or []
    if tree_children:
        return tree_children

    body = doc.get("body") or {}
    body_blocks = body.get("blocks") or []
    if body_blocks:
        return [{"blocks": body_blocks}]

    return []


def _para_to_text(block: dict) -> str:
    """从单个段落 block 提取文本，兼容 otl (para.runs) 和 docx (paragraph.elements) 两种命名。"""
    para = block.get("para") or {}
    runs = para.get("runs") or []
    if runs:
        return "".join(r.get("text", "") for r in runs).strip()

    paragraph = block.get("paragraph") or {}
    elements = paragraph.get("elements") or []
    if elements:
        return "".join(e.get("text_run", {}).get("text", "") for e in elements).strip()

    return ""


def _table_to_markdown(table_block: dict) -> str:
    """将文档 table block 转为 Markdown 表格。"""
    table = table_block.get("table") or {}
    rows_data = table.get("rows") or []
    if not rows_data:
        return ""
    parsed = []
    max_col = 0
    for row in rows_data:
        cells = row.get("cells") or []
        row_texts = []
        for cell in cells:
            cell_blocks = cell.get("blocks") or []
            cell_parts = [_para_to_text(b) for b in cell_blocks if b.get("type") in ("para", "paragraph")]
            cell_text = " ".join(t for t in cell_parts if t).replace("|", "\\|")
            row_texts.append(cell_text)
        if len(row_texts) > max_col:
            max_col = len(row_texts)
        parsed.append(row_texts)
    if not parsed or max_col == 0:
        return ""
    lines = []
    header = parsed[0] + [""] * (max_col - len(parsed[0]))
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---"] * max_col) + " |")
    for row_texts in parsed[1:]:
        row_texts += [""] * (max_col - len(row_texts))
        lines.append("| " + " | ".join(row_texts) + " |")
    return "\n".join(lines)


def _blocks_to_markdown(nodes: list) -> str:
    """递归遍历 block 节点列表，将段落和表格转为 Markdown。
    兼容 tree（otl）和 body.blocks（docx）两种结构。
    """
    parts = []
    for node in nodes:
        blocks = node.get("blocks") or []
        for b in blocks:
            btype = b.get("type")
            if btype in ("para", "paragraph"):
                text = _para_to_text(b)
                if text:
                    parts.append(text)
            elif btype == "table":
                md_table = _table_to_markdown(b)
                if md_table:
                    parts.append(md_table)
        sub_children = node.get("children") or []
        if sub_children:
            sub_md = _blocks_to_markdown(sub_children)
            if sub_md:
                parts.append(sub_md)
    return "\n\n".join(parts) if parts else ""


_PPT_SKIP_CONTAINERS = frozenset({
    "slide_masters", "slide_layouts", "notes_masters", "notes_slides",
})


def _ppt_block_texts(block: dict) -> list:
    """从 PPT KDC block（para/table）提取纯文本行。"""
    texts = []
    btype = block.get("type")
    if btype in ("para", "paragraph"):
        text = _para_to_text(block)
        if text:
            texts.append(text)
    elif btype == "table":
        table = block.get("table") or {}
        for row in table.get("rows") or []:
            for cell in row.get("cells") or []:
                for cell_block in cell.get("blocks") or []:
                    texts.extend(_ppt_block_texts(cell_block))
    return texts


def _ppt_shape_texts(shape: dict) -> list:
    """从 PPT shape_tree 节点递归提取文本（不含样式/坐标）。"""
    texts = []
    stype = shape.get("type")
    if stype == "textbox":
        for blk in (shape.get("textbox") or {}).get("blocks") or []:
            texts.extend(_ppt_block_texts(blk))
    elif stype == "table":
        texts.extend(_ppt_block_texts({"type": "table", "table": shape.get("table") or {}}))
    for sub in shape.get("shape_tree") or shape.get("children") or []:
        texts.extend(_ppt_shape_texts(sub))
    return texts


def _ppt_slide_texts(slide: dict) -> list:
    """单页幻灯片正文文本（不含母版/备注页）。"""
    simple = slide.get("text")
    if isinstance(simple, str) and simple.strip():
        return [simple.strip()]
    texts = []
    for shape in slide.get("shape_tree") or []:
        texts.extend(_ppt_shape_texts(shape))
    return texts


def _kdc_ppt_slides_text(doc: dict) -> list:
    """从 KDC doc 提取 PPT 各页文本，用于 Agent 输出（全量文字，无版式冗余）。"""
    if not isinstance(doc, dict):
        return []
    containers = doc.get("slide_containers") or []
    content_containers = [c for c in containers if c.get("category") == "slides"]
    if not content_containers:
        content_containers = [
            c for c in containers
            if c.get("category") not in _PPT_SKIP_CONTAINERS and c.get("slides")
        ]
    slides_out = []
    slide_index = 0
    for container in content_containers:
        for slide in container.get("slides") or []:
            texts = _ppt_slide_texts(slide)
            slides_out.append({
                "index": slide_index,
                "name": (slide.get("name") or "").strip(),
                "texts": texts,
            })
            slide_index += 1
    return slides_out


def _slides_text_to_markdown(slides: list) -> str:
    """将 PPT 页文本列表转为 Markdown。"""
    parts = []
    for slide in slides:
        texts = slide.get("texts") or []
        if not texts:
            continue
        idx = slide.get("index", 0)
        parts.append(f"## Slide {idx + 1}")
        name = (slide.get("name") or "").strip()
        if name:
            parts.append(f"*{name}*")
        parts.append("")
        parts.extend(texts)
        parts.append("")
    return "\n".join(parts).strip()


_MARKDOWN_EXTS = {
    ".otl",
    ".doc", ".docx", ".rtf", ".txt", ".xml", ".uof", ".dot", ".wps", ".wpt",
    ".dotx", ".docm", ".dotm", ".wpss", ".wpso", ".uot",
    ".pdf", ".ofd",
    ".otl",
}
_PLAIN_EXTS = {".pom", ".pof"}
_PPT_EXTS = {
    ".pptx", ".ppt", ".pot", ".potx", ".pps", ".ppsx",
    ".dps", ".dpt", ".pptm", ".potm", ".ppsm", ".uop",
}


def _is_ppt_file(file_name: str) -> bool:
    return os.path.splitext(file_name or "")[-1].lower() in _PPT_EXTS


def _resolve_include_raw(args, fmt, file_name: str) -> bool:
    """PPT 走 kdc + --json 时默认附带完整 raw（slide_containers 等），避免仅 content 文本摘要。"""
    if bool(getattr(args, "include_raw", False)):
        return True
    return (
        fmt == "kdc"
        and getattr(args, "json", False)
        and _is_ppt_file(file_name)
    )


import re as _re

_BASE64_IMG_RE = _re.compile(
    r"!\[([^\]]*)\]\(data:image/[^)]+\)",
)

_LONG_BASE64_RE = _re.compile(
    r'[A-Za-z0-9+/]{200,}={0,2}'
)


def _strip_base64_images(text: str) -> str:
    """剥离 Markdown 中的 base64 图片及残留超长 base64 串。"""
    text = _BASE64_IMG_RE.sub(r"![image](已省略：嵌入式 base64 图片)", text)
    text = _LONG_BASE64_RE.sub("(已省略：嵌入式 base64 数据)", text)
    return text


def _strip_base64_from_raw(raw: object) -> object:
    """清洗 raw_content 中可能含 base64 图片的文本字段（markdown / plain / html）。"""
    if not isinstance(raw, dict):
        return raw
    cleaned = dict(raw)
    for key in ("markdown", "plain", "html"):
        if key in cleaned and isinstance(cleaned[key], str):
            cleaned[key] = _strip_base64_images(cleaned[key])
    return cleaned


def _pick_extract_format(file_name: str) -> str:
    """根据文件扩展名选择最优抽取格式：markdown > kdc > plain。"""
    ext = os.path.splitext(file_name)[-1].lower() if file_name else ""
    if ext in _MARKDOWN_EXTS:
        return "markdown"
    if ext in _PLAIN_EXTS:
        return "plain"
    return "kdc"


def _kdc_agent_content(raw_content: object) -> object:
    """从 KDC 提取 Agent 需要的正文字集（全量业务单元格/幻灯片，去掉样式等冗余）。"""
    if not isinstance(raw_content, dict):
        return raw_content
    doc = _kdc_response_doc_root(raw_content)
    if not isinstance(doc, dict):
        return raw_content
    slim_doc = {}
    sheets = _kdc_normalize_sheets(doc)
    if sheets:
        slim_doc["sheets"] = sheets
    slides_text = _kdc_ppt_slides_text(doc)
    if slides_text:
        slim_doc["slides"] = slides_text
    for key in ("tree", "body", "comments"):
        val = doc.get(key)
        if val:
            slim_doc[key] = val
    if not slim_doc:
        return raw_content
    out = {"doc": slim_doc}
    file_info = raw_content.get("file_info")
    if isinstance(file_info, dict) and file_info:
        out["file_info"] = file_info
    return out


def _build_extract_meta(content_md, raw_content, fmt, auto_workbook_range=None, artifact_path=None) -> dict:
    """抽取结果元信息；成功路径 truncated 恒为 false（不截断业务数据）。"""
    if content_md:
        char_count = len(content_md)
    elif isinstance(raw_content, str):
        char_count = len(raw_content)
    elif isinstance(raw_content, dict):
        char_count = len(json.dumps(_kdc_agent_content(raw_content), ensure_ascii=False))
    else:
        char_count = 0

    meta = {
        "char_count": char_count,
        "truncated": False,
        "artifact_path": artifact_path,
    }

    if isinstance(raw_content, dict):
        doc = _kdc_response_doc_root(raw_content)
        diag = _kdc_sheet_diagnostics(doc if isinstance(doc, dict) else {})
        if diag.get("sheet_count"):
            meta["row_count"] = diag["total_data_rows"]
            meta["cell_count"] = diag["total_cells"]
            meta["sheet_count"] = diag["sheet_count"]
    if "row_count" not in meta and content_md:
        table_lines = [
            ln for ln in content_md.splitlines()
            if ln.strip().startswith("|") and not re.match(r"^\|\s*---", ln.strip())
        ]
        meta["row_count"] = max(0, len(table_lines) - 1) if table_lines else 0

    if auto_workbook_range:
        meta["workbook_range_auto"] = auto_workbook_range
    if fmt:
        meta["format"] = fmt
    if isinstance(raw_content, dict):
        doc = _kdc_response_doc_root(raw_content)
        if isinstance(doc, dict):
            slides_text = _kdc_ppt_slides_text(doc)
            if slides_text:
                meta["slide_count"] = len(slides_text)
    return meta


def _apply_json_stdout_budget(payload: dict, extract_meta: dict, include_raw: bool) -> dict:
    """--json 默认去掉 medias 长 URL 等大字段；完整数据用 --include-raw / --output-file。"""
    if include_raw:
        return payload
    medias = payload.pop("medias", None)
    if medias:
        extract_meta["media_count"] = len(medias)
        extract_meta["medias_note"] = (
            "默认 --json 省略 medias URL 列表；完整列表见 --include-raw 或 --output-file"
        )
    return payload


def _resolve_extract_content(content_md, raw_content, fmt):
    """决定写入 content 字段的正文：优先完整 Markdown，否则 KDC 业务子集（不截断）。"""
    if content_md:
        return content_md
    if fmt in ("plain", "markdown", "html") and isinstance(raw_content, str):
        return raw_content
    if isinstance(raw_content, dict):
        return _kdc_agent_content(raw_content)
    return raw_content


def _extract_stdout_byte_size(text: str) -> int:
    return len(text.encode("utf-8"))


def _auto_extract_artifact_path(prefix: str = "wps365-extract") -> str:
    return os.path.join(
        tempfile.gettempdir(),
        f"{prefix}-{os.getpid()}-{int(time.time())}.json",
    )


def _write_extract_artifact(
    path: str,
    out_data: dict,
    content_value,
    raw_content,
    extract_meta: dict,
    auto_wr=None,
) -> str:
    """将完整抽取结果写入 artifact 文件（content + raw，均未截断）。"""
    full_payload = dict(out_data)
    full_payload["content"] = content_value
    full_payload["raw"] = raw_content
    full_payload["extract_meta"] = extract_meta
    if auto_wr:
        full_payload["workbook_range_auto"] = auto_wr
    Path(path).write_text(
        json.dumps(full_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def _emit_extract_artifact_summary(args, out_data, extract_meta, build_default_md, note: str):
    """stdout 仅输出摘要，完整结果见 extract_meta.artifact_path。"""
    summary = {
        "file_id": out_data.get("file_id"),
        "file_name": out_data.get("file_name"),
        "file_path": out_data.get("file_path"),
        "file_type": out_data.get("file_type"),
        "format": out_data.get("format"),
        "extract_mode": out_data.get("extract_mode"),
        "extract_meta": extract_meta,
        "note": note,
    }
    if getattr(args, "json", False):
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    elif getattr(args, "raw", False):
        char_count = extract_meta.get("char_count", 0)
        path = extract_meta.get("artifact_path", "")
        print(f"完整抽取结果已写入（共 {char_count} 字符）: {path}")
    else:
        path = extract_meta.get("artifact_path", "")
        md = build_default_md()
        md.extend([
            "",
            f"- **完整结果文件**: `{path}`",
            f"- **字符数**: {extract_meta.get('char_count', 0)}",
            f"- **数据行数**: {extract_meta.get('row_count', '-')}",
            "",
            f"> {note}",
        ])
        _out(md, None)
    sys.stdout.flush()


def _spill_extract_stdout_if_needed(
    stdout_text: str,
    args,
    out_data: dict,
    content_value,
    raw_content,
    extract_meta: dict,
    auto_wr,
    build_default_md,
) -> bool:
    """stdout 超过预算时自动落盘 artifact（与错误 sidecar 同模式），返回是否已外置。"""
    if _extract_stdout_byte_size(stdout_text) <= _EXTRACT_STDOUT_MAX_BYTES:
        return False
    path = _auto_extract_artifact_path()
    spilled_meta = dict(extract_meta)
    spilled_meta["artifact_path"] = path
    spilled_meta["stdout_spilled"] = True
    spilled_meta["stdout_bytes"] = _extract_stdout_byte_size(stdout_text)
    limit_kb = _EXTRACT_STDOUT_MAX_BYTES // 1024
    note = (
        f"stdout 超过 {limit_kb}KB，完整抽取结果（content/raw 均未截断）"
        "已写入 extract_meta.artifact_path"
    )
    _write_extract_artifact(path, out_data, content_value, raw_content, spilled_meta, auto_wr)
    _emit_extract_artifact_summary(args, out_data, spilled_meta, build_default_md, note)
    return True


def _finish_extract_output(args, out_data, content_md, raw_content, build_default_md):
    """统一 get-file-content 输出：默认/--raw/--json/--output-file，业务数据不截断。"""
    fmt = out_data.get("format")
    file_name = out_data.get("file_name") or out_data.get("file_path") or ""
    include_raw = _resolve_include_raw(args, fmt, file_name)
    output_file = (getattr(args, "output_file", None) or "").strip()
    auto_wr = out_data.pop("workbook_range_auto", None)
    content_value = _resolve_extract_content(content_md, raw_content, fmt)

    if output_file:
        path = os.path.abspath(os.path.expanduser(output_file))
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        extract_meta = _build_extract_meta(content_md, raw_content, fmt, auto_wr, artifact_path=path)
        _write_extract_artifact(path, out_data, content_value, raw_content, extract_meta, auto_wr)
        note = "完整抽取结果（content/raw 均未截断）已写入 extract_meta.artifact_path"
        _emit_extract_artifact_summary(args, out_data, extract_meta, build_default_md, note)
        return

    extract_meta = _build_extract_meta(content_md, raw_content, fmt, auto_wr)

    if getattr(args, "json", False):
        payload = dict(out_data)
        payload["content"] = content_value
        payload["extract_meta"] = extract_meta
        if include_raw:
            payload["raw"] = raw_content
        if auto_wr:
            payload["workbook_range_auto"] = auto_wr
        payload = _apply_json_stdout_budget(payload, extract_meta, include_raw)
        payload["extract_meta"] = extract_meta
        stdout_text = json.dumps(payload, ensure_ascii=False, indent=2)
        if _spill_extract_stdout_if_needed(
            stdout_text, args, out_data, content_value, raw_content, extract_meta, auto_wr, build_default_md,
        ):
            return
        print(stdout_text)
        sys.stdout.flush()
        return

    if getattr(args, "raw", False):
        if content_md:
            stdout_text = content_md
        elif isinstance(content_value, str):
            stdout_text = content_value
        else:
            stdout_text = json.dumps(content_value, ensure_ascii=False, indent=2)
        if _spill_extract_stdout_if_needed(
            stdout_text, args, out_data, content_value, raw_content, extract_meta, auto_wr, build_default_md,
        ):
            return
        print(stdout_text)
        sys.stdout.flush()
        return

    md = build_default_md()
    if content_md:
        md.append(content_md)
    elif isinstance(content_value, (dict, list)):
        md.extend([
            "### 抽取结果",
            "",
            "```json",
            json.dumps(content_value, ensure_ascii=False, indent=2),
            "```",
        ])
    elif content_value:
        md.extend(["### 抽取结果", "", str(content_value)])
    stdout_text = "\n".join([""] + md)
    if _spill_extract_stdout_if_needed(
        stdout_text, args, out_data, content_value, raw_content, extract_meta, auto_wr, build_default_md,
    ):
        return
    _out(md, None)


def _is_local_path(value: str) -> bool:
    """判断参数是否为本地文件路径（绝对路径、相对路径、或含常见路径分隔符）。"""
    if not value:
        return False
    if os.path.isabs(value):
        return True
    if os.path.exists(value):
        return True
    if value.startswith("./") or value.startswith("../") or value.startswith("~/"):
        return True
    return False


def _cmd_extract_local(args):
    """本地文件内容解析：异步 create_job + query_job 轮询。"""
    file_path = args.file_id
    if file_path.startswith("~"):
        file_path = os.path.expanduser(file_path)
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)
    if not os.path.exists(file_path):
        _err(f"本地文件不存在: {file_path}")

    file_name = os.path.basename(file_path)
    ext = os.path.splitext(file_name)[-1].lower()
    _NO_IE_EXTS = {".pdf", ".ofd"}
    ie_raw = getattr(args, "include_elements", None)
    ie = ie_raw if ie_raw is not None else (None if ext in _NO_IE_EXTS else "all")
    fmt = _pick_extract_format(file_name)

    kwargs = dict(format=fmt, file_path=file_path, filename=file_name)
    if ie is not None:
        kwargs["include_elements"] = ie
    convert_options = _build_convert_options(args, file_name)
    if convert_options:
        kwargs["convert_options"] = convert_options
    resp = export_file_content_async(**kwargs)
    data = _check_resp(resp)
    file_type = os.path.splitext(file_name)[-1].lstrip(".") or "unknown"

    if fmt == "kdc":
        kdc_content = data.get("kdc") if isinstance(data.get("kdc"), (dict, list)) else data
        content_md = _kdc_to_markdown(kdc_content)
        raw_content = kdc_content
    else:
        content_md = (data.get(fmt) or "").strip()
        raw_content = data

    content_md = _strip_base64_images(content_md)
    raw_content = _strip_base64_from_raw(raw_content)

    out_data = {
        "file_name": file_name,
        "file_path": file_path,
        "file_type": file_type,
        "format": fmt,
    }

    def _local_md():
        md = [
            "## 本地文件内容解析",
            "",
            f"- **文件名**: {file_name}",
            f"- **路径**: `{file_path}`",
            f"- **类型**: {file_type}",
            f"- **格式**: {fmt}",
            "",
            "---",
            "",
        ]
        return md

    _finish_extract_output(args, out_data, content_md, raw_content, _local_md)


def cmd_extract(args):
    """文档内容提取解析；云文档默认 POST+async 轮询，本地文件用 KDC asyn_export。"""
    if not getattr(args, "file_id", None):
        _err("请指定文件ID、link_id 或本地文件路径，例如: run.py get-file-content <file_id|path>")

    if _is_local_path(args.file_id):
        _cmd_extract_local(args)
        return

    file_id, drive_id = _resolve_file_and_drive(
        args.file_id, getattr(args, "drive", None) or "private"
    )
    if not file_id:
        _err("无法解析 file_id")
    file_resp = get_file_directly(file_id, with_drive=True)
    if file_resp.get("code") == 0 and file_resp.get("data"):
        file_data = file_resp.get("data", {})
        drive_id = file_data.get("drive_id") or drive_id
    else:
        file_resp = get_file(drive_id=drive_id, file_id=file_id)
        file_data = file_resp.get("data") or {}
    file_name = file_data.get("name", "-")
    file_type = _get_file_type(drive_id, file_id) if not getattr(args, "type", None) else getattr(args, "type")

    ie = getattr(args, "include_elements", None) or "all"
    ef = (getattr(args, "extract_format", None) or "auto").strip().lower()
    fmt = _pick_extract_format(file_name) if ef == "auto" else ef

    convert_options = _build_convert_options(args, file_name)
    extract_mode = getattr(args, "extract_mode", None) or _default_extract_mode(file_name)
    component_file_id = getattr(args, "component_file_id", None)

    extract_query = dict(enable_upload_medias="true")
    data, auto_workbook_range = _extract_cloud_with_auto_workbook_range(
        drive_id=drive_id,
        file_id=file_id,
        file_name=file_name,
        fmt=fmt,
        include_elements=ie,
        convert_options=convert_options,
        extract_mode=extract_mode,
        component_file_id=component_file_id,
        extract_query=extract_query,
        args=args,
    )

    if fmt == "kdc":
        kdc_content = data.get("kdc") if isinstance(data.get("kdc"), (dict, list)) else data
        content_md = _kdc_to_markdown(kdc_content)
        raw_content = kdc_content
    else:
        content_md = (data.get(fmt) or "").strip()
        if _KS3_INTERNAL_SUFFIX in content_md:
            content_md = content_md.replace(_KS3_INTERNAL_SUFFIX, _KS3_EXTERNAL_SUFFIX)
        raw_content = data

    content_md = _strip_base64_images(content_md)
    raw_content = _strip_base64_from_raw(raw_content)

    out_data = {
        "file_id": file_id,
        "file_name": file_name,
        "file_type": file_type,
        "format": fmt,
        "extract_mode": extract_mode,
    }
    if auto_workbook_range:
        out_data["workbook_range_auto"] = auto_workbook_range
    if fmt == "kdc":
        ic = _kdc_inline_comments(raw_content if isinstance(raw_content, dict) else {})
        if ic is not None:
            out_data["inline_comments"] = ic
            out_data["inline_comments_note"] = (
                "正文划选/锚定批注（kdc doc.comments），与协作区「留言」comment-list 不同；"
                "正文与元数据仍以 raw.doc 为准（--include-raw 或 --output-file）"
            )
        medias = _kdc_extract_medias(raw_content if isinstance(raw_content, dict) else {})
        if medias:
            out_data["medias"] = medias

    def _cloud_md():
        md = [
            "## 文档内容抽取",
            "",
            f"- **文件名**: {file_name}",
            f"- **文件ID**: `{file_id}`",
            f"- **类型**: {file_type}",
            f"- **格式**: {fmt}",
            "",
            "---",
            "",
        ]
        if fmt == "kdc" and isinstance(raw_content, dict):
            ic = _kdc_inline_comments(raw_content)
            if ic is not None:
                md.extend([
                    "## 正文划选批注（侧栏「评论」，kdc `doc.comments`）",
                    "",
                    f"共 **{len(ic)}** 条（与底部「留言」comment-list 不是同一套数据）。",
                    "",
                ])
                if ic:
                    md.append("```json")
                    md.append(json.dumps(ic, ensure_ascii=False, indent=2))
                    md.append("```")
                else:
                    md.append("（服务端返回空列表）")
                md.extend(["", "---", ""])
            medias = _kdc_extract_medias(raw_content)
            if medias:
                md.extend([
                    "## 文档图片资源",
                    "",
                    f"共 **{len(medias)}** 张图片：",
                    "",
                ])
                for i, m in enumerate(medias, 1):
                    url = m.get("url", "")
                    mid = m.get("id", "")
                    md.append(f"{i}. `{mid}`：{url}")
                md.extend(["", "---", ""])
        return md

    _finish_extract_output(args, out_data, content_md, raw_content, _cloud_md)


_CREATE_SUPPORTED_EXTS = {
    ".otl", ".dbt", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
}


# ---------------------------------------------------------------------------
# 文档库（团队文档）
# ---------------------------------------------------------------------------

_ROLE_LABELS = {"owner": "拥有者", "admin": "管理员", "normal": "成员"}


def cmd_doclibs(args):
    """获取文档库（团队文档）列表。GET /v7/doclibs。"""
    user_role = _split_csv(getattr(args, "user_role", None))
    resp = list_doclibs(
        page_size=args.page_size or 100,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        user_role=user_role or None,
    )
    data = _check_resp(resp)

    if getattr(args, "json", False):
        print(json.dumps(data if data is not None else resp, ensure_ascii=False, indent=2))
        return

    items = (data if isinstance(data, dict) else {}).get("items") or []
    next_token = (data if isinstance(data, dict) else {}).get("next_page_token") or ""

    md = ["## 团队文档库列表", "", f"本页共 **{len(items)}** 个文档库。", ""]
    if not items:
        md.append("暂无文档库。")
    else:
        for i, item in enumerate(items, 1):
            drive = item.get("drive") or {}
            group = item.get("group") or {}
            role = item.get("user_role", "-")
            role_label = _ROLE_LABELS.get(role, role)
            pinned = item.get("pinned", False)
            name = drive.get("name") or group.get("name") or "-"
            drive_id = drive.get("id", "-")
            member_total = group.get("member_total", "-")
            creator = (drive.get("created_by") or {}).get("name", "-")
            pin_tag = " 📌" if pinned else ""
            md.append(f"{i}. **{name}**{pin_tag}")
            md.append(f"   > drive_id: `{drive_id}` | 成员: {member_total} | 角色: {role_label} | 创建者: {creator}")
    if next_token:
        md.append("")
        md.append(f"> 更多结果可使用 `doclibs --page-token {next_token}` 获取下一页。")
    md.extend([
        "",
        "> 使用 `list --drive <drive_id>` 查看文档库内的目录和文件。",
    ])
    _out(md, data if data is not None else resp)


def cmd_doclib_meta(args):
    """获取单个文档库（团队文档）信息。GET /v7/doclib/meta。"""
    drive_id = (getattr(args, "drive_id", None) or "").strip()
    if not drive_id:
        _err("请指定 drive_id，例如: run.py doclib-meta <drive_id>")
    resp = get_doclib_meta(drive_id=drive_id)
    data = _check_resp(resp)

    if getattr(args, "json", False):
        print(json.dumps(data if data is not None else resp, ensure_ascii=False, indent=2))
        return

    drive = (data if isinstance(data, dict) else {}).get("drive") or {}
    group = (data if isinstance(data, dict) else {}).get("group") or {}
    role = (data if isinstance(data, dict) else {}).get("user_role", "-")
    role_label = _ROLE_LABELS.get(role, role)
    pinned = (data if isinstance(data, dict) else {}).get("pinned", False)
    name = drive.get("name") or group.get("name") or "-"
    creator = (drive.get("created_by") or {}).get("name", "-")
    md = [
        "## 文档库详情",
        "",
        f"- **名称**: {name}" + (" 📌" if pinned else ""),
        f"- **drive_id**: `{drive.get('id', '-')}`",
        f"- **group_id**: `{group.get('id', '-')}`",
        f"- **成员数**: {group.get('member_total', '-')}",
        f"- **角色**: {role_label}",
        f"- **创建者**: {creator}",
        f"- **类型**: {group.get('type', '-')}",
        f"- **状态**: {drive.get('status', '-')}",
        "",
        f"> 使用 `list --drive {drive.get('id', '<drive_id>')}` 查看该文档库内的目录和文件。",
    ]
    _out(md, data if data is not None else resp)


_CREATE_SUPPORTED_EXTS = {
    ".otl", ".dbt", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
}

_UPDATE_DANGEROUS_TARGETS = {".otl", ".dbt"}
_UPDATE_DANGEROUS_SOURCES = {".md", ".txt", ".markdown", ".mdown"}


def cmd_create(args):
    """统一创建能力：新建文件/文件夹/快捷方式。POST /v7/drives/{drive_id}/files/{parent_id}/create。"""
    file_name = (getattr(args, "file_name", None) or "").strip()
    if not file_name:
        _err("请指定名称，例如: run.py create 反馈管理.dbt")

    file_type = (getattr(args, "file_type", None) or "file").strip().lower()
    if file_type == "file":
        ext = os.path.splitext(file_name)[-1].lower()
        if ext and ext not in _CREATE_SUPPORTED_EXTS:
            supported = " ".join(sorted(_CREATE_SUPPORTED_EXTS))
            _err(
                f"`create` 不支持 `{ext}` 格式。\n\n"
                f"  支持的云文档格式：{supported}\n\n"
                f"  如需将 `{ext}` 文件保存到云盘，请改用 `upload` 命令：\n"
                f"  python skills/drive/run.py upload ./{file_name}"
            )

    drive_name = getattr(args, "drive", None) or "private"
    drive_id = _get_drive_id(drive_name)

    path_value = getattr(args, "path", None)
    parent_path = _parent_path_list(path_value)

    if file_type == "shortcut" and not getattr(args, "file_id", None):
        _err("`create --file-type shortcut` 时必须提供 --file-id")
    on_conflict = getattr(args, "on_conflict", None) or "rename"
    if path_value:
        path_display = path_value
    elif getattr(args, "parent_id", None):
        path_display = f"parent_id={args.parent_id}"
    else:
        path_display = "根目录"
    is_dry_run, gate_md = _mutation_gate(
        "创建文件/文件夹（预览）",
        [
            f"- **名称**：{file_name}",
            f"- **云盘**：{drive_name}",
            f"- **类型**：{file_type}",
            f"- **路径**：{path_display}",
        ],
        getattr(args, "confirm", False),
    )
    if is_dry_run:
        _out(gate_md, None)
        return

    resp = create_file(
        drive_id=drive_id,
        file_name=file_name,
        parent_id=getattr(args, "parent_id", None) or "0",
        file_type=file_type,
        file_id=getattr(args, "file_id", None),
        parent_path=parent_path,
        on_name_conflict=on_conflict,
    )
    data = _check_resp(resp)
    file_id = data.get("id", "-")
    link_id = data.get("link_id", "") or file_id
    link_url = data.get("link_url", "")
    md = [
        "## 已创建对象",
        "",
        f"- **文件名**: {data.get('name', file_name)}",
        f"- **类型**: {file_type}",
        f"- **文件 ID**: `{file_id}`",
        f"- **link_id**: `{link_id}`",
        f"- **链接**: {link_url or '（无）'}",
    ]
    if file_type == "folder":
        md.extend([
            "",
            "**注意：该文件夹尚未开启链接分享权限，无法通过链接访问。**",
            "如需访问，请询问用户手动开启分享权限，并确认分享范围（企业内 / 所有人 / 指定用户）"
        ])
    else:
        md.extend([
            "",
            "> 多维表（.dbt）创建后，可使用 dbsheet 技能在该 file_id 下创建数据表与记录。发送云文档消息时 `cloud.id` 使用 **link_id**。",
        ])
    _out(md, data)


def cmd_link_meta(args):
    """根据 link_id 获取分享链接信息（含 file_id），用于 link_id 换 file_id。"""
    if not args.link_id:
        _err("请指定 link_id，例如: run.py link-meta <link_id>")
    link_id = _extract_link_id(args.link_id)
    resp = get_link_meta(link_id=link_id)
    data = _check_resp(resp)
    file_id = data.get("file_id") or "-"
    drive_id = data.get("drive_id") or "-"
    link_url = data.get("url") or data.get("link_url") or "-"
    md = [
        "## 分享链接详情（link_id → file_id）",
        "",
        f"- **link_id**: `{link_id}`",
        f"- **file_id**: `{file_id}`",
        f"- **drive_id**: `{drive_id}`",
        f"- **链接**: {link_url}",
    ]
    if file_id != "-":
        md.extend([
            "",
            "> 可使用上述 **file_id** 与 **drive_id** 调用 `get <file_id>` 或 `download <file_id>`（需指定 `--drive <drive_id>`）。",
        ])
    _out(md, data)


def cmd_search(args):
    """搜索云文档文件（简化版，便于 LLM 使用）。GET /v7/files/search。"""
    keyword = (getattr(args, "keyword", None) or "").strip() or None
    scope = getattr(args, "scope", None)
    if scope and isinstance(scope, str):
        scope = [s.strip() for s in scope.split(",") if s.strip()] or None

    start_ts = getattr(args, "start_time", None)
    end_ts = getattr(args, "end_time", None)
    time_type = getattr(args, "time_type", None)
    if (start_ts is not None or end_ts is not None) and not time_type:
        time_type = "mtime"

    resp = search_files(
        keyword=keyword,
        search_type=args.type or "all",
        scope=scope,
        file_type=getattr(args, "file_type", None),
        file_exts=_split_csv(getattr(args, "file_exts", None)),
        exclude_file_exts=_split_csv(getattr(args, "exclude_file_exts", None)),
        drive_ids=_split_csv(getattr(args, "drive_ids", None)),
        parent_ids=_split_csv(getattr(args, "parent_ids", None)),
        creator_ids=_split_csv(getattr(args, "creator_ids", None)),
        time_type=time_type,
        start_time=start_ts,
        end_time=end_ts,
        order=getattr(args, "order", None),
        order_by=getattr(args, "order_by", None),
        page_size=args.page_size or 20,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        with_total=not getattr(args, "no_total", False),
        with_link=True,
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    total = (data or {}).get("total")
    next_token = (data or {}).get("next_page_token") or ""

    md = ["## 文件搜索结果", ""]
    if keyword:
        md.append(f"关键词：**{keyword}**")
    md.append(f"本页共 **{len(items)}** 条" + (f"，共 **{total}** 条" if total is not None else "") + "。")
    md.append("")
    for i, item in enumerate(items, 1):
        fi = (item.get("file") or item) if isinstance(item, dict) else {}
        name = fi.get("name", "-")
        file_id = fi.get("id", "-")
        size = fi.get("size", "-")
        link_url = fi.get("link_url", "")
        md.append(f"{i}. **{name}**")
        md.append(f"   > ID: `{file_id}` | 大小: {size}" + (f" | [链接]({link_url})" if link_url else ""))
    if next_token:
        md.append("")
        md.append(f"> 更多结果可使用 `search --page-token {next_token}` 获取下一页。")
    if len(items) > 1:
        _set_marker(ASK_USER_REQUIRED=True, AMBIGUOUS_RESULTS=len(items))
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data if data is not None else resp)

def _split_csv(value):
    if not value or not isinstance(value, str):
        return None
    items = [s.strip() for s in value.split(",") if s.strip()]
    return items or None


_DRIVE_IDS_CACHE = None


def _list_user_drive_ids():
    """获取当前用户可访问的 drive_id 列表（带简单缓存）。"""
    global _DRIVE_IDS_CACHE
    if isinstance(_DRIVE_IDS_CACHE, list) and _DRIVE_IDS_CACHE:
        return _DRIVE_IDS_CACHE
    c = WpsV7Client()
    resp = c.get("/v7/drives", params={"allotee_type": "user", "page_size": 100})
    if resp.get("code") != 0:
        return []
    items = (resp.get("data") or {}).get("items") or []
    _DRIVE_IDS_CACHE = [str(it.get("id")) for it in items if it.get("id")]
    return _DRIVE_IDS_CACHE


def _resolve_file_meta_for_object_id(file_id):
    """将标签对象 ID 解析为文件详情。优先用 GET /v7/files/{file_id}/meta（仅需 file_id）。"""
    if not file_id:
        return None
    resp = get_file_directly(file_id, with_link=True, with_drive=True)
    if resp.get("code") == 0 and resp.get("data"):
        return resp.get("data")
    for drive_id in _list_user_drive_ids():
        resp = get_file(drive_id=drive_id, file_id=file_id)
        if resp.get("code") == 0 and resp.get("data"):
            return resp.get("data")
    return None


def cmd_latest(args):
    """获取最近列表。GET /v7/drive_latest/items。"""
    resp = list_latest_items(
        with_permission=getattr(args, "with_permission", None),
        with_link=getattr(args, "with_link", None),
        page_size=args.page_size or 50,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        include_exts=_split_csv(getattr(args, "include_exts", None)),
        exclude_exts=_split_csv(getattr(args, "exclude_exts", None)),
        include_creators=_split_csv(getattr(args, "include_creators", None)),
        exclude_creators=_split_csv(getattr(args, "exclude_creators", None)),
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    next_token = (data or {}).get("next_page_token") or ""

    md = ["## 最近列表", "", f"本页共 **{len(items)}** 条最近文档。", ""]
    if not items:
        md.append("暂无最近文档。")
    else:
        for i, item in enumerate(items, 1):
            name = item.get("name", "-")
            file_id = item.get("id", "-")
            drive_id = item.get("drive_id", "-")
            link_url = item.get("link_url", "")
            md.append(f"{i}. **{name}**")
            md.append(f"   > file_id: `{file_id}` | drive_id: `{drive_id}`" + (f" | [链接]({link_url})" if link_url else ""))
    if next_token:
        md.append("")
        md.append(f"> 更多结果可使用 `latest --page-token {next_token}` 获取下一页。")
    _out(md, data if data is not None else resp)


def cmd_file_versions(args):
    """获取文件版本列表。GET /v7/drives/{drive_id}/files/{file_id}/versions。"""
    if not args.file_id:
        _err("请指定文件 ID 或 link_id，例如: run.py file-versions <file_id>")
    with_comment = getattr(args, "with_comment", True)
    file_id, drive_id = _resolve_file_and_drive(
        args.file_id, getattr(args, "drive", None) or "private"
    )
    if not file_id or not drive_id:
        _err("无法解析文件 ID 或 drive_id")

    resp = list_file_versions(
        drive_id=drive_id,
        file_id=file_id,
        page_size=min(args.page_size or 20, 20),
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        with_comment=with_comment,
        with_ext_attrs=getattr(args, "with_ext_attrs", None),
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    next_token = (data or {}).get("next_page_token") or ""

    md = [
        "## 文件版本列表",
        "",
        f"文件 `{file_id}` | drive `{drive_id}` | 本页展示 **{len(items)}** 条版本记录",
        "",
    ]
    if not items:
        md.append("暂无历史版本。")
    else:
        md.append("> `version_id` 只是版本记录 ID，不代表第几个版本，也不代表总版本数。")
        md.append("")
        for i, item in enumerate(items, 1):
            md.extend(_fmt_file_version_item(item, i))
    if next_token:
        _set_marker(ASK_USER_REQUIRED=True, AMBIGUOUS_RESULTS=1)
        continue_cmd = _build_file_versions_continue_cmd(file_id, next_token, args, with_comment)
        md.append("")
        md.append("## 需要用户确认是否继续")
        md.append("")
        md.append("> 仍有更多版本记录未展示。请立即通过 `askUserQuestion` 询问用户：是否继续展示下一页版本记录？")
        md.append(f"> 若继续，可执行：`{continue_cmd}`")
    _out(md, data if data is not None else resp)


def cmd_file_version_diff(args):
    """下载并比较两个历史版本，输出主要变更与 unified diff。"""
    if not args.file_id:
        _err("请指定文件 ID 或 link_id，例如: run.py file-version-diff <file_id> 12 18")

    file_id, drive_id = _resolve_file_and_drive(
        args.file_id, getattr(args, "drive", None) or "private"
    )
    if not file_id or not drive_id:
        _err("无法解析文件 ID 或 drive_id")

    old_version, new_version = _normalize_version_pair(
        getattr(args, "version_a", None),
        getattr(args, "version_b", None),
    )
    if old_version is None or new_version is None:
        _ask_for_versions(file_id, drive_id)
        return

    file_meta_resp = get_file_directly(file_id, with_drive=True)
    if file_meta_resp.get("code") == 0 and file_meta_resp.get("data"):
        file_name = (file_meta_resp.get("data") or {}).get("name") or file_id
    else:
        file_meta_resp = get_file(drive_id=drive_id, file_id=file_id)
        file_name = (_check_resp(file_meta_resp) or {}).get("name") or file_id

    base_name = Path(file_name).stem or file_id
    suffix = Path(file_name).suffix or ".bin"

    with tempfile.TemporaryDirectory(prefix="drive-version-diff-") as tmpdir:
        old_download = _check_resp(download_file_version_to_local(
            drive_id=drive_id,
            file_id=file_id,
            version_num=old_version,
            output_dir=tmpdir,
            file_name=f"{base_name}.v{old_version}{suffix}",
        ))
        new_download = _check_resp(download_file_version_to_local(
            drive_id=drive_id,
            file_id=file_id,
            version_num=new_version,
            output_dir=tmpdir,
            file_name=f"{base_name}.v{new_version}{suffix}",
        ))

        old_md = _extract_content_from_local_file(old_download["path"])
        new_md = _extract_content_from_local_file(new_download["path"])

        old_md_path = os.path.join(tmpdir, f"{base_name}.v{old_version}.md")
        new_md_path = os.path.join(tmpdir, f"{base_name}.v{new_version}.md")
        _write_diff_input(old_md_path, old_md)
        _write_diff_input(new_md_path, new_md)
        diff_text = _run_unified_diff(old_md_path, new_md_path)

    changed = bool(diff_text.strip())
    md = [
        "## 文件版本比较",
        "",
        f"- **文件**: `{file_id}`",
        f"- **云盘**: `{drive_id}`",
        f"- **旧版本**: `{old_version}`",
        f"- **新版本**: `{new_version}`",
        "",
        "## 主要变更",
        "",
    ]
    md.extend(_summarize_diff_text(diff_text))
    md.extend([
        "",
        "## Diff",
        "",
        "```diff",
        diff_text.strip() or "# 未检测到差异",
        "```",
    ])
    _out(md, {
        "success": True,
        "file_id": file_id,
        "drive_id": drive_id,
        "old_version": old_version,
        "new_version": new_version,
        "changed": changed,
        "diff": diff_text,
        "old_download": old_download,
        "new_download": new_download,
    })


def cmd_star(args):
    """获取收藏列表。GET /v7/drive_star/items。"""
    resp = list_star_items(
        with_permission=getattr(args, "with_permission", None),
        with_link=getattr(args, "with_link", None),
        page_size=args.page_size or 50,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        order=(getattr(args, "order", None) or "").strip() or None,
        order_by=(getattr(args, "order_by", None) or "").strip() or None,
        include_exts=_split_csv(getattr(args, "include_exts", None)),
        exclude_exts=_split_csv(getattr(args, "exclude_exts", None)),
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    next_token = (data or {}).get("next_page_token") or ""

    md = ["## 收藏列表", "", f"本页共 **{len(items)}** 条收藏文档。", ""]
    if not items:
        md.append("暂无收藏文档。")
    else:
        for i, item in enumerate(items, 1):
            fi = (item.get("file") or item) if isinstance(item, dict) else {}
            name = fi.get("name", "-")
            file_id = fi.get("id", "-")
            drive_id = fi.get("drive_id", "-")
            link_url = fi.get("link_url", "")
            md.append(f"{i}. **{name}**")
            md.append(f"   > file_id: `{file_id}` | drive_id: `{drive_id}`" + (f" | [链接]({link_url})" if link_url else ""))
    if next_token:
        md.append("")
        md.append(f"> 更多结果可使用 `star --page-token {next_token}` 获取下一页。")
    _out(md, data if data is not None else resp)


def cmd_star_add_items(args):
    """批量添加收藏项。POST /v7/drive_star/items/batch_create"""
    objects = []
    raw_ids = _split_csv(getattr(args, "objects", None))
    if raw_ids:
        objects.extend(raw_ids)

    for field in ("objects_json", "items_json"):
        raw_json = (getattr(args, field, None) or "").strip()
        if raw_json:
            try:
                parsed = json.loads(raw_json)
                if isinstance(parsed, list):
                    objects.extend(parsed)
                else:
                    _err(f"--{field.replace('_', '-')} 必须是 JSON 数组")
            except json.JSONDecodeError:
                _err(f"--{field.replace('_', '-')} 不是合法 JSON")

    if not objects:
        _err("请至少通过 --objects / --objects-json / --items-json 传入一个对象")

    resp = batch_create_star_items(objects=objects)
    data = _check_resp(resp)
    md = [
        "## 已批量添加收藏项",
        "",
        "已提交批量添加收藏请求。",
        f"- 提交对象数: **{min(len(objects), 1024)}**",
    ]
    _out(md, data if data is not None else resp)


def cmd_star_remove_items(args):
    """批量移除收藏项。POST /v7/drive_star/items/batch_delete"""
    objects = []
    raw_ids = _split_csv(getattr(args, "objects", None))
    if raw_ids:
        objects.extend(raw_ids)

    raw_json = (getattr(args, "objects_json", None) or "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                objects.extend(parsed)
            else:
                _err("--objects-json 必须是 JSON 数组")
        except json.JSONDecodeError:
            _err("--objects-json 不是合法 JSON")

    item_ids = _split_csv(getattr(args, "item_ids", None)) or []

    if not objects and not item_ids:
        _err("请至少通过 --objects / --objects-json / --item-ids 传入一个对象")

    resp = batch_delete_star_items(objects=objects or None, item_ids=item_ids or None)
    data = _check_resp(resp)
    submitted = len(objects) if objects else len(item_ids)
    md = [
        "## 已批量移除收藏项",
        "",
        "已提交批量移除收藏请求。",
        f"- 提交对象数: **{min(submitted, 1024)}**",
    ]
    _out(md, data if data is not None else resp)


def cmd_tags(args):
    """分页获取自定义标签列表（v7）。GET /v7/drive_labels。"""
    resp = list_drive_labels(
        allotee_type=args.allotee_type or "user",
        allotee_id=getattr(args, "allotee_id", None),
        label_type=args.label_type or "custom",
        page_size=args.page_size or 20,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    total = (data or {}).get("total")
    next_token = (data or {}).get("next_page_token") or ""

    md = ["## 自定义标签列表（v7）", "", f"本页共 **{len(items)}** 条" + (f"，总计 **{total}** 条" if total is not None else "") + "。"]
    if not items:
        md.append("")
        md.append("暂无标签。")
    else:
        md.append("")
        for i, item in enumerate(items, 1):
            title = item.get("title") or item.get("name") or "-"
            tag_id = item.get("id") or item.get("tag_id") or "-"
            owner = item.get("allotee_type") or item.get("own_type") or "-"
            mtime = item.get("mtime", "-")
            md.append(f"{i}. **{title}**")
            md.append(f"   > tag_id: `{tag_id}` | allotee: {owner} | mtime: {mtime}")
    if next_token:
        md.append("")
        md.append(f"> 翻页可使用 `tags --page-token {next_token}`")
    _out(md, data if data is not None else resp)


def cmd_tag_get(args):
    """获取单个标签信息。GET /v7/drive_labels/{label_id}/meta"""
    if not args.label_id:
        _err("请指定标签 ID，例如: run.py tag-get <label_id>")
    resp = get_drive_label_meta(args.label_id)
    data = _check_resp(resp)
    md = [
        "## 标签详情",
        "",
        f"- **名称**: {data.get('name', '-')}",
        f"- **ID**: `{data.get('id', '-')}`",
        f"- **归属类型**: {data.get('allotee_type', '-')}",
        f"- **标签类型**: {data.get('label_type', '-')}",
        f"- **更新时间**: {data.get('mtime', '-')}",
    ]
    _out(md, data if data is not None else resp)


def cmd_tag_objects(args):
    """分页获取标签下的全部对象。GET /v7/drive_labels/{label_id}/objects"""
    if not args.label_id:
        _err("请指定标签 ID，例如: run.py tag-objects <label_id>")
    resp = list_drive_label_objects(
        label_id=args.label_id,
        page_size=args.page_size or 20,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        include_exts=_split_csv(getattr(args, "include_exts", None)),
        exclude_exts=_split_csv(getattr(args, "exclude_exts", None)),
        file_type=args.file_type or "file",
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    next_token = (data or {}).get("next_page_token") or ""
    md = ["## 标签对象列表", "", f"标签 `{args.label_id}` 本页共 **{len(items)}** 条。", ""]
    if not items:
        md.append("暂无对象。")
    else:
        for i, item in enumerate(items, 1):
            fi = (item.get("file") or item) if isinstance(item, dict) else {}
            obj_id = fi.get("id") or item.get("id") or "-"
            name = fi.get("name") or obj_id or "-"
            obj_type = fi.get("type") or item.get("type") or "-"
            link_url = fi.get("link_url") or item.get("link_url") or ""
            # 标签对象接口常只返回对象 ID；可选自动补全文件元信息。
            if getattr(args, "resolve_meta", True) and obj_type == "file" and (not fi.get("name") or not link_url):
                meta = _resolve_file_meta_for_object_id(obj_id)
                if meta:
                    name = meta.get("name") or name
                    link_url = meta.get("link_url") or link_url
            md.append(f"{i}. **{name}**")
            md.append(f"   > id: `{obj_id}` | type: {obj_type}" + (f" | [链接]({link_url})" if link_url else ""))
    if next_token:
        md.append("")
        md.append(f"> 翻页可使用 `tag-objects {args.label_id} --page-token {next_token}`")
    _out(md, data if data is not None else resp)


def cmd_tag_create(args):
    """创建自定义标签。POST /v7/drive_labels/create"""
    if not args.name:
        _err("请指定标签名称，例如: run.py tag-create --name 我的标签")
    resp = create_drive_label(
        name=args.name,
        allotee_type=args.allotee_type or "user",
        allotee_id=getattr(args, "allotee_id", None),
        label_type=args.label_type or "custom",
        attr=getattr(args, "attr", None),
        rank=getattr(args, "rank", None),
    )
    data = _check_resp(resp)
    md = [
        "## 已创建标签",
        "",
        f"- **名称**: {data.get('name', '-')}",
        f"- **ID**: `{data.get('id', '-')}`",
        f"- **归属类型**: {data.get('allotee_type', '-')}",
        f"- **标签类型**: {data.get('label_type', '-')}",
    ]
    _out(md, data if data is not None else resp)


def cmd_tag_add_objects(args):
    """批量添加标签对象。POST /v7/drive_labels/{label_id}/objects/batch_add"""
    if not args.label_id:
        _err("请指定标签 ID，例如: run.py tag-add-objects <label_id> --objects id1,id2")

    objects = []
    raw_ids = _split_csv(getattr(args, "objects", None))
    if raw_ids:
        objects.extend(raw_ids)

    raw_json = (getattr(args, "objects_json", None) or "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                objects.extend(parsed)
            else:
                _err("--objects-json 必须是 JSON 数组")
        except json.JSONDecodeError:
            _err("--objects-json 不是合法 JSON")

    if not objects:
        _err("请至少通过 --objects 或 --objects-json 传入一个对象")

    resp = batch_add_drive_label_objects(args.label_id, objects=objects)
    data = _check_resp(resp)
    md = [
        "## 已批量添加标签对象",
        "",
        f"标签 `{args.label_id}` 已提交批量添加请求。",
        f"- 提交对象数: **{min(len(objects), 100)}**",
    ]
    _out(md, data if data is not None else resp)


def cmd_tag_remove_objects(args):
    """批量移除标签对象。POST /v7/drive_labels/{label_id}/objects/batch_remove"""
    if not args.label_id:
        _err("请指定标签 ID，例如: run.py tag-remove-objects <label_id> --objects id1,id2")

    objects = []
    raw_ids = _split_csv(getattr(args, "objects", None))
    if raw_ids:
        objects.extend(raw_ids)

    raw_json = (getattr(args, "objects_json", None) or "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                objects.extend(parsed)
            else:
                _err("--objects-json 必须是 JSON 数组")
        except json.JSONDecodeError:
            _err("--objects-json 不是合法 JSON")

    if not objects:
        _err("请至少通过 --objects 或 --objects-json 传入一个对象")

    resp = batch_remove_drive_label_objects(args.label_id, objects=objects)
    data = _check_resp(resp)
    md = [
        "## 已批量移除标签对象",
        "",
        f"标签 `{args.label_id}` 已提交批量移除请求。",
        f"- 提交对象数: **{min(len(objects), 100)}**",
    ]
    _out(md, data if data is not None else resp)


def cmd_deleted_list(args):
    """获取回收站文件列表。GET /v7/deleted_files"""
    resp = list_deleted_files(
        drive_id=getattr(args, "drive_id", None),
        with_ext_attrs=getattr(args, "with_ext_attrs", None),
        page_size=args.page_size or 20,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        with_drive=getattr(args, "with_drive", None),
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    next_token = (data or {}).get("next_page_token") or ""
    md = ["## 回收站文件列表", "", f"本页共 **{len(items)}** 条。", ""]
    for i, item in enumerate(items, 1):
        name = item.get("name", "-")
        file_id = item.get("id", "-")
        md.append(f"{i}. **{name}**")
        md.append(f"   > file_id: `{file_id}`")
    if next_token:
        md.append("")
        md.append(f"> 翻页可使用 `deleted-list --page-token {next_token}`")
    _out(md, data if data is not None else resp)


def cmd_deleted_restore(args):
    """还原回收站文件。POST /v7/deleted_files/{file_id}/restore"""
    if not args.file_id:
        _err("请指定 file_id，例如: run.py deleted-restore <file_id>")
    resp = restore_deleted_file(args.file_id)
    data = _check_resp(resp)
    md = ["## 已还原回收站文件", "", f"文件 `{args.file_id}` 已发起还原。"]
    _out(md, data if data is not None else resp)


# ---------------------------------------------------------------------------
# 全文评论 (Document Comments)
# ---------------------------------------------------------------------------


def _unwrap_comment_list_item(item):
    """
    根评论列表单项可能是 {comment: {...}, sub_comments: {...}}，
    或与旧版一致直接在顶层带 id/content。统一成带 sub_comments 的扁平结构供 _fmt_comment 使用。
    """
    if not isinstance(item, dict):
        return item
    inner = item.get("comment")
    if isinstance(inner, dict):
        out = dict(inner)
        if "sub_comments" in item:
            out["sub_comments"] = item["sub_comments"]
        return out
    return item


def _fmt_comment(c, indent=""):
    """格式化单条评论为 Markdown 行列表。"""
    cid = c.get("id", "-")
    content = (c.get("content") or "")
    preview = (content[:80] + "…") if len(content) > 80 else content
    author = (c.get("created_by") or {}).get("name") or "-"
    ctime = c.get("ctime") or "-"
    status = c.get("status") or ""
    lines = [
        f"{indent}**评论 {cid}**（{author}，{ctime}）" + (f" [{status}]" if status == "deleted" else ""),
        f"{indent}> {preview}",
    ]
    return lines


def cmd_comment_list(args):
    """获取文档评论列表。GET /v7/documents/{file_id}/comments/{origin_id}/list"""
    if not args.file_id:
        _err("请指定文件 ID 或 link_id，例如: run.py comment-list <file_id>")
    file_id, _ = _resolve_file_and_drive(args.file_id)
    if not file_id:
        _err("无法解析文件 ID")
    origin_id = str(getattr(args, "origin_id", "0") or "0")
    resp = list_document_comments(
        file_id=file_id,
        origin_id=origin_id,
        page_size=args.page_size or 10,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    total = (data or {}).get("total", "?")
    next_token = (data or {}).get("next_page_token") or ""
    is_root = origin_id == "0"
    md = [
        "## 文档评论列表",
        "",
        f"文件 `{file_id}` | {'根评论' if is_root else f'子评论（origin_id={origin_id}）'} | 总数 **{total}** | 本页 **{len(items)}** 条",
        "",
    ]
    if not items:
        md.append("暂无评论。")
    else:
        for i, item in enumerate(items, 1):
            flat = _unwrap_comment_list_item(item)
            lines = _fmt_comment(flat)
            md.append(f"{i}. " + lines[0].lstrip())
            md.extend(lines[1:])
            subs = flat.get("sub_comments") or {}
            sub_items = (subs.get("items") or []) if isinstance(subs, dict) else []
            sub_total = (subs.get("total", 0)) if isinstance(subs, dict) else 0
            for sc in sub_items:
                md.extend(_fmt_comment(sc, indent="   "))
            if sub_total and sub_total > len(sub_items):
                root_id = flat.get("id", "")
                md.append(f"   > 更多子评论（共 {sub_total} 条）：`comment-list {file_id} --origin-id {root_id}`")
            md.append("")
    if next_token:
        md.append(f"> 翻页：`comment-list {file_id}"
                  + (f" --origin-id {origin_id}" if not is_root else "")
                  + f" --page-token {next_token}`")
    _out(md, data if data is not None else resp)


def cmd_comment_create(args):
    """创建全文评论。POST /v7/documents/{file_id}/comments/create"""
    if not args.file_id:
        _err("请指定文件 ID 或 link_id，例如: run.py comment-create <file_id> -c '评论内容'")
    content = (getattr(args, "content", None) or "").strip()
    if not content:
        _err("请通过 --content / -c 指定评论内容")
    file_id, _ = _resolve_file_and_drive(args.file_id)
    if not file_id:
        _err("无法解析文件 ID")
    origin_id = getattr(args, "origin_id", None)
    reply_id = getattr(args, "reply_id", None)
    content_preview = (content[:100] + "…") if len(content) > 100 else content
    detail = [
        f"- **文件**：`{file_id}`",
        f"- **评论内容预览**：{content_preview}",
    ]
    if origin_id:
        detail.append(f"- **回复根评论 ID**：`{origin_id}`")
    if reply_id:
        detail.append(f"- **回复评论 ID**：`{reply_id}`")
    stop, gate_md = _mutation_gate("创建评论（预览）", detail, getattr(args, "confirm", False))
    if stop:
        _out(gate_md, None)
        return
    resp = create_document_comment(
        file_id=file_id,
        content=content,
        origin_id=int(origin_id) if origin_id else None,
        reply_id=int(reply_id) if reply_id else None,
    )
    data = _check_resp(resp)
    md = [
        "## 已创建评论",
        "",
        f"- **评论 ID**：`{data.get('id', '-')}`",
        f"- **内容**：{data.get('content', '-')}",
        f"- **创建者**：{(data.get('created_by') or {}).get('name', '-')}",
        f"- **创建时间**：{data.get('ctime', '-')}",
    ]
    _out(md, data if data is not None else resp)


def cmd_comment_update(args):
    """更新全文评论内容。POST /v7/documents/{file_id}/comments/{comment_id}/update"""
    if not args.file_id:
        _err("请指定文件 ID 或 link_id")
    if not args.comment_id:
        _err("请指定评论 ID，例如: run.py comment-update <file_id> <comment_id> -c '新内容'")
    content = (getattr(args, "content", None) or "").strip()
    if not content:
        _err("请通过 --content / -c 指定新的评论内容")
    file_id, _ = _resolve_file_and_drive(args.file_id)
    if not file_id:
        _err("无法解析文件 ID")
    content_preview = (content[:100] + "…") if len(content) > 100 else content
    stop, gate_md = _mutation_gate(
        "更新评论（预览）",
        [
            f"- **文件**：`{file_id}`",
            f"- **评论 ID**：`{args.comment_id}`",
            f"- **新内容预览**：{content_preview}",
        ],
        getattr(args, "confirm", False),
    )
    if stop:
        _out(gate_md, None)
        return
    resp = update_document_comment(
        file_id=file_id,
        comment_id=str(args.comment_id),
        content=content,
    )
    data = _check_resp(resp)
    md = [
        "## 已更新评论",
        "",
        f"- **评论 ID**：`{data.get('id', '-')}`",
        f"- **新内容**：{data.get('content', '-')}",
        f"- **修改时间**：{data.get('mtime', '-')}",
    ]
    _out(md, data if data is not None else resp)


def cmd_comment_delete(args):
    """删除全文评论。POST /v7/documents/{file_id}/comments/{comment_id}/delete"""
    if not args.file_id:
        _err("请指定文件 ID 或 link_id")
    if not args.comment_id:
        _err("请指定评论 ID，例如: run.py comment-delete <file_id> <comment_id>")
    file_id, _ = _resolve_file_and_drive(args.file_id)
    if not file_id:
        _err("无法解析文件 ID")
    stop, gate_md = _mutation_gate(
        "删除评论（预览）",
        [
            f"- **文件**：`{file_id}`",
            f"- **评论 ID**：`{args.comment_id}`",
        ],
        getattr(args, "confirm", False),
    )
    if stop:
        _out(gate_md, None)
        return
    resp = delete_document_comment(file_id=file_id, comment_id=str(args.comment_id))
    _check_resp(resp)
    md = [
        "## 已删除评论",
        "",
        f"评论 `{args.comment_id}` 已删除。",
    ]
    _out(md, resp)


def cmd_file_delete(args):
    """将文件移入回收站。POST /v7/drives/{drive_id}/files/{file_id}/delete"""
    stop, gate_md = _mutation_gate(
        "删除文件（预览）",
        [
            f"- **drive_id**：`{args.drive_id}`",
            f"- **file_id**：`{args.file_id}`",
        ],
        getattr(args, "confirm", False),
    )
    if stop:
        _out(gate_md, None)
        return
    resp = delete_file(drive_id=args.drive_id, file_id=args.file_id)
    data = _check_resp(resp)
    md = ["## 已删除文件", "", f"文件 `{args.file_id}` 已移入回收站。"]
    _out(md, data if data is not None else resp)


def cmd_file_move(args):
    """移动文件。POST /v7/drives/{drive_id}/files/{file_id}/move"""
    stop, gate_md = _mutation_gate(
        "移动文件（预览）",
        [
            f"- **drive_id**：`{args.drive_id}`",
            f"- **file_id**：`{args.file_id}`",
            f"- **目标 drive_id**：`{args.dst_drive_id}`",
            f"- **目标 parent_id**：`{args.dst_parent_id}`",
        ],
        getattr(args, "confirm", False),
    )
    if stop:
        _out(gate_md, None)
        return
    resp = move_file(
        drive_id=args.drive_id,
        file_id=args.file_id,
        dst_drive_id=args.dst_drive_id,
        dst_parent_id=args.dst_parent_id,
        secure_type=getattr(args, "secure_type", None),
    )
    data = _check_resp(resp)
    md = ["## 已移动文件", "", f"文件 `{args.file_id}` 已移动。"]
    _out(md, data if data is not None else resp)


def cmd_file_copy(args):
    """复制文件。POST /v7/drives/{drive_id}/files/{file_id}/copy"""
    is_dry_run, gate_md = _mutation_gate(
        "复制文件（预览）",
        [
            f"- **drive_id**：`{args.drive_id}`",
            f"- **file_id**：`{args.file_id}`",
            f"- **目标 drive_id**：`{args.dst_drive_id}`",
            f"- **目标 parent_id**：`{args.dst_parent_id}`",
        ],
        getattr(args, "confirm", False),
    )
    if is_dry_run:
        _out(gate_md, None)
        return

    resp = copy_file(
        drive_id=args.drive_id,
        file_id=args.file_id,
        dst_drive_id=args.dst_drive_id,
        dst_parent_id=args.dst_parent_id,
        secure_type=getattr(args, "secure_type", None),
    )
    data = _check_resp(resp)
    md = ["## 已复制文件", "", f"文件 `{args.file_id}` 已发起复制。"]
    _out(md, data if data is not None else resp)

def cmd_file_rename(args):
    """重命名文件（夹）。POST /v7/drives/{drive_id}/files/{file_id}/rename"""
    is_dry_run, gate_md = _mutation_gate(
        "重命名文件（预览）",
        [
            f"- **drive_id**：`{args.drive_id}`",
            f"- **file_id**：`{args.file_id}`",
            f"- **新名称**：{args.dst_name}",
        ],
        getattr(args, "confirm", False),
    )
    if is_dry_run:
        _out(gate_md, None)
        return

    resp = rename_file(args.drive_id, args.file_id, args.dst_name)
    data = _check_resp(resp)
    md = ["## 已重命名文件", "", f"文件 `{args.file_id}` 已重命名为 **{args.dst_name}**。"]
    _out(md, data if data is not None else resp)


def cmd_file_save_as(args):
    """文件另存为。POST /v7/drives/{drive_id}/files/{file_id}/save_as"""
    is_dry_run, gate_md = _mutation_gate(
        "文件另存为（预览）",
        [
            f"- **drive_id**：`{args.drive_id}`",
            f"- **file_id**：`{args.file_id}`",
            f"- **目标 drive_id**：`{args.dst_drive_id}`",
            f"- **目标 parent_id**：`{args.dst_parent_id}`",
            f"- **名称**：{getattr(args, 'name', None) or '-'}",
        ],
        getattr(args, "confirm", False),
    )
    if is_dry_run:
        _out(gate_md, None)
        return

    resp = save_as_file(
        drive_id=args.drive_id,
        file_id=args.file_id,
        dst_drive_id=args.dst_drive_id,
        dst_parent_id=args.dst_parent_id,
        name=getattr(args, "name", None),
        on_name_conflict=getattr(args, "on_name_conflict", None),
    )
    data = _check_resp(resp)
    md = ["## 已另存为文件", "", f"源文件 `{args.file_id}` 已发起另存为。"]
    _out(md, data if data is not None else resp)


def cmd_file_check_name(args):
    """检查文件名是否存在。POST /v7/drives/{drive_id}/files/{parent_id}/check_name"""
    resp = check_name_exists(args.drive_id, args.parent_id, args.name)
    data = _check_resp(resp)
    exists = (data or {}).get("is_exist")
    md = ["## 文件名检查", "", f"- 名称：**{args.name}**", f"- 是否存在：**{exists}**"]
    _out(md, data if data is not None else resp)


def cmd_file_open_link(args):
    """开启文件分享。POST /v7/drives/{drive_id}/files/{file_id}/open_link"""
    # Sharing endpoints require the concrete drive ID. Resolve logical aliases
    # such as `private` before both the preview and the mutating request.
    drive_id = _get_drive_id(args.drive_id)
    opts = None
    raw_opts = (getattr(args, "opts_json", None) or "").strip()
    if raw_opts:
        try:
            parsed = json.loads(raw_opts)
            if isinstance(parsed, dict):
                opts = parsed
            else:
                _err("--opts-json 必须是 JSON 对象")
        except json.JSONDecodeError:
            _err("--opts-json 不是合法 JSON")
    scope = getattr(args, "scope", None)
    is_dry_run, gate_md = _mutation_gate(
        "开启文件分享（预览）",
        [
            f"- **drive_id**：`{drive_id}`（输入：`{args.drive_id}`）",
            f"- **file_id**：`{args.file_id}`",
            f"- **scope**：{scope if scope is not None else '-'}",
        ],
        getattr(args, "confirm", False),
    )
    if is_dry_run:
        _out(gate_md, None)
        return

    resp = open_file_link(
        drive_id=drive_id,
        file_id=args.file_id,
        opts=opts,
        role_id=getattr(args, "role_id", None),
        scope=scope,
    )
    data = _check_resp(resp)
    md = ["## 已开启文件分享", "", f"文件 `{args.file_id}` 已开启分享。"]
    _out(md, data if data is not None else resp)


def cmd_file_close_link(args):
    """取消文件分享。POST /v7/drives/{drive_id}/files/{file_id}/close_link"""
    drive_id = _get_drive_id(args.drive_id)
    mode = args.mode or "pause"
    stop, gate_md = _mutation_gate(
        "取消文件分享（预览）",
        [
            f"- **drive_id**：`{drive_id}`（输入：`{args.drive_id}`）",
            f"- **file_id**：`{args.file_id}`",
            f"- **mode**：{mode}",
        ],
        getattr(args, "confirm", False),
    )
    if stop:
        _out(gate_md, None)
        return
    resp = close_file_link(drive_id, args.file_id, mode=mode)
    data = _check_resp(resp)
    md = ["## 已取消文件分享", "", f"文件 `{args.file_id}` 已关闭分享（mode={mode}）。"]
    _out(md, data if data is not None else resp)


def cmd_ai_search(args):
    """文件智能搜索（多路语义召回）。POST /v7/files/ai_search"""
    keyword = (getattr(args, "keyword", None) or "").strip()
    if not keyword:
        _err("请指定搜索关键词，例如: run.py ai-search 项目周报")
    resp = ai_search(
        keyword=keyword,
        doc_qa_recall_strategy=args.recall_strategy or "all",
        page_size=args.page_size or 20,
        page_token=(getattr(args, "page_token", None) or "").strip() or None,
        file_exts=_split_csv(getattr(args, "file_exts", None)),
        exclude_file_exts=_split_csv(getattr(args, "exclude_file_exts", None)),
        drive_ids=_split_csv(getattr(args, "drive_ids", None)),
        parent_ids=_split_csv(getattr(args, "parent_ids", None)),
        scopes=_split_csv(getattr(args, "scopes", None)),
        with_total=not getattr(args, "no_total", False),
        with_permission=getattr(args, "with_permission", None),
        with_drive=getattr(args, "with_drive", None),
    )
    data = _check_resp(resp)
    items = (data or {}).get("items") or []
    total = (data or {}).get("total")
    next_token = (data or {}).get("next_page_token") or ""

    md = ["## 文件智能搜索结果", ""]
    md.append(f"关键词：**{keyword}**")
    md.append(f"召回策略：**{args.recall_strategy or 'all'}**")
    md.append(f"本页共 **{len(items)}** 条" + (f"，共 **{total}** 条" if total is not None else "") + "。")
    md.append("")
    for i, item in enumerate(items, 1):
        fi = (item.get("file") or item) if isinstance(item, dict) else {}
        name = fi.get("name", "-")
        file_id = fi.get("id", "-")
        size = fi.get("size", "-")
        link_url = fi.get("link_url", "")
        score = item.get("score", "")
        md.append(f"{i}. **{name}**")
        detail = f"   > ID: `{file_id}` | 大小: {size}"
        if score:
            detail += f" | 得分: {score}"
        if link_url:
            detail += f" | [链接]({link_url})"
        md.append(detail)
    if next_token:
        md.append("")
        md.append(f"> 更多结果可使用 `ai-search {keyword} --page-token {next_token}` 获取下一页。")
    if len(items) > 1:
        _set_marker(ASK_USER_REQUIRED=True, AMBIGUOUS_RESULTS=len(items))
        md.extend(["", "> 命中多条结果，如需对其中某条执行操作，请先通过 `askUserQuestion` 让用户选择。"])
    _out(md, data if data is not None else resp)


def main():
    parser = argparse.ArgumentParser(description="云文档 Drive（V7）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("upload", help="上传文件到云端（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_path", nargs="?", default=None, help="本地文件路径")
    p.add_argument("--filename", "-n", default=None, help="云端文件名（默认与本地文件相同）")
    p.add_argument("--drive", "-d", default="private", help="云盘ID: private(我的云文档), roaming(漫游箱)，默认 private")
    p.add_argument("--parent", "-p", default="root", help="父目录ID，默认 root")
    p.add_argument("--path", default=None, help="目标路径，如 'folder1/folder2'")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_upload)

    p = sub.add_parser("update", help="更新现有文件（上传新版本覆盖，需提供本地文件路径）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_id", help="文件ID 或 link_id")
    p.add_argument("file_path", help="本地文件路径")
    p.add_argument("--drive", "-d", default="private", help="云盘ID，默认 private")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("write", help="将 Markdown 内容写入文档：智能文档插入，文字/PDF 为转换后覆盖（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_id", help="文件ID 或 link_id")
    p.add_argument("--content", "-c", help="要写入的 Markdown 内容")
    p.add_argument("--file", "-f", help="从本地文件读取 Markdown")
    p.add_argument("--title", help="文档标题（智能文档时使用）")
    p.add_argument("--template", help="DOCX 模板文件路径（文字文档转换时使用）")
    p.add_argument("--mode", "-m", choices=("overwrite", "append"), default="overwrite", help="写入模式：overwrite 从头插入，append 追加，默认 overwrite")
    p.add_argument("--drive", "-d", default="private", help="云盘ID，默认 private")
    p.add_argument("--json", action="store_true", help="仅输出 JSON")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_write)

    p = sub.add_parser("doclibs", help="获取团队文档库列表（GET /v7/doclibs）")
    p.add_argument("--page-size", type=int, default=100, help="分页大小，最大 100")
    p.add_argument("--page-token", default=None, help="分页 token")
    p.add_argument("--user-role", default=None, dest="user_role", help="按角色筛选（逗号分隔）：owner/admin/normal")
    p.add_argument("--json", action="store_true", help="仅输出 JSON")
    p.set_defaults(func=cmd_doclibs)

    p = sub.add_parser("doclib-meta", help="获取单个团队文档库信息（GET /v7/doclib/meta）")
    p.add_argument("drive_id", nargs="?", default=None, help="文档库 drive_id")
    p.add_argument("--json", action="store_true", help="仅输出 JSON")
    p.set_defaults(func=cmd_doclib_meta)

    p = sub.add_parser("list", help="获取文件列表")
    p.add_argument("--drive", "-d", default="private", help="云盘ID，默认 private")
    p.add_argument("--parent", "-p", default="root", help="父目录ID，默认 root")
    p.add_argument("--page-size", "-s", type=int, default=50, help="分页大小，默认50")
    p.add_argument("--page-token", default=None, help="分页 token（从上一次返回的 next_page_token 获取）")
    p.add_argument("--all", action="store_true", help="拉取全部分页（会循环请求直到 next_page_token 为空）")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", help="获取文件详情（支持 file_id 或 link_id）")
    p.add_argument("file_id", nargs="?", default=None, help="文件ID 或 link_id")
    p.add_argument("--drive", "-d", default="private", help="云盘ID（仅当传入为 file_id 时生效），默认 private")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("download", help="下载文件到本地（必须显式指定 --dir）")
    p.add_argument("file_id", nargs="?", default=None, help="文件ID 或 link_id")
    p.add_argument("--dir", "-o", default=None, help="下载目标目录；未提供时应先 askUserQuestion 让用户选择目录")
    p.add_argument("--drive", "-d", default="private", help="云盘ID，默认 private")
    p.set_defaults(func=cmd_download)

    p = sub.add_parser(
        "get-file-content",
        aliases=["extract", "read"],
        help="文档内容提取解析：云文档用 GET .../content，本地文件用 POST exporter（自动识别）",
    )
    p.add_argument("file_id", nargs="?", default=None, help="文件ID、link_id 或本地文件路径")
    p.add_argument("--drive", "-d", default="private", help="云盘ID，默认 private（云文档时使用）")
    p.add_argument(
        "--include-elements",
        "-ie",
        default=None,
        type=_parse_include_elements_cli,
        metavar="ELEMENTS",
        help="抽取元素，半角逗号分隔；para（未写会自动补上）、table、component、textbox、all（仅可单独使用）；对应 include_elements。云文档默认 all，本地 PDF 等不传以避免图片渲染",
    )
    p.add_argument("--raw", "-r", action="store_true", help="仅输出 Markdown 正文，无摘要头和原始 JSON")
    p.add_argument(
        "--json",
        action="store_true",
        help="仅输出 JSON（含 content、extract_meta；默认不含 raw，需完整 KDC 时加 --include-raw；PPT + --format kdc 时即使未写 --include-raw 也会自动附带 raw）",
    )
    p.add_argument(
        "--include-raw",
        action="store_true",
        help="与 --json 联用：额外输出完整 raw（KDC/原始响应）；PPT 建议显式加上，未写时 --format kdc --json 对 .pptx 等也会自动附带",
    )
    p.add_argument(
        "--output-file",
        metavar="PATH",
        default=None,
        help="将完整抽取结果（content + raw，均未截断）写入文件；stdout 仅返回摘要与 artifact_path",
    )
    p.add_argument(
        "--format",
        dest="extract_format",
        choices=("auto", "markdown", "kdc", "plain"),
        default="auto",
        help="抽取格式：auto 按扩展名自动选择（默认）；文字文档 doc.comments 等内嵌批注需 kdc（见 SKILL.md）",
    )
    p.add_argument(
        "--workbook-range",
        "-wr",
        default=None,
        type=_parse_workbook_range_cli,
        metavar="RANGE",
        help="表格解析范围（convert_options.workbook_range）。JSON 或简写 sheetFrom:sheetTo,rowFrom:rowTo,colFrom:colTo，如 1:1,0:29,0:15",
    )
    p.add_argument(
        "--convert-options",
        default=None,
        type=_parse_convert_options_cli,
        metavar="JSON",
        help="额外 convert_options（JSON 对象），与 --workbook-range 合并；如 ignore_display_text",
    )
    p.add_argument(
        "--extract-mode",
        choices=("sync", "async", "auto"),
        default=None,
        help="云文档抽取模式：默认 async（POST 创建任务 + GET mode=async 轮询）；sync 为 GET 同步；auto 由服务端决定",
    )
    p.add_argument(
        "--component-file-id",
        default=None,
        help="POST body 级 file_id，用于 ksheet/ap 等基础存储附件组件（需平台配置 weboffice aksk）",
    )
    p.add_argument("--type", "-t", choices=("doc", "ap", "pdf", "ppt"), help="文档类型（可选，默认按扩展名检测）")
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("create", help="统一创建文件/文件夹/快捷方式，POST /v7/drives/{drive_id}/files/{parent_id}/create（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_name", help="名称，如 反馈管理.dbt、文档.otl 或 项目资料")
    p.add_argument("--drive", "-d", default="private", help="云盘：private/roaming/special，默认 private")
    p.add_argument("--parent-id", default=None, dest="parent_id", help="父目录 ID，默认 0")
    p.add_argument("--path", "-p", default=None, help="父路径，如 我的文档 或 我的文档/子目录")
    p.add_argument("--file-type", default="file", dest="file_type", choices=("folder", "file", "shortcut"), help="类型，默认 file")
    p.add_argument("--file-id", default=None, dest="file_id", help="快捷方式引用 file_id（file-type=shortcut 时可用）")
    p.add_argument("--on-conflict", default="rename", choices=("fail", "rename", "overwrite", "replace"), dest="on_conflict", help="重名处理策略，默认 rename")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("link-meta", help="根据 link_id 获取分享链接信息（含 file_id），用于 link_id 换 file_id")
    p.add_argument("link_id", nargs="?", default=None, help="分享链接 ID（如云文档消息中的 link_id）")
    p.set_defaults(func=cmd_link_meta)

    p = sub.add_parser("search", help="搜索云文档文件 GET /v7/files/search")
    p.add_argument("keyword", nargs="?", default=None, help="搜索关键词")
    p.add_argument("--type", "-t", default="all", choices=("file_name", "content", "all"), help="搜索类型：file_name(文件名)/content(正文)/all(全部)，默认 all")
    p.add_argument("--scope", default=None, help="搜索范围，逗号分隔：all, personal_drive, group_drive, latest, share_by_me, share_to_me, recycle, latest_opened, latest_edited")
    p.add_argument("--file-type", default=None, choices=("folder", "file", "shortcut"), dest="file_type", help="文件类型过滤：folder(文件夹)/file(文件)/shortcut(快捷方式)")
    p.add_argument("--file-exts", default=None, dest="file_exts", help="文件后缀过滤（逗号分隔），如 docx,pdf,xlsx")
    p.add_argument("--exclude-file-exts", default=None, dest="exclude_file_exts", help="排除文件后缀（逗号分隔），如 tmp,bak")
    p.add_argument("--drive-ids", default=None, dest="drive_ids", help="搜索盘 ID 列表（逗号分隔），限定在指定云盘中搜索")
    p.add_argument("--parent-ids", default=None, dest="parent_ids", help="搜索目录 ID 列表（逗号分隔），限定在指定目录中搜索")
    p.add_argument("--creator-ids", default=None, dest="creator_ids", help="创建者 user_id 列表（逗号分隔），筛选指定用户创建的文件")
    p.add_argument("--time-type", default=None, choices=("ctime", "mtime", "otime", "stime"), dest="time_type", help="时间筛选维度：ctime(创建)/mtime(修改)/otime(打开)/stime(分享)，传 --start-time/--end-time 时默认 mtime")
    p.add_argument("--start-time", type=int, default=None, dest="start_time", help="时间范围起始，Unix 秒级时间戳")
    p.add_argument("--end-time", type=int, default=None, dest="end_time", help="时间范围结束，Unix 秒级时间戳")
    p.add_argument("--order", default=None, choices=("desc", "asc"), help="排序方式：desc(降序)/asc(升序)")
    p.add_argument("--order-by", default=None, choices=("ctime", "mtime"), dest="order_by", help="排序字段：ctime(创建时间)/mtime(修改时间)")
    p.add_argument("--page-size", type=int, default=20, help="每页条数，默认 20，最大 500")
    p.add_argument("--page-token", default=None, help="分页 token（上一页返回的 next_page_token）")
    p.add_argument("--no-total", action="store_true", dest="no_total", help="不返回总条数")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("ai-search", help="文件智能搜索（多路语义召回）POST /v7/files/ai_search")
    p.add_argument("keyword", nargs="?", default=None, help="搜索关键词")
    p.add_argument("--recall-strategy", default="all", choices=("paragraph", "paragraph_embedding", "all"), dest="recall_strategy", help="召回策略：paragraph/paragraph_embedding/all，默认 all")
    p.add_argument("--page-size", type=int, default=20, help="每页条数，默认 20")
    p.add_argument("--page-token", default=None, help="分页 token（上一页返回的 next_page_token）")
    p.add_argument("--file-exts", default=None, dest="file_exts", help="文件后缀过滤（逗号分隔），如 docx,pdf")
    p.add_argument("--exclude-file-exts", default=None, dest="exclude_file_exts", help="排除文件后缀（逗号分隔）")
    p.add_argument("--drive-ids", default=None, dest="drive_ids", help="搜索盘列表（逗号分隔）")
    p.add_argument("--parent-ids", default=None, dest="parent_ids", help="搜索目录列表（逗号分隔）")
    p.add_argument("--scopes", default=None, help="搜索范围（逗号分隔）")
    p.add_argument("--no-total", action="store_true", dest="no_total", help="不返回总条数")
    p.add_argument("--with-permission", action="store_const", const=True, default=None, dest="with_permission", help="返回文件操作权限")
    p.add_argument("--with-drive", action="store_const", const=True, default=None, dest="with_drive", help="返回驱动盘信息")
    p.set_defaults(func=cmd_ai_search)

    p = sub.add_parser("latest", help="获取最近列表（最近打开/编辑文档）")
    p.add_argument("--page-size", type=int, default=50, help="分页大小，默认 50，最大 500")
    p.add_argument("--page-token", default=None, help="分页 token（上一页返回的 next_page_token）")
    p.add_argument("--with-permission", action="store_const", const=True, default=None, dest="with_permission", help="返回文件操作权限")
    p.add_argument("--with-link", action="store_const", const=True, default=None, dest="with_link", help="返回文件分享信息")
    p.add_argument("--include-exts", default=None, help="按后缀过滤（逗号分隔），例如 md,docx")
    p.add_argument("--exclude-exts", default=None, help="按后缀排除（逗号分隔）")
    p.add_argument("--include-creators", default=None, help="按创建者过滤（逗号分隔）")
    p.add_argument("--exclude-creators", default=None, help="按创建者排除（逗号分隔）")
    p.set_defaults(func=cmd_latest)

    p = sub.add_parser("file-versions", help="获取文件历史版本列表（GET /v7/drives/{drive_id}/files/{file_id}/versions）")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID 或 link_id")
    p.add_argument("--drive", "-d", default="private", help="云盘 ID，默认 private（仅当传入 file_id 时生效）")
    p.add_argument("--page-size", type=int, default=20, help="分页大小，默认 20；命令层每次最多展示 20 条")
    p.add_argument("--page-token", default=None, help="分页 token")
    p.add_argument("--with-comment", action="store_const", const=True, default=True, help="返回版本备注（默认开启）")
    p.add_argument("--without-comment", action="store_const", const=False, dest="with_comment", help="不返回版本备注")
    p.add_argument("--with-ext-attrs", action="store_const", const=True, default=None, dest="with_ext_attrs", help="返回版本扩展属性")
    p.set_defaults(func=cmd_file_versions)

    p = sub.add_parser("file-version-diff", help="比较两个历史版本：下载两个版本、提取 Markdown、再用 diff 对比")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID 或 link_id")
    p.add_argument("version_a", nargs="?", default=None, help="版本号 A；未提供时需 askUserQuestion 向用户索取")
    p.add_argument("version_b", nargs="?", default=None, help="版本号 B；未提供时需 askUserQuestion 向用户索取")
    p.add_argument("--drive", "-d", default="private", help="云盘 ID，默认 private（仅当传入 file_id 时生效）")
    p.set_defaults(func=cmd_file_version_diff)

    p = sub.add_parser("star", aliases=["favorites"], help="获取收藏列表（GET /v7/drive_star/items）")
    p.add_argument("--page-size", type=int, default=50, help="分页大小，默认 50，最大 200")
    p.add_argument("--page-token", default=None, help="分页 token（上一页返回的 next_page_token）")
    p.add_argument("--order", default=None, choices=("desc", "asc"), help="排序方向：desc/asc")
    p.add_argument("--order-by", default=None, help="排序字段：ctime/file_mtime/source/fname/fsize（按接口为准）")
    p.add_argument("--with-permission", action="store_const", const=True, default=None, dest="with_permission", help="返回文件操作权限")
    p.add_argument("--with-link", action="store_const", const=True, default=None, dest="with_link", help="返回文件分享信息")
    p.add_argument("--include-exts", default=None, help="按后缀过滤（逗号分隔），例如 md,docx")
    p.add_argument("--exclude-exts", default=None, help="按后缀排除（逗号分隔）")
    p.set_defaults(func=cmd_star)

    p = sub.add_parser("star-add-items", help="批量添加收藏项（POST /v7/drive_star/items/batch_create）")
    p.add_argument("--objects", default=None, help="对象 ID 列表，逗号分隔")
    p.add_argument("--objects-json", default=None, help="对象数组 JSON（array）")
    p.add_argument("--items-json", default=None, help="兼容旧字段 items 的数组 JSON（array）")
    p.set_defaults(func=cmd_star_add_items)

    p = sub.add_parser("star-remove-items", help="批量移除收藏项（POST /v7/drive_star/items/batch_delete）")
    p.add_argument("--objects", default=None, help="对象 ID 列表，逗号分隔")
    p.add_argument("--objects-json", default=None, help="对象数组 JSON（array）")
    p.add_argument("--item-ids", default=None, dest="item_ids", help="兼容旧字段 item_ids，逗号分隔")
    p.set_defaults(func=cmd_star_remove_items)

    p = sub.add_parser("tags", aliases=["user-tags"], help="分页获取自定义标签列表（v7: GET /v7/drive_labels）")
    p.add_argument("--allotee-type", default="user", choices=("user", "group", "app"), dest="allotee_type", help="标签归属类型：user/group/app，默认 user")
    p.add_argument("--allotee-id", default=None, dest="allotee_id", help="标签归属 ID；type 为 user 时通常可不传")
    p.add_argument("--label-type", default="custom", choices=("custom", "system"), dest="label_type", help="标签类型：custom/system，默认 custom")
    p.add_argument("--page-size", type=int, default=20, dest="page_size", help="分页大小，默认 20，最大 500")
    p.add_argument("--page-token", default=None, dest="page_token", help="分页 token")
    p.set_defaults(func=cmd_tags)

    p = sub.add_parser("tag-get", help="获取单个标签信息（GET /v7/drive_labels/{label_id}/meta）")
    p.add_argument("label_id", nargs="?", default=None, help="标签 ID")
    p.set_defaults(func=cmd_tag_get)

    p = sub.add_parser("tag-objects", help="分页获取标签下对象（GET /v7/drive_labels/{label_id}/objects）")
    p.add_argument("label_id", nargs="?", default=None, help="标签 ID")
    p.add_argument("--page-size", type=int, default=20, dest="page_size", help="分页大小，默认 20，最大 100")
    p.add_argument("--page-token", default=None, dest="page_token", help="分页 token")
    p.add_argument("--include-exts", default=None, help="按后缀包含过滤（逗号分隔）")
    p.add_argument("--exclude-exts", default=None, help="按后缀排除过滤（逗号分隔）")
    p.add_argument("--file-type", default="file", choices=("file", "folder", "short_cut"), dest="file_type", help="对象类型，默认 file")
    p.add_argument("--no-resolve-meta", action="store_false", default=True, dest="resolve_meta", help="不自动解析对象 ID 对应的文件名/链接")
    p.set_defaults(func=cmd_tag_objects)

    p = sub.add_parser("tag-create", help="创建自定义标签（POST /v7/drive_labels/create）")
    p.add_argument("--name", required=True, help="标签名称")
    p.add_argument("--allotee-type", default="user", choices=("user", "group", "app"), dest="allotee_type", help="标签归属类型，默认 user")
    p.add_argument("--allotee-id", default=None, dest="allotee_id", help="标签归属 ID；type 为 user 时通常可不传")
    p.add_argument("--label-type", default="custom", choices=("custom", "system"), dest="label_type", help="标签类型，默认 custom")
    p.add_argument("--attr", default=None, help="标签自定义属性")
    p.add_argument("--rank", type=float, default=None, help="标签排序值（可选）")
    p.set_defaults(func=cmd_tag_create)

    p = sub.add_parser("tag-add-objects", help="批量添加标签对象（POST /v7/drive_labels/{label_id}/objects/batch_add）")
    p.add_argument("label_id", nargs="?", default=None, help="标签 ID")
    p.add_argument("--objects", default=None, help="对象 ID 列表，逗号分隔")
    p.add_argument("--objects-json", default=None, help="完整对象数组 JSON（array）")
    p.set_defaults(func=cmd_tag_add_objects)

    p = sub.add_parser("tag-remove-objects", help="批量移除标签对象（POST /v7/drive_labels/{label_id}/objects/batch_remove）")
    p.add_argument("label_id", nargs="?", default=None, help="标签 ID")
    p.add_argument("--objects", default=None, help="对象 ID 列表，逗号分隔")
    p.add_argument("--objects-json", default=None, help="完整对象数组 JSON（array）")
    p.set_defaults(func=cmd_tag_remove_objects)

    p = sub.add_parser("deleted-list", help="获取回收站文件列表（GET /v7/deleted_files）")
    p.add_argument("--drive-id", default=None, dest="drive_id", help="按云盘 ID 过滤")
    p.add_argument("--with-ext-attrs", action="store_const", const=True, default=None, dest="with_ext_attrs", help="返回扩展属性")
    p.add_argument("--with-drive", action="store_const", const=True, default=None, dest="with_drive", help="返回 drive 信息")
    p.add_argument("--page-size", type=int, default=20, help="分页大小，默认 20，最大 100")
    p.add_argument("--page-token", default=None, help="分页 token")
    p.set_defaults(func=cmd_deleted_list)

    p = sub.add_parser("deleted-restore", help="还原回收站文件（POST /v7/deleted_files/{file_id}/restore）")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID")
    p.set_defaults(func=cmd_deleted_restore)

    # -- 全文评论 --
    p = sub.add_parser("comment-list", help="获取文档评论列表（GET /v7/documents/{file_id}/comments/{origin_id}/list）")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID 或 link_id")
    p.add_argument("--origin-id", default="0", dest="origin_id", help="根评论 ID，默认 0（查根评论）；传根评论 ID 可查子评论")
    p.add_argument("--page-size", type=int, default=10, help="分页大小，根评论最大 10，子评论最大 100，默认 10")
    p.add_argument("--page-token", default=None, help="分页 token")
    p.set_defaults(func=cmd_comment_list)

    p = sub.add_parser("comment-create", help="创建全文评论（POST /v7/documents/{file_id}/comments/create）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID 或 link_id")
    p.add_argument("--content", "-c", required=True, help="评论内容（1-5000 字）")
    p.add_argument("--origin-id", default=None, dest="origin_id", help="回复的根评论 ID（用于创建子评论）")
    p.add_argument("--reply-id", default=None, dest="reply_id", help="回复的评论 ID")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_comment_create)

    p = sub.add_parser("comment-update", help="更新全文评论内容（POST /v7/documents/{file_id}/comments/{comment_id}/update）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID 或 link_id")
    p.add_argument("comment_id", nargs="?", default=None, help="评论 ID")
    p.add_argument("--content", "-c", required=True, help="新的评论内容（1-5000 字）")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_comment_update)

    p = sub.add_parser("comment-delete", help="删除全文评论（POST /v7/documents/{file_id}/comments/{comment_id}/delete）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("file_id", nargs="?", default=None, help="文件 ID 或 link_id")
    p.add_argument("comment_id", nargs="?", default=None, help="评论 ID")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_comment_delete)

    p = sub.add_parser("file-move", help="移动文件（POST /v7/drives/{drive_id}/files/{file_id}/move）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="源 drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--dst-drive-id", required=True, dest="dst_drive_id", help="目标 drive_id")
    p.add_argument("--dst-parent-id", required=True, dest="dst_parent_id", help="目标目录 parent_id")
    p.add_argument("--secure-type", default=None, dest="secure_type", choices=("decrypt", "encrypt"), help="加密文档迁移策略")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_move)

    p = sub.add_parser("file-copy", help="复制文件（POST /v7/drives/{drive_id}/files/{file_id}/copy）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="源 drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--dst-drive-id", required=True, dest="dst_drive_id", help="目标 drive_id")
    p.add_argument("--dst-parent-id", required=True, dest="dst_parent_id", help="目标目录 parent_id")
    p.add_argument("--secure-type", default=None, dest="secure_type", choices=("decrypt", "encrypt"), help="加密文档迁移策略")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_copy)

    p = sub.add_parser("file-rename", help="重命名文件（夹）（POST /v7/drives/{drive_id}/files/{file_id}/rename）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--dst-name", required=True, dest="dst_name", help="新名称")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_rename)

    p = sub.add_parser("file-save-as", help="文件另存为（POST /v7/drives/{drive_id}/files/{file_id}/save_as）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="源 drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--dst-drive-id", required=True, dest="dst_drive_id", help="目标 drive_id")
    p.add_argument("--dst-parent-id", required=True, dest="dst_parent_id", help="目标目录 parent_id")
    p.add_argument("--name", default=None, help="目标文件名")
    p.add_argument("--on-name-conflict", default=None, dest="on_name_conflict", choices=("fail", "rename", "overwrite", "replace"), help="重名处理策略")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_save_as)

    p = sub.add_parser("file-check-name", help="检查文件名是否存在（POST /v7/drives/{drive_id}/files/{parent_id}/check_name）")
    p.add_argument("drive_id", help="drive_id")
    p.add_argument("parent_id", help="parent_id")
    p.add_argument("--name", required=True, help="待检查名称")
    p.set_defaults(func=cmd_file_check_name)

    p = sub.add_parser("file-open-link", help="开启文件分享（POST /v7/drives/{drive_id}/files/{file_id}/open_link）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--role-id", default=None, dest="role_id", help="权限角色 ID")
    p.add_argument("--scope", default=None, help="分享范围，如 anyone/company/users")
    p.add_argument("--opts-json", default=None, dest="opts_json", help="分享选项 JSON 对象")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_open_link)

    p = sub.add_parser("file-close-link", help="取消文件分享（POST /v7/drives/{drive_id}/files/{file_id}/close_link）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--mode", default="pause", choices=("pause", "delete"), help="取消模式，默认 pause")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_close_link)

    p = sub.add_parser("file-delete", help="将文件移入回收站（POST /v7/drives/{drive_id}/files/{file_id}/delete）（默认 dry-run，追加 --confirm 才会执行）")
    p.add_argument("drive_id", help="drive_id")
    p.add_argument("file_id", help="文件 ID")
    p.add_argument("--confirm", action="store_true", help="确认执行；默认仅预览（dry-run）")
    p.set_defaults(func=cmd_file_delete)

    args = parser.parse_args()
    _set_marker(ACTION_SELECTED=f"drive.{args.cmd}")
    try:
        args.func(args)
    except ValueError as e:
        _err(str(e))
    except Exception as e:
        _err("请求失败: " + str(e))


if __name__ == "__main__":
    main()
