"""Add-in lifecycle: wire the dispatcher, CAD builder, session and UI together."""

import adsk.core

from .cad import CadBuilder
from .dispatcher import MainThreadDispatcher
from .agent import Session
from .ui import ClaudeCadUI

_state = None


def start():
    global _state
    app = adsk.core.Application.get()
    ui = app.userInterface

    dispatcher = MainThreadDispatcher(app)
    cad = CadBuilder(app)
    session = Session()
    ui_controller = ClaudeCadUI(app, ui, dispatcher, cad, session)
    ui_controller.setup()

    _state = (ui_controller, dispatcher)


def stop():
    global _state
    if not _state:
        return
    ui_controller, dispatcher = _state
    ui_controller.teardown()
    dispatcher.cleanup()
    _state = None
