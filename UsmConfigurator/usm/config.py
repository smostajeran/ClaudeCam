"""Constants and small helpers for the USM Configurator add-in."""

import json
import os

# --- usm-engine endpoint ----------------------------------------------------
# The configurator calls the deployed engine's /api/build (Path P) for geometry
# + validation. The base URL / token are read from the environment, then from
# ~/.usmconfigurator/config.json, falling back to the known deployment.
DEFAULT_ENGINE_URL = "https://usm-engine-production-6fb8.up.railway.app"


def _settings_path():
    return os.path.join(os.path.expanduser("~"), ".usmconfigurator", "config.json")


def _load_settings():
    try:
        with open(_settings_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get_engine_url():
    return (os.environ.get("USM_ENGINE_URL")
            or _load_settings().get("engine_url")
            or DEFAULT_ENGINE_URL).rstrip("/")


def get_engine_user():
    return os.environ.get("USM_ENGINE_USER") or _load_settings().get("engine_user") or ""


def get_engine_password():
    return os.environ.get("USM_ENGINE_PASSWORD") or _load_settings().get("engine_password") or ""


def get_engine_token():
    return os.environ.get("USM_ENGINE_TOKEN") or _load_settings().get("engine_token") or ""


def save_engine_settings(url=None, user=None, password=None, token=None):
    """Persist engine url + credentials to ~/.usmconfigurator/config.json (owner-readable)."""
    data = _load_settings()
    if url is not None:
        data["engine_url"] = url.strip().rstrip("/")
    if user is not None:
        data["engine_user"] = user.strip()
    if password is not None:
        data["engine_password"] = password
    if token is not None:
        data["engine_token"] = token.strip()
    path = _settings_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    return path

# --- Fusion UI identifiers --------------------------------------------------
CMD_ID = "usmConfiguratorCmd"
CMD_NAME = "USM Configurator"
CMD_TOOLTIP = "Open the USM Haller configurator palette"
PANEL_ID = "SolidScriptsAddinsPanel"  # Fusion's Utilities > Add-Ins panel

PALETTE_ID = "usmConfiguratorPalette"
PALETTE_NAME = "USM Haller"
PALETTE_HTML = "resources/palette/index.html"

# The add-in folder is the parent of this package (…/AddIns/UsmConfigurator).
ADDIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def addin_dir():
    return ADDIN_DIR


def get_version():
    try:
        with open(os.path.join(ADDIN_DIR, "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip() or "unknown"
    except Exception:
        return "unknown"
