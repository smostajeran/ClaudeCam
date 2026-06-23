"""The Claude conversation loop that drives the CAD tools.

``run_turn`` runs on a background thread. CAD tool execution and all UI updates are
marshalled to Fusion's main thread through the dispatcher held by the UI object.
The Messages API is called via :mod:`claudecad.api` (standard library only).
"""

from . import api
from . import config
from . import tools

SYSTEM_PROMPT = """You are ClaudeCad, a CAD design assistant embedded inside Autodesk Fusion 360.
You turn a user's natural-language requirements into parametric 3D models by calling CAD tools.

Follow this workflow:
1. Analyze the requirement. If something material is missing or ambiguous (dimensions,
   units, quantities, orientation, intended use), ask concise clarifying questions BEFORE
   modeling. Ask only what you genuinely need; don't interrogate.
2. Every design starts with sketches. Create sketches first, then features (extrude, etc.).
3. Make the design pragmatic to adjust later: before drawing, create named user parameters
   for the key dimensions with create_parameter, and reference those parameter names in
   extrude distances (e.g. distance "height") instead of hard-coded numbers. Tell the user
   which parameter drives each dimension so they can change it later.
4. Geometry tool inputs are in millimetres unless the user specifies another unit.
5. When the build is complete, give a brief summary of what you created and list the key
   parameters, then explicitly ask the user to approve the design.
6. If the user approves, thank them and ask whether they'd like any feedback or refinements.
   Do not delete or rebuild anything after approval unless they ask.
7. Never delete the user's work yourself. Discarding and starting fresh is handled by the
   user through the Discard button in the panel.

Communication style: be concise and lead with the outcome. Between tool calls you don't
need to narrate routine steps. When you finish, write a short, readable summary in plain
sentences — not shorthand.
"""


class Session:
    """Holds the running conversation.

    Retained for backward compatibility; multi-chat sessions use
    :class:`claudecad.chats.Chat`, which has the same attributes.
    """

    def __init__(self):
        self.messages = []
        self.busy = False
        self.generation = 0

    def reset(self):
        self.messages = []
        self.busy = False
        self.generation += 1


def run_turn(chat, user_text, ui, cad, dispatcher):
    """Process one user message in ``chat``: call Claude, run tool calls, surface replies.

    Runs on a background thread. UI updates and CAD tool execution are marshalled to the
    main thread by ``ui``/``dispatcher`` and are scoped to ``chat`` — output for a chat
    that isn't currently shown is stored in that chat's transcript but not rendered.
    """
    if chat.busy:
        ui.system_for(chat, "ClaudeCad is still working on the previous request — please wait.")
        return

    key = config.get_api_key()
    if not key:
        ui.system_for(
            chat,
            "No Anthropic API key configured. Open Settings (the gear icon, top right) and "
            "paste your key, then try again.",
        )
        return

    gen = chat.generation

    def alive():
        return chat.generation == gen

    chat.busy = True
    ui.status(chat, True, "Thinking…")
    try:
        chat.messages.append({"role": "user", "content": user_text})

        while alive():
            response = api.create_message(
                api_key=key,
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=SYSTEM_PROMPT,
                messages=chat.messages,
                tools=tools.TOOLS,
                thinking={"type": "adaptive"},
            )
            content = response.get("content", [])

            # Guard immediately before mutating shared state: Discard may have bumped
            # the generation while we were waiting on Claude.
            if not alive():
                return
            # Preserve the full response (including thinking blocks) in history.
            chat.messages.append({"role": "assistant", "content": content})

            for block in content:
                if not alive():
                    return
                if block.get("type") == "text" and (block.get("text") or "").strip():
                    ui.assistant(chat, block["text"])

            if response.get("stop_reason") != "tool_use":
                break

            tool_results = []
            for block in content:
                if block.get("type") != "tool_use":
                    continue
                if not alive():
                    return
                ui.status(chat, True, "Building: {}…".format(block.get("name")))
                try:
                    output = dispatcher.run(
                        lambda b=block: tools.execute(b["name"], b.get("input", {}), cad)
                    )
                except Exception as exc:
                    # Tool ran on the main thread; Discard may have fired meanwhile.
                    if not alive():
                        return
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block["id"],
                        "content": "Error: {}".format(exc),
                        "is_error": True,
                    })
                    continue
                if not alive():
                    return
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block["id"],
                    "content": str(output),
                })

            if not alive():
                return
            chat.messages.append({"role": "user", "content": tool_results})

    except api.APIError as exc:
        if alive():
            ui.system_for(chat, "Claude API error: {}".format(exc))
    except Exception as exc:
        if alive():
            ui.system_for(chat, "Something went wrong: {}".format(exc))
    finally:
        # Only touch shared state if this turn is still the current one; otherwise a
        # discarded worker would clear the status/busy flag of a turn that started after it.
        if alive():
            chat.busy = False
            ui.status(chat, False, "")
