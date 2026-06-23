"""Minimal Anthropic Messages API client using only the Python standard library.

Fusion 360 ships a sandboxed Python where installing the official ``anthropic`` SDK
is unreliable (it depends on compiled wheels such as ``pydantic-core`` whose ABI must
match Fusion's interpreter). ``urllib`` is always available and needs nothing installed,
so ClaudeCad talks to the Messages API directly.
"""

import json
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


class APIError(Exception):
    pass


def create_message(api_key, model, max_tokens, system, messages, tools=None, thinking=None, timeout=180):
    """POST to /v1/messages and return the parsed response dict.

    The returned dict has the usual shape: ``{"content": [...blocks...], "stop_reason": ...}``.
    Content blocks are plain dicts and can be appended directly to ``messages`` for the
    next request (this preserves thinking blocks for tool-use continuation).
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

    request = urllib.request.Request(API_URL, data=json.dumps(body).encode("utf-8"), method="POST")
    request.add_header("content-type", "application/json")
    request.add_header("x-api-key", api_key)
    request.add_header("anthropic-version", ANTHROPIC_VERSION)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        message = detail[:400]
        try:
            message = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        raise APIError("HTTP {}: {}".format(exc.code, message))
    except urllib.error.URLError as exc:
        raise APIError("Network error: {} (check your internet connection / proxy).".format(exc.reason))

    if payload.get("type") == "error":
        raise APIError(payload.get("error", {}).get("message", "Unknown API error."))

    return payload
