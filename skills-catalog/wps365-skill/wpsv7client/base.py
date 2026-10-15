# -*- coding: utf-8 -*-
"""
WPS V7 客户端基类。
支持公网 / 私网（云端对话 / 本地对话）三种部署模式，通过环境变量自动切换。

公网（默认）：         WPS_SID + https://api.wps.cn
私网 · 云端对话：      PRIVATE + CLOUD_IDE=1 → encs-pri-api-gateway（域名直连，不加密）
私网 · 本地对话：      PRIVATE + X_ORIGIN    → {X_ORIGIN}/api（可选 WPS_ENCRYPT 加密）

判定优先级：
  1. 构造参数显式传入 → 最高优先
  2. PRIVATE 已设置（有值） → 私网
     a. CLOUD_IDE=1 → 云端对话，base_url = WPS_CLOUD_GATEWAY 或 http://encs-pri-api-gateway
     b. 其余       → 本地对话，base_url = {X_ORIGIN}/api
  3. 其余情况 → 公网

私网不可用接口：
  部分接口仅公网可用（私网返回 404 / 签名校验失败 / KSOToken 不合法）。
  在对应函数上标注 @private_unsupported 装饰器，私网调用时直接返回 code=-2，
  不发起网络请求。
"""
import functools
import json as _json
import os
from typing import Optional

import requests

from .ratelimit import throttle as _throttle

_PUBLIC_DEFAULTS = {
    "base_url": "https://api.wps.cn",
    "sid_env": "WPS_SID",
    "origin": "https://365.kdocs.cn",
    "referer": "https://365.kdocs.cn/woa/im/messages",
}


def _get_private_defaults() -> dict:
    """从 X_ORIGIN 环境变量动态构建私网（本地对话）配置。

    base_url 用完整 X_ORIGIN + /api（路由需要路径），
    origin/referer 只取 scheme + host（CSRF 白名单校验只认域名）。
    """
    x_origin = os.environ.get("X_ORIGIN", "").rstrip("/")
    # 从 X_ORIGIN 提取 scheme + host（如 https://10.217.18.196）
    from urllib.parse import urlparse
    parsed = urlparse(x_origin)
    scheme_host = f"{parsed.scheme}://{parsed.hostname}"
    if parsed.port:
        scheme_host += f":{parsed.port}"
    return {
        "base_url": f"{x_origin}/api",
        "sid_env": "WPS_SID",
        "origin": scheme_host,
        "referer": scheme_host,
    }


def _get_cloud_defaults() -> dict:
    """构建私网 · 云端对话配置。域名直连 encs-pri-api-gateway，不走加密。

    origin/referer 设为 None：云端网关不接受非白名单 Origin，不发反而能通过。
    """
    gateway = os.environ.get("WPS_CLOUD_GATEWAY", "http://encs-pri-api-gateway").rstrip("/")
    return {
        "base_url": gateway,
        "sid_env": "WPS_SID",
        "origin": None,
        "referer": None,
    }


def _detect_private() -> bool:
    return bool(os.environ.get("PRIVATE"))


def _detect_cloud_ide() -> bool:
    return os.environ.get("CLOUD_IDE") == "1"


def _private_unavailable_resp(name: str) -> dict:
    return {
        "code": -2,
        "msg": f"私网不支持此接口: {name}",
    }


def private_unsupported(func):
    """标记此接口仅公网可用。私网调用时直接返回 code=-2，不发起网络请求。"""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        client = kwargs.get("client")
        is_priv = (
            (client is not None and getattr(client, "_is_private", False))
            or (client is None and _detect_private())
        )
        if is_priv:
            return _private_unavailable_resp(func.__name__)
        return func(*args, **kwargs)
    wrapper._private_unsupported = True
    return wrapper


