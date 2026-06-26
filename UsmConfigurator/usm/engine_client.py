"""HTTP client for the usm-engine ``/api/build`` (Path P) endpoint.

Uses only Python's standard library (``urllib``) — no third-party packages, so
there is nothing to install inside Fusion's bundled interpreter. The engine is
the source of truth; this just posts the configuration and returns its IP-safe
payload (one52 ids / English labels / RealityKit geometry).
"""

import base64
import json
import urllib.error
import urllib.request

from . import config


class EngineError(Exception):
    """Raised with a human-readable message when the engine can't be reached or refuses."""


def _auth_header():
    """Authorization header for the engine: HTTP Basic (username/password) if set,
    else a Bearer token, else none."""
    user, password = config.get_engine_user(), config.get_engine_password()
    if user or password:
        raw = "{}:{}".format(user, password).encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")
    token = config.get_engine_token()
    if token:
        return "Bearer " + token
    return None


def _open(url, data=None, method="GET", timeout=30):
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    auth = _auth_header()
    if auth:
        headers["Authorization"] = auth
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        if exc.code in (401, 403):
            raise EngineError("Engine rejected the request ({}). Check the username/password "
                              "in Settings. {}".format(exc.code, detail))
        raise EngineError("Engine returned HTTP {} for {}. {}".format(exc.code, url, detail))
    except urllib.error.URLError as exc:
        raise EngineError("Could not reach the engine at {} ({}). Check the URL and your "
                          "connection.".format(url, getattr(exc, "reason", exc)))
    except Exception as exc:
        raise EngineError("Engine request failed: {}".format(exc))


def build(path_p, timeout=30):
    """POST a Path P configuration to ``/api/build`` and return the parsed payload.

    ``path_p`` = ``{columnWidths, rowHeights, depth, cells, baseSupport}``.
    Raises :class:`EngineError` on network / auth / server problems.
    """
    base = config.get_engine_url()
    if not base:
        raise EngineError("No engine URL configured. Set it in the palette's Settings.")
    raw = _open(base + "/api/build", data=json.dumps(path_p).encode("utf-8"),
                method="POST", timeout=timeout)
    return _parse(raw)


def catalog(path="/api/manifest", timeout=30):
    """Load the engine's IP-safe part catalogue (the manifest of one52 parts).

    Returns the parsed dict ``{owner, note, parts:[{part, label, family, dims, ...}]}``.
    """
    base = config.get_engine_url()
    if not base:
        raise EngineError("No engine URL configured. Set it in the palette's Settings.")
    return _parse(_open(base + path, timeout=timeout))


def _parse(raw):
    try:
        data = json.loads(raw)
    except Exception:
        raise EngineError("Engine returned a non-JSON response.")
    if isinstance(data, dict) and data.get("error"):
        raise EngineError("Engine error: {}".format(data["error"]))
    return data


def health(timeout=15):
    """Return the engine's /health dict, or raise EngineError."""
    return _parse(_open(config.get_engine_url() + "/health", timeout=timeout))
