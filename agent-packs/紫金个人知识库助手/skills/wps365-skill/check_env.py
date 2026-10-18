#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wps365-skill 环境自检脚本。

用法:
    python <包根>/check_env.py

作用:
    检查当前 Python 解释器是否满足 wps365-skill 的运行要求：
      - 依赖: requests, pycryptodome (import 名 Crypto)
      - 环境变量: WPS_SID（私网另需 PRIVATE=1、X_ORIGIN）

缺依赖时输出安装命令；全部通过则返回 0，否则返回 1。
本脚本不依赖第三方库，可在任意解释器下运行。
"""
import importlib
import os
import platform
import sys

REQUIRED = [
    ("requests", "requests"),
    ("Crypto", "pycryptodome"),
]
HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS = os.path.join(HERE, "requirements.txt")

WIDTH = 56


def banner(text):
    print("=" * WIDTH)
    print(text)
    print("=" * WIDTH)


def line(tag, text):
    print("[%s] %s" % (tag, text))


def main():
    banner("wps365-skill 环境自检")
    line("INFO", "解释器: %s" % sys.executable)
    line("INFO", "版本  : %s" % platform.python_version())
    line("INFO", "平台  : %s %s" % (platform.system(), platform.machine()))
    print("-" * WIDTH)

    ok = True
    for mod, pkg in REQUIRED:
        try:
            m = importlib.import_module(mod)
            ver = getattr(m, "__version__", "?")
            line("OK", "%s (%s) 已安装, 版本 %s" % (mod, pkg, ver))
        except Exception as exc:
            ok = False
            line("FAIL", "%s (%s) 缺失或导入失败: %s" % (mod, pkg, exc))

    sid = os.environ.get("WPS_SID")
    if sid:
        line("OK", "WPS_SID 已设置")
    else:
        ok = False
        line("FAIL", "WPS_SID 未设置")
    line("INFO", "PRIVATE = %s" % os.environ.get("PRIVATE", "(未设置)"))
    line("INFO", "X_ORIGIN = %s" % os.environ.get("X_ORIGIN", "(未设置)"))
    print("-" * WIDTH)

    if ok:
        line("OK", "环境就绪, 可直接运行各子模块 run.py")
        return 0

    line("WARN", "环境不完整, 请按以下步骤修复后重跑本脚本:")
    print("  1. 缺依赖: python -m pip install -r %s" % REQUIREMENTS)
    print("  2. 缺环境变量: 设置 WPS_SID (私网再加 PRIVATE=1、X_ORIGIN=<企业地址>)")
    print("  注: 依赖缺失是环境问题, 不是 WPS 授权/连接器问题")
    return 1


if __name__ == "__main__":
    sys.exit(main())
