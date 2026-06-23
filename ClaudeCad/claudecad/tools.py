"""Tool schemas exposed to Claude, and the dispatcher from tool name to CadBuilder."""

TOOLS = [
    {
        "name": "create_parameter",
        "description": (
            "Create a named user parameter that drives the model, so the design can be "
            "adjusted later by editing one value. Create parameters for the KEY dimensions "
            "BEFORE drawing, and reference their names in extrude distances (e.g. distance "
            "'height'). 'expression' is a value with units like '40 mm', or an expression "
            "referencing other parameters like '2 * width'."
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
        "description": "Create a new sketch on a construction plane. Every design starts with sketches. Returns a sketch id (e.g. 's1') used by the drawing and extrude tools.",
        "input_schema": {
            "type": "object",
            "properties": {
                "plane": {"type": "string", "enum": ["xy", "xz", "yz"], "description": "Construction plane. Defaults to xy."},
                "name": {"type": "string", "description": "Optional readable name for the sketch."},
            },
        },
    },
    {
        "name": "draw_rectangle",
        "description": "Draw a rectangle in a sketch, centred at (center_x, center_y). All values are millimetres.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "width": {"type": "number", "description": "Width in mm (X)."},
                "height": {"type": "number", "description": "Height in mm (Y)."},
                "center_x": {"type": "number", "description": "Centre X in mm. Default 0."},
                "center_y": {"type": "number", "description": "Centre Y in mm. Default 0."},
            },
            "required": ["sketch_id", "width", "height"],
        },
    },
    {
        "name": "draw_circle",
        "description": "Draw a circle in a sketch. All values are millimetres.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "radius": {"type": "number", "description": "Radius in mm."},
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
                "x1": {"type": "number"},
                "y1": {"type": "number"},
                "x2": {"type": "number"},
                "y2": {"type": "number"},
            },
            "required": ["sketch_id", "x1", "y1", "x2", "y2"],
        },
    },
    {
        "name": "extrude",
        "description": (
            "Extrude a closed profile of a sketch into a 3D feature. 'distance' should be a "
            "parameter-driven expression like 'height' or a value with units like '20 mm' "
            "(prefer referencing a parameter so the model stays adjustable). Use operation "
            "'cut' to remove material (e.g. holes) and 'join' to add to an existing body."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "distance": {
                    "type": ["string", "number"],
                    "description": "Expression like 'height' or '20 mm'. A bare number is treated as mm.",
                },
                "operation": {"type": "string", "enum": ["new", "join", "cut", "intersect"], "description": "Default 'new'."},
                "profile_index": {"type": "integer", "description": "Which profile in the sketch to extrude. Default 0."},
            },
            "required": ["sketch_id", "distance"],
        },
    },
    {
        "name": "get_design_summary",
        "description": "Report the current model state: body count, sketch count, and tracked parameters.",
        "input_schema": {"type": "object", "properties": {}},
    },
]


def execute(name, tool_input, cad):
    """Run a tool against the CadBuilder. Returns a status string; raises on failure."""
    ti = tool_input or {}

    if name == "create_parameter":
        return cad.create_parameter(ti["name"], ti["expression"], ti.get("unit", "mm"), ti.get("comment", ""))

    if name == "create_sketch":
        return cad.create_sketch(ti.get("plane", "xy"), ti.get("name"))

    if name == "draw_rectangle":
        return cad.draw_rectangle(
            ti["sketch_id"], float(ti["width"]), float(ti["height"]),
            float(ti.get("center_x", 0.0)), float(ti.get("center_y", 0.0)),
        )

    if name == "draw_circle":
        return cad.draw_circle(
            ti["sketch_id"], float(ti["radius"]),
            float(ti.get("center_x", 0.0)), float(ti.get("center_y", 0.0)),
        )

    if name == "draw_line":
        return cad.draw_line(ti["sketch_id"], float(ti["x1"]), float(ti["y1"]), float(ti["x2"]), float(ti["y2"]))

    if name == "extrude":
        distance = ti["distance"]
        distance = distance if isinstance(distance, str) else "{:g} mm".format(float(distance))
        return cad.extrude(ti["sketch_id"], distance, ti.get("operation", "new"), int(ti.get("profile_index", 0)))

    if name == "get_design_summary":
        return cad.get_design_summary()

    raise ValueError("Unknown tool: {}".format(name))
