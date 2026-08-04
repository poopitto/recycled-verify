"""Windows compatibility for the genlayer-test direct contract loader."""

import atexit
import os


_real_unlink = os.unlink
_delayed_unlinks = []


def _windows_safe_unlink(path, *args, **kwargs):
    try:
        return _real_unlink(path, *args, **kwargs)
    except PermissionError:
        _delayed_unlinks.append((path, args, kwargs))
        return None


def _cleanup_delayed_unlinks():
    for path, args, kwargs in _delayed_unlinks:
        try:
            _real_unlink(path, *args, **kwargs)
        except (FileNotFoundError, PermissionError):
            pass


if os.name == "nt":
    os.unlink = _windows_safe_unlink
    atexit.register(_cleanup_delayed_unlinks)
