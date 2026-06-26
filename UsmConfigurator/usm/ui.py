"""Fusion palette + command wiring for the USM Configurator.

A single command (button in Utilities > Add-Ins) toggles an HTML **palette** — a
visual USM Haller configurator: pick a base form, a width/depth module, the
number of columns/rows, which components fill the bays (back / shelf / divider /
door) and a colour, then Build. The palette posts its configuration to Fusion,
which computes the geometry (:mod:`usm.geometry`) and builds it
(:mod:`usm.builder`).

Palette events are delivered on Fusion's main thread, so the builder is called
directly from the event handler — no background marshalling needed.
"""

import json
import traceback

import adsk.core

from . import config
from . import geometry


class UsmConfiguratorUI:
    def __init__(self, app, ui):
        self.app = app
        self.ui = ui
        self.palette = None
        self._handlers = []  # keep handler refs alive

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
        try:
            if self.palette:
                self.palette.deleteMe()
                self.palette = None
        except Exception:
            pass
        try:
            panel = self.ui.allToolbarPanels.itemById(config.PANEL_ID)
            if panel:
                ctrl = panel.controls.itemById(config.CMD_ID)
                if ctrl:
                    ctrl.deleteMe()
        except Exception:
            pass
        try:
            cmd_def = self.ui.commandDefinitions.itemById(config.CMD_ID)
            if cmd_def:
                cmd_def.deleteMe()
        except Exception:
            pass

    def show_palette(self):
        self.palette = self.ui.palettes.itemById(config.PALETTE_ID)
        if not self.palette:
            self.palette = self.ui.palettes.add(
                config.PALETTE_ID, config.PALETTE_NAME, config.PALETTE_HTML,
                True, True, True, 300, 560,
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

    def _send_config(self):
        if not self.palette:
            return
        self.palette.sendInfoToHTML("config", json.dumps({
            "colors": geometry.COLORS,
            "presets": self._preset_list(),
            "version": config.get_version(),
        }))

    @staticmethod
    def _preset_list():
        from . import presets
        out = []
        for e in presets.list_presets():
            out.append({k: e.get(k) for k in
                        ("id", "name", "columns", "rows", "depths",
                         "back_panels", "shelves", "dividers", "color")})
        return out

    def _result(self, text):
        if self.palette:
            self.palette.sendInfoToHTML("result", json.dumps({"text": text}))

    def _build(self, data):
        try:
            columns = [float(c) for c in (data.get("columns") or [])]
            rows = [float(r) for r in (data.get("rows") or [])]
            depths = [float(d) for d in (data.get("depths") or [])] or None
            options = data.get("options") or {}
            spec = geometry.build_spec(columns, rows, depths, options)
            from .builder import UsmBuilder
            summary = UsmBuilder(self.app).build(spec)
            self._result(summary)
        except Exception as exc:
            self._result("Build failed: {}".format(exc))
            if self.ui:
                self.ui.messageBox("USM Configurator failed to build:\n{}".format(traceback.format_exc()))

    def _clear(self):
        try:
            from .builder import UsmBuilder
            self._result(UsmBuilder(self.app).clear())
        except Exception as exc:
            self._result("Clear failed: {}".format(exc))


# -- Fusion handlers ---------------------------------------------------------
class _CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    """The toolbar button: show the palette, then cancel the command (no dialog)."""
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
