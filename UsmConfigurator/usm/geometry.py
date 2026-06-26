"""USM Haller geometry — pure Python, no Fusion (``adsk``) dependency.

This module turns a *configuration* (how many bays wide / tall / deep, the cell
sizes, and which bays carry panels) into a flat list of primitives — ball
connectors, tubes, and panels — expressed in millimetres. The Fusion-coupled
:mod:`usm.builder` then materialises those primitives as solid bodies.

Keeping the maths here, free of ``adsk``, means the whole layout can be unit
tested offline (see ``tests/test_usm.py``). All coordinates are millimetres.

The model is the iconic USM Haller system:

* a 3D **grid** of nodes at the corners of every bay,
* a chrome **ball** connector at every node,
* a chrome **tube** along every grid edge between adjacent nodes, and
* powder-coated steel **panels** filling selected bay faces (backs, shelves,
  dividers, doors).

Axes: ``X`` = width (columns), ``Y`` = depth, ``Z`` = height (rows). The origin
is the front-bottom-left node, so the structure grows into +X, +Y, +Z.
"""

# Faces of a bay (cell). Each maps to the constant axis the panel lies in.
FACE_AXIS = {
    "back": "y", "front": "y",      # vertical panels in the X-Z plane
    "left": "x", "right": "x",      # vertical panels in the Y-Z plane (dividers/ends)
    "bottom": "z", "top": "z",      # horizontal panels in the X-Y plane (shelves)
}

# USM Haller powder-coat colours (approximate sRGB), keyed by name for the UI.
COLORS = {
    "USM Matte Silver": (188, 190, 192),
    "USM Light Gray": (200, 201, 199),
    "USM Pure White": (236, 236, 233),
    "USM Anthracite": (61, 62, 64),
    "USM Graphite Black": (42, 42, 44),
    "USM Steel Blue": (74, 96, 122),
    "USM Gentian Blue": (38, 64, 116),
    "USM Green": (92, 117, 86),
    "USM Golden Yellow": (240, 196, 78),
    "USM Pure Orange": (224, 106, 40),
    "USM Ruby Red": (151, 36, 44),
    "USM Beige": (212, 201, 175),
    "USM Brown": (92, 66, 54),
}

DEFAULT_COLOR = "USM Matte Silver"
CHROME_RGB = (208, 212, 216)  # the chrome frame (balls + tubes)


def _cumulative(sizes):
    """[a, b, c] -> [0, a, a+b, a+b+c] (the node coordinates along one axis)."""
    coords = [0.0]
    for s in sizes:
        coords.append(coords[-1] + float(s))
    return coords


def _norm_color(name):
    return name if name in COLORS else DEFAULT_COLOR


def expand_panels(nx, ny, nz, options):
    """Turn high-level panel *rules* into explicit ``(ix, iy, iz, face)`` cells.

    Rules (any combination) in ``options``:
      * ``back_panels``  — a panel on the rear (max-Y) face of every bay.
      * ``shelves``      — a horizontal panel on every interior horizontal grid
                           line (the dividers between stacked bays).
      * ``dividers``     — a vertical panel on every interior vertical grid line
                           between side-by-side bays (rear depth layer only).

    ``options['panels']`` may also carry an explicit list of cell dicts
    (``{ix, iy, iz, face, color?}``) for fully custom layouts (used by presets).
    Returns a de-duplicated list of cell dicts.
    """
    color = _norm_color(options.get("color", DEFAULT_COLOR))
    out = {}

    def add(ix, iy, iz, face, c=None):
        key = (ix, iy, iz, face)
        out[key] = {"ix": ix, "iy": iy, "iz": iz, "face": face, "color": _norm_color(c or color)}

    ncx, ncy, ncz = nx - 1, ny - 1, nz - 1  # bay counts along each axis

    if options.get("back_panels"):
        for iz in range(ncz):
            for ix in range(ncx):
                # one back panel per column, spanning the full depth's rear plane
                add(ix, ncy - 1, iz, "back")

    if options.get("door") or options.get("front_panels"):
        # a drop-down door / front panel on the front (min-Y) plane of every bay
        for iz in range(ncz):
            for ix in range(ncx):
                add(ix, 0, iz, "front")

    if options.get("shelves"):
        # interior horizontal dividers: the top face of every bay below the top row
        for iz in range(ncz - 1):
            for iy in range(ncy):
                for ix in range(ncx):
                    add(ix, iy, iz, "top")

    if options.get("dividers"):
        # interior vertical dividers between side-by-side columns
        for ix in range(ncx - 1):
            for iz in range(ncz):
                for iy in range(ncy):
                    add(ix, iy, iz, "right")

    for cell in options.get("panels", []) or []:
        add(int(cell["ix"]), int(cell["iy"]), int(cell["iz"]),
            cell.get("face", "back"), cell.get("color"))

    return list(out.values())


