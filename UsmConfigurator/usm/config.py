"""Constants and small helpers for the USM Configurator add-in."""

import os

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
