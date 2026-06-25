"""Hardware drill-pattern catalog (no Fusion dependency, so it can be unit-tested offline).

Entries describe a part's drilling pattern as face-local holes (du/dv mm from an anchor,
plus diameter and optional blind depth). The bundled catalog holds STANDARD industry
patterns (35 mm hinge system, System 32, etc.); a user file at ~/.claudecad/hardware.json
(same schema, a ``hardware`` list) is merged on top so the library can grow with exact
parts from manufacturer spec sheets. Proprietary 3D models are never bundled.
"""

import json
import os

from . import config


def _bundled_path():
    return os.path.join(config.addin_dir(), "resources", "hardware", "catalog.json")


def _user_path():
    return os.path.join(os.path.expanduser("~"), ".claudecad", "hardware.json")


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return []
    items = data.get("hardware") if isinstance(data, dict) else data
    return items if isinstance(items, list) else []


def load_catalog():
    """Return {id: entry}, with user entries overriding bundled ones of the same id."""
    catalog = {}
    for path in (_bundled_path(), _user_path()):
        for entry in _read(path):
            if isinstance(entry, dict) and entry.get("id"):
                catalog[entry["id"]] = entry
    return catalog


def list_hardware(filter_text=""):
    q = (filter_text or "").strip().lower()
    out = []
    for entry in load_catalog().values():
        hay = " ".join(str(entry.get(k, "")) for k in ("id", "brand", "category", "name")).lower()
        if not q or q in hay:
            out.append(entry)
    return sorted(out, key=lambda e: (e.get("category", ""), e.get("id", "")))


def get(hardware_id):
    return load_catalog().get(hardware_id)


def model_path(entry):
    """Full path to an entry's user-supplied 3D model (under ~/.claudecad/hardware/), or None.

    Only the basename is used, so a catalog 'model' field can't point outside that folder.
    """
    model = (entry or {}).get("model")
    if not model:
        return None
    return os.path.join(os.path.expanduser("~"), ".claudecad", "hardware", os.path.basename(str(model)))


def grouped_holes(entry, u, v):
    """Resolve an entry's pattern to {(diameter, depth): [(u, v), ...]} anchored at (u, v).

    Grouping by (diameter, depth) lets the driller cut each distinct bore size in one pass.
    """
    groups = {}
    for h in entry.get("holes") or []:
        diameter = float(h["diameter"])
        depth = float(h["depth"]) if h.get("depth") not in (None, "") else None
        pu = u + float(h.get("du", 0.0))
        pv = v + float(h.get("dv", 0.0))
        groups.setdefault((diameter, depth), []).append((pu, pv))
    return groups


def add_hardware(entry):
    """Merge one entry into the user catalog file (creating it if needed)."""
    if not isinstance(entry, dict) or not entry.get("id"):
        raise ValueError("A hardware entry needs at least an 'id'.")
    if not entry.get("holes") and not entry.get("model"):
        raise ValueError("A hardware entry needs a 'holes' pattern and/or a 'model' filename.")
    path = _user_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existing = _read(path)
    existing = [e for e in existing if e.get("id") != entry["id"]]
    existing.append(entry)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"hardware": existing}, fh, indent=2)
    return entry["id"]
