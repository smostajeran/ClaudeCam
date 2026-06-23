"""Marshal work onto Fusion's main thread.

The Fusion 360 API may only be called from the main thread, but ClaudeCad runs the
(blocking) Claude network call on a background thread so the UI stays responsive.
``MainThreadDispatcher.run(func)`` lets the worker thread execute ``func`` on the main
thread and block for its result, using a registered Fusion custom event as the bridge.
"""

import threading
import uuid

import adsk.core

EVENT_ID = "ClaudeCadMainThreadEvent"


class MainThreadDispatcher:
    def __init__(self, app):
        self.app = app
        self._pending = {}
        self._lock = threading.Lock()
        self._main_thread = threading.current_thread()
        self._event = self.app.registerCustomEvent(EVENT_ID)
        self._handler = _Handler(self)
        self._event.add(self._handler)

    def run(self, func, timeout=180):
        """Run ``func`` on the main thread and return its result.

        If already on the main thread, ``func`` runs immediately to avoid deadlock.
        """
        if threading.current_thread() is self._main_thread:
            return func()

        token = uuid.uuid4().hex
        job = {"func": func, "event": threading.Event(), "result": None, "error": None}
        with self._lock:
            self._pending[token] = job

        self.app.fireCustomEvent(EVENT_ID, token)

        if not job["event"].wait(timeout):
            with self._lock:
                self._pending.pop(token, None)
            raise TimeoutError("Main-thread operation timed out.")

        if job["error"] is not None:
            raise job["error"]
        return job["result"]

    def _dispatch(self, token):
        with self._lock:
            job = self._pending.pop(token, None)
        if not job:
            return
        try:
            job["result"] = job["func"]()
        except Exception as exc:  # surfaced to the waiting worker thread
            job["error"] = exc
        finally:
            job["event"].set()

    def cleanup(self):
        try:
            if self._event and self._handler:
                self._event.remove(self._handler)
        except Exception:
            pass
        try:
            self.app.unregisterCustomEvent(EVENT_ID)
        except Exception:
            pass


class _Handler(adsk.core.CustomEventHandler):
    def __init__(self, owner):
        super().__init__()
        self._owner = owner

    def notify(self, args):
        try:
            self._owner._dispatch(args.additionalInfo)
        except Exception:
            pass
