"""HTTP client for the usm-engine ``/api/build`` (Path P) endpoint.

Uses only Python's standard library (``urllib``) — no third-party packages, so
there is nothing to install inside Fusion's bundled interpreter. The engine is
the source of truth; this just posts the configuration and returns its IP-safe
payload (one52 ids / English labels / RealityKit geometry).
"""

import json
import urllib.error
import urllib.request

from . import config


class EngineError(Exception):
    """Raised with a human-readable message when the engine can't be reached or refuses."""


def build(path_p, timeout=30):
    """POST a Path P configuration to ``/api/build`` and return the parsed payload.

    ``path_p`` = ``{columnWidths, rowHeights, depth, cells, baseSupport}``.
    Raises :class:`EngineError` on network / auth / server problems.
    """
    base = config.get_engine_url()
    if not base:
        raise EngineError("No engine URL configured. Set it in the palette's Settings.")
    url = base + "/api/build"
    body = json.dumps(path_p).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = config.get_engine_token()
    if token:
        headers["Authorization"] = "Bearer " + token

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        if exc.code in (401, 403):
            raise EngineError(
                "Engine rejected the request ({}). If your deployment requires a token, "
                "add it in Settings. {}".format(exc.code, detail))
        raise EngineError("Engine returned HTTP {} for {}. {}".format(exc.code, url, detail))
    except urllib.error.URLError as exc:
        raise EngineError("Could not reach the engine at {} ({}). Check the URL and your "
                          "connection.".format(url, getattr(exc, "reason", exc)))
    except Exception as exc:
        raise EngineError("Engine request failed: {}".format(exc))

    try:
        data = json.loads(raw)
    except Exception:
        raise EngineError("Engine returned a non-JSON response.")
    if isinstance(data, dict) and data.get("error"):
        raise EngineError("Engine error: {}".format(data["error"]))
    return data


def health(timeout=15):
    """Return the engine's /health dict, or raise EngineError."""
    url = config.get_engine_url() + "/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise EngineError("Health check failed for {}: {}".format(url, exc))
