# -*- coding: utf-8 -*-
"""用户目录 sidecar：补齐当前进程里缺失的 WPS 365 环境变量。

Agent 子进程写入的用户环境变量不会立刻进入已打开的 Cursor/WorkBuddy。
各 365 脚本在启动时读取此文件，同一会话内即可用上刚导入的凭证。

路径与 wps365-env/run.py 必须保持一致。
"""
import json
import os
from pathlib import Path

SIDECAR_PATH = Path.home() / ".wps365" / "env.json"
SIDECAR_KEYS = ("WPS_SID", "PRIVATE", "X_ORIGIN")


def apply_sidecar_env():
    """用 sidecar 填补 os.environ 中缺失的键，已存在的环境变量不覆盖。"""
    if not SIDECAR_PATH.is_file():
        return False
    try:
        data = json.loads(SIDECAR_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    if not isinstance(data, dict):
        return False
    applied = False
    for key in SIDECAR_KEYS:
        current = (os.environ.get(key) or "").strip()
        incoming = data.get(key)
        if current or not isinstance(incoming, str) or not incoming.strip():
            continue
        os.environ[key] = incoming.strip()
        applied = True
    return applied


def save_sidecar(values):
    """写入 sidecar。只保存 SIDECAR_KEYS，目录仅当前用户可写。"""
    payload = {}
    for key in SIDECAR_KEYS:
        value = values.get(key)
        if isinstance(value, str) and value.strip():
            payload[key] = value.strip()
    SIDECAR_PATH.parent.mkdir(parents=True, exist_ok=True)
    SIDECAR_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    try:
        os.chmod(SIDECAR_PATH, 0o600)
    except OSError:
        pass


def env_snapshot():
    """供自检展示：不返回 WPS_SID 明文。"""
    sid = (os.environ.get("WPS_SID") or "").strip()
    return {
        "wps_sid_set": bool(sid),
        "private": (os.environ.get("PRIVATE") or "").strip(),
        "x_origin": (os.environ.get("X_ORIGIN") or "").rstrip("/"),
        "cloud_ide": os.environ.get("CLOUD_IDE") == "1",
        "sidecar_exists": SIDECAR_PATH.is_file(),
    }


def is_private_ready(snap=None):
    """紫金本地私网就绪：有 SID，且云端对话或已配 PRIVATE + X_ORIGIN。"""
    snap = snap if snap is not None else env_snapshot()
    if not snap["wps_sid_set"]:
        return False
    if snap["cloud_ide"]:
        return True
    return bool(snap["private"] and snap["x_origin"])
