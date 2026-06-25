"""CAD operations against the active Fusion 360 design.

Every method here must be called on Fusion's main thread (the dispatcher guarantees
that). Tool inputs use millimetres; Fusion's internal unit is centimetres, so lengths
are scaled by :data:`MM`. The builder tracks everything it creates during a session so
the user can discard the work and start fresh.

Dimensions can be **parametric**: width/height/radius/distance accept either a number
(mm) or an expression string such as ``"width"`` or ``"2 * wall"`` that references a
user parameter, so editing the parameter later updates the model.
"""

import base64
import math
import os
import tempfile
import threading

import adsk.core
import adsk.fusion

from . import util

MM = util.MM  # millimetres -> centimetres (Fusion internal units); single-sourced in util

_OPERATIONS = {
    "new": adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
    "join": adsk.fusion.FeatureOperations.JoinFeatureOperation,
    "cut": adsk.fusion.FeatureOperations.CutFeatureOperation,
    "intersect": adsk.fusion.FeatureOperations.IntersectFeatureOperation,
}


class CadBuilder:
    """CAD operations against the one active Fusion document.

    NOTE: a single CadBuilder is shared by all chats (there is one Fusion document). Its
    sketch-id registry and timeline marker are therefore global, so Discard in one chat
    rolls back geometry and clears sketch ids that an in-flight turn in another chat may
    still reference (it would then see "Unknown sketch id"). This is acceptable because the
    document itself is shared; chat isolation is about the conversation, not the geometry.
    """

    # Fusion attribute group/name used to tag everything ClaudeCad creates, so Discard
    # can roll back ONLY the assistant's work and never the user's geometry.
    _ATTR_GROUP = "ClaudeCad"
    _ATTR_NAME = "owned"

    def __init__(self, app):
        self.app = app
        self._sketches = {}
        self._sketch_counter = 0
        self._params = []
        self._last_feature = None
        self._last_body = None
        self._start_marker = 0
        # Document-level lock: only one CAD-agent turn may mutate the shared design at a
        # time (the dispatcher serializes individual calls, but not a whole multi-tool plan).
        self.turn_lock = threading.Lock()
        # Identity of the document this builder is bound to (set on first use). If the user
        # switches the active Fusion document mid-session, operations would silently land on
        # the wrong design — we detect that and refuse rather than corrupt another document.
        self._doc_key = None
        # Operation grouping for undo_last: each entry is the set of entities/params created
        # during one tool call, newest last, so a single bad operation can be rolled back.
        self._ops = []
        # Per-body displacement recorded by explode_assembly so reassemble restores exactly.
        self._explode_state = None
        self._record_start()

    def begin_operation(self, name):
        """Start a new undo group; subsequent created entities/params are attributed to it."""
        self._ops.append({"name": name, "entities": [], "params": []})

    def undo_last(self):
        """Delete everything created by the most recent geometry-producing operation.

        Removes only that operation's tagged features (and any parameters it created), newest
        first, so a single bad step (e.g. a drilling pass) can be reversed from chat without a
        manual Undo. Empty operations (e.g. read-only calls) are skipped.
        """
        design = self._design()
        while self._ops:
            op = self._ops.pop()
            entities = op.get("entities", [])
            params = op.get("params", [])
            if not entities and not params:
                continue
            for entity in reversed(entities):
                try:
                    entity.deleteMe()
                except Exception:
                    pass
            for name in reversed(params):
                try:
                    param = design.userParameters.itemByName(name)
                    if param:
                        param.deleteMe()
                    if name in self._params:
                        self._params.remove(name)
                except Exception:
                    pass
            self._last_feature = None
            self._last_body = None
            # Drop any sketch ids whose sketch was just deleted, so they can't be reused.
            self._sketches = {sid: sk for sid, sk in self._sketches.items() if self._sketch_valid(sk)}
            return "Undid the last operation ('{}') — removed {} feature(s){}.".format(
                op["name"], len(entities),
                " and {} parameter(s)".format(len(params)) if params else "")
        return "There's nothing from this session to undo."

    @staticmethod
    def _sketch_valid(sketch):
        try:
            return bool(sketch.isValid)
        except Exception:
            return False

    def _active_doc_key(self):
        """A stable-ish identifier for the active document (data file id, else its name)."""
        try:
            doc = self.app.activeDocument
            try:
                if doc.dataFile:
                    return doc.dataFile.id
            except Exception:
                pass
            return doc.name
        except Exception:
            return None

    def _own(self, entity):
        """Tag an entity as ClaudeCad-created so Discard can identify and remove only it,
        and attribute it to the current operation (for undo_last)."""
        try:
            if entity:
                entity.attributes.add(self._ATTR_GROUP, self._ATTR_NAME, "1")
                if self._ops:
                    self._ops[-1]["entities"].append(entity)
        except Exception:
            pass
        return entity

    def _is_owned(self, entity):
        try:
            return entity.attributes.itemByName(self._ATTR_GROUP, self._ATTR_NAME) is not None
        except Exception:
            return False

    @staticmethod
    def _name(entity, name):
        """Give a sketch/body a readable browser name (best-effort)."""
        try:
            if entity and name:
                entity.name = name
        except Exception:
            pass
        return entity

    # -- internals -----------------------------------------------------------
    def _design(self):
        design = adsk.fusion.Design.cast(self.app.activeProduct)
        if not design:
            raise RuntimeError("No active Fusion design. Open or create a design, then try again.")
        # Bind to the first document we see; refuse to operate on a different one later.
        key = self._active_doc_key()
        if self._doc_key is None:
            self._doc_key = key
        elif key is not None and key != self._doc_key:
            raise RuntimeError(
                "The active Fusion document changed since this chat started. Switch back to the "
                "original document, or open '+ New' for a fresh chat to work on this one."
            )
        return design

    def _comp(self):
        return self._design().rootComponent

    def _record_start(self):
        try:
            self._start_marker = self._design().timeline.count
        except Exception:
            self._start_marker = 0

    def _plane(self, comp, name):
        planes = {
            "xy": comp.xYConstructionPlane,
            "xz": comp.xZConstructionPlane,
            "yz": comp.yZConstructionPlane,
        }
        key = (name or "xy").lower()
        if key not in planes:
            raise ValueError("Unknown plane '{}'. Use 'xy', 'xz' or 'yz'.".format(name))
        return planes[key]

    def _axis(self, comp, name):
        axes = {
            "x": comp.xConstructionAxis,
            "y": comp.yConstructionAxis,
            "z": comp.zConstructionAxis,
        }
        key = (name or "z").lower()
        if key not in axes:
            raise ValueError("Unknown axis '{}'. Use 'x', 'y' or 'z'.".format(name))
        return axes[key]

    def _sketch(self, sketch_id):
        sk = self._sketches.get(sketch_id)
        if not sk:
            raise ValueError("Unknown sketch id '{}'. Create one with create_sketch first.".format(sketch_id))
        return sk

    @staticmethod
    def _pt(x_mm, y_mm):
        return adsk.core.Point3D.create(x_mm * MM, y_mm * MM, 0.0)

    @staticmethod
    def _length(value):
        """Coerce a tool length input to a ValueInput-ready string ('20 mm' or an expression)."""
        if isinstance(value, str):
            return value
        return "{:g} mm".format(float(value))

    def _resolve(self, value, default_seed=10.0):
        """Return ``(expression_or_None, seed_mm)`` for a width/height/radius input.

        A number → no expression, that value as the seed. A string → the expression, with
        a seed taken from the referenced parameter's current value if it's a bare name
        (otherwise a placeholder; the driving dimension fixes the real size afterwards).
        """
        if isinstance(value, str):
            seed = default_seed
            try:
                param = self._design().userParameters.itemByName(value.strip())
                if param:
                    seed = param.value / MM  # cm -> mm
            except Exception:
                pass
            return value, seed
        return None, float(value)

    def _remember(self, feature):
        self._last_feature = feature
        self._own(feature)
        try:
            if feature.bodies.count:
                self._last_body = feature.bodies.item(0)
        except Exception:
            pass

    def _body(self):
        if self._last_body:
            return self._last_body
        comp = self._comp()
        if comp.bRepBodies.count == 0:
            raise RuntimeError("There is no solid body yet. Create one with extrude/revolve first.")
        return comp.bRepBodies.item(comp.bRepBodies.count - 1)

    # -- parameters & sketches ----------------------------------------------
    def create_parameter(self, name, expression, unit="mm", comment=""):
        design = self._design()
        # Idempotent: if the parameter already exists (model reused 'width', 'wall', …),
        # update it in place instead of failing on a duplicate-name add.
        existing = design.userParameters.itemByName(name)
        if existing:
            existing.expression = expression
            if comment:
                existing.comment = comment
            return "Updated existing parameter {} = {} (now {}).".format(
                name, expression, self._format_param_value(existing)
            )
        value = adsk.core.ValueInput.createByString(expression)
        design.userParameters.add(name, value, unit or "mm", comment or "")
        if name not in self._params:
            self._params.append(name)
        if self._ops:
            self._ops[-1]["params"].append(name)
        return "Created parameter {} = {} ({}).".format(name, expression, unit or "mm")

    def create_sketch(self, plane="xy", name=None, offset=0):
        comp = self._comp()
        base = self._plane(comp, plane)
        target = base
        offset_note = ""

        use_offset = offset is not None and not (isinstance(offset, (int, float)) and float(offset) == 0.0)
        if use_offset:
            off_expr = offset if isinstance(offset, str) else "{:g} mm".format(float(offset))
            plane_input = comp.constructionPlanes.createInput()
            plane_input.setByOffset(base, adsk.core.ValueInput.createByString(off_expr))
            target = self._own(comp.constructionPlanes.add(plane_input))
            offset_note = ", offset {} from the {} plane".format(off_expr, (plane or "xy").lower())

        sketch = self._own(comp.sketches.add(target))
        if name:
            sketch.name = name
        self._sketch_counter += 1
        sketch_id = "s{}".format(self._sketch_counter)
        self._sketches[sketch_id] = sketch
        return "Created sketch '{}' on the {} plane{} (id={}).".format(
            sketch.name, (plane or "xy").lower(), offset_note, sketch_id
        )

    def draw_rectangle(self, sketch_id, width, height, center_x=0.0, center_y=0.0):
        sketch = self._sketch(sketch_id)
        w_expr, w_mm = self._resolve(width)
        h_expr, h_mm = self._resolve(height)
        cx, cy = float(center_x), float(center_y)

        bl = self._pt(cx - w_mm / 2.0, cy - h_mm / 2.0)
        tr = self._pt(cx + w_mm / 2.0, cy + h_mm / 2.0)
        rect = sketch.sketchCurves.sketchLines.addTwoPointRectangle(bl, tr)

        note = self._dimension_rectangle(sketch, rect, w_expr, h_expr, cx, cy, w_mm, h_mm)
        return "Drew a {:g}x{:g} mm rectangle in {} ({} profile(s)).{}".format(
            w_mm, h_mm, sketch_id, sketch.profiles.count, note
        )

    def _dimension_rectangle(self, sketch, rect, w_expr, h_expr, cx, cy, w_mm, h_mm):
        if not (w_expr or h_expr):
            return ""
        try:
            horiz = vert = None
            for i in range(rect.count):
                line = rect.item(i)
                sp = line.startSketchPoint.geometry
                ep = line.endSketchPoint.geometry
                if horiz is None and abs(sp.y - ep.y) < 1e-7:
                    horiz = line
                if vert is None and abs(sp.x - ep.x) < 1e-7:
                    vert = line
            dims = sketch.sketchDimensions
            if w_expr and horiz is not None:
                d = dims.addDistanceDimension(
                    horiz.startSketchPoint, horiz.endSketchPoint,
                    adsk.fusion.DimensionOrientations.HorizontalDimensionOrientation,
                    self._pt(cx, cy - h_mm / 2.0 - 8.0),
                )
                d.parameter.expression = w_expr
            if h_expr and vert is not None:
                d = dims.addDistanceDimension(
                    vert.startSketchPoint, vert.endSketchPoint,
                    adsk.fusion.DimensionOrientations.VerticalDimensionOrientation,
                    self._pt(cx + w_mm / 2.0 + 8.0, cy),
                )
                d.parameter.expression = h_expr
            return " Driven by {}.".format(", ".join(filter(None, [w_expr, h_expr])))
        except Exception as exc:
            return " (parametric dimension could not be applied: {} — size is fixed)".format(exc)

    def draw_circle(self, sketch_id, radius, center_x=0.0, center_y=0.0):
        sketch = self._sketch(sketch_id)
        r_expr, r_mm = self._resolve(radius, default_seed=5.0)
        cx, cy = float(center_x), float(center_y)
        circle = sketch.sketchCurves.sketchCircles.addByCenterRadius(self._pt(cx, cy), r_mm * MM)

        note = ""
        if r_expr:
            try:
                d = sketch.sketchDimensions.addRadialDimension(circle, self._pt(cx + r_mm + 6.0, cy + r_mm + 6.0))
                d.parameter.expression = r_expr
                note = " Driven by {}.".format(r_expr)
            except Exception as exc:
                note = " (parametric dimension could not be applied: {} — radius is fixed)".format(exc)
        return "Drew a circle r={:g} mm in {} ({} profile(s)).{}".format(r_mm, sketch_id, sketch.profiles.count, note)

    def draw_line(self, sketch_id, x1, y1, x2, y2):
        sketch = self._sketch(sketch_id)
        sketch.sketchCurves.sketchLines.addByTwoPoints(self._pt(x1, y1), self._pt(x2, y2))
        return "Drew a line in {} from ({:g},{:g}) to ({:g},{:g}) mm.".format(sketch_id, x1, y1, x2, y2)

    # -- features ------------------------------------------------------------
    def extrude(self, sketch_id, distance, operation="new", profile_index=0, symmetric=False, start_offset=None, name=None):
        sketch = self._sketch(sketch_id)
        if sketch.profiles.count == 0:
            raise RuntimeError("Sketch {} has no closed profile to extrude.".format(sketch_id))
        if profile_index < 0 or profile_index >= sketch.profiles.count:
            raise ValueError("profile_index {} out of range (sketch has {}).".format(profile_index, sketch.profiles.count))

        op = _OPERATIONS.get((operation or "new").lower())
        if op is None:
            raise ValueError("Unknown operation '{}'. Use new, join, cut or intersect.".format(operation))

        comp = self._comp()
        profile = sketch.profiles.item(profile_index)
        ext_input = comp.features.extrudeFeatures.createInput(profile, op)

        has_offset = start_offset is not None and not (isinstance(start_offset, (int, float)) and float(start_offset) == 0.0)
        if has_offset:
            ext_input.startExtent = adsk.fusion.OffsetStartDefinition.create(
                adsk.core.ValueInput.createByString(self._length(start_offset))
            )
        ext_input.setDistanceExtent(bool(symmetric), adsk.core.ValueInput.createByString(self._length(distance)))
        self._remember(comp.features.extrudeFeatures.add(ext_input))
        if name and (operation or "new").lower() == "new":
            self._name(self._last_body, name)

        extras = []
        if symmetric:
            extras.append("symmetric")
        if has_offset:
            extras.append("start offset {}".format(self._length(start_offset)))
        suffix = (", " + ", ".join(extras)) if extras else ""
        return "Extruded profile {} of {} by {} ({}{}).".format(
            profile_index, sketch_id, self._length(distance), operation, suffix
        )

    def revolve(self, sketch_id, axis="z", angle=360, operation="new", profile_index=0, name=None):
        sketch = self._sketch(sketch_id)
        if sketch.profiles.count == 0:
            raise RuntimeError("Sketch {} has no closed profile to revolve.".format(sketch_id))
        op = _OPERATIONS.get((operation or "new").lower())
        if op is None:
            raise ValueError("Unknown operation '{}'.".format(operation))

        comp = self._comp()
        profile = sketch.profiles.item(profile_index)
        rev_input = comp.features.revolveFeatures.createInput(profile, self._axis(comp, axis), op)
        angle_expr = angle if isinstance(angle, str) else "{:g} deg".format(float(angle))
        rev_input.setAngleExtent(False, adsk.core.ValueInput.createByString(angle_expr))
        self._remember(comp.features.revolveFeatures.add(rev_input))
        if name and (operation or "new").lower() == "new":
            self._name(self._last_body, name)
        return "Revolved profile {} of {} about the {} axis by {}.".format(profile_index, sketch_id, axis, angle_expr)

    def fillet_all_edges(self, radius):
        comp = self._comp()
        body = self._body()
        edges = adsk.core.ObjectCollection.create()
        for i in range(body.edges.count):
            edges.add(body.edges.item(i))
        if edges.count == 0:
            raise RuntimeError("The body has no edges to fillet.")
        fillets = comp.features.filletFeatures
        fin = fillets.createInput()
        fin.addConstantRadiusEdgeSet(edges, adsk.core.ValueInput.createByString(self._length(radius)), True)
        self._remember(fillets.add(fin))
        return "Filleted all {} edges of the body with radius {}.".format(edges.count, self._length(radius))

    def chamfer_all_edges(self, distance):
        comp = self._comp()
        body = self._body()
        edges = adsk.core.ObjectCollection.create()
        for i in range(body.edges.count):
            edges.add(body.edges.item(i))
        if edges.count == 0:
            raise RuntimeError("The body has no edges to chamfer.")
        chamfers = comp.features.chamferFeatures
        cin = chamfers.createInput(edges, True)
        cin.setToEqualDistance(adsk.core.ValueInput.createByString(self._length(distance)))
        self._remember(chamfers.add(cin))
        return "Chamfered all {} edges of the body by {}.".format(edges.count, self._length(distance))

    def shell(self, thickness, remove_top=True):
        comp = self._comp()
        body = self._body()
        entities = adsk.core.ObjectCollection.create()

        removed = "closed (hollow)"
        if remove_top:
            top = None
            best_z = None
            for i in range(body.faces.count):
                face = body.faces.item(i)
                plane = adsk.fusion.Plane.cast(face.geometry)
                if not plane:
                    continue
                if plane.normal.z <= 0.5:  # skip faces that aren't roughly upward-facing
                    continue
                z = face.boundingBox.maxPoint.z
                if best_z is None or z > best_z:
                    best_z, top = z, face
            if top is not None:
                entities.add(top)
                removed = "top face open"
        if entities.count == 0:
            entities.add(body)

        shells = comp.features.shellFeatures
        sin = shells.createInput(entities, False)
        sin.insideThickness = adsk.core.ValueInput.createByString(self._length(thickness))
        self._remember(shells.add(sin))
        return "Shelled the body to {} wall thickness ({}).".format(self._length(thickness), removed)

    def circular_pattern(self, count, axis="z", angle=360):
        comp = self._comp()
        if not self._last_feature:
            raise RuntimeError("No feature to pattern yet. Create one (extrude/revolve) first.")
        feats = adsk.core.ObjectCollection.create()
        feats.add(self._last_feature)
        pats = comp.features.circularPatternFeatures
        pin = pats.createInput(feats, self._axis(comp, axis))
        pin.quantity = adsk.core.ValueInput.createByString(str(int(count)))
        pin.totalAngle = adsk.core.ValueInput.createByString("{:g} deg".format(float(angle)))
        pin.isSymmetric = False
        self._remember(pats.add(pin))
        return "Created a circular pattern of {} about the {} axis over {:g} deg.".format(int(count), axis, float(angle))

    def rectangular_pattern(self, count_x, spacing_x, count_y=1, spacing_y=0.0):
        comp = self._comp()
        if not self._last_feature:
            raise RuntimeError("No feature to pattern yet. Create one (extrude/revolve) first.")
        feats = adsk.core.ObjectCollection.create()
        feats.add(self._last_feature)
        pats = comp.features.rectangularPatternFeatures
        pin = pats.createInput(
            feats, comp.xConstructionAxis,
            adsk.core.ValueInput.createByString(str(int(count_x))),
            adsk.core.ValueInput.createByString("{:g} mm".format(float(spacing_x))),
            adsk.fusion.PatternDistanceType.SpacingPatternDistanceType,
        )
        pin.setDirectionTwo(
            comp.yConstructionAxis,
            adsk.core.ValueInput.createByString(str(int(count_y))),
            adsk.core.ValueInput.createByString("{:g} mm".format(float(spacing_y))),
        )
        self._remember(pats.add(pin))
        return "Created a {}x{} rectangular pattern (spacing {:g} x {:g} mm).".format(
            int(count_x), int(count_y), float(spacing_x), float(spacing_y)
        )

    # -- inspection / vision -------------------------------------------------
    def get_design_summary(self):
        design = self._design()
        comp = design.rootComponent
        params = []
        ups = design.userParameters
        for i in range(ups.count):
            p = ups.item(i)
            if p.name in self._params:
                params.append("{}={}".format(p.name, p.expression))
        return "Bodies: {}. Sketches: {}. Parameters: {}.".format(
            comp.bRepBodies.count,
            comp.sketches.count,
            ", ".join(params) if params else "none",
        )

    # -- read-back / inspection ---------------------------------------------
    def _mm(self, cm):
        return cm / MM  # centimetres -> millimetres

    def _format_param_value(self, param):
        """Format a parameter's evaluated value using its own unit.

        Fusion stores internal values in cm (length) and radians (angle) regardless of the
        parameter's display unit, so convert per unit rather than always treating it as mm.
        """
        unit = (param.unit or "").lower()
        try:
            if unit in ("mm", "cm", "m", "in", "inch", "ft", "foot", "feet"):
                return "{:.4g} mm".format(self._mm(param.value))
            if unit in ("deg", "degree", "degrees", "rad", "radian", "radians"):
                return "{:.4g} deg".format(math.degrees(param.value))
            return "{:.4g}{}".format(param.value, " " + param.unit if param.unit else "")
        except Exception:
            return str(getattr(param, "value", "?"))

    def _fmt_pt(self, point):
        return "({:.1f}, {:.1f}, {:.1f})".format(self._mm(point.x), self._mm(point.y), self._mm(point.z))

    def _bbox_dims(self, bbox):
        mn, mx = bbox.minPoint, bbox.maxPoint
        return (self._mm(mx.x - mn.x), self._mm(mx.y - mn.y), self._mm(mx.z - mn.z))

    def _brep_body(self, index):
        comp = self._comp()
        if comp.bRepBodies.count == 0:
            raise RuntimeError("There are no solid bodies in the model.")
        if index < 0 or index >= comp.bRepBodies.count:
            raise ValueError("body_index {} out of range (model has {} solid bodies).".format(index, comp.bRepBodies.count))
        return comp.bRepBodies.item(index)

    @staticmethod
    def _surface_kind(geometry):
        for label, cls in (
            ("plane", adsk.core.Plane), ("cylinder", adsk.core.Cylinder),
            ("sphere", adsk.core.Sphere), ("cone", adsk.core.Cone), ("torus", adsk.core.Torus),
        ):
            try:
                if cls.cast(geometry):
                    return label
            except Exception:
                pass
        return "surface"

    @staticmethod
    def _curve_kind(geometry):
        for label, cls in (
            ("line", adsk.core.Line3D), ("arc", adsk.core.Arc3D),
            ("circle", adsk.core.Circle3D), ("ellipse", adsk.core.Ellipse3D),
        ):
            try:
                if cls.cast(geometry):
                    return label
            except Exception:
                pass
        return "curve"

    def inspect_model(self):
        """Report a structured read-back of the active document so Claude can see what
        already exists (its own work, the user's geometry, and imported meshes)."""
        design = self._design()
        comp = design.rootComponent
        lines = []
        try:
            lines.append("Length units: {}".format(design.fusionUnitsManager.defaultLengthUnits))
        except Exception:
            pass

        ups = design.userParameters
        if ups.count:
            params = []
            for i in range(ups.count):
                p = ups.item(i)
                params.append("{} = {} ({})".format(p.name, p.expression, self._format_param_value(p)))
            lines.append("User parameters: " + "; ".join(params))
        else:
            lines.append("User parameters: none")

        lines.append("Solid bodies: {}".format(comp.bRepBodies.count))
        for i in range(comp.bRepBodies.count):
            b = comp.bRepBodies.item(i)
            dx, dy, dz = self._bbox_dims(b.boundingBox)
            try:
                vol = " volume {:.2f} cm^3".format(b.volume)
            except Exception:
                vol = ""
            bb = b.boundingBox
            pos = " at X[{:.1f}..{:.1f}] Y[{:.1f}..{:.1f}] Z[{:.1f}..{:.1f}] mm".format(
                self._mm(bb.minPoint.x), self._mm(bb.maxPoint.x),
                self._mm(bb.minPoint.y), self._mm(bb.maxPoint.y),
                self._mm(bb.minPoint.z), self._mm(bb.maxPoint.z),
            )
            lines.append(
                "  [{}] '{}' — size {:.1f} x {:.1f} x {:.1f} mm{}, faces {}, edges {}{}, visible {}".format(
                    i, b.name, dx, dy, dz, pos, b.faces.count, b.edges.count, vol, b.isVisible
                )
            )

        meshes = comp.meshBodies
        lines.append("Mesh bodies: {}".format(meshes.count))
        for i in range(meshes.count):
            m = meshes.item(i)
            try:
                dx, dy, dz = self._bbox_dims(m.boundingBox)
                size = "size {:.1f} x {:.1f} x {:.1f} mm".format(dx, dy, dz)
            except Exception:
                size = "size unknown"
            tri = ""
            try:
                tri = ", {} triangles".format(m.displayMesh.triangleCount)
            except Exception:
                pass
            lines.append("  [{}] '{}' (mesh — not parametric; can't be edited by these tools) — {}{}".format(
                i, m.name, size, tri
            ))

        lines.append("Sketches: {}".format(comp.sketches.count))
        return "\n".join(lines)

    def list_faces(self, body_index=0, limit=80):
        body = self._brep_body(body_index)
        total = body.faces.count
        rows = []
        for i in range(min(total, limit)):
            f = body.faces.item(i)
            kind = self._surface_kind(f.geometry)
            try:
                loc = self._fmt_pt(f.pointOnFace)
            except Exception:
                loc = self._fmt_pt(f.boundingBox.minPoint)
            normal = ""
            frame = ""
            if kind == "plane":
                try:
                    n = adsk.core.Plane.cast(f.geometry).normal
                    normal = " normal ({:.2f}, {:.2f}, {:.2f})".format(n.x, n.y, n.z)
                except Exception:
                    pass
                uv = self._face_uv(f)
                if uv:
                    _o, u, v, us, vs = uv
                    frame = (" | face frame for drill_holes_on_face: "
                             "u 0..{:.0f}mm along ({:.2f},{:.2f},{:.2f}), "
                             "v 0..{:.0f}mm along ({:.2f},{:.2f},{:.2f})".format(
                                 us, u.x, u.y, u.z, vs, v.x, v.y, v.z))
            try:
                area = " area {:.1f} mm^2".format(f.area / (MM * MM))
            except Exception:
                area = ""
            rows.append("  [{}] {}{} at {} mm{}{}".format(i, kind, area, loc, normal, frame))
        header = "Body [{}] '{}' has {} faces".format(body_index, body.name, total)
        if total > limit:
            header += " (showing first {})".format(limit)
        return header + ":\n" + "\n".join(rows)

    def list_edges(self, body_index=0, limit=80):
        body = self._brep_body(body_index)
        total = body.edges.count
        rows = []
        for i in range(min(total, limit)):
            e = body.edges.item(i)
            kind = self._curve_kind(e.geometry)
            try:
                loc = self._fmt_pt(e.pointOnEdge)
            except Exception:
                loc = self._fmt_pt(e.boundingBox.minPoint)
            try:
                length = " length {:.1f} mm".format(self._mm(e.length))
            except Exception:
                length = ""
            rows.append("  [{}] {}{} near {} mm".format(i, kind, length, loc))
        header = "Body [{}] '{}' has {} edges".format(body_index, body.name, total)
        if total > limit:
            header += " (showing first {})".format(limit)
        return header + ":\n" + "\n".join(rows)

    # -- edit / modify -------------------------------------------------------
    def change_parameter(self, name, expression):
        design = self._design()
        param = design.userParameters.itemByName(name)
        if not param:
            param = design.allParameters.itemByName(name)
        if not param:
            raise ValueError("No parameter named '{}'. Use inspect_model to list parameters.".format(name))
        param.expression = expression
        # Report the evaluated value in the parameter's own unit (mm/deg/unitless), not always mm.
        return "Set parameter {} = {} (now {}).".format(name, expression, self._format_param_value(param))

    def _edge_set(self, body, indices):
        edges = adsk.core.ObjectCollection.create()
        for idx in indices:
            if 0 <= idx < body.edges.count:
                edges.add(body.edges.item(idx))
        if edges.count == 0:
            raise ValueError("No valid edge indices given. Use list_edges to get indices.")
        return edges

    def fillet_edges(self, body_index, edge_indices, radius):
        comp = self._comp()
        body = self._brep_body(body_index)
        edges = self._edge_set(body, edge_indices)
        fillets = comp.features.filletFeatures
        fin = fillets.createInput()
        fin.addConstantRadiusEdgeSet(edges, adsk.core.ValueInput.createByString(self._length(radius)), True)
        self._remember(fillets.add(fin))
        return "Filleted {} edge(s) of body [{}] with radius {}.".format(edges.count, body_index, self._length(radius))

    def chamfer_edges(self, body_index, edge_indices, distance):
        comp = self._comp()
        body = self._brep_body(body_index)
        edges = self._edge_set(body, edge_indices)
        chamfers = comp.features.chamferFeatures
        cin = chamfers.createInput(edges, True)
        cin.setToEqualDistance(adsk.core.ValueInput.createByString(self._length(distance)))
        self._remember(chamfers.add(cin))
        return "Chamfered {} edge(s) of body [{}] by {}.".format(edges.count, body_index, self._length(distance))

    def cut_hole(self, body_index, face_index, diameter, depth=None, x_offset=0.0, y_offset=0.0):
        body = self._brep_body(body_index)
        if face_index < 0 or face_index >= body.faces.count:
            raise ValueError("face_index {} out of range (body has {} faces).".format(face_index, body.faces.count))
        face = body.faces.item(face_index)
        r_mm = self._cut_hole_on_face(face, diameter, depth, x_offset, y_offset)
        depth_note = self._length(depth) if depth else "through all"
        return "Cut a {:g} mm hole through face [{}] of body [{}] ({}).".format(r_mm, face_index, body_index, depth_note)

    def _face_uv(self, face):
        """Return the face's local 2D frame: (origin_point, u_dir, v_dir, u_size_mm, v_size_mm).

        ``origin`` is the (min u, min v) corner of the face in world space; ``u_dir``/``v_dir``
        are unit world vectors along the face plane. Face-local coordinates (u, v) in mm map to
        the world point ``origin + u*u_dir + v*v_dir``. Returns None if it can't be determined.
        """
        plane = adsk.core.Plane.cast(face.geometry)
        if not plane:
            return None
        try:
            dirs = plane.getUVDirections()
            u, v = dirs[-2], dirs[-1]  # binding may return (u, v) or (success, u, v)
            o = plane.origin
            us, vs = [], []
            edges = face.edges
            for i in range(edges.count):
                e = edges.item(i)
                for vert in (e.startVertex, e.endVertex):
                    p = vert.geometry
                    dx, dy, dz = p.x - o.x, p.y - o.y, p.z - o.z
                    us.append(dx * u.x + dy * u.y + dz * u.z)
                    vs.append(dx * v.x + dy * v.y + dz * v.z)
            if not us:
                return None
            umin, umax, vmin, vmax = min(us), max(us), min(vs), max(vs)
            origin = adsk.core.Point3D.create(
                o.x + umin * u.x + vmin * v.x,
                o.y + umin * u.y + vmin * v.y,
                o.z + umin * u.z + vmin * v.z,
            )
            return (origin, u, v, self._mm(umax - umin), self._mm(vmax - vmin))
        except Exception:
            return None

    def _face_min_span(self, face):
        """Smaller of the face's two in-plane extents, in mm. Falls back to the world
        axis-aligned bounding box if the face's own (u, v) frame can't be computed."""
        frame = self._face_uv(face)
        if frame:
            return min(frame[3], frame[4])
        bb = face.boundingBox
        spans = sorted([
            self._mm(bb.maxPoint.x - bb.minPoint.x),
            self._mm(bb.maxPoint.y - bb.minPoint.y),
            self._mm(bb.maxPoint.z - bb.minPoint.z),
        ])
        return spans[1]  # the thickness (~0) is spans[0]

    def _cut_hole_on_face(self, face, diameter, depth=None, x_offset=0.0, y_offset=0.0):
        if not adsk.core.Plane.cast(face.geometry):
            raise RuntimeError("That face is not planar; a hole needs a flat face.")
        r_expr, r_mm = self._resolve(diameter, default_seed=10.0)  # r_mm is the diameter seed

        # Resolve the ACTUAL diameter for the guard. _resolve only seeds bare parameter names,
        # so for a compound expression ("cab_w / 2") evaluate it to a real mm value — otherwise
        # an expression that resolves large would slip past the seed-based check and gut the panel.
        guard_d = r_mm
        if r_expr:
            try:
                guard_d = self._mm(self._design().fusionUnitsManager.evaluateExpression(r_expr, "mm"))
            except Exception:
                raise ValueError(
                    "Couldn't evaluate the hole diameter expression '{}' to a number to verify "
                    "it's safe. Pass a numeric diameter in mm.".format(r_expr)
                )

        # Safety guard: refuse a hole that's too big for the face (>= 95% of its smaller in-plane
        # span), so a runaway diameter can't gut the panel instead of drilling it.
        face_min = self._face_min_span(face)
        if guard_d >= 0.95 * face_min:
            raise ValueError(
                "Hole diameter {:.1f} mm is too large for this face (~{:.1f} mm across). Refusing "
                "to cut so the panel isn't destroyed — use a smaller diameter, or check you picked "
                "the intended face and that 'diameter' isn't an expression that evaluates large.".format(guard_d, face_min)
            )

        comp = self._comp()
        sketch = self._name(self._own(comp.sketches.add(face)), "Hole")
        center_sketch = sketch.modelToSketchSpace(face.pointOnFace)
        center = adsk.core.Point3D.create(
            center_sketch.x + float(x_offset) * MM, center_sketch.y + float(y_offset) * MM, 0.0
        )
        circle = sketch.sketchCurves.sketchCircles.addByCenterRadius(center, (r_mm / 2.0) * MM)
        if r_expr:
            try:
                dim = sketch.sketchDimensions.addRadialDimension(
                    circle, adsk.core.Point3D.create(center.x + (r_mm / 2.0 + 6.0) * MM, center.y, 0.0)
                )
                dim.parameter.expression = "(" + r_expr + ") / 2"
            except Exception:
                pass

        profile = sketch.profiles.item(0)
        ext = comp.features.extrudeFeatures
        ext_input = ext.createInput(profile, adsk.fusion.FeatureOperations.CutFeatureOperation)
        if depth is not None and not (isinstance(depth, (int, float)) and float(depth) == 0.0):
            ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString("-(" + self._length(depth) + ")"))
        else:
            ext_input.setAllExtent(adsk.fusion.ExtentDirections.NegativeExtentDirection)
        self._remember(ext.add(ext_input))
        return r_mm

    _AXES = {
        "x": (1.0, 0.0, 0.0), "-x": (-1.0, 0.0, 0.0),
        "y": (0.0, 1.0, 0.0), "-y": (0.0, -1.0, 0.0),
        "z": (0.0, 0.0, 1.0), "-z": (0.0, 0.0, -1.0),
    }

    _BASE_AXIS = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}

    def drill_holes(self, body_index, holes):
        """Drill blind/through holes into one body by ABSOLUTE coordinates.

        Each hole is a circle sketched on a construction plane through the entry point
        (perpendicular to the hole axis) and extrude-CUT into the body — the same proven
        machinery as the cabinet groove and cut_hole, with ``participantBodies`` limiting the
        cut to this body. The plane offset and cut direction are derived from the plane normal
        (no sign guessing). This avoids the temporary-BRep + boolean-combine path, which can
        fail on some Fusion builds. Refuses a diameter too large for the body.
        """
        body = self._brep_body(body_index)
        body_min = min(self._bbox_dims(body.boundingBox))
        comp = self._comp()
        drilled = 0
        for i, h in enumerate(holes or []):
            d = float(h["diameter"])
            depth = float(h["depth"])
            if d <= 0 or depth <= 0:
                raise ValueError("Hole {}: diameter and depth must be greater than 0.".format(i))
            if d >= 0.95 * body_min:
                raise ValueError(
                    "Hole {}: diameter {:g} mm is too large for this body (~{:.1f} mm thick); "
                    "refusing so the panel isn't destroyed.".format(i, d, body_min)
                )
            axis = (h.get("axis") or "z").lower()
            unit = self._AXES.get(axis)
            if not unit:
                raise ValueError("Hole {}: axis must be one of x, -x, y, -y, z, -z.".format(i))
            x, y, z = float(h["x"]), float(h["y"]), float(h["z"])
            letter = axis[-1]
            base = {"x": comp.yZConstructionPlane, "y": comp.xZConstructionPlane,
                    "z": comp.xYConstructionPlane}[letter]
            coord = {"x": x, "y": y, "z": z}[letter]
            axw = self._BASE_AXIS[letter]
            try:
                n = base.geometry.normal
                comp_n = n.x * axw[0] + n.y * axw[1] + n.z * axw[2]  # +/-1 for axis-aligned planes
                if abs(comp_n) < 1e-6:
                    raise RuntimeError("unexpected construction-plane orientation")
                off = coord / comp_n  # offset (mm) so the plane lands at the entry coordinate
                pin = comp.constructionPlanes.createInput()
                pin.setByOffset(base, adsk.core.ValueInput.createByString("{:g} mm".format(off)))
                plane = self._own(comp.constructionPlanes.add(pin))
                sketch = self._name(self._own(comp.sketches.add(plane)), "Drilled Hole")
                sp = sketch.modelToSketchSpace(adsk.core.Point3D.create(x * MM, y * MM, z * MM))
                sketch.sketchCurves.sketchCircles.addByCenterRadius(
                    adsk.core.Point3D.create(sp.x, sp.y, 0.0), (d / 2.0) * MM)
                # Cut along the hole direction: positive distance follows the plane normal.
                udotn = unit[0] * n.x + unit[1] * n.y + unit[2] * n.z
                dist = depth if udotn > 0 else -depth
                ext = comp.features.extrudeFeatures
                ein = ext.createInput(sketch.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
                ein.participantBodies = [body]
                ein.setDistanceExtent(False, adsk.core.ValueInput.createByString("{:g} mm".format(dist)))
                self._remember(ext.add(ein))
                drilled += 1
            except Exception as exc:
                raise RuntimeError(
                    "Hole {} at ({:g}, {:g}, {:g}) failed ({}). Check it lies on/over the body; "
                    "or use drill_holes_on_face. Paste this and I'll adapt it.".format(i, x, y, z, exc)
                )
        if drilled == 0:
            raise ValueError("No holes were given to drill.")
        return "Drilled {} hole(s) into body [{}] '{}' by absolute coordinates.".format(drilled, body_index, body.name)

    def drill_holes_on_face(self, body_index, face_index, points, diameter, depth=None):
        """Drill holes positioned in a face's own 2D (u, v) frame — the easy, reliable way.

        Get the face's u/v directions and extents from list_faces, then give each hole as
        ``{"u": .., "v": ..}`` in mm from the face's (min u, min v) corner. The holes are cut
        perpendicular into the body (blind ``depth``, or through-all if omitted). This avoids
        having to compute absolute world coordinates, which is error-prone.
        """
        body = self._brep_body(body_index)
        if face_index < 0 or face_index >= body.faces.count:
            raise ValueError("face_index {} out of range (body has {} faces).".format(face_index, body.faces.count))
        face = body.faces.item(face_index)
        if not adsk.core.Plane.cast(face.geometry):
            raise RuntimeError("Face [{}] is not planar; pick a flat face from list_faces.".format(face_index))
        d = float(diameter)
        if d <= 0:
            raise ValueError("diameter must be greater than 0.")
        face_min = self._face_min_span(face)
        if d >= 0.95 * face_min:
            raise ValueError(
                "Hole diameter {:g} mm is too large for this face (~{:.1f} mm). Refusing so the "
                "panel isn't destroyed.".format(d, face_min))
        frame = self._face_uv(face)
        if not frame:
            raise RuntimeError(
                "Couldn't determine the face's 2D frame. Use drill_holes with absolute "
                "coordinates instead, or pick a different face.")
        origin, u, v, usize, vsize = frame
        pts = list(points or [])
        if not pts:
            raise ValueError("No points given. Each point is {'u': mm, 'v': mm} from the face corner.")

        comp = self._comp()
        sketch = self._name(self._own(comp.sketches.add(face)), "Drilled Holes")
        placed = 0
        for p in pts:
            pu, pv = float(p["u"]), float(p["v"])
            world = adsk.core.Point3D.create(
                origin.x + (pu * u.x + pv * v.x) * MM,
                origin.y + (pu * u.y + pv * v.y) * MM,
                origin.z + (pu * u.z + pv * v.z) * MM,
            )
            sp = sketch.modelToSketchSpace(world)
            sketch.sketchCurves.sketchCircles.addByCenterRadius(
                adsk.core.Point3D.create(sp.x, sp.y, 0.0), (d / 2.0) * MM)
            placed += 1

        profiles = adsk.core.ObjectCollection.create()
        for i in range(sketch.profiles.count):
            profiles.add(sketch.profiles.item(i))
        ext = comp.features.extrudeFeatures
        ext_input = ext.createInput(profiles, adsk.fusion.FeatureOperations.CutFeatureOperation)
        if depth is not None and not (isinstance(depth, (int, float)) and float(depth) == 0.0):
            ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString("-(" + self._length(depth) + ")"))
        else:
            ext_input.setAllExtent(adsk.fusion.ExtentDirections.NegativeExtentDirection)
        try:
            self._remember(ext.add(ext_input))
        except Exception as exc:
            raise RuntimeError(
                "Couldn't cut the holes on face [{}] ({}). Check the points lie on the face "
                "(0..{:.0f} in u, 0..{:.0f} in v).".format(face_index, exc, usize, vsize))
        return "Drilled {} hole(s) on face [{}] of body [{}] (u/v from the face corner).".format(
            placed, face_index, body_index)

    # -- viewport selection (pick in Fusion, act in chat) --------------------
    def _selected_entities(self):
        sels = self.app.userInterface.activeSelections
        return [sels.item(i).entity for i in range(sels.count)]

    def _selected_edges(self):
        edges = adsk.core.ObjectCollection.create()
        for e in self._selected_entities():
            if adsk.fusion.BRepEdge.cast(e):
                edges.add(e)
        return edges

    def get_selection(self):
        ents = self._selected_entities()
        if not ents:
            return "Nothing is selected in Fusion. Click the faces/edges/bodies you mean in the viewport, then ask again."
        rows = []
        for k, e in enumerate(ents):
            if adsk.fusion.BRepFace.cast(e):
                kind = "face ({})".format(self._surface_kind(e.geometry))
            elif adsk.fusion.BRepEdge.cast(e):
                kind = "edge ({}, {:.1f} mm)".format(self._curve_kind(e.geometry), self._mm(e.length))
            elif adsk.fusion.BRepBody.cast(e):
                kind = "body '{}'".format(e.name)
            else:
                kind = type(e).__name__
            rows.append("  [{}] {}".format(k, kind))
        return "Current Fusion selection ({}):\n".format(len(ents)) + "\n".join(rows)

    def fillet_selection(self, radius):
        edges = self._selected_edges()
        if edges.count == 0:
            raise RuntimeError("Select one or more edges in Fusion first, then try again.")
        comp = self._comp()
        fillets = comp.features.filletFeatures
        fin = fillets.createInput()
        fin.addConstantRadiusEdgeSet(edges, adsk.core.ValueInput.createByString(self._length(radius)), True)
        self._remember(fillets.add(fin))
        return "Filleted {} selected edge(s) with radius {}.".format(edges.count, self._length(radius))

    def chamfer_selection(self, distance):
        edges = self._selected_edges()
        if edges.count == 0:
            raise RuntimeError("Select one or more edges in Fusion first, then try again.")
        comp = self._comp()
        chamfers = comp.features.chamferFeatures
        cin = chamfers.createInput(edges, True)
        cin.setToEqualDistance(adsk.core.ValueInput.createByString(self._length(distance)))
        self._remember(chamfers.add(cin))
        return "Chamfered {} selected edge(s) by {}.".format(edges.count, self._length(distance))

    def cut_hole_selection(self, diameter, depth=None):
        face = None
        for e in self._selected_entities():
            f = adsk.fusion.BRepFace.cast(e)
            if f and adsk.core.Plane.cast(f.geometry):
                face = f
                break
        if not face:
            raise RuntimeError("Select a flat face in Fusion first, then try again.")
        r_mm = self._cut_hole_on_face(face, diameter, depth, 0.0, 0.0)
        depth_note = self._length(depth) if depth else "through all"
        return "Cut a {:g} mm hole in the selected face ({}).".format(r_mm, depth_note)



    def combine_bodies(self, target_index, tool_indices, operation="join"):
        comp = self._comp()
        op = _OPERATIONS.get((operation or "join").lower())
        if op is None or (operation or "join").lower() == "new":
            raise ValueError("operation must be join, cut or intersect.")
        target = self._brep_body(target_index)
        tools_col = adsk.core.ObjectCollection.create()
        for idx in tool_indices:
            tools_col.add(self._brep_body(idx))
        if tools_col.count == 0:
            raise ValueError("No tool bodies given.")
        combines = comp.features.combineFeatures
        cin = combines.createInput(target, tools_col)
        cin.operation = op
        self._remember(combines.add(cin))
        return "Combined body [{}] with {} body(ies) using '{}'.".format(target_index, tools_col.count, operation)

    def _translate_body(self, body, dx, dy, dz):
        """Translate one body by (dx, dy, dz) mm via a Move feature (remembers it)."""
        comp = self._comp()
        col = adsk.core.ObjectCollection.create()
        col.add(body)
        moves = comp.features.moveFeatures
        move_input = moves.createInput2(col)
        move_input.defineAsTranslateXYZ(
            adsk.core.ValueInput.createByString("{:g} mm".format(float(dx))),
            adsk.core.ValueInput.createByString("{:g} mm".format(float(dy))),
            adsk.core.ValueInput.createByString("{:g} mm".format(float(dz))),
            True,
        )
        # Remember the move feature so a following pattern targets it, not the prior feature.
        self._remember(moves.add(move_input))

    def move_body(self, body_index, dx=0.0, dy=0.0, dz=0.0):
        self._translate_body(self._brep_body(body_index), dx, dy, dz)
        return "Moved body [{}] by ({:g}, {:g}, {:g}) mm.".format(body_index, float(dx), float(dy), float(dz))

    def _body_center(self, body):
        bb = body.boundingBox
        return ((bb.minPoint.x + bb.maxPoint.x) / 2.0,
                (bb.minPoint.y + bb.maxPoint.y) / 2.0,
                (bb.minPoint.z + bb.maxPoint.z) / 2.0)

    def explode_assembly(self, factor=0.6):
        """Move bodies radially outward from the assembly centre for an exploded view.

        Records each body's displacement so reassemble() can restore the built positions
        exactly (this is a literal move — Fusion's animated exploded view isn't scriptable).
        """
        comp = self._comp()
        n = comp.bRepBodies.count
        if n == 0:
            raise RuntimeError("There are no bodies to explode.")
        if self._explode_state:
            raise RuntimeError("The model is already exploded — call reassemble first.")
        factor = float(factor)
        if factor <= 0:
            raise ValueError("factor must be greater than 0.")

        bodies = [comp.bRepBodies.item(i) for i in range(n)]
        centers = [self._body_center(b) for b in bodies]
        ctr = tuple(sum(c[k] for c in centers) / n for k in range(3))  # centroid of body centres

        state = []
        for b, c in zip(bodies, centers):
            dx = self._mm((c[0] - ctr[0]) * factor)
            dy = self._mm((c[1] - ctr[1]) * factor)
            dz = self._mm((c[2] - ctr[2]) * factor)
            if abs(dx) < 0.1 and abs(dy) < 0.1 and abs(dz) < 0.1:
                dz += 50.0  # a body at the centre would otherwise not move; nudge it up
            self._translate_body(b, dx, dy, dz)
            state.append((b.name, dx, dy, dz))
        self._explode_state = state
        return "Exploded {} bodies (factor {:g}). Call reassemble to restore the built positions.".format(n, factor)

    def reassemble(self):
        """Restore every body moved by explode_assembly back to its built position."""
        if not self._explode_state:
            raise RuntimeError("Nothing is exploded. (explode_assembly records the moves it undoes.)")
        comp = self._comp()
        by_name = {}
        for i in range(comp.bRepBodies.count):
            b = comp.bRepBodies.item(i)
            by_name.setdefault(b.name, []).append(b)
        restored = 0
        for name, dx, dy, dz in self._explode_state:
            bodies = by_name.get(name)
            if bodies:
                self._translate_body(bodies.pop(0), -dx, -dy, -dz)
                restored += 1
        self._explode_state = None
        return "Reassembled {} bodies to their built positions.".format(restored)

    def export_bom(self, filename=None):
        """Write a Bill of Materials (item, qty, part, material, dimensions) as CSV to the home
        folder, and return the table text so it can be shown / put on a drawing."""
        comp = self._comp()
        if comp.bRepBodies.count == 0:
            raise RuntimeError("There are no bodies for a BOM.")
        parts = []
        for i in range(comp.bRepBodies.count):
            b = comp.bRepBodies.item(i)
            length, width, thickness = sorted(self._bbox_dims(b.boundingBox), reverse=True)
            material = ""
            try:
                material = b.material.name if b.material else ""
            except Exception:
                pass
            parts.append({"name": b.name, "material": material,
                          "length": length, "width": width, "thickness": thickness})
        csv_text = util.bom_csv(parts)
        base = util.safe_export_basename(filename if filename else "claudecad_bom")
        home = os.path.realpath(os.path.expanduser("~"))
        path = os.path.realpath(os.path.join(home, base + ".csv"))
        if os.path.dirname(path) != home:
            raise ValueError("Refusing to write outside your home folder.")
        suffix = 1
        while os.path.exists(path):
            path = os.path.join(home, "{}_{}.csv".format(base, suffix))
            suffix += 1
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(csv_text)
        return "Wrote a BOM to {}\n\n{}".format(path, csv_text)

    def rename_body(self, body_index, name):
        """Give a solid body a readable name in the browser (body indices from inspect_model)."""
        body = self._brep_body(body_index)
        if not name or not str(name).strip():
            raise ValueError("Provide a non-empty name.")
        old = body.name
        body.name = str(name).strip()
        return "Renamed body [{}] from '{}' to '{}'.".format(body_index, old, body.name)

    def draw_polygon(self, sketch_id, sides, radius, center_x=0.0, center_y=0.0):
        sketch = self._sketch(sketch_id)
        sides = int(sides)
        if sides < 3:
            raise ValueError("A polygon needs at least 3 sides.")
        cx, cy = float(center_x), float(center_y)
        r = float(radius)
        verts = []
        for k in range(sides):
            angle = math.pi / 2 + 2 * math.pi * k / sides
            verts.append(self._pt(cx + r * math.cos(angle), cy + r * math.sin(angle)))
        lines = sketch.sketchCurves.sketchLines
        first = lines.addByTwoPoints(verts[0], verts[1])
        prev = first
        for k in range(2, sides):
            prev = lines.addByTwoPoints(prev.endSketchPoint, verts[k])
        lines.addByTwoPoints(prev.endSketchPoint, first.startSketchPoint)
        return "Drew a {}-sided polygon (radius {:g} mm) in {} ({} profile(s)).".format(
            sides, r, sketch_id, sketch.profiles.count
        )

    def export_model(self, fmt="step", filename=None):
        design = self._design()
        mgr = design.exportManager
        fmt = (fmt or "step").lower()
        ext = util.export_extension(fmt)
        if not ext:
            raise ValueError("Unsupported format '{}'. Use step, stl, iges or f3d.".format(fmt))
        # Sanitize the model-supplied filename (strip path + unsafe chars), confine it to the
        # home folder so a prompt can't traverse out (../) or write elsewhere, and auto-suffix
        # instead of overwriting an existing file.
        base = util.safe_export_basename(filename)
        home = os.path.realpath(os.path.expanduser("~"))
        path = os.path.realpath(os.path.join(home, base + ext))
        if os.path.dirname(path) != home:
            raise ValueError("Refusing to export outside your home folder.")
        suffix = 1
        while os.path.exists(path):
            path = os.path.join(home, "{}_{}{}".format(base, suffix, ext))
            suffix += 1

        if fmt == "stl":
            options = mgr.createSTLExportOptions(self._comp(), path)
        elif fmt in ("iges", "igs"):
            options = mgr.createIGESExportOptions(path)
        elif fmt == "f3d":
            options = mgr.createFusionArchiveExportOptions(path)
        else:
            options = mgr.createSTEPExportOptions(path)
        mgr.execute(options)
        return "Exported the model to {}".format(path)

    def export_cut_list(self, filename=None):
        """Write a CSV cut list of every solid body (length x width x thickness + material),
        grouping identical parts into quantities, to the user's home folder."""
        comp = self._comp()
        if comp.bRepBodies.count == 0:
            raise RuntimeError("There are no solid bodies to list.")
        parts = []
        for i in range(comp.bRepBodies.count):
            b = comp.bRepBodies.item(i)
            length, width, thickness = sorted(self._bbox_dims(b.boundingBox), reverse=True)
            material = ""
            try:
                material = b.material.name if b.material else ""
            except Exception:
                pass
            parts.append({"name": b.name, "length": length, "width": width,
                          "thickness": thickness, "material": material})
        csv_text = util.cut_list_csv(parts)

        base = util.safe_export_basename(filename if filename else "claudecad_cutlist")
        home = os.path.realpath(os.path.expanduser("~"))
        path = os.path.realpath(os.path.join(home, base + ".csv"))
        if os.path.dirname(path) != home:
            raise ValueError("Refusing to write outside your home folder.")
        suffix = 1
        while os.path.exists(path):
            path = os.path.join(home, "{}_{}.csv".format(base, suffix))
            suffix += 1
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(csv_text)
        return "Wrote a cut list of {} part(s) to {}".format(len(parts), path)

    # -- advanced features ---------------------------------------------------
    def loft(self, sketch_ids, operation="new"):
        comp = self._comp()
        op = _OPERATIONS.get((operation or "new").lower())
        if op is None:
            raise ValueError("Unknown operation '{}'.".format(operation))
        if not sketch_ids or len(sketch_ids) < 2:
            raise ValueError("Loft needs at least two profile sketches.")
        lofts = comp.features.loftFeatures
        lin = lofts.createInput(op)
        for sid in sketch_ids:
            sk = self._sketch(sid)
            if sk.profiles.count == 0:
                raise RuntimeError("Sketch {} has no closed profile to loft.".format(sid))
            lin.loftSections.add(sk.profiles.item(0))
        self._remember(lofts.add(lin))
        return "Lofted a body through {} profiles ({}).".format(len(sketch_ids), operation)

    def sweep(self, profile_sketch_id, path_sketch_id, operation="new"):
        comp = self._comp()
        op = _OPERATIONS.get((operation or "new").lower())
        if op is None:
            raise ValueError("Unknown operation '{}'.".format(operation))
        psk = self._sketch(profile_sketch_id)
        if psk.profiles.count == 0:
            raise RuntimeError("Profile sketch {} has no closed profile.".format(profile_sketch_id))
        path_sk = self._sketch(path_sketch_id)
        if path_sk.sketchCurves.count == 0:
            raise RuntimeError("Path sketch {} has no curve to sweep along.".format(path_sketch_id))
        path = comp.features.createPath(path_sk.sketchCurves.item(0), True)
        sweeps = comp.features.sweepFeatures
        sin = sweeps.createInput(psk.profiles.item(0), path, op)
        self._remember(sweeps.add(sin))
        return "Swept profile from {} along the path in {} ({}).".format(profile_sketch_id, path_sketch_id, operation)

    def mesh_to_solid(self, mesh_index=0):
        comp = self._comp()
        meshes = comp.meshBodies
        if meshes.count == 0:
            raise RuntimeError("There are no mesh bodies to convert. Import an STL/OBJ first.")
        if mesh_index < 0 or mesh_index >= meshes.count:
            raise ValueError("mesh_index {} out of range ({} mesh bodies).".format(mesh_index, meshes.count))

        feats = None
        for attr in ("meshToBRepFeatures", "convertMeshFeatures"):
            candidate = getattr(comp.features, attr, None)
            if candidate is not None:
                feats = candidate
                break
        if feats is None:
            raise RuntimeError(
                "Mesh-to-solid conversion isn't exposed by the Fusion API in this version. "
                "Workaround: in Fusion use the Mesh tab > BRep Conversion, then I can edit the result."
            )

        col = adsk.core.ObjectCollection.create()
        col.add(meshes.item(mesh_index))
        try:
            try:
                feats.add(feats.createInput(col))
            except TypeError:
                feats.add(feats.createInput(col, 0))  # some versions take a conversion-type arg
        except Exception as exc:
            raise RuntimeError(
                "Mesh conversion failed ({}). Your Fusion version's API may differ — paste this "
                "message, or use Mesh > BRep Conversion in the UI.".format(exc)
            )
        self._record_start()  # body set changed
        return "Converted mesh [{}] to a solid body.".format(mesh_index)

    def add_thread(self, body_index, face_index, internal=True):
        comp = self._comp()
        body = self._brep_body(body_index)
        if face_index < 0 or face_index >= body.faces.count:
            raise ValueError("face_index {} out of range (body has {} faces).".format(face_index, body.faces.count))
        face = body.faces.item(face_index)
        cyl = adsk.core.Cylinder.cast(face.geometry)
        if not cyl:
            raise RuntimeError(
                "Face [{}] is not cylindrical; threads need a cylindrical face. "
                "Run list_faces and pick one shown as 'cylinder'.".format(face_index)
            )

        threads = comp.features.threadFeatures
        diameter_mm = self._mm(cyl.radius * 2.0)
        try:
            query = threads.threadDataQuery
            thread_type = query.defaultMetricThreadType
            rec = query.recommendedThreadData(cyl.radius * 2.0, internal, thread_type)
        except Exception as exc:
            raise RuntimeError(
                "Couldn't query standard thread data ({}). The thread API can vary by Fusion "
                "version — paste this message and I'll adapt it.".format(exc)
            )
        if not rec or not rec[0] or len(rec) < 4:
            raise RuntimeError("No standard metric thread is recommended for a {:.1f} mm face.".format(diameter_mm))

        designation = rec[2]
        try:
            info = threads.createThreadInfo(internal, thread_type, designation, rec[3])
            faces = adsk.core.ObjectCollection.create()
            faces.add(face)
            tin = threads.createInput(faces, info)
            tin.isModeled = True
            self._remember(threads.add(tin))
        except Exception as exc:
            raise RuntimeError(
                "Couldn't create the thread (designation '{}'): {}. Paste this and I'll fix the "
                "thread-info mapping for your Fusion version.".format(designation, exc)
            )
        return "Added a modeled {} thread ({}) to face [{}] (~{:.1f} mm).".format(
            "internal" if internal else "external", designation, face_index, diameter_mm
        )

    def get_mass_properties(self, body_index=0):
        body = self._brep_body(body_index)
        pp = body.physicalProperties
        com = pp.centerOfMass
        return (
            "Body [{}] '{}': mass {:.2f} g, volume {:.2f} cm^3, surface area {:.2f} cm^2, "
            "centre of mass at {} mm.".format(
                body_index, body.name, pp.mass * 1000.0, pp.volume, pp.area, self._fmt_pt(com)
            )
        )

    def _iter_materials(self):
        """Yield every Material across all loaded Fusion material libraries.

        Appearance-only libraries (and any library whose materials can't be read) are
        skipped rather than aborting the whole search.
        """
        try:
            libs = self.app.materialLibraries
        except Exception:
            return
        for i in range(libs.count):
            try:
                mats = libs.item(i).materials
            except Exception:
                continue
            for j in range(mats.count):
                try:
                    yield mats.item(j)
                except Exception:
                    continue

    def list_materials(self, filter_text="", limit=60):
        q = (filter_text or "").strip().lower()
        names, seen = [], set()
        for m in self._iter_materials():
            if q and q not in m.name.lower():
                continue
            if m.name in seen:
                continue
            seen.add(m.name)
            names.append(m.name)
            if len(names) >= limit:
                break
        if not names:
            if q:
                return "No materials match '{}'. Call list_materials with no filter to see what's available.".format(filter_text)
            return "No materials are available in Fusion's material libraries on this install."
        header = "Available materials{} ({}{}):".format(
            " matching '{}'".format(filter_text) if q else "", len(names), "+" if len(names) >= limit else ""
        )
        return header + "\n  " + "\n  ".join(names)

    def _find_material(self, name):
        """Resolve a material name to a Material, preferring exact > prefix > substring."""
        q = (name or "").strip().lower()
        exact = prefix = contains = None
        for m in self._iter_materials():
            mn = m.name.lower()
            if mn == q:
                exact = m
                break
            if prefix is None and mn.startswith(q):
                prefix = m
            if contains is None and q in mn:
                contains = m
        return exact or prefix or contains

    def set_material(self, body_index, name, all_bodies=False):
        target = self._find_material(name)
        if not target:
            sample = []
            for m in self._iter_materials():
                sample.append(m.name)
                if len(sample) >= 15:
                    break
            hint = (" Examples: " + ", ".join(sample) + ".") if sample else \
                " No materials are available in this install's libraries."
            raise ValueError("No material matching '{}'. Call list_materials to see valid names.{}".format(name, hint))

        comp = self._comp()
        if all_bodies:
            bodies = [comp.bRepBodies.item(i) for i in range(comp.bRepBodies.count)]
            if not bodies:
                raise RuntimeError("There are no solid bodies to assign a material to.")
        else:
            bodies = [self._brep_body(body_index)]

        applied = 0
        for body in bodies:
            try:
                body.material = target
                applied += 1
            except Exception as exc:
                if not all_bodies:
                    raise RuntimeError(
                        "Found material '{}' but couldn't assign it to body '{}' ({}). "
                        "Paste this and I'll adapt it for your Fusion version.".format(target.name, body.name, exc)
                    )
        if applied == 0:
            raise RuntimeError("Found material '{}' but couldn't assign it to any body.".format(target.name))
        if all_bodies:
            return "Set material '{}' on all {} bodies.".format(target.name, applied)
        return "Set body [{}] '{}' material to '{}'.".format(body_index, bodies[0].name, target.name)

    # -- casework (cabinets) -------------------------------------------------
    def _box(self, name, x0, y0, z0, x1, y1, z1, ex=None, ey=None, ez0=None, edz=None):
        """Create a named, axis-aligned box body from corner (x0,y0,z0) to (x1,y1,z1) mm.

        Every panel is built as its X-Y footprint sketched on an offset XY plane and
        extruded up in Z, so there's no plane-orientation guesswork.

        Optional parameter expressions make the box adjustable later: ``ex``/``ey`` drive
        the footprint width (x) / depth (y) via sketch dimensions, ``ez0`` the plane offset,
        and ``edz`` the extrude distance (height). Coordinates are still seeded numerically,
        so the geometry is always built even if a dimension can't be applied.
        """
        comp = self._comp()
        if ez0 is None and abs(z0) < 1e-9:
            plane = comp.xYConstructionPlane
        else:
            z0_expr = ez0 if ez0 is not None else "{:g} mm".format(z0)
            pin = comp.constructionPlanes.createInput()
            pin.setByOffset(comp.xYConstructionPlane, adsk.core.ValueInput.createByString(z0_expr))
            plane = self._own(comp.constructionPlanes.add(pin))
        sketch = self._name(self._own(comp.sketches.add(plane)), "{} Sketch".format(name))
        rect = sketch.sketchCurves.sketchLines.addTwoPointRectangle(
            adsk.core.Point3D.create(x0 * MM, y0 * MM, 0.0),
            adsk.core.Point3D.create(x1 * MM, y1 * MM, 0.0),
        )
        if ex or ey:
            cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
            self._dimension_rectangle(sketch, rect, ex, ey, cx, cy, abs(x1 - x0), abs(y1 - y0))
        ext = comp.features.extrudeFeatures
        ext_input = ext.createInput(sketch.profiles.item(0), adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        dz_expr = edz if edz is not None else "{:g} mm".format(z1 - z0)
        ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString(dz_expr))
        feature = ext.add(ext_input)
        body = feature.bodies.item(0)
        body.name = name
        self._remember(feature)
        return body

    def _cut_box(self, target_body, x0, y0, z0, x1, y1, z1):
        """Cut an axis-aligned rectangular pocket (mm) from ONE body only.

        Used to rout a groove/rabbet into a panel without affecting the other panels —
        ``participantBodies`` limits the cut to the given body.
        """
        comp = self._comp()
        if abs(z0) < 1e-9:
            plane = comp.xYConstructionPlane
        else:
            pin = comp.constructionPlanes.createInput()
            pin.setByOffset(comp.xYConstructionPlane, adsk.core.ValueInput.createByString("{:g} mm".format(z0)))
            plane = self._own(comp.constructionPlanes.add(pin))
        sketch = self._name(self._own(comp.sketches.add(plane)), "Groove")
        sketch.sketchCurves.sketchLines.addTwoPointRectangle(
            adsk.core.Point3D.create(x0 * MM, y0 * MM, 0.0),
            adsk.core.Point3D.create(x1 * MM, y1 * MM, 0.0),
        )
        ext = comp.features.extrudeFeatures
        ext_input = ext.createInput(sketch.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
        ext_input.participantBodies = [target_body]
        ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString("{:g} mm".format(z1 - z0)))
        feature = ext.add(ext_input)
        self._remember(feature)
        return feature

    @staticmethod
    def _joinery_plan(method, thickness, shelves):
        m = (method or "screws").lower()
        lines = []
        if m == "screws":
            lines.append("  Sides <-> Bottom/Top: 3-4 confirmat or pocket screws per joint + glue.")
            lines.append("  Back: screwed/pinned to the rear edges + glue (or set in a groove).")
            if shelves:
                lines.append("  Shelves: shelf pins (adjustable) or screws through the sides (fixed).")
        elif m == "dowels":
            lines.append("  Sides <-> Bottom/Top: 3-4 x 8 mm dowels per joint + glue.")
            lines.append("  Back: glued/pinned at the rear; shelves on dowels or pins.")
        elif m in ("dado", "rabbet", "dado/rabbet"):
            lines.append("  Bottom/Top sit in {:g} mm dados cut into the sides, glued.".format(thickness))
            lines.append("  Back sits in a rear rabbet/groove, glued (keeps the carcass square).")
            if shelves:
                lines.append("  Shelves in dados (fixed) or on pins (adjustable).")
        else:  # auto
            lines.append("  Carcass (sides <-> bottom/top): screws + glue — sound for {:g} mm sheet goods.".format(thickness))
            lines.append("  Back: in a groove, glued — adds rigidity and squares the box.")
            if shelves:
                lines.append("  Shelves: pins if adjustable, dados if fixed.")
        lines.append("  (Plan only — joinery holes/dados aren't cut yet; say the word and I'll add them.)")
        return "\n".join(lines)

    def build_cabinet(self, width, height, depth, thickness=18.0, back_thickness=6.0,
                      shelves=0, joinery="screws", back_joint="groove", back_groove=None,
                      parametric=False):
        W, H, D = float(width), float(height), float(depth)
        T, BT = float(thickness), float(back_thickness)
        if W <= 2 * T + 10 or H <= 2 * T + 10 or D <= BT + 10:
            raise ValueError("Cabinet dimensions are too small for {:g} mm material.".format(T))
        n_sh = max(0, int(shelves))

        # Optional parametric mode (OFF by default): create named user parameters and
        # reference them on the panels so the cabinet is adjustable later (change a parameter,
        # the panels follow). Expressions are seeded from the current numbers, so the geometry
        # is always built. Experimental until validated in Fusion.
        if parametric:
            self.create_parameter("cab_w", "{:g} mm".format(W), comment="Cabinet overall width")
            self.create_parameter("cab_h", "{:g} mm".format(H), comment="Cabinet overall height")
            self.create_parameter("cab_d", "{:g} mm".format(D), comment="Cabinet overall depth")
            self.create_parameter("cab_t", "{:g} mm".format(T), comment="Panel thickness")
            self.create_parameter("cab_back", "{:g} mm".format(BT), comment="Back panel thickness")
            e_w, e_h, e_d, e_t, e_bk = "cab_w", "cab_h", "cab_d", "cab_t", "cab_back"
            e_inner_w = "cab_w - 2 * cab_t"   # clear width between the sides
            e_inner_d = "cab_d - cab_back"    # depth from front to the back panel
        else:
            e_w = e_h = e_d = e_t = e_bk = e_inner_w = e_inner_d = None

        # Origin at the bottom-left-back corner: X=width, Y=depth, Z=height.
        # Sides run full depth/height; bottom/top/shelves stop at the back panel.
        left = self._box("Left Side", 0, 0, 0, T, D, H, ex=e_t, ey=e_d, edz=e_h)
        right = self._box("Right Side", W - T, 0, 0, W, D, H, ex=e_t, ey=e_d, edz=e_h)
        self._box("Bottom", T, 0, 0, W - T, D - BT, T, ex=e_inner_w, ey=e_inner_d, edz=e_t)
        self._box("Top", T, 0, H - T, W - T, D - BT, H, ex=e_inner_w, ey=e_inner_d,
                  ez0=("cab_h - cab_t" if parametric else None), edz=e_t)

        # Back panel. Default 'groove': the back carries a tongue (protrusion) on its left and
        # right edges that seats into a groove routed into each side panel — this squares the
        # carcass and captures the back's edges. 'inset' = flush between the sides; 'overlay' =
        # covers the full rear over the side edges. (The groove detail itself is sized numerically.)
        bj = (back_joint or "groove").lower()
        if bj == "groove":
            gd = float(back_groove) if back_groove else T / 2.0
            gd = max(2.0, min(gd, T - 2.0))  # keep at least 2 mm of side wall
            try:
                self._cut_box(left, T - gd, D - BT, 0, T, D, H)        # groove in left side
                self._cut_box(right, W - T, D - BT, 0, W - T + gd, D, H)  # groove in right side
                e_back_w = ("cab_w - 2 * cab_t + {:g} mm".format(2 * gd)) if parametric else None
                self._box("Back", T - gd, D - BT, 0, W - T + gd, D, H, ex=e_back_w, ey=e_bk, edz=e_h)
                back_w = W - 2 * T + 2 * gd
                back_note = " Back is tongued {:g} mm into a groove in each side.".format(gd)
            except Exception as exc:
                self._box("Back", T, D - BT, 0, W - T, D, H, ex=e_inner_w, ey=e_bk, edz=e_h)
                bj, back_w = "inset", W - 2 * T
                back_note = " (Back groove not supported here [{}] — used a flush inset back.)".format(exc)
        elif bj == "overlay":
            self._box("Back", 0, D - BT, 0, W, D, H, ex=e_w, ey=e_bk, edz=e_h)
            back_w = W
            back_note = " Back overlays the full rear (covers the side edges)."
        else:  # inset
            bj = "inset"
            self._box("Back", T, D - BT, 0, W - T, D, H, ex=e_inner_w, ey=e_bk, edz=e_h)
            back_w = W - 2 * T
            back_note = " Back is inset flush between the sides."

        shelf_lines = []
        if n_sh:
            gap = (H - 2 * T) / (n_sh + 1)
            for i in range(1, n_sh + 1):
                z0 = T + gap * i - T / 2.0
                self._box("Shelf {}".format(i), T, 0, z0, W - T, D - BT, z0 + T,
                          ex=e_inner_w, ey=e_inner_d, edz=e_t)
            shelf_lines.append("  Shelf x{}: {:g} x {:g} x {:g} mm".format(n_sh, W - 2 * T, D - BT, T))

        cut = [
            "  Side x2: {:g} x {:g} x {:g} mm".format(D, H, T),
            "  Bottom/Top x2: {:g} x {:g} x {:g} mm".format(W - 2 * T, D - BT, T),
            "  Back x1: {:g} x {:g} x {:g} mm".format(back_w, H, BT),
        ] + shelf_lines

        param_note = (
            " Parameter-driven: cab_w/cab_h/cab_d/cab_t/cab_back — change one with "
            "change_parameter to resize." if parametric else ""
        )
        return (
            "Built a frameless cabinet {:g}(W) x {:g}(H) x {:g}(D) mm in {:g} mm material"
            "{}.{}\nBack joint: {}.{}\nCut list:\n{}\nJoinery ({}):\n{}".format(
                W, H, D, T,
                " with {} shelf(es)".format(n_sh) if n_sh else "",
                param_note,
                bj, back_note,
                "\n".join(cut), joinery, self._joinery_plan(joinery, T, n_sh),
            )
        )

    # -- cabinet fronts (front=y=0, outward=-Y; same frame as build_cabinet) --
    def add_face_frame(self, width, height, stile=38.0, rail=38.0, frame_thickness=19.0):
        """Apply a face frame (left/right stiles + top/bottom rails) to the cabinet front."""
        W, H = float(width), float(height)
        sw, rw, ft = float(stile), float(rail), float(frame_thickness)
        if sw * 2 >= W or rw * 2 >= H:
            raise ValueError("Stile/rail widths are too large for the cabinet face.")
        y0, y1 = -ft, 0.0  # frame sits proud of the carcass front (y=0), extending outward (-Y)
        self._box("FF Left Stile", 0, y0, 0, sw, y1, H)
        self._box("FF Right Stile", W - sw, y0, 0, W, y1, H)
        self._box("FF Top Rail", sw, y0, H - rw, W - sw, y1, H)
        self._box("FF Bottom Rail", sw, y0, 0, W - sw, y1, rw)
        return "Added a face frame ({:g} mm stiles, {:g} mm rails, {:g} mm thick) to the front.".format(sw, rw, ft)

    def add_doors(self, width, height, count=1, thickness=18.0, gap=3.0, reveal=2.0,
                  style="overlay", carcass_thickness=18.0):
        """Add overlay or inset door fronts across the cabinet face."""
        W, H = float(width), float(height)
        t, gap, rev = float(thickness), float(gap), float(reveal)
        n = max(1, int(count))
        style = (style or "overlay").lower()
        if style == "inset":
            ct = float(carcass_thickness)
            ox0, oz0, ox1, oz1 = ct, ct, W - ct, H - ct  # opening between the panels
            clr = 2.0
            avail = (ox1 - ox0) - 2 * clr - (n - 1) * gap
            if avail <= 0:
                raise ValueError("Opening too small for {} inset door(s).".format(n))
            dw, dh = avail / n, (oz1 - oz0) - 2 * clr
            y0, y1 = 0.0, t  # flush with the carcass front, extending back into the opening
            x_start, z0 = ox0 + clr, oz0 + clr
        else:  # overlay
            avail = (W - 2 * rev) - (n - 1) * gap
            if avail <= 0:
                raise ValueError("Face too small for {} overlay door(s).".format(n))
            dw, dh = avail / n, H - 2 * rev
            y0, y1 = -t, 0.0  # proud of the carcass front
            x_start, z0 = rev, rev
        for i in range(n):
            x0 = x_start + i * (dw + gap)
            self._box("Door {}".format(i + 1), x0, y0, z0, x0 + dw, y1, z0 + dh)
        return "Added {} {} door(s) ({:g} x {:g} mm each, {:g} mm thick).".format(n, style, dw, dh, t)

    def add_drawers(self, width, height, depth, count=1, front_thickness=18.0, gap=3.0,
                    reveal=2.0, carcass_thickness=18.0, box_thickness=12.0, slide_clearance=13.0,
                    boxes=True):
        """Add stacked overlay drawer fronts, and (optionally) a simple box behind each."""
        W, H, D = float(width), float(height), float(depth)
        ft, gap, rev = float(front_thickness), float(gap), float(reveal)
        ct, bt, slc = float(carcass_thickness), float(box_thickness), float(slide_clearance)
        n = max(1, int(count))
        avail = (H - 2 * rev) - (n - 1) * gap
        if avail <= 0:
            raise ValueError("Face too small for {} drawer(s).".format(n))
        fh, fw = avail / n, W - 2 * rev
        # Drawer box footprint: inside the opening, minus slide clearance each side.
        bx0, bx1 = ct + slc, W - ct - slc
        by1 = D - ct  # leave the carcass back clear; box runs from the front into the cabinet
        for i in range(n):
            z0 = rev + i * (fh + gap)
            self._box("Drawer Front {}".format(i + 1), rev, -ft, z0, W - rev, 0.0, z0 + fh)
            if boxes and bx1 - bx0 > 10:
                bz0 = z0 + 5.0          # box bottom sits a little above the front's lower edge
                bh = max(40.0, fh - 25.0)  # box height a bit less than the front
                bz1 = bz0 + bh
                by0 = 5.0               # start just inside the front
                self._box("Drawer {} Bottom".format(i + 1), bx0, by0, bz0, bx1, by1, bz0 + bt)
                self._box("Drawer {} Left".format(i + 1), bx0, by0, bz0, bx0 + bt, by1, bz1)
                self._box("Drawer {} Right".format(i + 1), bx1 - bt, by0, bz0, bx1, by1, bz1)
                self._box("Drawer {} Back".format(i + 1), bx0, by1 - bt, bz0, bx1, by1, bz1)
        return "Added {} drawer(s){} ({:g} x {:g} mm fronts).".format(
            n, " with boxes" if boxes else "", fw, fh)

    def promote_to_components(self):
        """Move each solid body into its own component/occurrence to form a real assembly."""
        comp = self._comp()
        count = comp.bRepBodies.count
        if count == 0:
            raise RuntimeError("There are no solid bodies to promote.")
        bodies = [comp.bRepBodies.item(i) for i in range(count)]
        moved = 0
        for b in bodies:
            name = b.name
            try:
                occ = comp.occurrences.addNewComponent(adsk.core.Matrix3D.create())
                occ.component.name = name
                b.moveToComponent(occ)
                moved += 1
            except Exception as exc:
                raise RuntimeError(
                    "Couldn't promote body '{}' to a component ({}). Paste this and I'll adapt "
                    "it for your Fusion version.".format(name, exc)
                )
        return "Promoted {} body(ies) into their own components (a real assembly).".format(moved)

    def _largest_planar_face(self, body):
        best, best_area = None, -1.0
        for i in range(body.faces.count):
            f = body.faces.item(i)
            if not adsk.core.Plane.cast(f.geometry):
                continue
            try:
                area = f.area
            except Exception:
                continue
            if area > best_area:
                best, best_area = f, area
        return best

    def export_dxf(self, folder=None):
        """Export each body's largest flat face as a DXF (for CNC/laser) into a home subfolder."""
        comp = self._comp()
        if comp.bRepBodies.count == 0:
            raise RuntimeError("There are no solid bodies to export.")
        base = util.safe_export_basename(folder if folder else "claudecad_dxf")
        home = os.path.realpath(os.path.expanduser("~"))
        outdir = os.path.realpath(os.path.join(home, base))
        if os.path.dirname(outdir) != home:
            raise ValueError("Refusing to write outside your home folder.")
        os.makedirs(outdir, exist_ok=True)
        written = 0
        for i in range(comp.bRepBodies.count):
            b = comp.bRepBodies.item(i)
            face = self._largest_planar_face(b)
            if not face:
                continue
            sketch = self._own(comp.sketches.add(face))
            try:
                sketch.project(face)
                path = os.path.join(outdir, "{}_{}.dxf".format(util.safe_export_basename(b.name), i))
                sketch.saveAsDXF(path)
                written += 1
            except Exception as exc:
                raise RuntimeError(
                    "DXF export failed for body '{}' ({}). Paste this and I'll adapt it.".format(b.name, exc)
                )
            finally:
                # The sketch is only a means to the DXF; remove it so repeated exports don't
                # clutter the timeline/browser (export isn't part of an undo group).
                try:
                    sketch.deleteMe()
                except Exception:
                    pass
        return "Wrote {} DXF panel(s) to {}".format(written, outdir)

    def capture_view(self):
        """Fit the camera and return a PNG of the active viewport as image content blocks."""
        viewport = self.app.activeViewport
        if not viewport:
            raise RuntimeError("No active viewport to capture.")
        try:
            viewport.fit()
        except Exception:
            pass
        path = os.path.join(tempfile.gettempdir(), "claudecad_view.png")
        if not viewport.saveAsImageFile(path, 1024, 768):
            raise RuntimeError("Fusion could not export the viewport image.")
        with open(path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        try:
            os.remove(path)
        except Exception:
            pass
        return [
            {"type": "text", "text": "Current Fusion viewport:"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
        ]

    # -- session reset -------------------------------------------------------
    def reset(self):
        """Delete only the geometry ClaudeCad created (tagged via attributes), never the
        user's own work — even if they added geometry after the add-in started.

        We scan the timeline and remove only items whose entity carries the ClaudeCad
        ownership attribute, then delete the parameters we created. Deleting in reverse
        creation order means a feature is removed before anything it depends on.
        """
        design = self._design()
        timeline = design.timeline
        owned = []
        for i in range(timeline.count):
            try:
                entity = timeline.item(i).entity
                if entity and self._is_owned(entity):
                    owned.append(entity)
            except Exception:
                pass
        for entity in reversed(owned):
            try:
                entity.deleteMe()
            except Exception:
                pass
        for name in reversed(self._params):
            try:
                param = design.userParameters.itemByName(name)
                if param:
                    param.deleteMe()
            except Exception:
                pass
        self._params = []
        self._sketches = {}
        self._sketch_counter = 0
        self._last_feature = None
        self._last_body = None
        self._ops = []
        self._explode_state = None
        self._record_start()
