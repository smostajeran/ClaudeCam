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
                "name": {"type": "string", "description": "Readable name for the new body (operation 'new'). Always name bodies meaningfully."},
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
                "name": {"type": "string", "description": "Readable name for the new body (operation 'new')."},
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
                    "description": "EXPERIMENTAL: create named user parameters (cab_w/cab_h/cab_d/cab_t/cab_back) and drive the panels from them. Default false (the proven fixed-geometry build); the parametric path adds driven dimensions and is still being validated, so leave off unless asked.",
                },
            },
            "required": ["width", "height", "depth"],
        },
    },
    {
        "name": "drill_holes",
        "description": (
            "Drill one or more holes into a body by ABSOLUTE coordinates — the deterministic, "
            "safe way to add dowel / shelf-pin / fastener holes (e.g. into cabinet panels). Each "
            "hole is a cylinder from an entry point along an axis for a depth, boolean-cut from "
            "the target body; there's no face-frame or plane guesswork. Get body_index and panel "
            "positions from inspect_model. Pass numeric mm values (not parameter expressions). "
            "Refuses a diameter too large for the body so it can't destroy a panel."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Which solid body to drill (from inspect_model)."},
                "holes": {
                    "type": "array",
                    "description": "The holes to drill.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {"type": "number", "description": "Entry-point X in mm (absolute)."},
                            "y": {"type": "number", "description": "Entry-point Y in mm (absolute)."},
                            "z": {"type": "number", "description": "Entry-point Z in mm (absolute)."},
                            "axis": {"type": "string", "enum": ["x", "-x", "y", "-y", "z", "-z"],
                                      "description": "Direction the hole goes from the entry point."},
                            "depth": {"type": "number", "description": "Hole depth in mm."},
                            "diameter": {"type": "number", "description": "Hole diameter in mm."},
                        },
                        "required": ["x", "y", "z", "axis", "depth", "diameter"],
                    },
                },
            },
            "required": ["body_index", "holes"],
        },
    },
    {
        "name": "drill_holes_on_face",
        "description": (
            "Drill holes positioned in a FACE'S OWN 2D frame — the reliable way to place "
            "dowel / shelf-pin / hinge holes without computing world coordinates. First call "
            "list_faces to get the target face's u/v directions and extents, then give each "
            "hole as {u, v} in mm measured from the face's (min u, min v) corner. Holes are cut "
            "perpendicular into the panel (blind 'depth', or through-all if omitted). Refuses a "
            "diameter too large for the face."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer", "description": "Which solid body (from inspect_model)."},
                "face_index": {"type": "integer", "description": "Planar face from list_faces (use its reported u/v frame)."},
                "points": {
                    "type": "array",
                    "description": "Hole positions in the face's 2D frame.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "u": {"type": "number", "description": "mm along the face's u axis from its corner."},
                            "v": {"type": "number", "description": "mm along the face's v axis from its corner."},
                        },
                        "required": ["u", "v"],
                    },
                },
                "diameter": {"type": "number", "description": "Hole diameter in mm."},
                "depth": {"type": "number", "description": "Blind-hole depth in mm. Omit for through-all."},
            },
            "required": ["body_index", "face_index", "points", "diameter"],
        },
    },
    {
        "name": "build_kitchen_cabinet",
        "description": (
            "Build a CONFIGURABLE kitchen cabinet in one step, composing the carcass, an optional "
            "recessed toe kick, shelves, and a door or drawer front using kitchen-standard "
            "defaults per type (base / wall / tall). Use this for kitchen cabinets instead of "
            "wiring build_cabinet + add_doors yourself. Ask the user for type, width, and front "
            "(doors/drawers) and the joinery method if not given. Sensible defaults: base = 720 "
            "high x 560 deep + toe kick; wall = 720 x 320, no toe kick; tall = 2100 x 580 + toe kick."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "width": {"type": "number", "description": "Cabinet width in mm (e.g. 600)."},
                "cabinet_type": {"type": "string", "enum": ["base", "wall", "tall"], "description": "Default 'base'."},
                "height": {"type": "number", "description": "Override carcass height in mm (default per type)."},
                "depth": {"type": "number", "description": "Override depth in mm (default per type)."},
                "thickness": {"type": "number", "description": "Panel thickness in mm. Default 18."},
                "back_thickness": {"type": "number", "description": "Back panel thickness in mm. Default 6."},
                "front": {"type": "string", "enum": ["doors", "drawers", "none"], "description": "Front type. Default 'doors'."},
                "doors": {"type": "integer", "description": "Number of doors (default 1 if width<=600 else 2)."},
                "drawers": {"type": "integer", "description": "Number of drawers when front='drawers'. Default 3."},
                "shelves": {"type": "integer", "description": "Interior shelves (default per type)."},
                "joinery": {"type": "string", "enum": ["screws", "dowels", "dado", "auto"], "description": "Carcass joinery. Default 'screws'."},
                "back_joint": {"type": "string", "enum": ["groove", "inset", "overlay"], "description": "Back panel joint. Default 'groove'."},
                "toe_kick_height": {"type": "number", "description": "Toe-kick height in mm (base/tall). Default 100."},
                "toe_kick_recess": {"type": "number", "description": "Toe-kick setback from the front in mm. Default 50."},
            },
            "required": ["width"],
        },
    },
    {
        "name": "add_face_frame",
        "description": (
            "EXPERIMENTAL casework: apply a face frame (left/right stiles + top/bottom rails) to "
            "the front of a cabinet built with build_cabinet. Pass the same width/height. Front is "
            "at y=0, frame extends outward. Smoke-test before relying on it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "width": {"type": "number", "description": "Cabinet overall width in mm."},
                "height": {"type": "number", "description": "Cabinet overall height in mm."},
                "stile": {"type": "number", "description": "Vertical stile width in mm. Default 38."},
                "rail": {"type": "number", "description": "Horizontal rail width in mm. Default 38."},
                "frame_thickness": {"type": "number", "description": "Frame thickness in mm. Default 19."},
            },
            "required": ["width", "height"],
        },
    },
    {
        "name": "add_doors",
        "description": (
            "EXPERIMENTAL casework: add overlay or inset door fronts across a cabinet face. Pass "
            "the same width/height as build_cabinet. style 'overlay' (default) covers the front; "
            "'inset' sits within the opening (needs carcass_thickness). Smoke-test before relying on it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "width": {"type": "number", "description": "Cabinet overall width in mm."},
                "height": {"type": "number", "description": "Cabinet overall height in mm."},
                "count": {"type": "integer", "description": "Number of doors across. Default 1."},
                "thickness": {"type": "number", "description": "Door thickness in mm. Default 18."},
                "gap": {"type": "number", "description": "Gap between doors in mm. Default 3."},
                "reveal": {"type": "number", "description": "Edge reveal in mm (overlay). Default 2."},
                "style": {"type": "string", "enum": ["overlay", "inset"], "description": "Default 'overlay'."},
                "carcass_thickness": {"type": "number", "description": "Panel thickness in mm (for inset). Default 18."},
            },
            "required": ["width", "height"],
        },
    },
    {
        "name": "add_drawers",
        "description": (
            "EXPERIMENTAL casework: add stacked overlay drawer fronts and (optionally) a simple "
            "box behind each. Pass the same width/height/depth as build_cabinet. Smoke-test first."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "width": {"type": "number", "description": "Cabinet overall width in mm."},
                "height": {"type": "number", "description": "Cabinet overall height in mm."},
                "depth": {"type": "number", "description": "Cabinet overall depth in mm."},
                "count": {"type": "integer", "description": "Number of drawers. Default 1."},
                "front_thickness": {"type": "number", "description": "Drawer front thickness in mm. Default 18."},
                "gap": {"type": "number", "description": "Gap between fronts in mm. Default 3."},
                "reveal": {"type": "number", "description": "Edge reveal in mm. Default 2."},
                "carcass_thickness": {"type": "number", "description": "Panel thickness in mm. Default 18."},
                "box_thickness": {"type": "number", "description": "Drawer box material in mm. Default 12."},
                "slide_clearance": {"type": "number", "description": "Per-side slide clearance in mm. Default 13."},
                "boxes": {"type": "boolean", "description": "Also build a box behind each front. Default true."},
            },
            "required": ["width", "height", "depth"],
        },
    },
    {
        "name": "promote_to_components",
        "description": (
            "EXPERIMENTAL: move each solid body into its own component/occurrence to form a real "
            "assembly (so you get a browser tree, BOM and can add joints). Smoke-test before relying on it."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "export_dxf",
        "description": (
            "EXPERIMENTAL: export each body's largest flat face as a DXF (for CNC/laser) into a "
            "subfolder of your home folder. Smoke-test before relying on it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "Subfolder name under home. Default 'claudecad_dxf'."},
            },
        },
    },
    {
        "name": "list_hardware",
        "description": (
            "List the cabinet-hardware catalog (hinges, slides, shelf pins, connectors, handles "
            "from Blum / Hettich / Häfele and generic standards), optionally filtered. Each entry "
            "has a drill pattern you apply with drill_for_hardware. The catalog is extensible "
            "(add exact parts with add_hardware); seeded patterns are standards — verify the SKU."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"filter_text": {"type": "string", "description": "Filter by id/brand/category/name, e.g. 'hinge'. Omit for all."}},
        },
    },
    {
        "name": "hardware_info",
        "description": "Show one hardware item's details and exact drill pattern (hole offsets, diameters, depths, notes).",
        "input_schema": {
            "type": "object",
            "properties": {"hardware_id": {"type": "string", "description": "Catalog id from list_hardware."}},
            "required": ["hardware_id"],
        },
    },
    {
        "name": "drill_for_hardware",
        "description": (
            "Drill a catalogued hardware pattern onto a face (e.g. a 35 mm hinge cup, slide holes). "
            "First call list_faces to get the face's u/v frame, then anchor the pattern at face-local "
            "(u, v) mm. Each bore size is cut in one pass. Refuses oversized holes for the face."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hardware_id": {"type": "string", "description": "Catalog id (from list_hardware)."},
                "body_index": {"type": "integer", "description": "Which body (from inspect_model)."},
                "face_index": {"type": "integer", "description": "Planar face (from list_faces; use its u/v frame)."},
                "u": {"type": "number", "description": "Anchor position along the face u axis, mm."},
                "v": {"type": "number", "description": "Anchor position along the face v axis, mm."},
            },
            "required": ["hardware_id", "body_index", "face_index", "u", "v"],
        },
    },
    {
        "name": "add_hardware",
        "description": (
            "Add or update a hardware catalog entry (saved to ~/.claudecad/hardware.json) so the "
            "library grows with exact parts from a manufacturer spec sheet. Provide id, brand, "
            "category, name, and 'holes' (each {du, dv, diameter, depth?} in mm relative to the anchor)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "brand": {"type": "string"},
                "category": {"type": "string"},
                "name": {"type": "string"},
                "notes": {"type": "string"},
                "model": {"type": "string", "description": "Filename of a 3D model in ~/.claudecad/hardware/ for place_hardware (optional)."},
                "holes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "du": {"type": "number"}, "dv": {"type": "number"},
                            "diameter": {"type": "number"}, "depth": {"type": "number"},
                            "role": {"type": "string"},
                        },
                        "required": ["diameter"],
                    },
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "import_model",
        "description": (
            "Import a 3D file (STEP / IGES / SAT / SMT / F3D) into the design and optionally "
            "position it at (x, y, z) mm — e.g. a manufacturer's hardware model so it renders. "
            "The user supplies the file path; proprietary models aren't bundled."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Full path to the 3D file."},
                "x": {"type": "number", "description": "Position X in mm. Default 0."},
                "y": {"type": "number", "description": "Position Y in mm. Default 0."},
                "z": {"type": "number", "description": "Position Z in mm. Default 0."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "place_hardware",
        "description": (
            "Import and place the 3D model linked to a catalog hardware entry (a user-supplied "
            "STEP in ~/.claudecad/hardware/). Use this to put a real hinge/slide/handle into the "
            "model for rendering. If no model is on file it tells you how to add one."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hardware_id": {"type": "string", "description": "Catalog id (from list_hardware)."},
                "x": {"type": "number", "description": "Position X in mm. Default 0."},
                "y": {"type": "number", "description": "Position Y in mm. Default 0."},
                "z": {"type": "number", "description": "Position Z in mm. Default 0."},
            },
            "required": ["hardware_id"],
        },
    },
    {
        "name": "explode_assembly",
        "description": (
            "Move all bodies radially outward from the assembly centre for an exploded view "
            "(e.g. for a screenshot). Records each move so reassemble restores the built "
            "positions exactly. 'factor' scales the spread (default 0.6)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "factor": {"type": "number", "description": "How far to spread bodies (multiplier on their offset from centre). Default 0.6."},
            },
        },
    },
    {
        "name": "reassemble",
        "description": "Restore every body moved by explode_assembly back to its built position (exact, from the recorded moves).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "export_bom",
        "description": (
            "Write a Bill of Materials (item #, qty, part name, material, dimensions) as CSV to "
            "the home folder and return the table — for a drawing's parts list or ordering. "
            "Grouped by part name (unlike export_cut_list, which groups by size for sheet layout)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Base filename (no extension). Default 'claudecad_bom'."},
            },
        },
    },
    {
        "name": "rename_body",
        "description": "Give a solid body a readable name in the browser (body indices from inspect_model). Use this to label bodies meaningfully (e.g. 'Lid', 'Bracket') so the model and cut list are clear.",
        "input_schema": {
            "type": "object",
            "properties": {
                "body_index": {"type": "integer"},
                "name": {"type": "string", "description": "The new body name."},
            },
            "required": ["body_index", "name"],
        },
    },
    {
        "name": "undo_last",
        "description": (
            "Undo the most recent geometry-producing operation — removes just the features that "
            "operation created (e.g. the last drilling pass or the last extrude), newest first. "
            "Use this to recover from a step that went wrong, instead of discarding everything. "
            "Does not touch the user's own geometry or earlier operations."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "export_cut_list",
        "description": (
            "Write a CSV cut list of every solid body (length x width x thickness, grouped into "
            "quantities, with material) to the user's home folder — for the shop / ordering sheet goods."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Base filename (no extension). Default 'claudecad_cutlist'."},
            },
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
    if policy.risk(name) in (policy.BUILD, policy.MODIFY) and name != "undo_last":
        cad.begin_operation(name)  # group created entities so undo_last can roll this back
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
                           ti.get("start_offset"), ti.get("name"))
    if name == "revolve":
        return cad.revolve(ti["sketch_id"], ti.get("axis", "z"), ti.get("angle", 360),
                           ti.get("operation", "new"), int(ti.get("profile_index", 0)), ti.get("name"))
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
            bool(ti.get("parametric", False)),
        )
    if name == "drill_holes":
        return cad.drill_holes(int(ti["body_index"]), list(ti["holes"]))
    if name == "drill_holes_on_face":
        return cad.drill_holes_on_face(int(ti["body_index"]), int(ti["face_index"]),
                                       list(ti["points"]), float(ti["diameter"]), ti.get("depth"))
    if name == "build_kitchen_cabinet":
        return cad.build_kitchen_cabinet(
            float(ti["width"]), ti.get("cabinet_type", "base"),
            (float(ti["height"]) if ti.get("height") is not None else None),
            (float(ti["depth"]) if ti.get("depth") is not None else None),
            float(ti.get("thickness", 18.0)), float(ti.get("back_thickness", 6.0)),
            ti.get("front", "doors"),
            (int(ti["doors"]) if ti.get("doors") is not None else None),
            int(ti.get("drawers", 3)),
            (int(ti["shelves"]) if ti.get("shelves") is not None else None),
            ti.get("joinery", "screws"), ti.get("back_joint", "groove"),
            float(ti.get("toe_kick_height", 100.0)), float(ti.get("toe_kick_recess", 50.0)))
    if name == "add_face_frame":
        return cad.add_face_frame(float(ti["width"]), float(ti["height"]),
                                  float(ti.get("stile", 38.0)), float(ti.get("rail", 38.0)),
                                  float(ti.get("frame_thickness", 19.0)))
    if name == "add_doors":
        return cad.add_doors(float(ti["width"]), float(ti["height"]), int(ti.get("count", 1)),
                             float(ti.get("thickness", 18.0)), float(ti.get("gap", 3.0)),
                             float(ti.get("reveal", 2.0)), ti.get("style", "overlay"),
                             float(ti.get("carcass_thickness", 18.0)))
    if name == "add_drawers":
        return cad.add_drawers(float(ti["width"]), float(ti["height"]), float(ti["depth"]),
                               int(ti.get("count", 1)), float(ti.get("front_thickness", 18.0)),
                               float(ti.get("gap", 3.0)), float(ti.get("reveal", 2.0)),
                               float(ti.get("carcass_thickness", 18.0)), float(ti.get("box_thickness", 12.0)),
                               float(ti.get("slide_clearance", 13.0)), bool(ti.get("boxes", True)))
    if name == "promote_to_components":
        return cad.promote_to_components()
    if name == "export_dxf":
        return cad.export_dxf(ti.get("folder"))
    if name == "list_hardware":
        from . import hardware
        items = hardware.list_hardware(ti.get("filter_text", ""))
        if not items:
            return "No hardware matches that filter."
        rows = ["{} [{}] — {} ({})".format(e.get("id"), e.get("category", ""), e.get("name", ""), e.get("brand", "")) for e in items]
        return "Hardware catalog ({}):\n  ".format(len(items)) + "\n  ".join(rows)
    if name == "hardware_info":
        from . import hardware
        e = hardware.get(ti["hardware_id"])
        if not e:
            return "No hardware with id '{}'. Use list_hardware.".format(ti["hardware_id"])
        holes = "; ".join("{}@({:g},{:g}) d{:g}{}".format(
            h.get("role", "hole"), h.get("du", 0), h.get("dv", 0), h["diameter"],
            " x{:g}deep".format(h["depth"]) if h.get("depth") else " through") for h in e.get("holes", []))
        return "{} ({}, {})\nDatum: {}\nHoles: {}\nNotes: {}".format(
            e.get("name"), e.get("brand", ""), e.get("category", ""), e.get("datum", "—"), holes, e.get("notes", ""))
    if name == "drill_for_hardware":
        return cad.drill_for_hardware(ti["hardware_id"], int(ti["body_index"]), int(ti["face_index"]),
                                      float(ti["u"]), float(ti["v"]))
    if name == "add_hardware":
        from . import hardware
        entry = {k: ti[k] for k in ("id", "brand", "category", "name", "notes", "model", "holes") if k in ti}
        return "Saved hardware '{}' to your catalog.".format(hardware.add_hardware(entry))
    if name == "import_model":
        return cad.import_model(ti["path"], float(ti.get("x", 0.0)), float(ti.get("y", 0.0)), float(ti.get("z", 0.0)))
    if name == "place_hardware":
        return cad.place_hardware(ti["hardware_id"], float(ti.get("x", 0.0)), float(ti.get("y", 0.0)), float(ti.get("z", 0.0)))
    if name == "explode_assembly":
        return cad.explode_assembly(float(ti.get("factor", 0.6)))
    if name == "reassemble":
        return cad.reassemble()
    if name == "export_bom":
        return cad.export_bom(ti.get("filename"))
    if name == "rename_body":
        return cad.rename_body(int(ti["body_index"]), ti["name"])
    if name == "undo_last":
        return cad.undo_last()
    if name == "export_cut_list":
        return cad.export_cut_list(ti.get("filename"))
    if name == "get_design_summary":
        return cad.get_design_summary()

    raise ValueError("Unknown tool: {}".format(name))
