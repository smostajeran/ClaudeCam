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
    """Builds a USM structure in Fusion from the engine's real placement + meshes.

    Geometry is never fabricated: ``build_from_engine`` loads each placed part's
    real mesh (from ``/api/part-mesh``) as a Fusion mesh body at its pos/quat, and
    ``place_mesh`` does the same for a single catalogue part.
    """

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

    # -- real-mesh build (the only path: geometry from usm-engine) -----------
    def build_from_engine(self, placed, meshes, render=None):
        """Build a whole configuration from real engine meshes.

        ``placed`` = the engine placement (``usm.payload.placement_parts``); each
        part's real mesh (``usm.payload`` transformed) is loaded as a Fusion mesh
        body at its ``pos``/``quat``. ``meshes`` maps part id -> /api/part-mesh
        payload. Nothing is fabricated — parts with no mesh are skipped and
        reported. Returns a summary string.
        """
        from . import payload as payload_mod
        design = self._design()
        comp = design.rootComponent

        panel_rgb = None
        if render and render.get("color"):
            from .ui import COLORS
            panel_rgb = COLORS.get(render["color"], payload_mod.DEFAULT_PANEL_RGB)

        # (flat coords cm, triangles, rgb, name)
        jobs, missing = [], []
        for p in placed:
            mesh = meshes.get(p["part"])
            positions = (mesh or {}).get("positions") or []
            triangles = (mesh or {}).get("triangles") or []
            if not positions or not triangles:
                missing.append(p["part"])
                continue
            coords = payload_mod.transform_mesh(positions, p["quat"], p["pos"])
            frame = p["family"] in payload_mod.FRAME_FAMILIES
            jobs.append((coords, [int(i) for i in triangles],
                         payload_mod.rgb_for(p["family"], panel_rgb), p["label"], frame))

        if not jobs:
            return ("No meshes were built. The engine returned {} placed part(s) but no meshes "
                    "for them ({}).".format(len(placed), ", ".join(sorted(set(missing))) or "—"))

        built = self._add_mesh_bodies(design, comp, jobs)
        note = ""
        if missing:
            uniq = sorted(set(missing))
            note = "  ({} part(s) had no engine mesh: {})".format(
                len(missing), ", ".join(uniq[:6]) + ("…" if len(uniq) > 6 else ""))
        return "Built {} real part meshes from the engine.{}".format(built, note)

    def place_mesh(self, part, mesh, index=0, label=None, family=None, render=None):
        """Load one engine part mesh (from /api/part-mesh) into Fusion as a mesh body.

        Positions (metres, native axes) are mapped to Fusion cm (Z-up) and offset
        along X by ``index`` so successive placements don't overlap. No geometry
        is fabricated — if the payload has no triangles, nothing is built.
        """
        from . import payload as payload_mod
        positions = mesh.get("positions") or []
        triangles = mesh.get("triangles") or []
        if not positions or not triangles:
            return "The engine returned no mesh for '{}'.".format(part)

        coords = payload_mod.transform_mesh(positions, [0, 0, 0, 1], [0, 0, 0])
        ox = index * 80.0  # cm row offset along X
        for i in range(0, len(coords), 3):
            coords[i] += ox

        panel_rgb = None
        if render and render.get("color"):
            from .ui import COLORS
            panel_rgb = COLORS.get(render["color"], payload_mod.DEFAULT_PANEL_RGB)
        rgb = payload_mod.rgb_for(family, panel_rgb)
        frame = family in payload_mod.FRAME_FAMILIES
        name = label or part

        design = self._design()
        built = self._add_mesh_bodies(design, design.rootComponent,
                                      [(coords, [int(i) for i in triangles], rgb, name, frame)])
        if not built:
            return ("Could not load the mesh for '{}' (this Fusion version may not support "
                    "addByTriangleMeshData).".format(part))
        return "Placed {} — real mesh ({} triangles).".format(name, len(triangles) // 3)

    def _add_mesh_bodies(self, design, comp, jobs):
        """Add real mesh bodies for a list of (coords_cm, triangles, rgb, name, frame).
        Groups them in one base feature (parametric) for speed. Returns the count built."""
        try:
            parametric = design.designType == adsk.fusion.DesignTypes.ParametricDesignType
        except Exception:
            parametric = False

        created = []  # (body, rgb, name, frame)
        base = None
        if parametric:
            base = comp.features.baseFeatures.add()
            base.startEdit()
        try:
            for coords, tris, rgb, name, frame in jobs:
                try:
                    body = comp.meshBodies.addByTriangleMeshData(coords, tris, [], [])
                    body = body.item(0) if hasattr(body, "count") else body
                    created.append((body, rgb, name, frame))
                except Exception:
                    continue
        finally:
            if base is not None:
                base.finishEdit()
                self._own(base)

        for body, rgb, name, frame in created:
            try:
                body.name = name
            except Exception:
                pass
            self._own(body)
            self._apply_appearance(design, body, rgb, frame)
        if self.engine is not None:
            try:
                self.engine.set_material(0, "Steel", all_bodies=True)
            except Exception:
                pass
        return len(created)

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
