"""ClaudeCad — a Fusion 360 add-in that turns a chat conversation into parametric CAD.

This file is the thin entry point Fusion loads. It puts the add-in folder on
``sys.path`` and delegates to the :mod:`claudecad` package. There are no
third-party dependencies — ClaudeCad calls the Claude API with the standard
library only.

Each ``run`` first drops any cached ``claudecad.*`` modules from ``sys.modules`` and
re-imports fresh, because Fusion keeps the Python interpreter alive across Stop/Run within
a session — so without this, a Stop/Run after updating files would keep running the OLD
code in memory (the cause of stale-module crashes like a missing new attribute).
"""

import importlib
import os
import sys
import traceback

import adsk.core

ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
if ADDIN_DIR not in sys.path:
    sys.path.insert(0, ADDIN_DIR)

_addin = None  # the freshly-imported claudecad.addin module for this run


def _load_addin_fresh():
    """Purge cached claudecad modules and import claudecad.addin from the current files."""
    for name in [n for n in list(sys.modules) if n == "claudecad" or n.startswith("claudecad.")]:
        del sys.modules[name]
    return importlib.import_module("claudecad.addin")


def run(context):
    global _addin
    try:
        _addin = _load_addin_fresh()
        _addin.start()
    except Exception:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            app.userInterface.messageBox("ClaudeCad failed to start:\n{}".format(traceback.format_exc()))


def stop(context):
    global _addin
    try:
        if _addin is not None:
            _addin.stop()
    except Exception:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            app.userInterface.messageBox("ClaudeCad failed to stop:\n{}".format(traceback.format_exc()))
    finally:
        _addin = None
