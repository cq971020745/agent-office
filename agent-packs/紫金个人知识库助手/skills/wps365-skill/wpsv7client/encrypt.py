# -*- coding: utf-8 -*-
"""
私有云网关加解密模块（RSA + AES-CBC）。

移植自 ecissdk gateway.ts，与 base.py / requests 完全解耦。
仅通过 encrypt_request / decrypt_response 两个方法与外部交互。

协议流程：
  1. 每会话随机生成 AES key（32 hex → 32 字节 UTF-8）+ IV（16 hex → 16 字节 UTF-8）
  2. 用服务端 RSA 公钥加密 {private_key, iv} → Encryption-Parameters 请求头
  3. 每次请求：API 路由元数据 AES 加密 → API-Parameters 头；请求体 AES 加密
  4. 所有加密请求强制 POST
  5. 响应头 encryption=1 时 AES 解密响应体

环境变量：
  WPS_ENCRYPT          = 1            # 开关
  WPS_ENCRYPT_PUBLIC_KEY = <PEM/Base64>  # RSA 公钥
  WPS_ENCRYPT_ALGORITHM  = <string>      # 算法标识，原样写入请求头
"""
import base64
import json
import os
import secrets
from typing import Any, Dict, NamedTuple, Optional
from urllib.parse import urlencode, urlparse

from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Util.Padding import pad, unpad


class EncryptedRequest(NamedTuple):
    """encrypt_request 返回值，调用方应以 POST + data= 发送。"""
    url: str
    headers: Dict[str, str]
    data: Optional[str]


class GatewayEncryption:
    """每会话一个实例，持有随机 AES 密钥，提供请求加密 / 响应解密。"""

    def __init__(self, public_key: str, algorithm: str):
        self._algorithm = algorithm
        self._csrf = secrets.token_hex(16)
        self._key = secrets.token_hex(16)
        self._iv = secrets.token_hex(8)
        self._parameters = self._rsa_encrypt_params(public_key)

    # ── 公开接口 ──────────────────────────────────────────────────

    def encrypt_request(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[dict] = None,
        params: Optional[dict] = None,
        api_path: Optional[str] = None,
    ) -> EncryptedRequest:
        """加密一个出站请求。

        Args:
            method:  原始 HTTP 方法（GET / POST …）
            url:     完整请求 URL（含 scheme + host + path）
            headers: 原始请求头（会被复制，不会修改原 dict）
            body:    JSON 请求体（dict），可为 None
            params:  URL 查询参数（dict），可为 None
            api_path: 显式业务路径（如 /v7/users/current），优先于从 url 中提取。
                      用于避免 base_url 路径前缀被带入 API-Parameters。

        Returns:
            EncryptedRequest(url, headers, data)
            - url:     去掉查询参数的 URL（查询参数已加密到 API-Parameters）
            - headers: 注入了 Encryption-* 和 API-Parameters 的新 headers
            - data:    AES 加密后的请求体字符串，或 None
        """
        parsed = urlparse(url)
        csrf_kv = f"csrfmiddlewaretoken={self._csrf}"

        qs_parts = [p for p in (
            parsed.query,
            urlencode(params) if params else "",
            csrf_kv,
        ) if p]

        api_object = {
            "schema": parsed.scheme or "https",
            "method": method.upper(),
            "api": api_path or parsed.path,
            "query_string": "&".join(qs_parts),
        }

        enc_headers = {**headers}
        enc_headers["Encryption-Algorithm"] = self._algorithm
        enc_headers["Encryption-Parameters"] = self._parameters
        enc_headers["API-Parameters"] = self._aes_encrypt(json.dumps(api_object))
        cookie = enc_headers.get("cookie", "")
        enc_headers["cookie"] = f"{cookie}; {csrf_kv}" if cookie else csrf_kv

        enc_body: Optional[str] = None
        if body is not None:
            payload = {**body, "csrfmiddlewaretoken": self._csrf}
            enc_body = self._aes_encrypt(json.dumps(payload))
            enc_headers["Content-Type"] = "application/json; charset=utf-8"

        clean_url = (
            f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            if parsed.scheme
            else url.split("?")[0]
        )
        return EncryptedRequest(url=clean_url, headers=enc_headers, data=enc_body)

    def decrypt_response(self, headers, text: str) -> Optional[Any]:
        """解密响应体。

        Args:
            headers: 响应头（任何支持 .get() 的映射）
            text:    响应体文本

        Returns:
            加密响应 → 解密后的 dict / list / str
            非加密响应 → None（调用方走正常解析流程）
        """
        if headers.get("encryption") != "1":
            return None
        if not text:
            return {}
        decrypted = self._aes_decrypt(text)
        content_type = headers.get("content-type", "")
        if content_type.lower().startswith("application/json"):
            return json.loads(decrypted)
        return decrypted

    # ── 内部实现 ──────────────────────────────────────────────────

    def _rsa_encrypt_params(self, public_key_raw: str) -> str:
        payload = json.dumps({"private_key": self._key, "iv": self._iv})
        try:
            pem = base64.b64decode(public_key_raw).decode("utf-8")
        except Exception:
            pem = public_key_raw
        key = RSA.import_key(pem)
        cipher = PKCS1_v1_5.new(key)
        ct = cipher.encrypt(payload.encode("utf-8"))
        return base64.b64encode(ct).decode("ascii")

    def _aes_encrypt(self, plaintext: str) -> str:
        cipher = AES.new(
            self._key.encode("utf-8"),
            AES.MODE_CBC,
            self._iv.encode("utf-8"),
        )
        ct = cipher.encrypt(pad(plaintext.encode("utf-8"), AES.block_size))
        return base64.b64encode(ct).decode("ascii")

    def _aes_decrypt(self, ciphertext_b64: str) -> str:
        cipher = AES.new(
            self._key.encode("utf-8"),
            AES.MODE_CBC,
            self._iv.encode("utf-8"),
        )
        pt = unpad(cipher.decrypt(base64.b64decode(ciphertext_b64)), AES.block_size)
        return pt.decode("utf-8")


def create_encryption() -> Optional[GatewayEncryption]:
    """根据环境变量创建加密实例。未启用时返回 None。"""
    if os.environ.get("WPS_ENCRYPT") != "1":
        return None
    public_key = os.environ.get("WPS_ENCRYPT_PUBLIC_KEY", "")
    algorithm = os.environ.get("WPS_ENCRYPT_ALGORITHM", "")
    if not public_key:
        raise ValueError("WPS_ENCRYPT=1 requires WPS_ENCRYPT_PUBLIC_KEY")
    if not algorithm:
        raise ValueError("WPS_ENCRYPT=1 requires WPS_ENCRYPT_ALGORITHM")
    return GatewayEncryption(public_key=public_key, algorithm=algorithm)
