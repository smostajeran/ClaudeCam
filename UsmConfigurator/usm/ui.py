"""Fusion palette + command wiring for the USM Configurator.

A single command (button in Utilities > Add-Ins) toggles an HTML **palette** — the
USM Haller configurator: pick the bay widths/heights/depth and per-cell content,
then Build. The palette posts a **Path P** configuration to Fusion, which calls
the deployed **usm-engine** (`/api/build`) for the geometry + validation
(:mod:`usm.engine_client`), maps the returned one52 payload to primitives
(:mod:`usm.payload`) and builds them (:mod:`usm.builder`).

The engine is the source of truth; this add-in renders its IP-safe payload.
"""

import json
import threading
import traceback

import adsk.core

from . import config
from . import engine_client
from . import payload as payload_mod

# Engine vocabulary (mirrors usm-engine build_frame.ts: WIDTH_VOCAB / DEPTH_DOMAIN
# and the per-cell content families whose component types are source-verified).
WIDTH_VOCAB = [175, 250, 350, 395, 500, 750]
DEPTH_DOMAIN = [250, 350, 500]
CELL_TYPES = [
    {"id": "open", "name": "Open"},
    {"id": "closed", "name": "Closed box"},
    {"id": "shelf", "name": "Shelf"},
    {"id": "pullout", "name": "Pull-out"},
    {"id": "door", "name": "Door"},
    {"id": "glass", "name": "Glass"},
    {"id": "panel", "name": "Back panel"},
]
COLORS = {
    "USM Matte Silver": (188, 190, 192), "USM Light Gray": (200, 201, 199),
    "USM Pure White": (236, 236, 233), "USM Anthracite": (61, 62, 64),
    "USM Graphite Black": (42, 42, 44), "USM Steel Blue": (74, 96, 122),
    "USM Gentian Blue": (38, 64, 116), "USM Green": (92, 117, 86),
    "USM Golden Yellow": (240, 196, 78), "USM Pure Orange": (224, 106, 40),
    "USM Ruby Red": (151, 36, 44), "USM Beige": (212, 201, 175), "USM Brown": (92, 66, 54),
}


