"""USM Configurator — a Fusion 360 add-in that builds parametric USM Haller
modular furniture from a configuration dialog.

This file is the thin entry point Fusion loads. It puts the add-in folder on
``sys.path`` and delegates to the :mod:`usm` package. Each ``run`` drops any
cached ``usm.*`` modules first and re-imports from disk, so a Stop/Run reliably
loads the latest files after an edit (Fusion keeps the interpreter alive across
Stop/Run within a session).
"""

import importlib
import os
import sys
import traceback

import adsk.core

ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
if ADDIN_DIR not in sys.path:
    sys.path.insert(0, ADDIN_DIR)

_addin = None


def _load_addin_fresh():
    for name in [n for n in list(sys.modules) if n == "usm" or n.startswith("usm.")]:
        del sys.modules[name]
    return importlib.import_module("usm.addin")


def run(context):
    global _addin
    try:
        _addin = _load_addin_fresh()
        _addin.start()
    except Exception:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            app.userInterface.messageBox("USM Configurator failed to start:\n{}".format(traceback.format_exc()))


def stop(context):
    global _addin
    try:
        if _addin is not None:
            _addin.stop()
    except Exception:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            app.userInterface.messageBox("USM Configurator failed to stop:\n{}".format(traceback.format_exc()))
    finally:
        _addin = None
