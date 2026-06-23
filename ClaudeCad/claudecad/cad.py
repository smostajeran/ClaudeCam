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

    def create_sketch(self, plane="xy", name=None):
        comp = self._comp()
        sketch = comp.sketches.add(self._plane(comp, plane))
        if name:
            sketch.name = name
        self._sketch_counter += 1
        sketch_id = "s{}".format(self._sketch_counter)
        self._sketches[sketch_id] = sketch
        return "Created sketch '{}' on the {} plane (id={}).".format(sketch.name, (plane or "xy").lower(), sketch_id)

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
    def extrude(self, sketch_id, distance, operation="new", profile_index=0):
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
        ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString(self._length(distance)))
        self._remember(comp.features.extrudeFeatures.add(ext_input))
        return "Extruded profile {} of {} by {} ({}).".format(profile_index, sketch_id, self._length(distance), operation)

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
