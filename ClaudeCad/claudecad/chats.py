"""Chat sessions for ClaudeCad.

A ``Chat`` is one independent conversation thread. ``ChatManager`` holds the chats for
the current add-in run. Nothing is persisted to disk, so each Fusion session starts with
a single empty chat, and chats never carry over across restarts or leak into one another:

* ``messages``   — the Anthropic API conversation history (model-facing).
* ``transcript`` — what the panel shows (user / assistant / system bubbles), so a chat's
  history can be re-rendered when you switch back to it.
* ``generation`` — bumped on reset; an in-flight turn aborts when it changes.
"""


class Chat:
    def __init__(self, chat_id, title):
        self.id = chat_id
        self.title = title
        self.messages = []
        self.transcript = []
        self.busy = False
        self.generation = 0

    def reset(self):
        self.messages = []
        self.transcript = []
        self.busy = False
        self.generation += 1

    def cancel(self):
        """Stop the in-flight turn (bump the generation so the worker aborts) but KEEP the
        conversation and geometry — used by the Stop button, unlike reset()/Discard."""
        self.busy = False
        self.generation += 1


MAX_CHATS = 20  # soft cap; the oldest chat is evicted past this to bound memory


class ChatManager:
    def __init__(self):
        self._chats = []
        self._counter = 0
        self.active = None
        self.new_chat()

    def new_chat(self):
        self._counter += 1
        chat = Chat("chat-{}".format(self._counter), "Chat {}".format(self._counter))
        self._chats.append(chat)
        # Bound memory over a long session: drop the oldest chat (never the new one).
        while len(self._chats) > MAX_CHATS:
            self._chats.pop(0)
        self.active = chat
        return chat

    def get(self, chat_id):
        for chat in self._chats:
            if chat.id == chat_id:
                return chat
        return None

    def switch(self, chat_id):
        chat = self.get(chat_id)
        if chat:
            self.active = chat
        return self.active

    def summary(self):
        return [{"id": c.id, "title": c.title, "active": c is self.active} for c in self._chats]
