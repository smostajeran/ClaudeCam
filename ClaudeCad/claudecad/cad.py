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

import adsk.core
import adsk.fusion

MM = 0.1  # millimetres -> centimetres (Fusion internal units)

_OPERATIONS = {
    "new": adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
    "join": adsk.fusion.FeatureOperations.JoinFeatureOperation,
    "cut": adsk.fusion.FeatureOperations.CutFeatureOperation,
    "intersect": adsk.fusion.FeatureOperations.IntersectFeatureOperation,
}


class CadBuilder:
    def __init__(self, app):
        self.app = app
        self._sketches = {}
        self._sketch_counter = 0
        self._params = []
        self._last_feature = None
        self._last_body = None
        self._start_marker = 0
        self._record_start()

    # -- internals -----------------------------------------------------------
    def _design(self):
        design = adsk.fusion.Design.cast(self.app.activeProduct)
        if not design:
            raise RuntimeError("No active Fusion design. Open or create a design, then try again.")
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
        value = adsk.core.ValueInput.createByString(expression)
        design.userParameters.add(name, value, unit or "mm", comment or "")
        if name not in self._params:
            self._params.append(name)
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
            target = comp.constructionPlanes.add(plane_input)
            offset_note = ", offset {} from the {} plane".format(off_expr, (plane or "xy").lower())

        sketch = comp.sketches.add(target)
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
    def extrude(self, sketch_id, distance, operation="new", profile_index=0, symmetric=False, start_offset=None):
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

        extras = []
        if symmetric:
            extras.append("symmetric")
        if has_offset:
            extras.append("start offset {}".format(self._length(start_offset)))
        suffix = (", " + ", ".join(extras)) if extras else ""
        return "Extruded profile {} of {} by {} ({}{}).".format(
            profile_index, sketch_id, self._length(distance), operation, suffix
        )

    def revolve(self, sketch_id, axis="z", angle=360, operation="new", profile_index=0):
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
                if plane.normal.z <= 0.5:  # roughly upward-facing
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
                params.append("{} = {} ({:.3g} {})".format(p.name, p.expression, self._mm(p.value), "mm"))
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
            lines.append(
                "  [{}] '{}' — size {:.1f} x {:.1f} x {:.1f} mm, faces {}, edges {}{}, visible {}".format(
                    i, b.name, dx, dy, dz, b.faces.count, b.edges.count, vol, b.isVisible
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
            if kind == "plane":
                try:
                    n = adsk.core.Plane.cast(f.geometry).normal
                    normal = " normal ({:.2f}, {:.2f}, {:.2f})".format(n.x, n.y, n.z)
                except Exception:
                    pass
            try:
                area = " area {:.1f} mm^2".format(f.area / (MM * MM))
            except Exception:
                area = ""
            rows.append("  [{}] {}{} at {} mm{}".format(i, kind, area, loc, normal))
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
        return "Set parameter {} = {} (now {:.3g} mm).".format(name, expression, self._mm(param.value))

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
        comp = self._comp()
        body = self._brep_body(body_index)
        if face_index < 0 or face_index >= body.faces.count:
            raise ValueError("face_index {} out of range (body has {} faces).".format(face_index, body.faces.count))
        face = body.faces.item(face_index)
        if not adsk.core.Plane.cast(face.geometry):
            raise RuntimeError("Face [{}] is not planar; cut_hole needs a flat face.".format(face_index))

        sketch = comp.sketches.add(face)
        center_sketch = sketch.modelToSketchSpace(face.pointOnFace)
        center = adsk.core.Point3D.create(
            center_sketch.x + float(x_offset) * MM, center_sketch.y + float(y_offset) * MM, 0.0
        )
        r_expr, r_mm = self._resolve(diameter, default_seed=10.0)
        sketch.sketchCurves.sketchCircles.addByCenterRadius(center, (r_mm / 2.0) * MM)

        profile = sketch.profiles.item(0)
        ext = comp.features.extrudeFeatures
        ext_input = ext.createInput(profile, adsk.fusion.FeatureOperations.CutFeatureOperation)
        if depth is not None and not (isinstance(depth, (int, float)) and float(depth) == 0.0):
            # negative distance cuts into the body (opposite the outward face normal)
            ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString("-(" + self._length(depth) + ")"))
        else:
            ext_input.setAllExtent(adsk.fusion.ExtentDirections.NegativeExtentDirection)
        self._remember(ext.add(ext_input))
        depth_note = self._length(depth) if depth else "through all"
        return "Cut a {:g} mm hole through face [{}] of body [{}] ({}).".format(r_mm, face_index, body_index, depth_note)

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

    def move_body(self, body_index, dx=0.0, dy=0.0, dz=0.0):
        comp = self._comp()
        body = self._brep_body(body_index)
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
        moves.add(move_input)
        return "Moved body [{}] by ({:g}, {:g}, {:g}) mm.".format(body_index, float(dx), float(dy), float(dz))

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
        ext = {"step": ".step", "stp": ".step", "stl": ".stl", "iges": ".igs", "igs": ".igs", "f3d": ".f3d"}.get(fmt)
        if not ext:
            raise ValueError("Unsupported format '{}'. Use step, stl, iges or f3d.".format(fmt))
        name = (filename or "claudecad_export").rsplit(".", 1)[0]
        path = os.path.join(os.path.expanduser("~"), name + ext)

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
            raise RuntimeError("There are no mesh bodies to convert.")
        if mesh_index < 0 or mesh_index >= meshes.count:
            raise ValueError("mesh_index {} out of range ({} mesh bodies).".format(mesh_index, meshes.count))
        feats = getattr(comp.features, "meshToBRepFeatures", None)
        if not feats:
            raise RuntimeError(
                "Mesh-to-solid conversion isn't exposed by the Fusion API in this version. "
                "Workaround: in Fusion, use the Mesh tab > BRep Conversion, then I can edit the result."
            )
        col = adsk.core.ObjectCollection.create()
        col.add(meshes.item(mesh_index))
        feats.add(feats.createInput(col))
        self._record_start()  # body set changed
        return "Converted mesh [{}] to a solid body.".format(mesh_index)

    def add_thread(self, body_index, face_index, internal=True):
        comp = self._comp()
        body = self._brep_body(body_index)
        if face_index < 0 or face_index >= body.faces.count:
            raise ValueError("face_index {} out of range.".format(face_index))
        face = body.faces.item(face_index)
        cyl = adsk.core.Cylinder.cast(face.geometry)
        if not cyl:
            raise RuntimeError("Face [{}] is not cylindrical; threads need a cylindrical face.".format(face_index))

        threads = comp.features.threadFeatures
        query = threads.threadDataQuery
        thread_type = query.defaultMetricThreadType
        diameter_cm = cyl.radius * 2.0
        rec = query.recommendedThreadData(diameter_cm, internal, thread_type)
        # rec: (bool ok, threadSize, threadDesignation, threadClass)
        if not rec or not rec[0]:
            raise RuntimeError("No standard thread recommendation for this diameter.")
        info = threads.createThreadInfo(internal, thread_type, rec[2], rec[3])
        faces = adsk.core.ObjectCollection.create()
        faces.add(face)
        tin = threads.createInput(faces, info)
        tin.isModeled = True
        self._remember(threads.add(tin))
        return "Added a modeled {} thread ({}) to face [{}].".format(
            "internal" if internal else "external", rec[2], face_index
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

    def set_material(self, body_index, name):
        body = self._brep_body(body_index)
        libs = self.app.materialLibraries
        target = None
        for i in range(libs.count):
            mats = libs.item(i).materials
            for j in range(mats.count):
                m = mats.item(j)
                if name.lower() in m.name.lower():
                    target = m
                    break
            if target:
                break
        if not target:
            raise ValueError("No material matching '{}' found in the material libraries.".format(name))
        body.material = target
        return "Set body [{}] material to '{}'.".format(body_index, target.name)

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
        """Delete everything created this session (timeline features + parameters)."""
        design = self._design()
        timeline = design.timeline
        for i in range(timeline.count - 1, self._start_marker - 1, -1):
            try:
                timeline.item(i).deleteMe()
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
        self._record_start()
