"""ClaudeCad — a Fusion 360 add-in that turns a chat conversation into parametric CAD.

This file is the thin entry point Fusion loads. It puts the add-in folder on
``sys.path`` and delegates to the :mod:`claudecad` package. There are no
third-party dependencies — ClaudeCad calls the Claude API with the standard
library only.
"""

import os
import sys
import traceback

import adsk.core

ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
if ADDIN_DIR not in sys.path:
    sys.path.insert(0, ADDIN_DIR)

from claudecad import addin


def run(context):
    try:
        addin.start()
    except Exception:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            app.userInterface.messageBox("ClaudeCad failed to start:\n{}".format(traceback.format_exc()))


def stop(context):
    try:
        addin.stop()
    except Exception:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            app.userInterface.messageBox("ClaudeCad failed to stop:\n{}".format(traceback.format_exc()))
