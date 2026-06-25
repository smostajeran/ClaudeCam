"""Pure helpers with no Fusion (``adsk``) dependency, so they can be unit-tested offline.

Keeping unit conversion and filename sanitization here (rather than inline in cad.py,
which imports ``adsk`` and can't load outside Fusion) lets the test suite exercise them.
"""

import os
import re

MM = 0.1  # millimetres -> centimetres (Fusion's internal length unit)


def mm_to_cm(mm):
    return float(mm) * MM


def cm_to_mm(cm):
    return float(cm) / MM


_EXPORT_EXT = {
    "step": ".step", "stp": ".step", "stl": ".stl",
    "iges": ".igs", "igs": ".igs", "f3d": ".f3d",
}


def export_extension(fmt):
    """Return the file extension for an export format, or None if unsupported."""
    return _EXPORT_EXT.get((fmt or "step").lower())


def safe_export_basename(filename):
    """Reduce a model-supplied filename to a safe base name (no path, no extension).

    Strips any directory component, keeps only ``[A-Za-z0-9._-]``, and never returns an
    empty string. The caller joins this to the export directory, so traversal (``../``)
    and absolute paths can't escape it.
    """
    raw = os.path.basename(filename or "claudecad_export").rsplit(".", 1)[0]
    base = re.sub(r"[^A-Za-z0-9._-]", "_", raw).strip("._")
    return base or "claudecad_export"


def _csv_cell(value):
    """Quote a CSV cell if it contains a comma, quote or newline (minimal RFC-4180)."""
    s = "" if value is None else str(value)
    if any(c in s for c in (",", '"', "\n", "\r")):
        return '"' + s.replace('"', '""') + '"'
    return s


def cut_list_csv(parts):
    """Build a cut-list CSV from a list of parts.

    Each part is a dict with ``name`` and ``length`` / ``width`` / ``thickness`` (mm) and an
    optional ``material``. Parts with the same dimensions (rounded to 0.1 mm) and material are
    grouped into one row with a quantity and the member names. Returns the CSV as a string.
    """
    groups = {}
    order = []
    for p in parts:
        dims = tuple(round(float(p.get(k, 0.0)), 1) for k in ("length", "width", "thickness"))
        material = p.get("material") or ""
        key = (dims, material)
        if key not in groups:
            groups[key] = {"qty": 0, "names": []}
            order.append(key)
        groups[key]["qty"] += 1
        if p.get("name"):
            groups[key]["names"].append(p["name"])

    rows = ["Qty,Length(mm),Width(mm),Thickness(mm),Material,Parts"]
    for key in order:
        (length, width, thickness), material = key
        g = groups[key]
        rows.append(",".join(_csv_cell(c) for c in (
            g["qty"], "{:g}".format(length), "{:g}".format(width),
            "{:g}".format(thickness), material, "; ".join(g["names"]),
        )))
    return "\n".join(rows) + "\n"


def bom_csv(parts):
    """Build a Bill of Materials CSV from a list of parts.

    Unlike the cut list (grouped purely by size for sheet layout), the BOM groups by part
    identity — ``name`` + ``material`` + dimensions — and assigns an item number per row, the
    way a drawing's parts table reads. Each part dict has ``name`` and ``length`` / ``width`` /
    ``thickness`` (mm) and an optional ``material``.
    """
    groups = {}
    order = []
    for p in parts:
        dims = tuple(round(float(p.get(k, 0.0)), 1) for k in ("length", "width", "thickness"))
        key = (p.get("name") or "Part", p.get("material") or "", dims)
        if key not in groups:
            groups[key] = 0
            order.append(key)
        groups[key] += 1

    rows = ["Item,Qty,Part,Material,Length(mm),Width(mm),Thickness(mm)"]
    for item, key in enumerate(order, start=1):
        name, material, (length, width, thickness) = key
        rows.append(",".join(_csv_cell(c) for c in (
            item, groups[key], name, material,
            "{:g}".format(length), "{:g}".format(width), "{:g}".format(thickness),
        )))
    return "\n".join(rows) + "\n"
