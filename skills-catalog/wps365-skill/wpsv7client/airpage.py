# -*- coding: utf-8 -*-
"""
智能文档 Airpage：写入内容到智能文档（.otl）。

POST {weboffice}/api/v3/office/file/{file_id}/core/execute

路由（对齐 drive._build_store_*_headers 模式：URL 与 Header 分开处理）：
- 私网·云端 URL：http://weboffice-openresty（internal，与 V7 API 的 encs-pri-api-gateway 并列）
- 私网·本地 URL：{X_ORIGIN}/weboffice
- WebOffice Header：不用 API 的 X-Origin（encs-pri-api-gateway），需外部网关 path
  → WPS_WEBOFFICE_X_ORIGIN 或 X_ORIGIN 提供 Origin/Referer/X-Origin
"""
import os
from typing import Optional
from urllib.parse import urlparse

from .base import WpsV7Client

_CLOUD_WEBOFFICE_DEFAULT = "http://weboffice-openresty"


def weboffice_x_origin() -> str:
    """WebOffice 网关 X-Origin 前缀（可与 API 的 X_ORIGIN 不同，如 path3 vs path5）。"""
    return (
        os.environ.get("WPS_WEBOFFICE_X_ORIGIN")
        or os.environ.get("X_ORIGIN", "")
    ).rstrip("/")


def _scheme_host(url: str) -> str:
    parsed = urlparse(url)
    host = f"{parsed.scheme}://{parsed.hostname}"
    if parsed.port:
        host += f":{parsed.port}"
    return host


def _weboffice_base(client: WpsV7Client) -> str:
    if client.is_private:
        if client.is_cloud:
            return os.environ.get(
                "WPS_CLOUD_WEBOFFICE", _CLOUD_WEBOFFICE_DEFAULT
            ).rstrip("/")
        x_origin = weboffice_x_origin()
        if not x_origin:
            raise ValueError("私网本地需设置 X_ORIGIN 或 WPS_WEBOFFICE_X_ORIGIN")
        return f"{x_origin}/weboffice"
    return "https://365.kdocs.cn"


def _build_weboffice_headers(client: WpsV7Client) -> dict:
    """
    WebOffice 专用请求头（不复用 client._headers() 的 encs-pri-api-gateway X-Origin）。

    云端沙箱验证：URL 仍走 weboffice-openresty，但 X-Origin 须为外部 path（如 path3/path4），
    并携带 Origin/Referer，否则 SessionDeleted。
    """
    x_origin = weboffice_x_origin()
    if x_origin:
        scheme_host = _scheme_host(x_origin)
        return {
            "Content-Type": "application/json",
            "cookie": f"wps_sid={client.sid}; csrf={client.sid}",
            "Origin": scheme_host,
            "Referer": scheme_host,
            "X-Origin": x_origin,
        }
    return client._headers()


def write_airpage_content(
    file_id: str,
    title: str,
    content: str,
    pos: str = "begin",
    client: Optional[WpsV7Client] = None,
) -> dict:
    """向智能文档写入内容（Markdown/文本）。"""
    c = client or WpsV7Client()
    base = _weboffice_base(c)
    url = f"{base}/api/v3/office/file/{file_id}/core/execute"
    body = {
        "command": "http.otl.exec",
        "param": {
            "subType": "insertContent",
            "params": {
                "title": title,
                "content": content,
                "pos": pos,
            },
        },
    }
    return c.post_url(
        url,
        json=body,
        gateway=base,
        headers=_build_weboffice_headers(c),
    )
