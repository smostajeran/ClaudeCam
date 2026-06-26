"""Materialise a USM geometry spec as solid bodies in the active Fusion design.

This module is the only USM Configurator code that touches Fusion (``adsk``). It
deliberately **reuses the proven CAD engine from the sibling ClaudeCad add-in**
rather than re-deriving the Fusion plumbing: ClaudeCad's :class:`CadBuilder`
gives us a battle-tested way to bind to the active document, the mm->cm unit
constant, ownership tagging (so a build can be cleanly removed), and physical
material assignment. We only add what ClaudeCad doesn't have — the procedural
ball/tube/panel lattice — which is built with Fusion's ``TemporaryBRepManager``
(exact world-space spheres, cylinders and boxes, with no sketch-plane
orientation guesswork) and committed through a single base feature.

If the ClaudeCad engine can't be found, the builder still works standalone with
local fallbacks; the engine simply makes the integration richer.
"""

import os
import sys

import adsk.core
import adsk.fusion

from . import geometry

_ATTR_GROUP = "UsmConfigurator"
_ATTR_NAME = "owned"


def _load_engine():
    """Import ClaudeCad's CAD engine (``claudecad.cad`` / ``claudecad.util``).

    Tries a plain import first, then locates a sibling ``ClaudeCad`` add-in
    folder (repo checkout or Fusion AddIns dir) and puts it on ``sys.path``.
    Returns ``(cad_module, util_module)`` or ``(None, None)``.
    """
    try:
        from claudecad import cad as cad_mod, util as util_mod
        return cad_mod, util_mod
    except Exception:
        pass
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # …/UsmConfigurator
    parent = os.path.dirname(here)
    for candidate in (os.path.join(parent, "ClaudeCad"),):
        if os.path.isdir(os.path.join(candidate, "claudecad")):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
            try:
                from claudecad import cad as cad_mod, util as util_mod
                return cad_mod, util_mod
            except Exception:
                continue
    return None, None


