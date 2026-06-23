"""Palette-based chat UI and Fusion command wiring."""

import json
import threading

import adsk.core

from . import agent
from . import config


class ClaudeCadUI:
    def __init__(self, app, ui, dispatcher, cad, session):
        self.app = app
        self.ui = ui
        self.dispatcher = dispatcher
        self.cad = cad
        self.session = session
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
                True, True, True, 420, 620,
            )
            self.palette.dockingState = adsk.core.PaletteDockingStates.PaletteDockStateRight
            incoming = _IncomingHandler(self)
            self.palette.incomingFromHTML.add(incoming)
            self._handlers.append(incoming)
        else:
            self.palette.isVisible = True

    # -- messages to the palette (safe from any thread) ----------------------
    def _send(self, action, payload):
        def do():
            if self.palette:
                self.palette.sendInfoToHTML(action, json.dumps(payload))
        self.dispatcher.run(do)

    def assistant(self, text):
        self._send("assistant", {"text": text})

    def system(self, text):
        self._send("system", {"text": text})

    def status(self, busy, text):
        self._send("status", {"busy": bool(busy), "text": text or ""})

    def reset_chat(self):
        self._send("reset", {})

    # -- handling messages from the palette (runs on main thread) ------------
    def on_html_event(self, action, raw_data):
        try:
            data = json.loads(raw_data) if raw_data else {}
        except Exception:
            data = {}

        if action == "ready":
            self._greet()
        elif action == "send":
            text = (data.get("text") or "").strip()
            if text:
                threading.Thread(
                    target=agent.run_turn,
                    args=(self.session, text, self, self.cad, self.dispatcher),
                    daemon=True,
                ).start()
        elif action == "save_key":
            self._save_key(data.get("key", ""))
        elif action == "discard":
            self._discard()

    def _send_config(self):
        self._send("config", {"has_key": config.has_api_key(), "env": config.key_from_env()})

    def _greet(self):
        self.reset_chat()
        self._send_config()
        if config.has_api_key():
            self.system(
                "Hi! I'm ClaudeCad. Describe the part you'd like to design — for example "
                "'a 100x60x20 mm enclosure with a 30 mm hole in the lid'. I'll ask questions "
                "if I need to, sketch it parametrically, and check with you before finishing."
            )
        else:
            self.system(
                "Welcome to ClaudeCad. Add your Anthropic API key in Settings (the gear icon, "
                "top right) to get started."
            )

    def _save_key(self, key):
        if config.key_from_env():
            self.system(
                "Note: ANTHROPIC_API_KEY is set in your environment and takes precedence. "
                "I'll still save this key, but the environment value will be used until it's unset."
            )
        try:
            config.save_api_key(key)
            self.session.client = None  # rebuild the client with the new key
            self._send_config()
            self.system("API key saved. You're ready to design — describe a part to begin.")
        except Exception as exc:
            self.system("Could not save the API key: {}".format(exc))

    def _discard(self):
        try:
            self.cad.reset()
        except Exception as exc:
            self.system("Could not fully clear the model: {}".format(exc))
        self.session.reset()
        self.reset_chat()
        self.system("Workspace cleared. Describe your next design and we'll start fresh.")


class _CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, owner):
        super().__init__()
        self._owner = owner

    def notify(self, args):
        execute = _CommandExecuteHandler(self._owner)
        args.command.execute.add(execute)
        self._owner._handlers.append(execute)


class _CommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, owner):
        super().__init__()
        self._owner = owner

    def notify(self, args):
        self._owner.show_palette()


class _IncomingHandler(adsk.core.HTMLEventHandler):
    def __init__(self, owner):
        super().__init__()
        self._owner = owner

    def notify(self, args):
        try:
            self._owner.on_html_event(args.action, args.data)
        except Exception:
            pass
        args.returnData = "OK"
