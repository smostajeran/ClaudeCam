"""Add-in lifecycle: wire the dispatcher, CAD builder, chats and UI together."""

import adsk.core

from .cad import CadBuilder
from .chats import ChatManager
from .dispatcher import MainThreadDispatcher
from .ui import ClaudeCadUI

_state = None


def start():
    global _state
    app = adsk.core.Application.get()
    ui = app.userInterface

    dispatcher = MainThreadDispatcher(app)
    cad = CadBuilder(app)
    chats = ChatManager()  # in-memory only; nothing carries over across Fusion sessions
    ui_controller = ClaudeCadUI(app, ui, dispatcher, cad, chats)
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