class UsmBuilder:
    """Builds a USM structure from a :func:`usm.geometry.build_spec` result."""

    def __init__(self, app):
        self.app = app
        cad_mod, util_mod = _load_engine()
        self.engine_available = cad_mod is not None
        self.MM = util_mod.MM if util_mod else 0.1  # mm -> cm (Fusion internal unit)
        # Reuse ClaudeCad's CadBuilder for material assignment + design binding.
        self.engine = cad_mod.CadBuilder(app) if cad_mod else None

    # -- design access -------------------------------------------------------
    def _design(self):
        design = adsk.fusion.Design.cast(self.app.activeProduct)
        if not design:
            raise RuntimeError("No active Fusion design. Open or create a design, then try again.")
        return design

    def _own(self, entity):
        """Tag an entity as USM-Configurator-created so a build can be removed cleanly."""
        try:
            if entity:
                entity.attributes.add(_ATTR_GROUP, _ATTR_NAME, "1")
        except Exception:
            pass
        return entity

    def _is_owned(self, entity):
        try:
            return entity.attributes.itemByName(_ATTR_GROUP, _ATTR_NAME) is not None
        except Exception:
            return False

    # -- temp BRep primitives (millimetres in, cm internally) ----------------
    def _pt(self, x, y, z):
        return adsk.core.Point3D.create(x * self.MM, y * self.MM, z * self.MM)

    def _sphere(self, tmgr, ball):
        c = self._pt(ball["x"], ball["y"], ball["z"])
        return tmgr.createSphere(c, (ball["diameter"] / 2.0) * self.MM)

    def _tube(self, tmgr, tube):
        p0 = self._pt(*tube["p0"])
        p1 = self._pt(*tube["p1"])
        r = (tube["diameter"] / 2.0) * self.MM
        return tmgr.createCylinderOrCone(p0, r, p1, r)

    def _panel_box(self, tmgr, panel):
        x0, y0, z0, x1, y1, z1 = panel["box"]
        center = self._pt((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0)
        length_dir = adsk.core.Vector3D.create(1.0, 0.0, 0.0)
        width_dir = adsk.core.Vector3D.create(0.0, 1.0, 0.0)
        obb = adsk.core.OrientedBoundingBox3D.create(
            center, length_dir, width_dir,
            max(x1 - x0, 1e-4) * self.MM,
            max(y1 - y0, 1e-4) * self.MM,
            max(z1 - z0, 1e-4) * self.MM)
        return tmgr.createBox(obb)

    # -- appearance (colour) -------------------------------------------------
    def _base_appearance(self, names):
        """Find a base appearance in any installed material library by name."""
        try:
            libs = self.app.materialLibraries
        except Exception:
            return None
        for i in range(libs.count):
            try:
                apprs = libs.item(i).appearances
            except Exception:
                continue
            for name in names:
                try:
                    found = apprs.itemByName(name)
                    if found:
                        return found
                except Exception:
                    continue
        return None

    def _appearance(self, design, name, rgb, base_names):
        """Get-or-create a design appearance named ``name`` coloured ``rgb``."""
        try:
            apps = design.appearances
            existing = apps.itemByName(name)
            if existing:
                return existing
            base = self._base_appearance(base_names)
            if not base:
                return None
            appr = apps.addByCopy(base, name)
            self._set_color(appr, rgb)
            return appr
        except Exception:
            return None

    @staticmethod
    def _set_color(appr, rgb):
        r, g, b = [max(0, min(255, int(v))) for v in rgb]
        color = adsk.core.Color.create(r, g, b, 255)
        for prop in appr.appearanceProperties:
            try:
                cp = adsk.core.ColorProperty.cast(prop)
                if cp:
                    cp.value = color
                    return
            except Exception:
                continue

    _CHROME_BASES = ["Chrome", "Chrome - Polished", "Steel - Satin",
                     "Aluminum - Polished", "Steel - Polished", "Metal"]
    _PANEL_BASES = ["Paint - Enamel Glossy (White)", "Powder Coat",
                    "Plastic - Matte (White)", "Paint", "Plastic"]

    def _apply_appearance(self, design, body, rgb, frame):
        try:
            if frame:
                appr = self._appearance(design, "USM Chrome", rgb, self._CHROME_BASES)
            else:
                key = "USM Panel {},{},{}".format(*[int(v) for v in rgb])
                appr = self._appearance(design, key, rgb, self._PANEL_BASES)
            if appr:
                body.appearance = appr
        except Exception:
            pass

    # -- build ---------------------------------------------------------------
    def build(self, spec, material=None):
        """Build the spec's balls, tubes and panels as bodies. Returns a summary string."""
        design = self._design()
        comp = design.rootComponent
        tmgr = adsk.fusion.TemporaryBRepManager.get()

        # (temp body, is_frame, rgb, name)
        queued = []
        for i, ball in enumerate(spec["balls"]):
            queued.append((self._sphere(tmgr, ball), True, geometry.CHROME_RGB, "Ball {}".format(i + 1)))
        for i, tube in enumerate(spec["tubes"]):
            if tube["length"] <= 1e-6:
                continue
            queued.append((self._tube(tmgr, tube), True, geometry.CHROME_RGB,
                           "Tube {} ({:g}mm)".format(i + 1, tube["length"])))
        for i, panel in enumerate(spec["panels"]):
            rgb = geometry.COLORS.get(panel.get("color"), geometry.COLORS[geometry.DEFAULT_COLOR])
            queued.append((self._panel_box(tmgr, panel), False, rgb,
                           "Panel {} ({})".format(i + 1, panel.get("face", ""))))

        self._commit(design, comp, queued, material)
        n_frame = sum(1 for _, f, _, _ in queued if f)
        n_panel = len(queued) - n_frame
        return "{}\n\nBuilt {} frame bodies (balls + tubes) and {} panel(s).{}".format(
            geometry.summary_text(spec), n_frame, n_panel,
            "" if self.engine_available else
            "\n(Note: ClaudeCad engine not found — built standalone; materials best-effort.)")

    # -- engine-payload build (the live path: geometry from usm-engine) -------
    def build_payload(self, parsed, material=None):
        """Build the parts in a parsed usm-engine payload (see :mod:`usm.payload`).

        ``parsed['primitives']`` carry coordinates already in Fusion centimetres,
        so they are drawn directly — the engine, not this add-in, decided the
        geometry. Returns a summary string (incl. any conflicts the engine flagged).
        """
        from . import payload as payload_mod
        design = self._design()
        comp = design.rootComponent
        tmgr = adsk.fusion.TemporaryBRepManager.get()

        queued = []  # (temp body, is_frame, rgb, name)
        for i, prim in enumerate(parsed.get("primitives", [])):
            temp = self._primitive(tmgr, prim)
            if temp is None:
                continue
            name = "{} {}".format(prim.get("label") or prim.get("kind"), i + 1)
            queued.append((temp, bool(prim.get("frame")), tuple(prim.get("rgb", payload_mod.CHROME_RGB)), name))

        if not queued:
            return "The engine returned no buildable parts for this configuration."
        self._commit(design, comp, queued, material)
        return payload_mod.summary_text(parsed) + (
            "" if self.engine_available else
            "\n(ClaudeCad engine not found — materials best-effort.)")

    def _primitive(self, tmgr, prim):
        """Build one temp BRep body from a payload primitive (cm coordinates)."""
        try:
            kind = prim.get("kind")
            if kind == "sphere":
                return tmgr.createSphere(self._cm(prim["center"]), prim["radius_cm"])
            if kind == "cylinder":
                p0, p1 = self._cm(prim["p0"]), self._cm(prim["p1"])
                if p0.distanceTo(p1) < 1e-6:
                    return None
                return tmgr.createCylinderOrCone(p0, prim["radius_cm"], p1, prim["radius_cm"])
            if kind == "panel":
                return self._panel_from_corners(tmgr, prim["corners"], prim["thickness_cm"])
            if kind == "box":
                cx, cy, cz = prim["center"]
                dx, dy, dz = prim["size"]
                obb = adsk.core.OrientedBoundingBox3D.create(
                    adsk.core.Point3D.create(cx, cy, cz),
                    adsk.core.Vector3D.create(1, 0, 0), adsk.core.Vector3D.create(0, 1, 0),
                    max(dx, 1e-3), max(dy, 1e-3), max(dz, 1e-3))
                return tmgr.createBox(obb)
        except Exception:
            return None
        return None

    # Frame families are chrome; everything else takes the chosen panel colour.
    _FRAME_FAMILIES = {"connector", "tube", "support", "fitting", "hardware"}

    def place_mesh(self, part, mesh, index=0, label=None, family=None, render=None):
        """Load the engine's REAL part mesh (metres) into Fusion as a mesh body.

        ``mesh`` is the ``/api/part-mesh`` payload. Positions are scaled m->cm and
        offset along X by ``index`` so successive placements don't overlap. No
        geometry is fabricated — if the payload has no triangles, nothing is built.
        """
        from . import payload as payload_mod
        positions = mesh.get("positions") or []
        triangles = mesh.get("triangles") or []
        if not positions or not triangles:
            return "The engine returned no mesh for '{}'.".format(part)

        scale = 100.0  # metres -> centimetres (Fusion internal unit)
        ox = index * 80.0
        coords = []
        for v in positions:
            coords.append(float(v[0]) * scale + ox)
            coords.append(float(v[1]) * scale)
            coords.append(float(v[2]) * scale)
        tris = [int(i) for i in triangles]

        design = self._design()
        comp = design.rootComponent
        body = self._add_mesh_body(design, comp, coords, tris)
        if body is None:
            return ("Could not load the mesh for '{}' (this Fusion version may not support "
                    "addByTriangleMeshData).".format(part))

        name = label or part
        try:
            body.name = name
        except Exception:
            pass
        self._own(body)
        frame = (family in self._FRAME_FAMILIES)
        rgb = payload_mod.CHROME_RGB
        if not frame and render and render.get("color"):
            from .ui import COLORS
            rgb = COLORS.get(render["color"], payload_mod.DEFAULT_PANEL_RGB)
        self._apply_appearance(design, body, rgb, frame)
        if self.engine is not None:
            try:
                self.engine.set_material(0, "Steel", all_bodies=True)
            except Exception:
                pass
        return "Placed {} — real mesh ({} triangles).".format(name, len(tris) // 3)

    def _add_mesh_body(self, design, comp, coords, tris):
        """Create a real mesh body from flat coordinates (cm) + triangle indices."""
        try:
            parametric = design.designType == adsk.fusion.DesignTypes.ParametricDesignType
        except Exception:
            parametric = False
        try:
            if parametric:
                base = comp.features.baseFeatures.add()
                base.startEdit()
                try:
                    body = comp.meshBodies.addByTriangleMeshData(coords, tris, [], [])
                finally:
                    base.finishEdit()
                self._own(base)
            else:
                body = comp.meshBodies.addByTriangleMeshData(coords, tris, [], [])
            # Some API versions return a list-like; normalise to a single body.
            try:
                return body.item(0) if hasattr(body, "count") else body
            except Exception:
                return body
        except Exception:
            return None

    def place_part(self, part, family, dims, index=0, render=None):
        """Place a single catalogue part as a sized primitive. Returns a summary string."""
        from . import payload as payload_mod
        opts = {}
        if render and render.get("color"):
            from .ui import COLORS  # render colour lookup lives with the palette config
            opts["panel_rgb"] = COLORS.get(render["color"], payload_mod.DEFAULT_PANEL_RGB)
        prim = payload_mod.catalog_primitive(part, family, dims, index, opts)
        temp = self._primitive(adsk.fusion.TemporaryBRepManager.get(), prim)
        if temp is None:
            return "Could not build a primitive for '{}'.".format(part)
        design = self._design()
        name = prim.get("label") or part
        self._commit(design, design.rootComponent,
                     [(temp, bool(prim.get("frame")), tuple(prim.get("rgb", payload_mod.CHROME_RGB)), name)])
        return "Placed {}.".format(name)

    @staticmethod
    def _cm(p):
        return adsk.core.Point3D.create(p[0], p[1], p[2])

    def _panel_from_corners(self, tmgr, corners, thickness_cm):
        """A thin box spanning the 4 quad corners (cm), thickness along the face normal."""
        c0, c1, _c2, c3 = [self._cm(c) for c in corners[:4]]
        e1 = c0.vectorTo(c1)   # length edge
        e2 = c0.vectorTo(c3)   # width edge
        ln, wd = e1.length, e2.length
        if ln < 1e-6 or wd < 1e-6:
            return None
        e1.normalize(); e2.normalize()
        center = adsk.core.Point3D.create(
            (corners[0][0] + corners[2][0]) / 2.0,
            (corners[0][1] + corners[2][1]) / 2.0,
            (corners[0][2] + corners[2][2]) / 2.0)
        obb = adsk.core.OrientedBoundingBox3D.create(center, e1, e2, ln, wd, max(thickness_cm, 1e-3))
        return tmgr.createBox(obb)

    def _commit(self, design, comp, queued, material=None):
        """Commit queued temp bodies (base feature in parametric, direct add otherwise),
        then name, tag and colour them. Shared by both build paths."""
        parametric = False
        try:
            parametric = design.designType == adsk.fusion.DesignTypes.ParametricDesignType
        except Exception:
            pass

        created = []
        if parametric:
            base = comp.features.baseFeatures.add()
            base.startEdit()
            try:
                for temp, frame, rgb, name in queued:
                    created.append((comp.bRepBodies.add(temp, base), frame, rgb, name))
            finally:
                base.finishEdit()
            self._own(base)
        else:
            for temp, frame, rgb, name in queued:
                created.append((comp.bRepBodies.add(temp), frame, rgb, name))

        for body, frame, rgb, name in created:
            try:
                body.name = name
            except Exception:
                pass
            self._own(body)
            self._apply_appearance(design, body, rgb, frame)

        if self.engine is not None:
            try:
                self.engine.set_material(0, material or "Steel", all_bodies=True)
            except Exception:
                pass
        return created

    def clear(self):
        """Remove everything this add-in created in the active design (tagged bodies/features)."""
        design = self._design()
        timeline = None
        try:
            timeline = design.timeline
        except Exception:
            pass
        removed = 0
        if timeline:
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
                    removed += 1
                except Exception:
                    pass
        # Direct-design bodies (no timeline) — sweep the component too.
        try:
            comp = design.rootComponent
            for i in range(comp.bRepBodies.count - 1, -1, -1):
                body = comp.bRepBodies.item(i)
                if self._is_owned(body):
                    body.deleteMe()
                    removed += 1
        except Exception:
            pass
        return "Removed {} USM body/bodies from the design.".format(removed)