def _panel_box(coords, cell, inset, thickness):
    """Axis-aligned box (mm corners) for one panel cell, inset within its tubes."""
    xs, ys, zs = coords
    ix, iy, iz, face = cell["ix"], cell["iy"], cell["iz"], cell["face"]
    x0, x1 = xs[ix] + inset, xs[ix + 1] - inset
    y0, y1 = ys[iy] + inset, ys[iy + 1] - inset
    z0, z1 = zs[iz] + inset, zs[iz + 1] - inset
    half = thickness / 2.0
    if face in ("back", "front"):
        plane = ys[iy + 1] if face == "back" else ys[iy]
        y0, y1 = plane - half, plane + half
    elif face in ("left", "right"):
        plane = xs[ix + 1] if face == "right" else xs[ix]
        x0, x1 = plane - half, plane + half
    else:  # top / bottom -> horizontal
        plane = zs[iz + 1] if face == "top" else zs[iz]
        z0, z1 = plane - half, plane + half
    return (x0, y0, z0, x1, y1, z1)


def build_spec(columns, rows, depths=None, options=None):
    """Compute the full primitive list for a USM structure.

    ``columns`` / ``rows`` / ``depths`` are lists of bay sizes (mm) along
    X / Z / Y. ``depths`` defaults to a single bay. Returns a dict with
    ``balls``, ``tubes``, ``panels`` and a ``bom`` summary.
    """
    options = dict(options or {})
    columns = [float(c) for c in columns]
    rows = [float(r) for r in rows]
    depths = [float(d) for d in (depths if depths else [350.0])]
    if not columns or not rows:
        raise ValueError("Need at least one column and one row.")
    if min(columns + rows + depths) <= 0:
        raise ValueError("Bay sizes must be greater than 0 mm.")

    xs = _cumulative(columns)
    ys = _cumulative(depths)
    zs = _cumulative(rows)
    nx, ny, nz = len(xs), len(ys), len(zs)
    coords = (xs, ys, zs)

    ball_d = float(options.get("ball_diameter", 25.0))
    tube_d = float(options.get("tube_diameter", 19.0))
    thickness = float(options.get("panel_thickness", 18.0))
    # Keep panels clear of the tubes: inset by a tube radius plus a small gap.
    inset = float(options.get("panel_inset", tube_d / 2.0 + 2.0))

    balls = [{"x": x, "y": y, "z": z, "diameter": ball_d}
             for z in zs for y in ys for x in xs]

    tubes = []

    def tube(x0, y0, z0, x1, y1, z1, axis):
        length = abs((x1 - x0) + (y1 - y0) + (z1 - z0))
        tubes.append({"p0": (x0, y0, z0), "p1": (x1, y1, z1),
                      "axis": axis, "diameter": tube_d, "length": length})

    for iz in range(nz):
        for iy in range(ny):
            for ix in range(nx - 1):  # X edges
                tube(xs[ix], ys[iy], zs[iz], xs[ix + 1], ys[iy], zs[iz], "x")
    for iz in range(nz):
        for iy in range(ny - 1):     # Y edges
            for ix in range(nx):
                tube(xs[ix], ys[iy], zs[iz], xs[ix], ys[iy + 1], zs[iz], "y")
    for iz in range(nz - 1):         # Z edges
        for iy in range(ny):
            for ix in range(nx):
                tube(xs[ix], ys[iy], zs[iz], xs[ix], ys[iy], zs[iz + 1], "z")

    panels = []
    for cell in expand_panels(nx, ny, nz, options):
        x0, y0, z0, x1, y1, z1 = _panel_box(coords, cell, inset, thickness)
        if x1 - x0 <= 0 or y1 - y0 <= 0 or z1 - z0 <= 0:
            continue  # degenerate (inset larger than the bay) — skip rather than build junk
        panels.append({**cell, "box": (x0, y0, z0, x1, y1, z1),
                       "size": (round(x1 - x0, 1), round(y1 - y0, 1), round(z1 - z0, 1))})

    tube_total = sum(t["length"] for t in tubes)
    panel_area = sum(
        max(p["box"][3] - p["box"][0], thickness) * max(p["box"][5] - p["box"][2], thickness)
        if FACE_AXIS[p["face"]] != "z"
        else (p["box"][3] - p["box"][0]) * (p["box"][4] - p["box"][1])
        for p in panels)

    bom = {
        "balls": len(balls),
        "tubes": len(tubes),
        "tube_total_mm": round(tube_total, 1),
        "panels": len(panels),
        "panel_area_m2": round(panel_area / 1_000_000.0, 3),
        "overall": (round(xs[-1], 1), round(ys[-1], 1), round(zs[-1], 1)),
        "grid": (nx - 1, ny - 1, nz - 1),
    }

    return {"coords": {"x": xs, "y": ys, "z": zs},
            "balls": balls, "tubes": tubes, "panels": panels, "bom": bom}


def summary_text(spec):
    """A short human-readable summary of a spec's bill of materials."""
    b = spec["bom"]
    w, d, h = b["overall"]
    gx, gy, gz = b["grid"]
    return (
        "USM structure {:g}(W) x {:g}(D) x {:g}(H) mm  [{}x{}x{} bays]\n"
        "  Ball connectors: {}\n"
        "  Tubes: {} ({:g} mm total)\n"
        "  Panels: {} ({:g} m2)".format(
            w, d, h, gx, gy, gz, b["balls"], b["tubes"],
            b["tube_total_mm"], b["panels"], b["panel_area_m2"]))
