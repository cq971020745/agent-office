# -*- coding: utf-8 -*-
"""从已登录的紫金协作 Electron Cookie 中取出 wps_sid。

Windows：Local State 里 DPAPI 包装的 AES 密钥 + Cookie v10 AES-256-GCM。
macOS：Keychain「… Safe Storage」密码 + PBKDF2 派生 AES-128-CBC（Chromium/Electron 标准）。
"""
import base64
import hashlib
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

SYSTEM = platform.system()
REQUIREMENTS = Path(__file__).resolve().parent / "requirements.txt"


def _require_crypto():
    """解密前确认 pycryptodome 可用。缺库时不要误报成密钥错误。"""
    try:
        from Crypto.Cipher import AES  # noqa: F401
        from Crypto.Util.Padding import unpad  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "缺少 pycryptodome，无法解密紫金协作 Cookie。"
            "请执行: python -m pip install -r %s" % REQUIREMENTS
        ) from exc


def _aes_gcm_decrypt(key, data):
    from Crypto.Cipher import AES

    nonce, cipher, tag = data[:12], data[12:-16], data[-16:]
    return AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(cipher, tag)


def _aes_cbc_decrypt(key, data):
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad

    iv = b" " * 16
    plain = AES.new(key, AES.MODE_CBC, iv).decrypt(data)
    return unpad(plain, AES.block_size)


def _maybe_strip_integrity_prefix(plain):
    """Chrome/Electron 部分版本在明文前加 32 字节 SHA256。"""
    if len(plain) <= 32:
        return plain
    head = plain[:32]
    if any(b < 32 or b > 126 for b in head):
        return plain[32:]
    return plain


def _decode_plain(plain):
    text = _maybe_strip_integrity_prefix(plain).decode("utf-8", errors="strict").strip()
    if not text:
        raise ValueError("解密结果为空")
    return text


def _dpapi_decrypt(blob):
    import ctypes
    import ctypes.wintypes as wt

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    if not blob:
        raise ValueError("空 DPAPI 密文")
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    in_blob = DATA_BLOB(
        len(blob),
        ctypes.cast(ctypes.create_string_buffer(blob, len(blob)), ctypes.POINTER(ctypes.c_byte)),
    )
    out_blob = DATA_BLOB()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    ):
        raise OSError("CryptUnprotectData 失败, winerr=%s" % ctypes.GetLastError())
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)


def _windows_aes_key(local_state_path):
    data = json.loads(local_state_path.read_text(encoding="utf-8"))
    enc_key_b64 = ((data.get("os_crypt") or {}).get("encrypted_key") or "")
    if not enc_key_b64:
        raise ValueError("Local State 中没有 os_crypt.encrypted_key")
    enc_key = base64.b64decode(enc_key_b64)
    if enc_key.startswith(b"DPAPI"):
        enc_key = enc_key[5:]
    return _dpapi_decrypt(enc_key)


def _macos_keychain_password(service):
    try:
        out = subprocess.check_output(
            ["security", "find-generic-password", "-w", "-s", service],
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    password = out.decode("utf-8", errors="ignore").strip()
    return password or None


def _macos_aes_keys(root):
    """Electron 在 macOS 用 Keychain 密码经 PBKDF2 得到 16 字节 AES 密钥。"""
    names = [
        root.name,
        "zjxiezuo",
        "紫金协作",
        "WPS协作",
        "wpsoffice",
        "Chromium",
        "Electron",
    ]
    services = ["%s Safe Storage" % name for name in names]
    seen = set()
    keys = []
    for service in services:
        if service in seen:
            continue
        seen.add(service)
        password = _macos_keychain_password(service)
        if not password:
            continue
        keys.append(
            hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), b"saltysalt", 1003, dklen=16)
        )
    keys.append(hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1003, dklen=16))
    return keys


def _decrypt_cookie_value(raw, keys):
    blob = bytes(raw or b"")
    if not blob:
        raise ValueError("Cookie 密文为空")
    prefix = blob[:3]
    body = blob[3:]
    errors = []
    if prefix in (b"v10", b"v11"):
        for key in keys:
            try:
                if len(key) == 32:
                    return _decode_plain(_aes_gcm_decrypt(key, body))
            except ImportError:
                raise
            except Exception as exc:
                errors.append("gcm:%s" % exc)
            try:
                if len(key) == 16:
                    return _decode_plain(_aes_cbc_decrypt(key, body))
            except ImportError:
                raise
            except Exception as exc:
                errors.append("cbc:%s" % exc)
        raise ValueError("Cookie 解密失败（已尝试 %s 个密钥）" % len(keys))
    if prefix == b"v20":
        raise ValueError("Cookie 使用 v20 应用绑定加密，当前脚本不支持")
    try:
        return blob.decode("utf-8").strip()
    except UnicodeDecodeError:
        if SYSTEM == "Windows":
            return _decode_plain(_dpapi_decrypt(blob))
        raise ValueError("无法解码 Cookie 明文")


