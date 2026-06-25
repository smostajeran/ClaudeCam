"""Palette-based chat UI and Fusion command wiring."""

import json
import threading

import adsk.core

from . import agent
from . import config


class ClaudeCadUI:
    def __init__(self, app, ui, dispatcher, cad, chats):
        self.app = app
        self.ui = ui
        self.dispatcher = dispatcher
        self.cad = cad
        self.chats = chats
        self.palette = None
        self._handlers = []  # keep handler refs alive
        self._pending_chat = None  # chat currently awaiting an Approve/Reject decision

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
    def _emit(self, chat, role, text):
        """Append a bubble to ``chat``'s transcript and render it if ``chat`` is shown.

        The append happens on the main thread under a generation check, so a worker
        whose turn was discarded can't repopulate a cleared chat or leak into it.
        """
        gen = chat.generation

        def do():
            if chat.generation != gen:
                return
            chat.transcript.append({"role": role, "text": text})
            if self.palette and self.chats.active is chat:
                self.palette.sendInfoToHTML("message", json.dumps({"role": role, "text": text}))
        self.dispatcher.run(do)

    def assistant(self, chat, text):
        self._emit(chat, "assistant", text)

    def system_for(self, chat, text):
        self._emit(chat, "system", text)

    def system(self, text):
        self._emit(self.chats.active, "system", text)

    def status(self, chat, busy, text):
        gen = chat.generation

        def do():
            if chat.generation != gen:
                return
            if self.palette and self.chats.active is chat:
                self.palette.sendInfoToHTML("status", json.dumps({"busy": bool(busy), "text": text or ""}))
        self.dispatcher.run(do)

    def _send_chats(self):
        def do():
            if self.palette:
                self.palette.sendInfoToHTML("chats", json.dumps({"chats": self.chats.summary()}))
        self.dispatcher.run(do)

    # -- preview / approve -> execute gate -----------------------------------
    def _set_approval_bar(self, chat, pending):
        def do():
            if self.palette and self.chats.active is chat:
                self.palette.sendInfoToHTML("approval", json.dumps({"pending": bool(pending)}))
        self.dispatcher.run(do)

    def request_approval(self, chat, plan_text):
        """Show ``plan_text`` and reveal Approve/Reject. Returns an Event the worker waits on."""
        event = threading.Event()
        chat._approval = {"event": event, "approved": None}
        self._pending_chat = chat
        self._emit(chat, "system", plan_text)
        self._set_approval_bar(chat, True)
        return event

    def take_approval(self, chat):
        appr = getattr(chat, "_approval", None)
        chat._approval = None
        return appr.get("approved") if appr else None

    def clear_approval(self, chat):
        chat._approval = None
        if self._pending_chat is chat:
            self._pending_chat = None
        self._set_approval_bar(chat, False)

    def _resolve_approval(self, approved):
        chat = self._pending_chat
        appr = getattr(chat, "_approval", None) if chat else None
        if appr:
            appr["approved"] = approved
            appr["event"].set()
        if chat:
            self._set_approval_bar(chat, False)
        self._pending_chat = None

    def _show_chat(self, chat):
        """Clear the panel and replay one chat's transcript (used on switch/new/open)."""
        def do():
            if not self.palette:
                return
            self.palette.sendInfoToHTML("reset", "{}")
            for msg in chat.transcript:
                self.palette.sendInfoToHTML("message", json.dumps({"role": msg["role"], "text": msg["text"]}))
            self.palette.sendInfoToHTML(
                "status", json.dumps({"busy": bool(chat.busy), "text": "Working…" if chat.busy else ""})
            )
            # Re-reveal the approval bar if the chat we're showing is mid-approval.
            self.palette.sendInfoToHTML(
                "approval", json.dumps({"pending": bool(getattr(chat, "_approval", None))})
            )
        self.dispatcher.run(do)
        self._send_chats()

    def _greet(self, chat):
        if config.has_api_key():
            self.system_for(
                chat,
                "Hi! I'm ClaudeCad. Describe the part you'd like to design — for example "
                "'a 100x60x20 mm enclosure with a 30 mm hole in the lid'. I'll ask questions "
                "if I need to, sketch it parametrically, and check with you before finishing.",
            )
        else:
            self.system_for(
                chat,
                "Welcome to ClaudeCad. Add your Anthropic API key in Settings (the gear icon, "
                "top right) to get started.",
            )

    # -- handling messages from the palette (runs on main thread) ------------
    def on_html_event(self, action, raw_data):
        try:
            data = json.loads(raw_data) if raw_data else {}
        except Exception:
            data = {}

        if action == "ready":
            self._send_config()
            chat = self.chats.active
            if not chat.transcript:
                self._greet(chat)
            self._show_chat(chat)
        elif action == "send":
            text = (data.get("text") or "").strip()
            image = data.get("image") if isinstance(data.get("image"), dict) else None
            if text or image:
                chat = self.chats.active
                if chat.busy:
                    self.system_for(chat, "ClaudeCad is still working — please wait.")
                    return
                shown = text + (("\n" if text else "") + "🖼 [image attached]" if image else "")
                self._emit(chat, "user", shown)  # render + store the user's message
                threading.Thread(
                    target=agent.run_turn,
                    args=(chat, text, self, self.cad, self.dispatcher),
                    kwargs={"image": image},
                    daemon=True,
                ).start()
        elif action == "new_chat":
            chat = self.chats.new_chat()
            self._greet(chat)
            self._show_chat(chat)
        elif action == "switch_chat":
            chat = self.chats.switch(data.get("id"))
            if chat:
                self._show_chat(chat)
        elif action == "approve_plan":
            self._resolve_approval(True)
        elif action == "reject_plan":
            self._resolve_approval(False)
        elif action == "save_key":
            self._save_key(data.get("key", ""))
        elif action == "save_token":
            self._save_token(data.get("token", ""))
        elif action == "stop":
            self._stop()
        elif action == "discard":
            self._discard()
        elif action == "update":
            self._update()

    def _send_config(self):
        def do():
            if self.palette:
                self.palette.sendInfoToHTML(
                    "config",
                    json.dumps({
                        "has_key": config.has_api_key(),
                        "env": config.key_from_env(),
                        "has_token": config.has_github_token(),
                        "token_env": config.token_from_env(),
                        "version": config.get_version(),
                    }),
                )
        self.dispatcher.run(do)

    def _save_token(self, token):
        chat = self.chats.active
        if config.token_from_env():
            self.system_for(
                chat,
                "Note: GITHUB_TOKEN is set in your environment and takes precedence over a saved token.",
            )
        try:
            config.save_github_token(token)
            self._send_config()
            self.system_for(chat, "GitHub token saved. Updates can now reach a private repository.")
        except Exception as exc:
            self.system_for(chat, "Could not save the token: {}".format(exc))

    def _update(self):
        chat = self.chats.active
        self.system_for(chat, "Checking for updates…")

        def work():
            try:
                from . import updater
                message, updated, _version = updater.update()
            except Exception as exc:
                self.system_for(chat, "Update failed: {}".format(exc))
                return
            self.system_for(chat, message)
            if updated:
                # Reload the new code in place so the user doesn't have to Stop/Run by hand.
                self.system_for(chat, "Reloading ClaudeCad with the new version…")
                try:
                    from . import addin
                    self.dispatcher.run(addin.reload_in_place)
                except Exception as exc:
                    self.system_for(
                        chat,
                        "Auto-reload failed ({}). Please Stop, then Run ClaudeCad in "
                        "Scripts and Add-Ins to load the update.".format(exc),
                    )

        threading.Thread(target=work, daemon=True).start()

    def _save_key(self, key):
        chat = self.chats.active
        if config.key_from_env():
            self.system_for(
                chat,
                "Note: ANTHROPIC_API_KEY is set in your environment and takes precedence. "
                "I'll still save this key, but the environment value will be used until it's unset.",
            )
        try:
            config.save_api_key(key)
            self._send_config()
            self.system_for(chat, "API key saved. You're ready to design — describe a part to begin.")
        except Exception as exc:
            self.system_for(chat, "Could not save the API key: {}".format(exc))

    def _stop(self):
        # Cancel the in-flight turn without clearing the conversation or geometry. Bumping the
        # generation makes the worker abort at its next checkpoint; we also resolve any pending
        # approval so a worker blocked on it unblocks immediately.
        chat = self.chats.active
        if not chat.busy and self._pending_chat is not chat:
            self.system_for(chat, "Nothing is running to stop.")
            return
        if self._pending_chat is chat:
            self._resolve_approval(False)  # unblock a waiting approval and hide the bar
        chat.cancel()
        try:
            self.cad.turns.clear_owner(id(chat))  # free the document slot immediately
        except Exception:
            pass
        self.status(chat, False, "")
        self.system_for(chat, "Stopped. Your model and chat are unchanged — continue when ready.")

    def _discard(self):
        # Cancel any in-flight turn in this chat first (bumps the generation) so a worker
        # still waiting on Claude can't repopulate the model or the chat after we clear.
        chat = self.chats.active
        chat.reset()
        try:
            self.cad.turns.clear_owner(id(chat))  # free the document slot a stuck turn may hold
        except Exception:
            pass
        try:
            self.cad.reset()
        except Exception as exc:
            self.system_for(chat, "Could not fully clear the model: {}".format(exc))
        self._show_chat(chat)
        self.system_for(chat, "Workspace cleared. Describe your next design and we'll start fresh.")


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
        except Exception as exc:
            try:
                self._owner.system("Something went wrong handling that action: {}".format(exc))
            except Exception:
                pass
        args.returnData = "OK"
