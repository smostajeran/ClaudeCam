"""Minimal Anthropic Messages API client using only the Python standard library.

Fusion 360 ships a sandboxed Python where installing the official ``anthropic`` SDK
is unreliable (it depends on compiled wheels such as ``pydantic-core`` whose ABI must
match Fusion's interpreter). ``urllib`` is always available and needs nothing installed,
so ClaudeCad talks to the Messages API directly.
"""

import json
import time
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

_RETRYABLE_CODES = {408, 409, 429, 500, 502, 503, 504, 529}
_MAX_ATTEMPTS = 3


def _error_message(detail):
    try:
        return json.loads(detail)["error"]["message"]
    except Exception:
        return detail[:400]


class APIError(Exception):
    pass


def create_message(api_key, model, max_tokens, system, messages, tools=None, thinking=None, timeout=180):
    """POST to /v1/messages and return the parsed response dict.

    The returned dict has the usual shape: ``{"content": [...blocks...], "stop_reason": ...}``.
    Content blocks are plain dicts and can be appended directly to ``messages`` for the
    next request (this preserves thinking blocks for tool-use continuation). Transient
    failures (429 / 5xx / network) are retried with exponential backoff.
    """
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    if tools:
        body["tools"] = tools
    if thinking:
        body["thinking"] = thinking
    data = json.dumps(body).encode("utf-8")

    for attempt in range(_MAX_ATTEMPTS):
        last = _MAX_ATTEMPTS - 1
        request = urllib.request.Request(API_URL, data=data, method="POST")
        request.add_header("content-type", "application/json")
        request.add_header("x-api-key", api_key)
        request.add_header("anthropic-version", ANTHROPIC_VERSION)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("type") == "error":
                raise APIError(payload.get("error", {}).get("message", "Unknown API error."))
            return payload
        except urllib.error.HTTPError as exc:
            message = _error_message(exc.read().decode("utf-8", "replace"))
            if exc.code in _RETRYABLE_CODES and attempt < last:
                time.sleep(2 ** attempt)
                continue
            raise APIError("HTTP {}: {}".format(exc.code, message))
        except urllib.error.URLError as exc:
            if attempt < last:
                time.sleep(2 ** attempt)
                continue
            raise APIError("Network error: {} (check your internet connection / proxy).".format(exc.reason))
