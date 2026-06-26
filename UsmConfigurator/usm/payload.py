"""Pure helpers for turning the usm-engine output into real Fusion geometry —
no Fusion (``adsk``) dependency, so it is unit-tested offline.

The engine is the source of truth. Two endpoints are used:

* ``POST /api/build`` returns the **placement**: each part as
  ``{id, part, label, family, pos, quat}`` (metres, RealityKit frame: Y-up).
* ``GET /api/part-mesh?part=<id>`` returns that part's **real mesh**:
  ``positions`` (metres, the part's native mesh axes) + ``triangles``.

No primitives are fabricated. To place a part we take its real mesh vertices,
rotate them by the placement ``quat``, translate by ``pos`` (giving the part in
RealityKit world space), then convert to Fusion's native space —
**centimetres, Z-up**: ``(x, y, z)_cm = (rk_x*100, -rk_z*100, rk_y*100)``.
"""

CHROME_RGB = (208, 212, 216)
DEFAULT_PANEL_RGB = (188, 190, 192)  # USM matte silver

M_TO_CM = 100.0

# Frame families render chrome; everything else takes the chosen panel colour.
FRAME_FAMILIES = {"connector", "tube", "support", "fitting", "hardware"}


# -- vector / quaternion -----------------------------------------------------
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


# -- placement ---------------------------------------------------------------
def placement_parts(payload):
    """Extract the placed parts from a ``/api/build`` (or ``/api/configure``)
    payload: ``[{id, part, pos, quat, family, label}]`` (only those with a pos)."""
    out = []
    for p in (payload.get("parts") or payload.get("placement") or []):
        if not p.get("part") or not p.get("pos"):
            continue
        out.append({
            "id": p.get("id"),
            "part": p["part"],
            "label": p.get("label") or p["part"],
            "family": p.get("family"),
            "pos": [float(c) for c in p["pos"]],
            "quat": [float(c) for c in (p.get("quat") or [0, 0, 0, 1])],
        })
    return out


def unique_part_ids(placed):
    seen, out = set(), []
    for p in placed:
        if p["part"] not in seen:
            seen.add(p["part"])
            out.append(p["part"])
    return out


def transform_mesh(positions_m, quat, pos_m):
    """Real mesh vertices (metres, native axes) -> flat Fusion cm coordinates,
    rotated by ``quat`` and translated by ``pos`` (RealityKit world), then mapped
    to Fusion Z-up. Returns ``[x0,y0,z0, x1,y1,z1, …]`` in centimetres."""
    px, py, pz = pos_m
    out = []
    for v in positions_m:
        w = _qrot(quat, (float(v[0]), float(v[1]), float(v[2])))
        f = rk_to_fusion_cm((w[0] + px, w[1] + py, w[2] + pz))
        out.append(f[0]); out.append(f[1]); out.append(f[2])
    return out


def rgb_for(family, panel_rgb=None):
    if family in FRAME_FAMILIES:
        return CHROME_RGB
    return tuple(panel_rgb) if panel_rgb else DEFAULT_PANEL_RGB


def conflict_summary(payload):
    conf = payload.get("conflicts") or {}
    counts = conf.get("counts") or {}
    sev, warn = counts.get("severe", 0), counts.get("warning", 0)
    if sev or warn:
        return " Conflicts: {} severe, {} warning.".format(sev, warn)
    return ""
