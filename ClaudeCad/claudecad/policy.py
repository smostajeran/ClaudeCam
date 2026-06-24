"""Tool risk classification and deterministic input validation (no Fusion dependency).

This is the safety boundary in front of :func:`claudecad.tools.execute`. ``validate``
rejects nonsensical arguments BEFORE any geometry is created, so a bad tool call fails
cleanly (the model sees the error and corrects) instead of half-mutating the document.
``risk`` / ``is_destructive`` classify a tool so the UI can decide what warrants a
heads-up or confirmation.
"""

import math

READ = "read"      # inspection only; never changes the document
BUILD = "build"    # creates new geometry/parameters
MODIFY = "modify"  # changes or consumes existing geometry
EXPORT = "export"  # writes a file

RISK = {
    "get_design_summary": READ, "inspect_model": READ, "list_faces": READ,
    "list_edges": READ, "get_selection": READ, "get_mass_properties": READ,
    "list_materials": READ, "capture_view": READ,
    "create_parameter": BUILD, "create_sketch": BUILD, "draw_rectangle": BUILD,
    "draw_circle": BUILD, "draw_line": BUILD, "draw_polygon": BUILD,
    "extrude": BUILD, "revolve": BUILD, "loft": BUILD, "sweep": BUILD,
    "fillet_all_edges": BUILD, "chamfer_all_edges": BUILD, "shell": BUILD,
    "circular_pattern": BUILD, "rectangular_pattern": BUILD, "build_cabinet": BUILD,
    "fillet_edges": BUILD, "chamfer_edges": BUILD, "fillet_selection": BUILD,
    "chamfer_selection": BUILD, "set_material": BUILD, "add_thread": BUILD,
    "change_parameter": MODIFY, "cut_hole": MODIFY, "cut_hole_selection": MODIFY,
    "combine_bodies": MODIFY, "move_body": MODIFY, "mesh_to_solid": MODIFY,
    "drill_holes": MODIFY,
    "export_model": EXPORT,
}

# Operations that consume/alter existing geometry in a way worth a heads-up.
DESTRUCTIVE = {"combine_bodies", "cut_hole", "cut_hole_selection", "mesh_to_solid", "drill_holes"}

# Tools that should be gated behind explicit user confirmation in a preview/approve UI.
REQUIRES_CONFIRMATION = DESTRUCTIVE | {"export_model", "move_body", "combine_bodies", "build_cabinet"}


def needs_confirmation(name):
    return name in REQUIRES_CONFIRMATION


def summarize_call(name, tool_input):
    """A short, human-readable one-line description of a pending tool call for the plan preview."""
    ti = tool_input or {}
    if name == "build_cabinet":
        extra = []
        if ti.get("shelves"):
            extra.append("{} shelf(es)".format(ti["shelves"]))
        extra.append("{} joinery".format(ti.get("joinery", "screws")))
        extra.append("{} back".format(ti.get("back_joint", "groove")))
        return "Build cabinet {}x{}x{} mm ({})".format(
            ti.get("width"), ti.get("height"), ti.get("depth"), ", ".join(extra))
    if name == "cut_hole":
        return "Cut a {} mm hole in body[{}] face[{}]".format(
            ti.get("diameter"), ti.get("body_index", 0), ti.get("face_index"))
    if name == "cut_hole_selection":
        return "Cut a {} mm hole in the selected face".format(ti.get("diameter"))
    if name == "combine_bodies":
        return "Combine body[{}] with {} ({})".format(
            ti.get("target_index"), ti.get("tool_indices"), ti.get("operation", "join"))
    if name == "move_body":
        return "Move body[{}] by ({}, {}, {}) mm".format(
            ti.get("body_index"), ti.get("dx", 0), ti.get("dy", 0), ti.get("dz", 0))
    if name == "mesh_to_solid":
        return "Convert mesh[{}] to a solid body".format(ti.get("mesh_index", 0))
    if name == "export_model":
        return "Export the model as {}".format((ti.get("format") or "step").upper())
    if name == "drill_holes":
        return "Drill {} hole(s) into body[{}]".format(len(ti.get("holes") or []), ti.get("body_index"))
    return name

# Tools that act on the live viewport selection: get_selection must be read first.
REQUIRES_SELECTION = {"fillet_selection", "chamfer_selection", "cut_hole_selection"}

# Tools that edit existing geometry by index/name: an inspection must precede them so the
# indices/names are valid against the current model rather than guessed.
REQUIRES_INSPECTION = {
    "cut_hole", "combine_bodies", "move_body", "fillet_edges", "chamfer_edges",
    "add_thread", "mesh_to_solid", "change_parameter", "drill_holes",
}

# Calls that count as "inspecting" the model (any one satisfies REQUIRES_INSPECTION).
INSPECTION_TOOLS = {"inspect_model", "list_faces", "list_edges", "get_design_summary", "get_selection"}

_MAX_MM = 100000.0  # 100 m — an upper bound on any single length input