def _cookie_file_candidates(root):
    return [
        root / "Network" / "Cookies",
        root / "Cookies",
        root / "Default" / "Network" / "Cookies",
        root / "Default" / "Cookies",
    ]


def _named_user_data_roots():
    home = Path.home()
    if SYSTEM == "Windows":
        appdata = os.environ.get("APPDATA") or str(home / "AppData" / "Roaming")
        base = Path(appdata)
        return [
            base / "zjxiezuo",
            base / "紫金协作",
            base / "Kingsoft" / "XieZuo",
        ]
    if SYSTEM == "Darwin":
        base = home / "Library" / "Application Support"
        return [
            base / "zjxiezuo",
            base / "紫金协作",
            base / "WPS协作",
            base / "wpsoffice",
            base / "Kingsoft" / "XieZuo",
        ]
    raise EnvironmentError("仅支持 Windows 与 macOS，当前系统: %s" % SYSTEM)


def _scan_support_roots():
    """按目录名缩小扫描范围，避免遍历整个 Application Support。"""
    if SYSTEM == "Windows":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:
        base = Path.home() / "Library" / "Application Support"
    if not base.is_dir():
        return []
    keywords = ("zjxiezuo", "xiezuo", "woa", "wpsoffice", "kingsoft")
    found = []
    try:
        for child in base.iterdir():
            name = child.name.lower()
            if child.is_dir() and any(key in name for key in keywords):
                found.append(child)
    except OSError:
        return []
    return found


def _first_cookie_file(root):
    for cookies in _cookie_file_candidates(root):
        if cookies.is_file():
            return cookies
    return None


def _find_profile_root():
    seen = set()
    ordered = []
    for root in _named_user_data_roots() + _scan_support_roots():
        resolved = str(root)
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(root)
    for root in ordered:
        cookies = _first_cookie_file(root)
        if cookies is None:
            continue
        local_state = root / "Local State"
        # Windows 解密密钥在 Local State；macOS 密钥来自 Keychain。
        # 部分紫金协作 Electron 版本不生成 Local State，不能当成未登录。
        if SYSTEM == "Windows" and not local_state.is_file():
            continue
        return root, cookies, local_state if local_state.is_file() else None
    raise FileNotFoundError(
        "未找到紫金协作登录数据。请先打开「紫金协作」并用 EnUES 登录后再试。"
    )


def zjxiezuo_running():
    try:
        if SYSTEM == "Windows":
            out = subprocess.check_output(
                ["tasklist", "/FI", "IMAGENAME eq zjxiezuo.exe", "/FO", "CSV", "/NH"],
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            text = out.decode("gbk", errors="ignore").lower()
            return "zjxiezuo.exe" in text
        out = subprocess.check_output(["pgrep", "-ifl", "zjxiezuo|紫金协作"], stderr=subprocess.DEVNULL)
        return bool(out.strip())
    except Exception:
        return False


def _collect_keys(root, local_state):
    keys = []
    if SYSTEM == "Windows":
        if local_state is None or not Path(local_state).is_file():
            raise FileNotFoundError("Windows 解密需要 Local State，当前配置目录里没有该文件")
        keys.append(_windows_aes_key(local_state))
        return keys
    keys.extend(_macos_aes_keys(root))
    if not keys:
        raise ValueError(
            "未从 Keychain 读到紫金协作 Safe Storage 密码。请在弹窗中允许访问钥匙串后重试。"
        )
    return keys


def _pick_sid_row(rows):
    scored = []
    for host, name, enc in rows:
        host = host or ""
        score = 0
        if name == "wps_sid":
            score += 10
        if host == "wps.zjholdings.cn":
            score += 5
        elif host.endswith("wps.zjholdings.cn"):
            score += 3
        scored.append((score, host, enc))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0] if scored else None


def extract_session():
    """返回 {WPS_SID, PRIVATE, X_ORIGIN}。失败抛出带中文说明的异常。"""
    _require_crypto()
    root, cookies_path, local_state = _find_profile_root()
    keys = _collect_keys(root, local_state)
    tmp = Path(tempfile.gettempdir()) / "zjxiezuo_cookies_wps365_env.db"
    shutil.copy2(cookies_path, tmp)
    try:
        con = sqlite3.connect(str(tmp))
        try:
            rows = con.execute(
                "SELECT host_key, name, encrypted_value FROM cookies "
                "WHERE name IN ('wps_sid', 'wps_sids')"
            ).fetchall()
        finally:
            con.close()
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass

    picked = _pick_sid_row(rows)
    if not picked:
        raise LookupError(
            "紫金协作 Cookie 中没有 wps_sid。请确认已用 EnUES 登录紫金协作后再试。"
        )
    _, host, enc = picked
    sid = _decrypt_cookie_value(enc, keys)
    host = (host or "").lstrip(".")
    if not host:
        raise ValueError("Cookie host 为空，无法推导 X_ORIGIN")
    return {
        "WPS_SID": sid,
        "PRIVATE": "1",
        "X_ORIGIN": "https://%s" % host,
        "profile_root": str(root),
    }
