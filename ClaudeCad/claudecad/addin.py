"""Add-in lifecycle: wire the dispatcher, CAD builder, chats and UI together.

Imports of the logic/UI modules are done lazily inside the functions (not at module
top) so that an in-place reload after a self-update can purge those modules from
``sys.modules`` and have ``_build_ui`` re-import the freshly written code. This module
and :mod:`claudecad.dispatcher` are deliberately kept loaded across a reload: the
dispatcher's registered Fusion custom event must NOT be torn down and re-registered on
the fly (that is the operation most likely to destabilise Fusion), so the dispatcher
instance is reused and only the UI is rebuilt.
"""

import sys

import adsk.core

_app = None
_dispatcher = None
_ui = None
_cad = None
_chats = None


def start():
    global _app, _dispatcher
    _app = adsk.core.Application.get()

    from .dispatcher import MainThreadDispatcher
    _dispatcher = MainThreadDispatcher(_app)
    _build_ui()


def _build_ui():
    """(Re)create the CAD builder, chats and UI using whatever code is loaded now."""
    global _ui, _cad, _chats
    from .cad import CadBuilder
    from .chats import ChatManager
    from .ui import ClaudeCadUI

    _cad = CadBuilder(_app)
    _chats = ChatManager()  # in-memory only; nothing carries over across reloads/sessions
    _ui = ClaudeCadUI(_app, _app.userInterface, _dispatcher, _cad, _chats)
    _ui.setup()


def _purge_modules():
    """Drop the reloadable claudecad submodules so the next import reads the new files.

    Keeps this module and the dispatcher (whose custom event stays registered).
    """
    keep = {"claudecad", "claudecad.addin", "claudecad.dispatcher"}
    for name in [n for n in sys.modules if n.startswith("claudecad.") and n not in keep]:
        try:
            del sys.modules[name]
        except Exception:
            pass


def reload_in_place():
    """Reload the add-in's code without a manual Stop/Run, on the main thread.

    Tears down only the UI, purges the cached logic modules, and rebuilds the UI from
    the freshly written files. The dispatcher (and its custom event) is reused. Returns
    True on success; on any failure it restores nothing but pops a message box telling
    the user to Stop then Run, and returns False.
    """
    global _ui
    try:
        if _ui:
            _ui.teardown()
        _ui = None
        _purge_modules()
        _build_ui()
        return True
    except Exception:
        import traceback
        try:
            if _app and _app.userInterface:
                _app.userInterface.messageBox(
                    "ClaudeCad updated but could not reload automatically:\n\n{}\n\n"
                    "Please Stop, then Run ClaudeCad in Scripts and Add-Ins to load the "
                    "new version.".format(traceback.format_exc())
                )
        except Exception:
            pass
        return False


def stop():
    global _app, _dispatcher, _ui, _cad, _chats
    try:
        if _ui:
            _ui.teardown()
    finally:
        if _dispatcher:
            _dispatcher.cleanup()
        _ui = _cad = _chats = _dispatcher = _app = None
