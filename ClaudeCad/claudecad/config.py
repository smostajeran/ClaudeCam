"""Configuration and constants for ClaudeCad.

The Anthropic API key is never hard-coded. It is read from the ``ANTHROPIC_API_KEY``
environment variable, or from ``~/.claudecad/config.json`` ({"api_key": "sk-ant-..."}).
"""

import json
import os

# --- Claude model -----------------------------------------------------------
# Opus 4.8 is the most capable Opus-tier model; adaptive thinking is enabled in agent.py.
MODEL = "claude-opus-4-8"
MAX_TOKENS = 8000

# --- Fusion UI identifiers --------------------------------------------------
PALETTE_ID = "claudeCadChatPalette"
PALETTE_NAME = "ClaudeCad"
PALETTE_HTML = "resources/palette/index.html"

CMD_ID = "claudeCadShowCmd"
CMD_NAME = "ClaudeCad"
CMD_TOOLTIP = "Open the ClaudeCad AI design assistant"
PANEL_ID = "SolidScriptsAddinsPanel"


def get_api_key():
    """Return the Anthropic API key, or ``None`` if it is not configured."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key.strip()
    try:
        cfg = os.path.join(os.path.expanduser("~"), ".claudecad", "config.json")
        if os.path.isfile(cfg):
            with open(cfg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            key = data.get("api_key")
            if key:
                return key.strip()
    except Exception:
        pass
    return None
