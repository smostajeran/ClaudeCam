"""Pure helpers with no Fusion (``adsk``) dependency, so they can be unit-tested offline.

Keeping unit conversion and filename sanitization here (rather than inline in cad.py,
which imports ``adsk`` and can't load outside Fusion) lets the test suite exercise them.
"""

import os
import re
import threading

MM = 0.1  # millimetres -> centimetres (Fusion's internal length unit)


class TurnGuard:
    """One-CAD-turn-at-a-time guard for the shared document.

    Unlike a held lock (which a cancelled/blocked worker can't release from another thread),
    this is a marker: ``try_begin`` claims the slot for a key, ``end`` releases it only if the
    key still owns it, and ``clear_owner`` (Stop/Discard) frees the slot immediately so a new
    turn can start even while the old worker is still unwinding a blocked network call.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._active = None  # the key (e.g. (chat_id, generation)) currently running

    def try_begin(self, key):
        with self._lock:
            if self._active is not None:
                return False
            self._active = key
            return True

    def end(self, key):
        with self._lock:
            if self._active == key:
                self._active = None
                return True
            return False

    def clear_owner(self, owner):
        """Free the slot if its key's first element matches ``owner`` (e.g. a chat id)."""
        with self._lock:
            if self._active is not None and self._active[0] == owner:
                self._active = None
                return True
            return False

    def active(self):
        with self._lock:
            return self._active


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


def nest_panels(panels, sheet_w=2440.0, sheet_h=1220.0, kerf=3.0):
    """Shelf-pack rectangular panels onto standard sheets; return usage stats.

    ``panels`` is a list of (width, height) mm. Returns a dict with the number of sheets, the
    total sheet vs used area, utilisation %, and any oversized panels that don't fit a sheet.
    Approximate (first-fit-decreasing shelf packing) but good for an estimate.
    """
    usable_w, usable_h = float(sheet_w), float(sheet_h)
    kerf = float(kerf)
    items, oversized, used_area = [], [], 0.0
    for w, h in panels:
        w, h = float(w), float(h)
        used_area += w * h
        a, b = max(w + kerf, h + kerf), min(w + kerf, h + kerf)  # longer side first
        if a > max(usable_w, usable_h) + 1e-6 or b > min(usable_w, usable_h) + 1e-6:
            oversized.append((w, h))
            continue
        items.append((a, b))
    items.sort(key=lambda t: (-t[1], -t[0]))  # tallest first

    remaining = list(items)
    sheets = 0
    while remaining:
        sheets += 1
        y = 0.0
        while remaining:
            # open a shelf with the first remaining panel that still fits the sheet height
            idx = next((i for i, (a, b) in enumerate(remaining)
                        if b <= usable_h - y + 1e-6 and a <= usable_w + 1e-6), None)
            if idx is None:
                break
            a, b = remaining.pop(idx)
            shelf_h, x = b, a
            i = 0
            while i < len(remaining):  # fill the shelf left-to-right
                aa, bb = remaining[i]
                if bb <= shelf_h + 1e-6 and x + aa <= usable_w + 1e-6:
                    x += aa
                    remaining.pop(i)
                else:
                    i += 1
            y += shelf_h

    sheet_area = usable_w * usable_h * sheets
    utilization = (used_area / sheet_area * 100.0) if sheet_area else 0.0
    return {"sheets": sheets, "sheet_area_mm2": sheet_area, "used_area_mm2": used_area,
            "utilization_pct": utilization, "oversized": oversized}


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
