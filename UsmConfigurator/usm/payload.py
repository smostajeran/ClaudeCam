"""Map the usm-engine ``/api/build`` payload to Fusion-ready primitives — pure
Python, no Fusion (``adsk``) dependency, so it is unit-tested offline against a
real captured payload (``tests/fixtures/engine_build_sample.json``).

The engine is the source of truth for geometry and validation. It returns the
IP-safe one52 payload: parts as ``{id, part, label, family, material, pos, quat,
quad?}`` with positions in **metres**, RealityKit frame (**Y-up**, X-right,
Z-toward-viewer), plus ``bom`` and ``conflicts``. No USM codes/prices are present
and none are reconstructed here.

This module converts each part into a small primitive the Fusion builder draws:

* ``connector`` -> a sphere (the chrome ball)
* ``tube``      -> a cylinder along the rod axis (length from the part id)
* ``support``   -> a short cylinder (levelling foot)
* anything with a ``quad`` (panel/shelf/door/glass) -> a thin box on that face

Coordinates are returned already converted to Fusion's native space:
**centimetres, Z-up** — ``(x, y, z)_cm = (rk_x*100, -rk_z*100, rk_y*100)`` — so
the model stands upright with X=width, Y=depth, Z=height.
"""

import re

# Render-only dimensions (mm). The engine emits procedural primitives and does not
# specify rod/ball thickness or a finish palette, so these are the add-in's choice.
BALL_D = 25.0
TUBE_D = 16.0
FOOT_D = 30.0
FOOT_H = 30.0
PANEL_T = 10.0
GLASS_T = 6.0

CHROME_RGB = (208, 212, 216)
DEFAULT_PANEL_RGB = (188, 190, 192)  # USM matte silver

MM_TO_CM = 0.1
M_TO_CM = 100.0


# -- vector / quaternion helpers --------------------------------------------
def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _qrot(q, v):
    """Rotate vector ``v`` by quaternion ``q=(x,y,z,w)``."""
    x, y, z, w = q
    t = (2 * (y * v[2] - z * v[1]),
         2 * (z * v[0] - x * v[2]),
         2 * (x * v[1] - y * v[0]))
    c = _cross((x, y, z), t)
    return (v[0] + w * t[0] + c[0],
            v[1] + w * t[1] + c[1],
            v[2] + w * t[2] + c[2])


def rk_to_fusion_cm(p):
    """RealityKit metres (Y-up) -> Fusion centimetres (Z-up)."""
    return (p[0] * M_TO_CM, -p[2] * M_TO_CM, p[1] * M_TO_CM)


def _tube_length_mm(part, label):
    """Rod length in mm from the part id (e.g. 'tube-750') or label ('Tube 750 mm')."""
    for s in (part or "", label or ""):
        m = re.search(r"(\d{2,4})", str(s))
        if m:
            return float(m.group(1))
    return 350.0


# -- payload -> primitives ---------------------------------------------------
def parse(payload, options=None):
    """Turn an engine payload into a list of Fusion primitives + pass-through
    bom/conflicts. Returns a dict; never raises on a well-formed payload."""
    options = dict(options or {})
    ball_d = float(options.get("ball_diameter", BALL_D))
    tube_d = float(options.get("tube_diameter", TUBE_D))
    panel_t = float(options.get("panel_thickness", PANEL_T))
    panel_rgb = tuple(options.get("panel_rgb", DEFAULT_PANEL_RGB))

    parts = payload.get("parts") or payload.get("placement") or []
    prims = []
    counts = {}

    for part in parts:
        fam = part.get("family")
        counts[fam] = counts.get(fam, 0) + 1
        pos = part.get("pos")
        quad = part.get("quad")

        if quad and len(quad) >= 4:
            glass = fam == "glass"
            corners = [rk_to_fusion_cm(c) for c in quad[:4]]
            prims.append({
                "kind": "panel",
                "corners": corners,
                "thickness_cm": (GLASS_T if glass else panel_t) * MM_TO_CM,
                "glass": glass,
                "rgb": CHROME_RGB if glass else panel_rgb,
                "frame": False,
                "part": part.get("part"), "label": part.get("label"),
            })
        elif fam == "connector" and pos:
            prims.append({
                "kind": "sphere",
                "center": rk_to_fusion_cm(pos),
                "radius_cm": (ball_d / 2.0) * MM_TO_CM,
                "rgb": CHROME_RGB, "frame": True,
                "part": part.get("part"), "label": part.get("label"),
            })
        elif fam == "tube" and pos:
            axis = _qrot(part.get("quat") or [0, 0, 0, 1], (0.0, 1.0, 0.0))  # rod drawn along local Y
            half_m = _tube_length_mm(part.get("part"), part.get("label")) / 1000.0 / 2.0
            p0 = rk_to_fusion_cm((pos[0] - axis[0] * half_m, pos[1] - axis[1] * half_m, pos[2] - axis[2] * half_m))
            p1 = rk_to_fusion_cm((pos[0] + axis[0] * half_m, pos[1] + axis[1] * half_m, pos[2] + axis[2] * half_m))
            prims.append({
                "kind": "cylinder", "p0": p0, "p1": p1,
                "radius_cm": (tube_d / 2.0) * MM_TO_CM,
                "rgb": CHROME_RGB, "frame": True,
                "part": part.get("part"), "label": part.get("label"),
            })
        elif fam == "support" and pos:
            base = rk_to_fusion_cm(pos)
            prims.append({
                "kind": "cylinder",
                "p0": base, "p1": (base[0], base[1], base[2] + FOOT_H * MM_TO_CM),
                "radius_cm": (FOOT_D / 2.0) * MM_TO_CM,
                "rgb": CHROME_RGB, "frame": True,
                "part": part.get("part"), "label": part.get("label"),
            })
        # unknown family with neither quad nor a known primitive: skip silently

    return {
        "primitives": prims,
        "counts": counts,
        "bom": payload.get("bom") or [],
        "conflicts": payload.get("conflicts") or {},
        "meta": payload.get("meta") or {},
    }


def summary_text(parsed):
    """A short human-readable build summary from a parsed payload."""
    c = parsed["counts"]
    frame = c.get("connector", 0) + c.get("tube", 0) + c.get("support", 0)
    panels = sum(v for k, v in c.items() if k not in ("connector", "tube", "support"))
    conf = parsed.get("conflicts") or {}
    counts = conf.get("counts") or {}
    sev = counts.get("severe", 0)
    warn = counts.get("warning", 0)
    line = "Built {} frame parts (balls/tubes/feet) and {} panel(s).".format(frame, panels)
    if sev or warn:
        line += " Conflicts: {} severe, {} warning.".format(sev, warn)
    return line
