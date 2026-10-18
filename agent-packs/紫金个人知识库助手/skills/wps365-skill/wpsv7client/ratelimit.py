# -*- coding: utf-8 -*-
"""基于本地文件的滑动窗口限频器。

与 wps365-cli (Go) 共享同一个 ratelimit.json，两侧请求合并计数。
超限时静默等待，不抛异常。
"""
import json
import logging
import os
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 5
_DEFAULT_WINDOW = 1.0  # seconds

_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:
    import msvcrt

    def _lock_file(f):
        """Lock byte 0 as a mutex region (works even on empty files)."""
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)

    def _unlock_file(f):
        """Unlock the same byte-0 region locked by _lock_file."""
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _lock_file(f):
        fcntl.flock(f, fcntl.LOCK_EX)

    def _unlock_file(f):
        fcntl.flock(f, fcntl.LOCK_UN)


def _default_path() -> str:
    config_dir = os.environ.get("WPS365_CONFIG_DIR")
    if not config_dir:
        config_dir = os.path.join(Path.home(), ".config", "wps365-cli")
    return os.path.join(config_dir, "ratelimit.json")


class FileLimiter:
    """Sliding-window rate limiter backed by a local JSON file with flock."""

    def __init__(
        self,
        path: str | None = None,
        limit: int = _DEFAULT_LIMIT,
        window: float = _DEFAULT_WINDOW,
    ):
        self._path = path or _default_path()
        self._limit = limit
        self._window = window

    def wait(self) -> None:
        """Block until a request slot is available."""
        while True:
            sleep_for = self._acquire()
            if sleep_for <= 0:
                return
            time.sleep(sleep_for)

    def _acquire(self) -> float:
        """Try to record a request. Returns seconds to sleep, or 0 if recorded."""
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with open(self._path, "a+") as f:
                _lock_file(f)
                try:
                    f.seek(0)
                    content = f.read()
                    timestamps: list[int] = json.loads(content) if content.strip() else []
                except (json.JSONDecodeError, ValueError):
                    timestamps = []

                now_ms = int(time.time() * 1000)
                cutoff_ms = now_ms - int(self._window * 1000)

                recent = [ts for ts in timestamps if ts > cutoff_ms]

                if len(recent) >= self._limit:
                    oldest_ms = recent[0]
                    _unlock_file(f)
                    return (oldest_ms + int(self._window * 1000) - now_ms) / 1000.0

                recent.append(now_ms)

                f.seek(0)
                f.truncate()
                json.dump(recent, f)
                f.write("\n")

                _unlock_file(f)
                return 0.0
        except OSError:
            logger.warning("[ratelimit] file operation failed, proceeding without limit", exc_info=True)
            return 0.0


_global_limiter: FileLimiter | None = None


def get_limiter() -> FileLimiter:
    """Return the module-level singleton limiter (lazy init)."""
    global _global_limiter
    if _global_limiter is None:
        _global_limiter = FileLimiter()
    return _global_limiter


def throttle() -> None:
    """Convenience function: block until a request slot is available."""
    get_limiter().wait()