class WpsV7Client:
    """V7 API 统一客户端，自动适配公网 / 私网（云端 / 本地）部署。"""

    def __init__(
        self,
        base_url: Optional[str] = None,
        sid: Optional[str] = None,
        private: Optional[bool] = None,
    ):
        is_private = private if private is not None else _detect_private()
        is_cloud = _detect_cloud_ide() if is_private else False
        self._is_private = is_private
        self._is_cloud = is_cloud

        if is_private:
            defaults = _get_cloud_defaults() if is_cloud else _get_private_defaults()
        else:
            defaults = _PUBLIC_DEFAULTS

        self.base_url = (
            base_url
            or os.environ.get("WPS_API_BASE")
            or defaults["base_url"]
        ).rstrip("/")

        self.sid = (
            sid
            or os.environ.get(defaults["sid_env"])
            or os.environ.get("WPS_SID")
        )

        self._origin = os.environ.get("WPS_ORIGIN") or defaults["origin"]
        self._referer = os.environ.get("WPS_REFERER") or defaults["referer"]
        self._session = requests.Session()
        self._encryption = None
        if is_private:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            self._session.verify = False
            if not is_cloud and os.environ.get("WPS_ENCRYPT") == "1":
                from .encrypt import create_encryption
                self._encryption = create_encryption()

    @property
    def is_private(self) -> bool:
        return self._is_private

    @property
    def is_cloud(self) -> bool:
        return self._is_cloud

    def private_x_origin(self) -> Optional[str]:
        """私网 internal 短域名：云端为 gateway，本地为 X_ORIGIN。用于 V7 API 与 store_url 改写。"""
        if not self._is_private:
            return None
        if self._is_cloud:
            return os.environ.get("WPS_CLOUD_GATEWAY", "http://encs-pri-api-gateway").rstrip("/")
        return os.environ.get("X_ORIGIN", "").rstrip("/") or None

    def _gateway_url(self) -> str:
        """加密请求的网关入口 URL（仅本地对话 + 加密环境使用）。"""
        x_origin = os.environ.get("X_ORIGIN", "").rstrip("/")
        return f"{x_origin}/api"

    def _headers(self, content_type: str = "application/json") -> dict:
        if not self.sid:
            raise ValueError(
                "缺少用户凭证: 请设置环境变量 WPS_SID"
            )
        h = {
            "Content-Type": content_type,
            "cookie": f"wps_sid={self.sid}; csrf={self.sid}",
        }
        if self._origin:
            h["Origin"] = self._origin
        if self._referer:
            h["Referer"] = self._referer
        x_origin = self.private_x_origin()
        if x_origin:
            h["X-Origin"] = x_origin
        return h

    @staticmethod
    def _normalize_code(result: dict) -> dict:
        """私网成功码 20000000 统一映射为 0，保证上层 code==0 判断一致。"""
        if isinstance(result, dict) and result.get("code") == 20000000:
            result["code"] = 0
        return result

    def _parse_response(self, resp) -> dict:
        """统一响应解析：先尝试解密，再 JSON 解析。"""
        if self._encryption:
            decrypted = self._encryption.decrypt_response(resp.headers, resp.text)
            if decrypted is not None:
                if isinstance(decrypted, dict):
                    return self._normalize_code(decrypted)
                if isinstance(decrypted, str):
                    try:
                        parsed = _json.loads(decrypted)
                        if isinstance(parsed, dict):
                            return self._normalize_code(parsed)
                        return parsed
                    except (ValueError, _json.JSONDecodeError):
                        return {"code": -1, "msg": "decrypted response is not json", "text": decrypted[:500]}
                return decrypted
        if not resp.content:
            if resp.status_code >= 400:
                return {
                    "code": -1,
                    "msg": f"HTTP {resp.status_code}",
                    "http_status": resp.status_code,
                }
            return {}
        try:
            return self._normalize_code(resp.json())
        except (ValueError, _json.JSONDecodeError):
            return {"code": -1, "msg": "response is not json", "text": (resp.text or "")[:500]}

    def get(self, path: str, params: Optional[dict] = None, **kwargs) -> dict:
        """GET 请求，path 为相对路径，如 /v7/users/current。"""
        _throttle()
        url = f"{self.base_url}{path}"
        if self._encryption:
            gateway = self._gateway_url()
            req = self._encryption.encrypt_request(
                "GET", gateway, self._headers(), params=params, api_path=path,
            )
            resp = self._session.post(req.url, headers=req.headers, data=req.data, timeout=30, **kwargs)
        else:
            resp = self._session.get(url, headers=self._headers(), params=params, timeout=30, **kwargs)
        return self._parse_response(resp)

    def post(self, path: str, json: Optional[dict] = None, **kwargs) -> dict:
        """POST 请求。"""
        _throttle()
        url = f"{self.base_url}{path}"
        if self._encryption:
            gateway = self._gateway_url()
            req = self._encryption.encrypt_request(
                "POST", gateway, self._headers(), body=json, api_path=path,
            )
            resp = self._session.post(req.url, headers=req.headers, data=req.data, timeout=30, **kwargs)
        else:
            resp = self._session.post(url, headers=self._headers(), json=json, timeout=30, **kwargs)
        return self._parse_response(resp)

    def post_url(
        self,
        url: str,
        json: Optional[dict] = None,
        gateway: Optional[str] = None,
        headers: Optional[dict] = None,
        **kwargs,
    ) -> dict:
        """POST 到完整 URL（非 base_url 相对路径），统一处理加密和响应解析。

        用于 airpage 等 base 不同于 self.base_url 的场景。
        gateway: 加密时的网关入口 URL，不同服务需要不同网关
                 （如 API → {X_ORIGIN}/api，weboffice → {X_ORIGIN}/weboffice）。
                 不传则使用默认 _gateway_url()。
        headers: 可选，覆盖默认 _headers()（WebOffice 等下游需独立 Header）。
        """
        _throttle()
        req_headers = headers if headers is not None else self._headers()
        if self._encryption:
            from urllib.parse import urlparse
            gw = gateway or self._gateway_url()
            gw_path = urlparse(gw).path.rstrip("/")
            full_path = urlparse(url).path
            api_path = full_path[len(gw_path):] if gw_path and full_path.startswith(gw_path) else full_path
            req = self._encryption.encrypt_request(
                "POST", gw, req_headers, body=json, api_path=api_path,
            )
            resp = self._session.post(req.url, headers=req.headers, data=req.data, timeout=60, **kwargs)
        else:
            resp = self._session.post(url, headers=req_headers, json=json, timeout=60, **kwargs)
        return self._parse_response(resp)

    def post_multipart(self, path: str, files=None, data=None, **kwargs) -> dict:
        """POST multipart/form-data（附件上传等场景）。

        文件上传始终跳过加密（与 ecissdk 行为一致）。
        """
        _throttle()
        url = f"{self.base_url}{path}"
        headers = self._headers()
        headers.pop("Content-Type", None)
        resp = self._session.post(url, headers=headers, files=files, data=data, timeout=60, **kwargs)
        return self._parse_response(resp)
