"""A tiny Claude API client built on the Python standard library only.

Fusion 360 ships its own bundled Python, into which third-party wheels (like the
``anthropic`` SDK and its compiled ``pydantic-core`` dependency) often fail to
import because of version/ABI mismatches. To avoid any dependency-install step,
this module talks to the Claude Messages API directly over HTTPS with ``urllib``.

It exposes a single function, :func:`create_message`, which mirrors the shape of
``POST /v1/messages`` and returns the parsed JSON response as a plain ``dict``.
Content blocks (text, thinking, tool_use) come back as dicts, so the agent loop
can append them straight back into the conversation history unchanged — which
preserves thinking-block signatures across tool-use turns.
"""

import json
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"


class APIError(Exception):
    """Raised when the Claude API returns an error or is unreachable."""


def create_message(api_key, model, max_tokens, system, messages,
                   tools=None, thinking=None, timeout=300):
    """Call ``POST /v1/messages`` and return the parsed JSON response (a dict).

    ``messages`` is the conversation history; each assistant turn should contain
    the raw ``content`` list returned by a previous call so thinking blocks are
    preserved. Raises :class:`APIError` on any HTTP or network failure.
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
    request = urllib.request.Request(
        API_URL,
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": API_VERSION,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
        return json.loads(payload)
    except urllib.error.HTTPError as exc:
        detail = _read_error(exc)
        raise APIError("API request failed ({}): {}".format(exc.code, detail))
    except urllib.error.URLError as exc:
        raise APIError("Could not reach the Claude API: {}".format(exc.reason))


def _read_error(exc):
    """Extract a human-readable message from an HTTPError body, if possible."""
    try:
        payload = exc.read().decode("utf-8")
    except Exception:
        return "no response body"
    try:
        data = json.loads(payload)
        return data.get("error", {}).get("message", payload)
    except Exception:
        return payload