def risk(name):
    return RISK.get(name, BUILD)


def is_destructive(name):
    return name in DESTRUCTIVE


def metadata(name):
    """Full policy descriptor for a tool (risk + permission/safety flags)."""
    return {
        "name": name,
        "risk_level": risk(name),
        "destructive": name in DESTRUCTIVE,
        "requires_confirmation": name in REQUIRES_CONFIRMATION,
        "requires_selection": name in REQUIRES_SELECTION,
        "requires_inspection": name in REQUIRES_INSPECTION,
    }


def check_prerequisites(name, tools_called):
    """Enforce runtime ordering rules; raise ValueError (surfaced to the model) if unmet.

    ``tools_called`` is the set of tool names already invoked in this conversation (and the
    current batch). Selection edits need a prior get_selection; index/name edits need a prior
    inspection so they don't act on guessed indices.
    """
    if name in REQUIRES_SELECTION and "get_selection" not in tools_called:
        raise ValueError(
            "'{}' acts on your Fusion viewport selection — call get_selection first to read "
            "what's selected, then act on it.".format(name)
        )
    if name in REQUIRES_INSPECTION and tools_called.isdisjoint(INSPECTION_TOOLS):
        raise ValueError(
            "'{}' edits existing geometry — call inspect_model (or list_faces / list_edges) "
            "first so the body/face/edge indices are valid for the current model, not guessed.".format(name)
        )


def _num(value):
    """Return value as float if it's a real number, else None (e.g. a parameter
    expression string, which Fusion validates itself)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _check_len(label, value, allow_negative=False):
    n = _num(value)
    if n is None:
        return  # expression string or omitted — not our job to validate
    if math.isnan(n) or math.isinf(n):
        raise ValueError("{} must be a finite number.".format(label))
    if not allow_negative and n <= 0:
        raise ValueError("{} must be greater than 0 (got {:g} mm).".format(label, n))
    if abs(n) > _MAX_MM:
        raise ValueError("{} {:g} mm is unreasonably large (over 100 m).".format(label, n))


def _check_count(label, value, lo, hi):
    n = _num(value)
    if n is None or int(n) != n or int(n) < lo or int(n) > hi:
        raise ValueError("{} must be an integer between {} and {}.".format(label, lo, hi))


def validate(name, tool_input):
    """Raise ValueError if the arguments for ``name`` are out of range / nonsensical.

    Only fields that carry a real risk of degenerate geometry are checked; string
    parameter-expressions are passed through for Fusion to resolve.
    """
    ti = tool_input or {}

    if name == "draw_rectangle":
        _check_len("width", ti.get("width"))
        _check_len("height", ti.get("height"))
    elif name == "draw_circle":
        _check_len("radius", ti.get("radius"))
    elif name == "extrude":
        _check_len("distance", ti.get("distance"))
    elif name in ("fillet_all_edges", "fillet_edges", "fillet_selection"):
        _check_len("radius", ti.get("radius"))
    elif name in ("chamfer_all_edges", "chamfer_edges", "chamfer_selection"):
        _check_len("distance", ti.get("distance"))
    elif name == "shell":
        _check_len("thickness", ti.get("thickness"))
    elif name in ("cut_hole", "cut_hole_selection"):
        _check_len("diameter", ti.get("diameter"))
        if ti.get("depth") is not None:
            _check_len("depth", ti.get("depth"))
    elif name == "draw_polygon":
        _check_count("sides", ti.get("sides"), 3, 1000)
        _check_len("radius", ti.get("radius"))
    elif name == "circular_pattern":
        _check_count("count", ti.get("count"), 1, 2000)
    elif name == "rectangular_pattern":
        _check_count("count_x", ti.get("count_x"), 1, 5000)
        if ti.get("count_y") is not None:
            _check_count("count_y", ti.get("count_y"), 1, 5000)
    elif name == "build_cabinet":
        for k in ("width", "height", "depth"):
            _check_len(k, ti.get(k))
        if ti.get("thickness") is not None:
            _check_len("thickness", ti.get("thickness"))
        if ti.get("back_thickness") is not None:
            _check_len("back_thickness", ti.get("back_thickness"))
        if ti.get("shelves") is not None:
            _check_count("shelves", ti.get("shelves"), 0, 50)
    elif name == "drill_holes":
        holes = ti.get("holes")
        if not isinstance(holes, list) or not holes:
            raise ValueError("drill_holes needs a non-empty 'holes' list.")
        for i, h in enumerate(holes):
            if not isinstance(h, dict):
                raise ValueError("Hole {} must be an object.".format(i))
            _check_len("hole {} diameter".format(i), h.get("diameter"))
            _check_len("hole {} depth".format(i), h.get("depth"))
    elif name == "export_model":
        from . import util
        if util.export_extension(ti.get("format", "step")) is None:
            raise ValueError("Unsupported export format '{}'. Use step, stl, iges or f3d.".format(ti.get("format")))
