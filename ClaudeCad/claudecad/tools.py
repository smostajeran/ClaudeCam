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
        "name": "change_parameter",
        "description": "Change an existing user parameter's value/expression (e.g. make the part bigger). Use inspect_model to see parameter names.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "expression": {"type": "string", "description": "New value/expression, e.g. '120 mm' or '2 * width'."},
            },
            "required": ["name", "expression"],
        },
    },
    {
        "name": "fillet_edges",
        "description": "Round specific edges of a body. Get edge indices from list_edges first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Default 0."},
                "edge_indices": {"type": "array", "items": {"type": "integer"}, "description": "Edge indices from list_edges."},
                "radius": _LENGTH,
            },
            "required": ["edge_indices", "radius"],
        },
    },
    {
        "name": "chamfer_edges",
        "description": "Bevel specific edges of a body. Get edge indices from list_edges first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Default 0."},
                "edge_indices": {"type": "array", "items": {"type": "integer"}, "description": "Edge indices from list_edges."},
                "distance": _LENGTH,
            },
            "required": ["edge_indices", "distance"],
        },
    },
    {
        "name": "cut_hole",
        "description": "Cut a round hole into a flat face of a body. Get the face index from list_faces. Through-all by default; give depth for a blind hole. x_offset/y_offset (mm) move the hole from the face's centre.",
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Default 0."},
                "face_index": {"type": "integer", "description": "Planar face from list_faces."},
                "diameter": _LENGTH,
                "depth": {"type": ["string", "number"], "description": "Blind-hole depth (mm/expression). Omit for through-all."},
                "x_offset": {"type": "number", "description": "mm from face centre. Default 0."},
                "y_offset": {"type": "number", "description": "mm from face centre. Default 0."},
            },
            "required": ["face_index", "diameter"],
        },
    },
    {
        "name": "combine_bodies",
        "description": "Boolean-combine bodies: join (union), cut (subtract tools from target), or intersect. Body indices come from inspect_model.",
        "input_schema": {
            "type": "object",
            "properties": {
                "target_index": {"type": "integer", "description": "The body kept/modified."},
                "tool_indices": {"type": "array", "items": {"type": "integer"}, "description": "Bodies combined into/subtracted from the target."},
                "operation": {"type": "string", "enum": ["join", "cut", "intersect"], "description": "Default 'join'."},
            },
            "required": ["target_index", "tool_indices"],
        },
    },
    {
        "name": "move_body",
        "description": "Translate a body by (dx, dy, dz) millimetres — useful to position an existing body. Index from inspect_model.",
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer"},
                "dx": {"type": "number"}, "dy": {"type": "number"}, "dz": {"type": "number"},
            },
            "required": ["body_index"],
        },
    },
    {
        "name": "draw_polygon",
        "description": "Draw a regular N-sided polygon (vertices on a circle of the given radius) in a sketch. All values in mm.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_id": {"type": "string"},
                "sides": {"type": "integer", "description": "Number of sides (>=3)."},
                "radius": {"type": "number", "description": "Circumscribed radius in mm."},
                "center_x": {"type": "number", "description": "Default 0."},
                "center_y": {"type": "number", "description": "Default 0."},
            },
            "required": ["sketch_id", "sides", "radius"],
        },
    },
    {
        "name": "export_model",
        "description": "Export the model to a file in the user's home folder. Formats: step, stl, iges, f3d.",
        "input_schema": {
            "type": "object",
            "properties": {
                "format": {"type": "string", "enum": ["step", "stl", "iges", "f3d"], "description": "Default 'step'."},
                "filename": {"type": "string", "description": "Base filename (no extension needed). Default 'claudecad_export'."},
            },
        },
    },
    {
        "name": "loft",
        "description": "Create a body by lofting through two or more profiles (one per sketch, in order). Use for tapered/blended shapes. Sketches are usually on offset planes at different heights.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sketch_ids": {"type": "array", "items": {"type": "string"}, "description": "Sketch ids in loft order (>=2)."},
                "operation": {"type": "string", "enum": ["new", "join", "cut", "intersect"], "description": "Default 'new'."},
            },
            "required": ["sketch_ids"],
        },
    },
    {
        "name": "sweep",
        "description": "Sweep a profile along a path to make pipes/handles/rails. Give the sketch holding the profile and a separate sketch holding the path curve.",
        "input_schema": {
            "type": "object",
            "properties": {
                "profile_sketch_id": {"type": "string", "description": "Sketch with the closed profile."},
                "path_sketch_id": {"type": "string", "description": "Sketch with the path curve."},
                "operation": {"type": "string", "enum": ["new", "join", "cut", "intersect"], "description": "Default 'new'."},
            },
            "required": ["profile_sketch_id", "path_sketch_id"],
        },
    },
    {
        "name": "mesh_to_solid",
        "description": "Convert an imported mesh body (from inspect_model) into an editable solid body, where the Fusion version supports it.",
        "input_schema": {
            "type": "object",
            "properties": {"mesh_index": {"type": "integer", "description": "Which mesh body. Default 0."}},
        },
    },
    {
        "name": "add_thread",
        "description": "Add a standard (metric) modeled thread to a cylindrical face — e.g. tap a hole (internal) or thread a shaft (external). Get the cylindrical face index from list_faces.",
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Default 0."},
                "face_index": {"type": "integer", "description": "A cylindrical face from list_faces."},
                "internal": {"type": "boolean", "description": "True for a tapped hole, false for an external (shaft) thread. Default true."},
            },
            "required": ["face_index"],
        },
    },
    {
        "name": "get_mass_properties",
        "description": "Report mass, volume, surface area and centre of mass for a body (uses its assigned material's density).",
        "input_schema": {
            "type": "object",
            "properties": {"body_index": {"type": "integer", "description": "Default 0."}},
        },
    },
    {
        "name": "list_materials",
        "description": (
            "List the physical materials actually available in this Fusion install's material "
            "libraries (optionally filtered). Call this BEFORE set_material to pick a name that "
            "really exists — material names vary by install, so don't guess (e.g. for casework "
            "filter 'wood', 'oak', 'plywood', 'mdf')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filter_text": {"type": "string", "description": "Case-insensitive substring to filter material names, e.g. 'wood'. Omit to list all."},
            },
        },
    },
    {
        "name": "set_material",
        "description": (
            "Assign a physical material to a body (e.g. 'Aluminum', 'ABS Plastic', 'Oak') so mass "
            "properties and appearance are realistic. Names vary by install — if unsure, call "
            "list_materials first to get a valid name. Matching prefers exact, then prefix, then "
            "substring. Set all_bodies true to apply the same material to every body at once "
            "(handy for a cabinet's panels)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Default 0. Ignored when all_bodies is true."},
                "name": {"type": "string", "description": "Material name (from list_materials; matched case-insensitively)."},
                "all_bodies": {"type": "boolean", "description": "Apply to every solid body. Default false."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "get_selection",
        "description": "Read what the user has currently selected (clicked) in the Fusion viewport — faces, edges, or bodies. Use this when the user says 'this edge', 'the face I picked', 'these', etc., then act on the selection.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "fillet_selection",
        "description": "Round the edges the user has selected in the Fusion viewport.",
        "input_schema": {
            "type": "object",
            "properties": {"radius": _LENGTH},
            "required": ["radius"],
        },
    },
    {
        "name": "chamfer_selection",
        "description": "Bevel the edges the user has selected in the Fusion viewport.",
        "input_schema": {
            "type": "object",
            "properties": {"distance": _LENGTH},
            "required": ["distance"],
        },
    },
    {
        "name": "cut_hole_selection",
        "description": "Cut a round hole, centred, in the flat face the user has selected in the Fusion viewport. Through-all unless depth is given.",
        "input_schema": {
            "type": "object",
            "properties": {
                "diameter": _LENGTH,
                "depth": {"type": ["string", "number"], "description": "Blind-hole depth. Omit for through-all."},
            },
            "required": ["diameter"],
        },
    },
    {
        "name": "build_cabinet",
        "description": (
            "Build a frameless (Euro-style) cabinet carcass from its overall size, in one step. "
            "This encodes casework domain knowledge: it creates the named panels positioned to "
            "actually fit together — Left Side, Right Side, Bottom, Top, Back, and optional "
            "Shelves — and returns a cut list plus a joinery plan. Origin is the bottom-left-back "
            "corner; X=width, Y=depth, Z=height. Use this whenever the user asks for a cabinet, "
            "carcass, box, or casework rather than building each panel by hand. Do NOT guess the "
            "joinery method: if the user hasn't explicitly chosen one, ask them (screws / dowels / "
            "dado / auto) and wait for their answer before calling this tool. Note: panels are "
            "solid bodies and the joinery is a plan only — joint geometry (pocket holes, dados) "
            "isn't cut yet (except the back-panel groove, which IS cut — see back_joint)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "width": {"type": "number", "description": "Overall outside width in mm (X)."},
                "height": {"type": "number", "description": "Overall outside height in mm (Z)."},
                "depth": {"type": "number", "description": "Overall outside depth in mm (Y)."},
                "thickness": {"type": "number", "description": "Panel/sheet thickness in mm. Default 18."},
                "back_thickness": {"type": "number", "description": "Back panel thickness in mm. Default 6."},
                "shelves": {"type": "integer", "description": "Number of evenly-spaced interior shelves. Default 0."},
                "joinery": {
                    "type": "string",
                    "enum": ["screws", "dowels", "dado", "auto"],
                    "description": "Joinery method to plan for, as chosen by the user (ask first; don't guess). 'auto' picks a sound default only when the user explicitly asks you to choose.",
                },
                "back_joint": {
                    "type": "string",
                    "enum": ["groove", "inset", "overlay"],
                    "description": (
                        "How the back panel meets the sides. 'groove' (default): the back has a "
                        "tongue on its left and right edges that seats into a groove cut into each "
                        "side panel (squares the carcass, captures the edges). 'inset': flush "
                        "between the sides. 'overlay': covers the full rear over the side edges."
                    ),
                },
                "back_groove": {
                    "type": "number",
                    "description": "Groove/tongue depth in mm for back_joint='groove'. Default half the panel thickness.",
                },
                "parametric": {
                    "type": "boolean",
                    "description": "Create named user parameters (cab_w/cab_h/cab_d/cab_t/cab_back) and drive the panels from them so the cabinet is adjustable later. Default true.",
                },
            },
            "required": ["width", "height", "depth"],
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
    from . import policy
    policy.validate(name, tool_input)  # reject bad args before any geometry is created
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
    if name == "change_parameter":
        return cad.change_parameter(ti["name"], ti["expression"])
    if name == "fillet_edges":
        return cad.fillet_edges(int(ti.get("body_index", 0)), list(ti["edge_indices"]), ti["radius"])
    if name == "chamfer_edges":
        return cad.chamfer_edges(int(ti.get("body_index", 0)), list(ti["edge_indices"]), ti["distance"])
    if name == "cut_hole":
        return cad.cut_hole(int(ti.get("body_index", 0)), int(ti["face_index"]), ti["diameter"],
                            ti.get("depth"), float(ti.get("x_offset", 0.0)), float(ti.get("y_offset", 0.0)))
    if name == "combine_bodies":
        return cad.combine_bodies(int(ti["target_index"]), list(ti["tool_indices"]), ti.get("operation", "join"))
    if name == "move_body":
        return cad.move_body(int(ti["body_index"]), float(ti.get("dx", 0.0)), float(ti.get("dy", 0.0)), float(ti.get("dz", 0.0)))
    if name == "draw_polygon":
        return cad.draw_polygon(ti["sketch_id"], int(ti["sides"]), float(ti["radius"]),
                                float(ti.get("center_x", 0.0)), float(ti.get("center_y", 0.0)))
    if name == "export_model":
        return cad.export_model(ti.get("format", "step"), ti.get("filename"))
    if name == "loft":
        return cad.loft(list(ti["sketch_ids"]), ti.get("operation", "new"))
    if name == "sweep":
        return cad.sweep(ti["profile_sketch_id"], ti["path_sketch_id"], ti.get("operation", "new"))
    if name == "mesh_to_solid":
        return cad.mesh_to_solid(int(ti.get("mesh_index", 0)))
    if name == "add_thread":
        return cad.add_thread(int(ti.get("body_index", 0)), int(ti["face_index"]), bool(ti.get("internal", True)))
    if name == "get_mass_properties":
        return cad.get_mass_properties(int(ti.get("body_index", 0)))
    if name == "list_materials":
        return cad.list_materials(ti.get("filter_text", ""))
    if name == "set_material":
        return cad.set_material(int(ti.get("body_index", 0)), ti["name"], bool(ti.get("all_bodies", False)))
    if name == "get_selection":
        return cad.get_selection()
    if name == "fillet_selection":
        return cad.fillet_selection(ti["radius"])
    if name == "chamfer_selection":
        return cad.chamfer_selection(ti["distance"])
    if name == "cut_hole_selection":
        return cad.cut_hole_selection(ti["diameter"], ti.get("depth"))
    if name == "build_cabinet":
        joinery = ti.get("joinery")
        if not joinery:
            raise ValueError(
                "No joinery method was provided. Ask the user which joinery they want "
                "(screws / dowels / dado / auto) and wait for their answer before building — "
                "do not guess."
            )
        return cad.build_cabinet(
            float(ti["width"]), float(ti["height"]), float(ti["depth"]),
            float(ti.get("thickness", 18.0)), float(ti.get("back_thickness", 6.0)),
            int(ti.get("shelves", 0)), joinery,
            ti.get("back_joint", "groove"),
            ti.get("back_groove"),
            bool(ti.get("parametric", True)),
        )
    if name == "get_design_summary":
        return cad.get_design_summary()

    raise ValueError("Unknown tool: {}".format(name))
