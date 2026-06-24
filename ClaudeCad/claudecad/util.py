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
