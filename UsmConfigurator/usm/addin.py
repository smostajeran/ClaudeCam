"""Add-in lifecycle: create the command/button on start, remove it on stop."""

import adsk.core

_app = None
_ui = None


def start():
    global _app, _ui
    _app = adsk.core.Application.get()
    from .ui import UsmConfiguratorUI
    _ui = UsmConfiguratorUI(_app, _app.userInterface)
    _ui.setup()


def stop():
    global _app, _ui
    try:
        if _ui:
            _ui.teardown()
    finally:
        _ui = None
        _app = None