class UsmConfiguratorUI:
    def __init__(self, app, ui):
        self.app = app
        self.ui = ui
        self.palette = None
        self._handlers = []
        self._placed = 0  # catalogue parts placed this session (row offset)

    # -- setup / teardown ----------------------------------------------------
    def setup(self):
        cmd_defs = self.ui.commandDefinitions
        cmd_def = cmd_defs.itemById(config.CMD_ID)
        if not cmd_def:
            cmd_def = cmd_defs.addButtonDefinition(config.CMD_ID, config.CMD_NAME, config.CMD_TOOLTIP)

        created = _CommandCreatedHandler(self)
        cmd_def.commandCreated.add(created)
        self._handlers.append(created)

        panel = self.ui.allToolbarPanels.itemById(config.PANEL_ID)
        if panel and not panel.controls.itemById(config.CMD_ID):
            panel.controls.addCommand(cmd_def)

        self.show_palette()

    def teardown(self):
        for delete in (
            lambda: self.palette and self.palette.deleteMe(),
            lambda: self._del_control(),
            lambda: self._del_cmd(),
        ):
            try:
                delete()
            except Exception:
                pass
        self.palette = None

    def _del_control(self):
        panel = self.ui.allToolbarPanels.itemById(config.PANEL_ID)
        if panel:
            ctrl = panel.controls.itemById(config.CMD_ID)
            if ctrl:
                ctrl.deleteMe()

    def _del_cmd(self):
        cmd_def = self.ui.commandDefinitions.itemById(config.CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()

    def show_palette(self):
        self.palette = self.ui.palettes.itemById(config.PALETTE_ID)
        if not self.palette:
            self.palette = self.ui.palettes.add(
                config.PALETTE_ID, config.PALETTE_NAME, config.PALETTE_HTML,
                True, True, True, 300, 600,
            )
            self.palette.dockingState = adsk.core.PaletteDockingStates.PaletteDockStateRight
            incoming = _IncomingHandler(self)
            self.palette.incomingFromHTML.add(incoming)
            self._handlers.append(incoming)
        else:
            self.palette.isVisible = True

    # -- HTML bridge ---------------------------------------------------------
    def on_html_event(self, action, raw_data):
        try:
            data = json.loads(raw_data) if raw_data else {}
        except Exception:
            data = {}

        if action == "ready":
            self._send_config()
        elif action == "build":
            self._build(data)
        elif action == "clear":
            self._clear()
        elif action == "save_settings":
            self._save_settings(data)
        elif action == "check_engine":
            self._check_engine()
        elif action == "load_catalog":
            self._load_catalog()
        elif action == "place_part":
            self._place_part(data)

    def _send_config(self):
        if not self.palette:
            return
        self.palette.sendInfoToHTML("config", json.dumps({
            "colors": COLORS,
            "widths": WIDTH_VOCAB,
            "depths": DEPTH_DOMAIN,
            "cellTypes": CELL_TYPES,
            "engineUrl": config.get_engine_url(),
            "engineUser": config.get_engine_user(),
            "version": config.get_version(),
        }))

    def _result(self, text, level="info"):
        if self.palette:
            self.palette.sendInfoToHTML("result", json.dumps({"text": text, "level": level}))

    def _build(self, data):
        """Path P -> engine /api/build -> payload -> Fusion bodies. Network runs off
        the main thread; the build itself is marshalled back on (Fusion is main-thread only)."""
        path_p = data.get("path_p") or {}
        render = data.get("render") or {}

        def work():
            try:
                payload = engine_client.build(path_p)
            except engine_client.EngineError as exc:
                self._result(str(exc), "error")
                return
            except Exception as exc:  # noqa: BLE001
                self._result("Build failed: {}".format(exc), "error")
                return
            parsed = payload_mod.parse(payload, {
                "panel_rgb": COLORS.get(render.get("color"), payload_mod.DEFAULT_PANEL_RGB),
            })

            def do_build():
                try:
                    from .builder import UsmBuilder
                    summary = UsmBuilder(self.app).build_payload(parsed)
                    self._result(summary, "ok")
                except Exception:
                    self._result("Build failed in Fusion:\n{}".format(traceback.format_exc()), "error")

            self._on_main(do_build)

        threading.Thread(target=work, daemon=True).start()

    def _clear(self):
        def do():
            try:
                from .builder import UsmBuilder
                self._placed = 0
                self._result(UsmBuilder(self.app).clear(), "ok")
            except Exception as exc:  # noqa: BLE001
                self._result("Clear failed: {}".format(exc), "error")
        self._on_main(do)

    def _place_part(self, data):
        """Place one catalogue part by loading its REAL mesh from the engine.

        Fetches /api/part-mesh off the main thread, then builds the mesh body on
        it. No geometry is fabricated — if the engine has no mesh, we say so.
        """
        index = self._placed
        part = data.get("part")
        label = data.get("label")
        family = data.get("family")
        render = data.get("render")

        def work():
            try:
                mesh = engine_client.part_mesh(part)
            except engine_client.EngineError as exc:
                self._result("No mesh for {} — {}".format(label or part, exc), "error")
                return
            self._placed += 1

            def do():
                try:
                    from .builder import UsmBuilder
                    self._result(UsmBuilder(self.app).place_mesh(part, mesh, index, label, family, render), "ok")
                except Exception:
                    self._result("Place failed in Fusion:\n{}".format(traceback.format_exc()), "error")
            self._on_main(do)

        threading.Thread(target=work, daemon=True).start()

    def _save_settings(self, data):
        try:
            config.save_engine_settings(url=data.get("engine_url"),
                                        user=data.get("engine_user"),
                                        password=data.get("engine_password"))
            self._send_config()
            self._result("Engine settings saved.", "ok")
        except Exception as exc:  # noqa: BLE001
            self._result("Could not save settings: {}".format(exc), "error")

    def _load_catalog(self):
        """Load the engine's IP-safe part catalogue and push it to the palette."""
        def work():
            try:
                cat = engine_client.catalog()
            except engine_client.EngineError as exc:
                self._result(str(exc), "error")
                return
            parts = [{"part": p.get("part"), "label": p.get("label"),
                      "family": p.get("family"), "dims": p.get("dims") or []}
                     for p in (cat.get("parts") or []) if p.get("part")]
            if self.palette:
                self.palette.sendInfoToHTML("catalog", json.dumps({"parts": parts}))
            self._result("Loaded {} catalogue parts.".format(len(parts)), "ok")
        threading.Thread(target=work, daemon=True).start()

    def _check_engine(self):
        def work():
            try:
                h = engine_client.health()
            except engine_client.EngineError as exc:
                self._result(str(exc), "error")
                return
            if not h.get("auth"):
                self._result("Engine reachable (local/open — no sign-in needed).", "ok")
                return
            # Auth is enforced — verify the username/password by signing in.
            if not (config.get_engine_user() and config.get_engine_password()):
                self._result("Engine reachable but requires sign-in. Enter your username/password "
                             "and Save.", "error")
                return
            try:
                engine_client.login()
                self._result("Engine reachable and signed in OK.", "ok")
            except engine_client.EngineError as exc:
                self._result(str(exc), "error")
        threading.Thread(target=work, daemon=True).start()

    def _on_main(self, fn):
        """Run a callable on Fusion's main thread (CAD/UI are main-thread only).

        Uses a custom event so a background worker can safely trigger geometry.
        """
        try:
            event_id = "usmConfiguratorRun"
            ev = self.app.registerCustomEvent(event_id)
            handler = _RunOnceHandler(fn, event_id, self.app)
            ev.add(handler)
            self._handlers.append(handler)
            self.app.fireCustomEvent(event_id)
        except Exception:
            # Fall back to running inline (already on main thread, e.g. clear()).
            try:
                fn()
            except Exception:
                pass


# -- Fusion handlers ---------------------------------------------------------
class _CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def notify(self, args):
        try:
            self.owner.show_palette()
        except Exception:
            if self.owner.ui:
                self.owner.ui.messageBox("USM Configurator failed:\n{}".format(traceback.format_exc()))


class _IncomingHandler(adsk.core.HTMLEventHandler):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def notify(self, args):
        try:
            self.owner.on_html_event(args.action, args.data)
        except Exception:
            if self.owner.ui:
                self.owner.ui.messageBox("USM Configurator event error:\n{}".format(traceback.format_exc()))


class _RunOnceHandler(adsk.core.CustomEventHandler):
    """Runs a callable once on the main thread, then unregisters its event."""
    def __init__(self, fn, event_id, app):
        super().__init__()
        self.fn = fn
        self.event_id = event_id
        self.app = app

    def notify(self, args):
        try:
            self.fn()
        finally:
            try:
                self.app.unregisterCustomEvent(self.event_id)
            except Exception:
                pass
