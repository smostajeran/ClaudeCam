"""Tool schemas exposed to Claude, and the dispatcher from tool name to CadBuilder."""

_LENGTH = {"type": ["string", "number"], "description": "Millimetres, or a parameter expression like 'width' or '2 * wall'."}

TOOLS = [
    {
        "name": "create_parameter",
        "description": (
            "Create a named user parameter that drives the model, so the design can be "
            "adjusted later by editing one value. Create parameters for the KEY dimensions "
            "BEFORE drawing, then reference their names in the drawing/feature tools (e.g. "
            "width='width', distance='height'). 'expression' is a value with units like "
            "'40 mm', or an expression like '2 * width'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Parameter name, e.g. 'width'."},
                "expression": {"type": "string", "description": "e.g. '40 mm' or '2 * width'."},
                "unit": {"type": "string", "description": "Unit, e.g. mm, cm, deg. Defaults to mm."},
                "comment": {"type": "string", "description": "What this parameter controls."},
            },
            "required": ["name", "expression"],
        },
    },
    {
        "name": "create_sketch",
        "description": (
            "Create a new sketch on a construction plane. Every design starts with sketches. "
            "Use 'offset' to place the sketch at a height/position away from the origin so "
            "parts assemble in the right place instead of overlapping at the origin (e.g. a lid "
            "on top of a box, or a peg on a face). Returns a sketch id (e.g. 's1')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "plane": {"type": "string", "enum": ["xy", "xz", "yz"], "description": "Base construction plane. Defaults to xy."},
                "offset": {"type": ["string", "number"], "description": "Distance (mm) or expression to offset the sketch from the base plane. Default 0 (on the plane)."},
                "name": {"type": "string", "description": "Optional readable name for the sketch."},
            },
        },
    },
    {
        "name": "draw_rectangle",
        "description": "Draw a rectangle in a sketch, centred at (center_x, center_y). Pass width/height as parameter expressions to make the rectangle adjustable later.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "width": _LENGTH,
                "height": _LENGTH,
                "center_x": {"type": "number", "description": "Centre X in mm. Default 0."},
                "center_y": {"type": "number", "description": "Centre Y in mm. Default 0."},
            },
            "required": ["sketch_id", "width", "height"],
        },
    },
    {
        "name": "draw_circle",
        "description": "Draw a circle in a sketch. Pass radius as a parameter expression to make it adjustable later.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "radius": _LENGTH,
                "center_x": {"type": "number", "description": "Centre X in mm. Default 0."},
                "center_y": {"type": "number", "description": "Centre Y in mm. Default 0."},
            },
            "required": ["sketch_id", "radius"],
        },
    },
    {
        "name": "draw_line",
        "description": "Draw a single line segment between two points in a sketch. All values are millimetres.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "x1": {"type": "number"}, "y1": {"type": "number"},
                "x2": {"type": "number"}, "y2": {"type": "number"},
            },
            "required": ["sketch_id", "x1", "y1", "x2", "y2"],
        },
    },
    {
        "name": "extrude",
        "description": "Extrude a closed profile of a sketch. Prefer a parameter expression for distance (e.g. 'height'). Use operation 'cut' for holes, 'join' to add to a body. Use 'symmetric' to extrude both ways about the sketch, and 'start_offset' to begin the extrude at a distance from the sketch plane (useful for positioning).",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "distance": _LENGTH,
                "operation": {"type": "string", "enum": ["new", "join", "cut", "intersect"], "description": "Default 'new'."},
                "profile_index": {"type": "integer", "description": "Which profile in the sketch to extrude. Default 0."},
                "symmetric": {"type": "boolean", "description": "Extrude equally in both directions about the sketch plane. Default false."},
                "start_offset": {"type": ["string", "number"], "description": "Distance (mm) or expression to offset the start of the extrude from the sketch plane. Default 0."},
            },
            "required": ["sketch_id", "distance"],
        },
    },
    {
        "name": "revolve",
        "description": "Revolve a closed profile around the X, Y or Z construction axis to make a rotationally-symmetric body.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "axis": {"type": "string", "enum": ["x", "y", "z"], "description": "Axis of revolution. Default 'z'."},
                "angle": {"type": ["string", "number"], "description": "Degrees (default 360) or an expression like '180 deg'."},
                "operation": {"type": "string", "enum": ["new", "join", "cut", "intersect"], "description": "Default 'new'."},
                "profile_index": {"type": "integer", "description": "Default 0."},
            },
            "required": ["sketch_id"],
        },
    },
    {
        "name": "fillet_all_edges",
        "description": "Round (fillet) ALL edges of the most recently created body with a constant radius.",
        "input_schema": {
            "type": "object",
            "properties": {"radius": _LENGTH},
            "required": ["radius"],
        },
    },
    {
        "name": "chamfer_all_edges",
        "description": "Bevel (chamfer) ALL edges of the most recently created body by an equal distance.",
        "input_schema": {
            "type": "object",
            "properties": {"distance": _LENGTH},
            "required": ["distance"],
        },
    },
    {
        "name": "shell",
        "description": "Hollow out the most recent body to a wall thickness. By default the top face is removed (open box); set remove_top false for a fully enclosed shell.",
        "input_schema": {
            "type": "object",
            "properties": {
                "thickness": _LENGTH,
                "remove_top": {"type": "boolean", "description": "Remove the top face to leave an opening. Default true."},
            },
            "required": ["thickness"],
        },
    },
    {
        "name": "circular_pattern",
        "description": "Pattern the most recent feature in a circle about the X, Y or Z axis.",
        "input_schema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "Total number of copies."},
                "axis": {"type": "string", "enum": ["x", "y", "z"], "description": "Default 'z'."},
                "angle": {"type": "number", "description": "Total angle in degrees. Default 360."},
            },
            "required": ["count"],
        },
    },
    {
        "name": "rectangular_pattern",
        "description": "Pattern the most recent feature in a grid along X (and optionally Y).",
        "input_schema": {
            "type": "object",
            "properties": {
                "count_x": {"type": "integer"},
                "spacing_x": {"type": "number", "description": "Spacing in mm along X."},
                "count_y": {"type": "integer", "description": "Default 1."},
                "spacing_y": {"type": "number", "description": "Spacing in mm along Y. Default 0."},
            },
            "required": ["count_x", "spacing_x"],
        },
    },
    {
        "name": "capture_view",
        "description": "Take a screenshot of the current Fusion 3D viewport and look at it. Use this to visually check your work and self-correct (proportions, placement, missing features).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "inspect_model",
        "description": (
            "Read back the current document so you can see what already exists — your own "
            "work, geometry the user added, and imported meshes. Returns units, user "
            "parameters, every solid body (name, bounding-box size in mm, face/edge counts, "
            "volume), every mesh body (size + triangle count; meshes are NOT parametric and "
            "can't be edited by these tools), and sketch count. Call this before acting on or "
            "around existing geometry, or to verify your work."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_faces",
        "description": "List the faces of a solid body with an index, surface type (plane/cylinder/…), area, location (mm) and (for planes) normal. Use to find a specific face to work from.",
        "input_schema": {
            "type": "object",
            "properties": {"body_index": {"type": "integer", "description": "Which solid body (from inspect_model). Default 0."}},
        },
    },
    {
        "name": "list_edges",
        "description": "List the edges of a solid body with an index, curve type (line/arc/circle), length (mm) and location (mm). Use to find a specific edge.",
        "input_schema": {
            "type": "object",
            "properties": {"body_index": {"type": "integer", "description": "Which solid body (from inspect_model). Default 0."}},
        },
    },
    {
        "name": "get_design_summary",
        "description": "Quick state: body count, sketch count, and the parameters this assistant created. For full detail use inspect_model.",
        "input_schema": {"type": "object", "properties": {}},
    },
]


