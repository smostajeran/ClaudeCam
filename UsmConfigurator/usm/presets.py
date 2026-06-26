"""USM configuration presets — pure Python, no Fusion dependency (so it's unit
testable offline).

A preset is a named, ready-to-build USM configuration: its column / row / depth
bay sizes plus panel options. Presets ship with the add-in
(``resources/presets/usm.json``) and can be extended by the user in
``~/.usmconfigurator/presets.json`` (same schema, a ``presets`` list, merged on
top of the bundled set). This is the standalone configurator's equivalent of a
catalogue of starting points.
"""

import json
import os

# Fields a preset entry may carry (beyond id/name/notes).
FIELDS = ("columns", "rows", "depths", "ball_diameter", "tube_diameter",
          "panel_thickness", "color", "back_panels", "shelves", "dividers", "panels")


def _bundled_path():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "resources", "presets", "usm.json")


def _user_path():
    return os.path.join(os.path.expanduser("~"), ".usmconfigurator", "presets.json")


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return []
    items = data.get("presets") if isinstance(data, dict) else data
    return items if isinstance(items, list) else []


def load_catalog():
    """Return {id: entry}, user entries overriding bundled ones of the same id."""
    catalog = {}
    for path in (_bundled_path(), _user_path()):
        for entry in _read(path):
            if isinstance(entry, dict) and entry.get("id"):
                catalog[entry["id"]] = entry
    return catalog


def list_presets(filter_text=""):
    q = (filter_text or "").strip().lower()
    out = []
    for entry in load_catalog().values():
        hay = " ".join(str(entry.get(k, "")) for k in ("id", "name", "notes")).lower()
        if not q or q in hay:
            out.append(entry)
    return sorted(out, key=lambda e: (e.get("name") or e.get("id", "")))


def get(preset_id):
    return load_catalog().get(preset_id)


def to_options(entry):
    """Extract the geometry ``options`` dict from a preset entry."""
    opts = {}
    for k in ("ball_diameter", "tube_diameter", "panel_thickness", "color",
              "back_panels", "shelves", "dividers", "panels"):
        if entry.get(k) is not None:
            opts[k] = entry[k]
    return opts


def save_preset(entry):
    """Merge one preset into the user catalogue file (creating it if needed)."""
    if not isinstance(entry, dict) or not entry.get("id"):
        raise ValueError("A preset needs at least an 'id'.")
    if not entry.get("columns") or not entry.get("rows"):
        raise ValueError("A preset needs 'columns' and 'rows' (lists of bay sizes in mm).")
    path = _user_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existing = [e for e in _read(path) if e.get("id") != entry["id"]]
    existing.append(entry)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"presets": existing}, fh, indent=2)
    return entry["id"]
