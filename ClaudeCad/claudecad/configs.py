"""Cabinet configuration presets (no Fusion dependency, so it can be unit-tested offline).

A named set of cabinet configurations — size, type, front, door and shelf counts — bundled with
the add-in and extensible via ~/.claudecad/cabinet_configs.json (same schema, a ``configs`` list,
merged on top). This is the practical equivalent of Fusion's Configurations table, which the
add-in API can't author directly: pick a row and ``apply_cabinet_config`` rebuilds the cabinet to
it. Rows that change the number of doors/shelves change the body count, so applying rebuilds
rather than just switching a parameter.
"""

import json
import os

from . import config

# Fields an entry may carry (beyond id/name/notes), with the apply path's defaults applied in cad.
FIELDS = ("cabinet_type", "width", "height", "depth", "thickness", "front", "doors", "shelves", "joinery")


def _bundled_path():
    return os.path.join(config.addin_dir(), "resources", "configs", "cabinets.json")


def _user_path():
    return os.path.join(os.path.expanduser("~"), ".claudecad", "cabinet_configs.json")


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return []
    items = data.get("configs") if isinstance(data, dict) else data
    return items if isinstance(items, list) else []


def load_catalog():
    """Return {id: entry}, with user entries overriding bundled ones of the same id."""
    catalog = {}
    for path in (_bundled_path(), _user_path()):
        for entry in _read(path):
            if isinstance(entry, dict) and entry.get("id"):
                catalog[entry["id"]] = entry
    return catalog


def list_configs(filter_text=""):
    q = (filter_text or "").strip().lower()
    out = []
    for entry in load_catalog().values():
        hay = " ".join(str(entry.get(k, "")) for k in ("id", "name", "cabinet_type", "notes")).lower()
        if not q or q in hay:
            out.append(entry)
    return sorted(out, key=lambda e: (e.get("cabinet_type", ""), float(e.get("width", 0) or 0), e.get("id", "")))


def get(config_id):
    return load_catalog().get(config_id)


def save_config(entry):
    """Merge one configuration into the user catalog file (creating it if needed)."""
    if not isinstance(entry, dict) or not entry.get("id"):
        raise ValueError("A cabinet configuration needs at least an 'id'.")
    if entry.get("width") in (None, ""):
        raise ValueError("A cabinet configuration needs a 'width' (mm).")
    path = _user_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existing = [e for e in _read(path) if e.get("id") != entry["id"]]
    existing.append(entry)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"configs": existing}, fh, indent=2)
    return entry["id"]
