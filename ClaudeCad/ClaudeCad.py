"""ClaudeCad — a Fusion 360 add-in that turns a chat conversation into parametric CAD.

This file is the thin entry point Fusion loads. It puts the add-in folder (and the
vendored ``lib/`` directory that holds the ``anthropic`` SDK) on ``sys.path`` and
delegates to the :mod:`claudecad` package.
"""

import os
import sys
import traceback

import adsk.core

ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
for _path in (ADDIN_DIR, os.path.join(ADDIN_DIR, "lib")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

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
