"""Configuration and constants for ClaudeCad.

The Anthropic API key is never hard-coded. It is read from the ``ANTHROPIC_API_KEY``
environment variable, or from ``~/.claudecad/config.json`` ({"api_key": "sk-ant-..."}).
"""

import json
import os

# --- Claude model -----------------------------------------------------------
# Opus 4.8 is the most capable Opus-tier model; adaptive thinking is enabled in agent.py.
MODEL = "claude-opus-4-8"
MAX_TOKENS = 16000

# --- Fusion UI identifiers --------------------------------------------------
PALETTE_ID = "claudeCadChatPalette"
PALETTE_NAME = "ClaudeCad"
PALETTE_HTML = "resources/palette/index.html"

CMD_ID = "claudeCadShowCmd"
CMD_NAME = "ClaudeCad"
CMD_TOOLTIP = "Open the ClaudeCad AI design assistant"
PANEL_ID = "SolidScriptsAddinsPanel"

# --- Self-update ------------------------------------------------------------
REPO = "smostajeran/ClaudeCam"
UPDATE_BRANCH = "main"

# The add-in folder is the parent of this package (…/AddIns/ClaudeCad).
ADDIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def addin_dir():
    return ADDIN_DIR


def get_version():
    try:
        with open(os.path.join(ADDIN_DIR, "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip() or "unknown"
    except Exception:
        return "unknown"


def get_github_token():
    """Optional token for self-updating from a private repo (env or config file)."""
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        return token.strip()
    try:
        cfg = _config_path()
        if os.path.isfile(cfg):
            with open(cfg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            token = data.get("github_token")
            if token:
                return token.strip()
    except Exception:
        pass
    return None


def has_github_token():
    return bool(get_github_token())


def token_from_env():
    return bool(os.environ.get("GITHUB_TOKEN"))


def save_github_token(token):
    """Persist a GitHub token to ``~/.claudecad/config.json`` (owner-readable only)."""
    token = (token or "").strip()
    if not token:
        raise ValueError("The token is empty.")
    cfg = _config_path()
    os.makedirs(os.path.dirname(cfg), exist_ok=True)
    data = {}
    if os.path.isfile(cfg):
        try:
            with open(cfg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            data = {}
    data["github_token"] = token
    with open(cfg, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    try:
        os.chmod(cfg, 0o600)
    except Exception:
        pass


def _config_path():
    return os.path.join(os.path.expanduser("~"), ".claudecad", "config.json")


def get_api_key():
    """Return the Anthropic API key, or ``None`` if it is not configured."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key.strip()
    try:
        cfg = _config_path()
        if os.path.isfile(cfg):
            with open(cfg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            key = data.get("api_key")
            if key:
                return key.strip()
    except Exception:
        pass
    return None


def has_api_key():
    return bool(get_api_key())


def key_from_env():
    """True when the key comes from the environment (overrides the saved file)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def save_api_key(key):
    """Persist the API key to ``~/.claudecad/config.json`` (owner-readable only)."""
    key = (key or "").strip()
    if not key:
        raise ValueError("The API key is empty.")

    cfg = _config_path()
    os.makedirs(os.path.dirname(cfg), exist_ok=True)

    data = {}
    if os.path.isfile(cfg):
        try:
            with open(cfg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            data = {}

    data["api_key"] = key
    with open(cfg, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    try:
        os.chmod(cfg, 0o600)
    except Exception:
        pass
