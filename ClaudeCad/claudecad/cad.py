"""CAD operations against the active Fusion 360 design.

Every method here must be called on Fusion's main thread (the dispatcher guarantees
that). Tool inputs use millimetres; Fusion's internal unit is centimetres, so lengths
are scaled by :data:`MM`. The builder tracks everything it creates during a session so
the user can discard the work and start fresh.
"""

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
        self._start_marker = 0
        self._record_start()

    # -- internals -----------------------------------------------------------
    def _design(self):
        design = adsk.fusion.Design.cast(self.app.activeProduct)
        if not design:
            raise RuntimeError("No active Fusion design. Open or create a design, then try again.")
        return design

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

    def _sketch(self, sketch_id):
        sk = self._sketches.get(sketch_id)
        if not sk:
            raise ValueError("Unknown sketch id '{}'. Create one with create_sketch first.".format(sketch_id))
        return sk

    @staticmethod
    def _pt(x_mm, y_mm):
        return adsk.core.Point3D.create(x_mm * MM, y_mm * MM, 0.0)

    # -- tools ---------------------------------------------------------------
    def create_parameter(self, name, expression, unit="mm", comment=""):
        design = self._design()
        value = adsk.core.ValueInput.createByString(expression)
        design.userParameters.add(name, value, unit or "mm", comment or "")
        if name not in self._params:
            self._params.append(name)
        return "Created parameter {} = {} ({}).".format(name, expression, unit or "mm")

    def create_sketch(self, plane="xy", name=None):
        comp = self._design().rootComponent
        sketch = comp.sketches.add(self._plane(comp, plane))
        if name:
            sketch.name = name
        self._sketch_counter += 1
        sketch_id = "s{}".format(self._sketch_counter)
        self._sketches[sketch_id] = sketch
        return "Created sketch '{}' on the {} plane (id={}).".format(sketch.name, (plane or "xy").lower(), sketch_id)

    def draw_rectangle(self, sketch_id, width, height, center_x=0.0, center_y=0.0):
        sketch = self._sketch(sketch_id)
        p1 = self._pt(center_x - width / 2.0, center_y - height / 2.0)
        p2 = self._pt(center_x + width / 2.0, center_y + height / 2.0)
        sketch.sketchCurves.sketchLines.addTwoPointRectangle(p1, p2)
        return "Drew a {:g}x{:g} mm rectangle in {}. It has {} profile(s).".format(
            width, height, sketch_id, sketch.profiles.count
        )

    def draw_circle(self, sketch_id, radius, center_x=0.0, center_y=0.0):
        sketch = self._sketch(sketch_id)
        sketch.sketchCurves.sketchCircles.addByCenterRadius(self._pt(center_x, center_y), radius * MM)
        return "Drew a circle r={:g} mm in {}. It has {} profile(s).".format(radius, sketch_id, sketch.profiles.count)

    def draw_line(self, sketch_id, x1, y1, x2, y2):
        sketch = self._sketch(sketch_id)
        sketch.sketchCurves.sketchLines.addByTwoPoints(self._pt(x1, y1), self._pt(x2, y2))
        return "Drew a line in {} from ({:g},{:g}) to ({:g},{:g}) mm.".format(sketch_id, x1, y1, x2, y2)

    def extrude(self, sketch_id, distance, operation="new", profile_index=0):
        sketch = self._sketch(sketch_id)
        if sketch.profiles.count == 0:
            raise RuntimeError("Sketch {} has no closed profile to extrude.".format(sketch_id))
        if profile_index < 0 or profile_index >= sketch.profiles.count:
            raise ValueError("profile_index {} out of range (sketch has {}).".format(profile_index, sketch.profiles.count))

        op = _OPERATIONS.get((operation or "new").lower())
        if op is None:
            raise ValueError("Unknown operation '{}'. Use new, join, cut or intersect.".format(operation))

        comp = self._design().rootComponent
        profile = sketch.profiles.item(profile_index)
        ext_input = comp.features.extrudeFeatures.createInput(profile, op)
        ext_input.setDistanceExtent(False, adsk.core.ValueInput.createByString(str(distance)))
        comp.features.extrudeFeatures.add(ext_input)
        return "Extruded profile {} of {} by {} ({}).".format(profile_index, sketch_id, distance, operation)

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
        self._record_start()
