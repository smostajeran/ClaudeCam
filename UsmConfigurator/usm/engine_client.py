"""HTTP client for the usm-engine, including Supabase sign-in.

Uses only Python's standard library (``urllib``) — nothing to install in Fusion.

The deployed engine gates its endpoints behind a **Supabase JWT** (it validates
the token against ``{SUPABASE_URL}/auth/v1/user``). So a username/password is a
Supabase Auth login that must be exchanged for a JWT first. The engine publishes
the Supabase URL + anon key at ``GET /api/config``, so this client signs in
itself: it fetches that config, performs the password grant against Supabase,
caches the resulting access token, and sends it as ``Authorization: Bearer`` on
every engine request. A locally-run engine (no ``SUPABASE_URL``) needs no token.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

from . import config

# Cache of Supabase access tokens, keyed by (engine_url, username), for this session.
_TOKENS = {}


class EngineError(Exception):
    """Raised with a human-readable message when the engine can't be reached or refuses."""


# -- low-level HTTP ----------------------------------------------------------
def _http(url, data=None, headers=None, method="GET", timeout=30):
    """Perform a request; return the body text. Raises urllib errors to the caller."""
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def _json(url, data=None, headers=None, method="GET", timeout=30):
    return json.loads(_http(url, data, headers, method, timeout))


# -- Supabase sign-in --------------------------------------------------------
def _engine_supabase_config(base):
    """Fetch the Supabase URL + anon key the engine is configured with."""
    try:
        cfg = _json(base + "/api/config", timeout=15)
    except Exception as exc:  # noqa: BLE001
        raise EngineError("Could not read /api/config from the engine ({}).".format(exc))
    sb_url, anon = cfg.get("supabaseUrl"), cfg.get("supabaseAnonKey")
    if not sb_url or not anon:
        raise EngineError("The engine did not publish Supabase auth config.")
    return sb_url.rstrip("/"), anon, bool(cfg.get("authEnforced"))


def login():
    """Sign in with the configured username/password and cache the access token.

    Returns the JWT. Raises :class:`EngineError` with a clear message on failure.
    """
    base = config.get_engine_url()
    user, password = config.get_engine_user(), config.get_engine_password()
    if not (user and password):
        raise EngineError("Set a username and password in Settings to sign in.")
    sb_url, anon, _enforced = _engine_supabase_config(base)
    body = json.dumps({"email": user, "password": password}).encode("utf-8")
    url = sb_url + "/auth/v1/token?" + urllib.parse.urlencode({"grant_type": "password"})
    headers = {"apikey": anon, "Authorization": "Bearer " + anon, "Content-Type": "application/json"}
    try:
        data = json.loads(_http(url, data=body, headers=headers, method="POST", timeout=20))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            j = json.loads(exc.read().decode("utf-8"))
            detail = j.get("error_description") or j.get("msg") or j.get("error") or ""
        except Exception:
            pass
        raise EngineError("Sign-in failed ({}). {}".format(exc.code, detail or "Check your username/password."))
    except Exception as exc:  # noqa: BLE001
        raise EngineError("Sign-in request failed: {}".format(exc))
    tok = data.get("access_token")
    if not tok:
        raise EngineError("Sign-in returned no access token.")
    _TOKENS[(base, user)] = tok
    return tok


def _bearer(force=False):
    """Authorization header value for engine calls, or None if no auth is configured."""
    base = config.get_engine_url()
    user, password = config.get_engine_user(), config.get_engine_password()
    if user and password:
        tok = None if force else _TOKENS.get((base, user))
        if not tok:
            tok = login()
        return "Bearer " + tok
    token = config.get_engine_token()
    if token:
        return "Bearer " + token
    return None


def _request(url, data=None, method="GET", timeout=30, authed=True):
    """Engine request with auto Supabase auth + one re-auth retry on 401."""
    for attempt in (1, 2):
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if authed:
            auth = _bearer(force=(attempt == 2))  # raises EngineError if sign-in fails
            if auth:
                headers["Authorization"] = auth
        try:
            return _http(url, data=data, headers=headers, method=method, timeout=timeout)
        except urllib.error.HTTPError as exc:
            if exc.code == 401 and authed and attempt == 1 and config.get_engine_user():
                _TOKENS.pop((config.get_engine_url(), config.get_engine_user()), None)
                continue  # token expired/invalid -> re-auth once
            detail = ""
            try:
                detail = exc.read().decode("utf-8")[:300]
            except Exception:
                pass
            if exc.code in (401, 403):
                raise EngineError("Engine rejected the request ({}). Sign in with a valid "
                                  "username/password in Settings. {}".format(exc.code, detail))
            raise EngineError("Engine returned HTTP {} for {}. {}".format(exc.code, url, detail))
        except urllib.error.URLError as exc:
            raise EngineError("Could not reach the engine at {} ({}).".format(url, getattr(exc, "reason", exc)))
        except Exception as exc:  # noqa: BLE001
            raise EngineError("Engine request failed: {}".format(exc))


def _parse(raw):
    try:
        data = json.loads(raw)
    except Exception:
        raise EngineError("Engine returned a non-JSON response.")
    if isinstance(data, dict) and data.get("error"):
        raise EngineError("Engine error: {}".format(data["error"]))
    return data


# -- public API --------------------------------------------------------------
def build(path_p, timeout=30):
    """POST a Path P configuration to ``/api/build`` and return the parsed payload."""
    base = config.get_engine_url()
    if not base:
        raise EngineError("No engine URL configured. Set it in the palette's Settings.")
    return _parse(_request(base + "/api/build", data=json.dumps(path_p).encode("utf-8"),
                           method="POST", timeout=timeout))


def catalog(path="/api/manifest", timeout=30):
    """Load the engine's IP-safe part catalogue (the manifest of one52 parts)."""
    base = config.get_engine_url()
    if not base:
        raise EngineError("No engine URL configured. Set it in the palette's Settings.")
    return _parse(_request(base + path, timeout=timeout))


def health(timeout=15):
    """Return the engine's /health dict (open endpoint, no auth)."""
    return _parse(_request(config.get_engine_url() + "/health", timeout=timeout, authed=False))
