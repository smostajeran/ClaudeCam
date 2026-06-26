"""Fusion command + dialog wiring for the USM Configurator.

A single command (button in Utilities > Add-Ins) opens a dialog where the user
configures the structure — bays wide/tall/deep, cell sizes, the chrome ball/tube
diameters, and which bays carry panels (and their colour) — or picks a preset.
On OK it computes the geometry (:mod:`usm.geometry`) and builds it
(:mod:`usm.builder`).
"""

import traceback

import adsk.core

from . import config
from . import geometry
from . import presets


# -- input ids ---------------------------------------------------------------
_PRESET = "usm_preset"
_COLS = "usm_cols"
_COL_W = "usm_col_w"
_ROWS = "usm_rows"
_ROW_H = "usm_row_h"
_DEPTH = "usm_depth"
_BALL = "usm_ball_d"
_TUBE = "usm_tube_d"
_THICK = "usm_thick"
_BACK = "usm_back"
_SHELF = "usm_shelf"
_DIVID = "usm_divider"
_COLOR = "usm_color"

_CUSTOM = "Custom"


def _mm(value_cm):
    """A ValueCommandInput reports internal cm; convert to mm for the geometry layer."""
    return value_cm / 0.1


class UsmConfiguratorUI:
    def __init__(self, app, ui):
        self.app = app
        self.ui = ui
        self._handlers = []  # keep handler refs alive
        self.cmd_def = None

    def setup(self):
        cmd_defs = self.ui.commandDefinitions
        cmd_def = cmd_defs.itemById(config.CMD_ID)
        if not cmd_def:
            cmd_def = cmd_defs.addButtonDefinition(config.CMD_ID, config.CMD_NAME, config.CMD_TOOLTIP)
        self.cmd_def = cmd_def

        created = _CommandCreatedHandler(self)
        cmd_def.commandCreated.add(created)
        self._handlers.append(created)

        # Add a button to the Utilities > Add-Ins panel so it's reachable any time.
        panel = self.ui.allToolbarPanels.itemById(config.PANEL_ID)
        if panel and not panel.controls.itemById(config.CMD_ID):
            panel.controls.addCommand(cmd_def)

        # Open the configurator dialog immediately on Run, so there's a visible UI
        # without hunting for the button (best-effort; the button remains either way).
        self.show()

    def show(self):
        """Open the configurator dialog now."""
        try:
            if self.cmd_def:
                self.cmd_def.execute()
        except Exception:
            pass

    def teardown(self):
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

    # -- dialog construction -------------------------------------------------
    def build_inputs(self, command):
        inputs = command.commandInputs

        preset_in = inputs.addDropDownCommandInput(_PRESET, "Preset", adsk.core.DropDownStyles.TextListDropDownStyle)
        preset_in.listItems.add(_CUSTOM, True)
        for entry in presets.list_presets():
            preset_in.listItems.add(entry.get("name") or entry["id"], False)

        inputs.addIntegerSpinnerCommandInput(_COLS, "Columns (bays wide)", 1, 16, 1, 2)
        inputs.addValueInput(_COL_W, "Column width", "mm", adsk.core.ValueInput.createByReal(750 * 0.1))
        inputs.addIntegerSpinnerCommandInput(_ROWS, "Rows (bays tall)", 1, 16, 1, 1)
        inputs.addValueInput(_ROW_H, "Row height", "mm", adsk.core.ValueInput.createByReal(350 * 0.1))
        inputs.addValueInput(_DEPTH, "Depth", "mm", adsk.core.ValueInput.createByReal(350 * 0.1))

        inputs.addValueInput(_BALL, "Ball connector Ø", "mm", adsk.core.ValueInput.createByReal(25 * 0.1))
        inputs.addValueInput(_TUBE, "Tube Ø", "mm", adsk.core.ValueInput.createByReal(19 * 0.1))
        inputs.addValueInput(_THICK, "Panel thickness", "mm", adsk.core.ValueInput.createByReal(18 * 0.1))

        inputs.addBoolValueInput(_BACK, "Back panels", True, "", True)
        inputs.addBoolValueInput(_SHELF, "Shelves (horizontal dividers)", True, "", True)
        inputs.addBoolValueInput(_DIVID, "Vertical dividers", True, "", False)

        color_in = inputs.addDropDownCommandInput(_COLOR, "Panel colour", adsk.core.DropDownStyles.TextListDropDownStyle)
        for name in geometry.COLORS:
            color_in.listItems.add(name, name == geometry.DEFAULT_COLOR)

    # -- execute -------------------------------------------------------------
    def execute(self, command):
        inputs = command.commandInputs
        preset_name = inputs.itemById(_PRESET).selectedItem.name

        if preset_name != _CUSTOM:
            entry = self._preset_by_name(preset_name)
        else:
            entry = None

        if entry:
            columns = entry["columns"]
            rows = entry["rows"]
            depths = entry.get("depths") or [_mm(inputs.itemById(_DEPTH).value)]
            options = presets.to_options(entry)
        else:
            cols = int(inputs.itemById(_COLS).value)
            rows_n = int(inputs.itemById(_ROWS).value)
            columns = [_mm(inputs.itemById(_COL_W).value)] * cols
            rows = [_mm(inputs.itemById(_ROW_H).value)] * rows_n
            depths = [_mm(inputs.itemById(_DEPTH).value)]
            options = {
                "ball_diameter": _mm(inputs.itemById(_BALL).value),
                "tube_diameter": _mm(inputs.itemById(_TUBE).value),
                "panel_thickness": _mm(inputs.itemById(_THICK).value),
                "back_panels": inputs.itemById(_BACK).value,
                "shelves": inputs.itemById(_SHELF).value,
                "dividers": inputs.itemById(_DIVID).value,
                "color": inputs.itemById(_COLOR).selectedItem.name,
            }

        spec = geometry.build_spec(columns, rows, depths, options)

        from .builder import UsmBuilder
        summary = UsmBuilder(self.app).build(spec)
        self.ui.messageBox(summary, "USM Configurator")

    def _preset_by_name(self, name):
        for entry in presets.list_presets():
            if (entry.get("name") or entry["id"]) == name:
                return entry
        return None


# -- Fusion command handlers -------------------------------------------------
class _CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def notify(self, args):
        try:
            command = args.command
            self.owner.build_inputs(command)
            execute = _CommandExecuteHandler(self.owner)
            command.execute.add(execute)
            self.owner._handlers.append(execute)
        except Exception:
            if self.owner.ui:
                self.owner.ui.messageBox("USM Configurator failed to open:\n{}".format(traceback.format_exc()))


class _CommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def notify(self, args):
        try:
            self.owner.execute(args.command)
        except Exception:
            if self.owner.ui:
                self.owner.ui.messageBox("USM Configurator failed to build:\n{}".format(traceback.format_exc()))