def execute(name, tool_input, cad):
    """Run a tool against the CadBuilder. Returns a status string, or (for capture_view)
    a list of content blocks. Raises on failure."""
    ti = tool_input or {}

    if name == "create_parameter":
        return cad.create_parameter(ti["name"], ti["expression"], ti.get("unit", "mm"), ti.get("comment", ""))
    if name == "create_sketch":
        return cad.create_sketch(ti.get("plane", "xy"), ti.get("name"), ti.get("offset", 0))
    if name == "draw_rectangle":
        return cad.draw_rectangle(ti["sketch_id"], ti["width"], ti["height"],
                                  float(ti.get("center_x", 0.0)), float(ti.get("center_y", 0.0)))
    if name == "draw_circle":
        return cad.draw_circle(ti["sketch_id"], ti["radius"],
                               float(ti.get("center_x", 0.0)), float(ti.get("center_y", 0.0)))
    if name == "draw_line":
        return cad.draw_line(ti["sketch_id"], float(ti["x1"]), float(ti["y1"]), float(ti["x2"]), float(ti["y2"]))
    if name == "extrude":
        return cad.extrude(ti["sketch_id"], ti["distance"], ti.get("operation", "new"),
                           int(ti.get("profile_index", 0)), bool(ti.get("symmetric", False)),
                           ti.get("start_offset"))
    if name == "revolve":
        return cad.revolve(ti["sketch_id"], ti.get("axis", "z"), ti.get("angle", 360),
                           ti.get("operation", "new"), int(ti.get("profile_index", 0)))
    if name == "fillet_all_edges":
        return cad.fillet_all_edges(ti["radius"])
    if name == "chamfer_all_edges":
        return cad.chamfer_all_edges(ti["distance"])
    if name == "shell":
        return cad.shell(ti["thickness"], bool(ti.get("remove_top", True)))
    if name == "circular_pattern":
        return cad.circular_pattern(int(ti["count"]), ti.get("axis", "z"), float(ti.get("angle", 360)))
    if name == "rectangular_pattern":
        return cad.rectangular_pattern(int(ti["count_x"]), float(ti["spacing_x"]),
                                       int(ti.get("count_y", 1)), float(ti.get("spacing_y", 0.0)))
    if name == "capture_view":
        return cad.capture_view()
    if name == "inspect_model":
        return cad.inspect_model()
    if name == "list_faces":
        return cad.list_faces(int(ti.get("body_index", 0)))
    if name == "list_edges":
        return cad.list_edges(int(ti.get("body_index", 0)))
    if name == "get_design_summary":
        return cad.get_design_summary()

    raise ValueError("Unknown tool: {}".format(name))
