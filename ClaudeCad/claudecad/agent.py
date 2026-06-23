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
2. Every design starts with sketches. Create sketches first, then features.
3. Make the design pragmatic to adjust later: before drawing, create named user parameters
   for the key dimensions with create_parameter, then pass those parameter names as the
   width/height/radius/distance on the drawing and feature tools (e.g. width="width",
   distance="height"). The geometry becomes parameter-driven, so changing a parameter
   updates the model. Tell the user which parameter drives each dimension.
4. Geometry tool inputs are in millimetres unless the user specifies another unit. Build
   features with the right tool: extrude, revolve, fillet_all_edges, chamfer_all_edges,
   shell, and circular_pattern / rectangular_pattern. Use extrude with operation "cut" for
   holes.
4a. POSITION parts in a single coherent coordinate system so they assemble correctly —
   do NOT leave parts floating apart. Decide an origin and where each part sits, then place
   it there: sketch on an offset plane (create_sketch offset=...) for parts at a height (a
   lid on top, a peg on a face), use the in-plane center_x/center_y to position within a
   plane, and use extrude start_offset / symmetric to control where a feature begins. To add
   material to an existing body use extrude/revolve operation "join". Sketch on xz or yz for
   vertical walls/panels. Before finishing, capture_view and check the parts actually fit
   together.
5. Use capture_view to take a screenshot of the model and visually verify your work
   (proportions, placement, that holes/features landed correctly) before reporting. If
   something looks wrong, fix it and check again.
6. When the build is complete, give a brief summary of what you created and list the key
   parameters, then explicitly ask the user to approve the design.
7. If the user approves, thank them and ask whether they'd like any feedback or refinements.
   Do not delete or rebuild anything after approval unless they ask.
8. Never delete the user's work yourself. Discarding and starting fresh is handled by the
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


def _strip_orphan_tool_uses(messages):
    """Remove assistant messages whose tool_use blocks aren't immediately followed by a
    user message containing tool_result blocks.

    Such an orphan can arise when a turn is interrupted (e.g. Discard, or an error) between
    Claude emitting tool calls and the results being recorded. The API rejects it with a
    400 ("tool_use ids were found without tool_result blocks") on the next request, so we
    repair the history before sending instead of getting stuck.
    """
    result = []
    n = len(messages)
    i = 0
    while i < n:
        message = messages[i]
        content = message.get("content") if isinstance(message, dict) else None
        is_tool_use = (
            isinstance(message, dict)
            and message.get("role") == "assistant"
            and isinstance(content, list)
            and any(isinstance(b, dict) and b.get("type") == "tool_use" for b in content)
        )
        if is_tool_use:
            nxt = messages[i + 1] if i + 1 < n else None
            nxt_content = nxt.get("content") if isinstance(nxt, dict) else None
            followed = (
                isinstance(nxt, dict)
                and nxt.get("role") == "user"
                and isinstance(nxt_content, list)
                and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in nxt_content)
            )
            if not followed:
                i += 1
                continue
        result.append(message)
        i += 1
    return result


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
            # Repair any orphaned tool_use left by a previously interrupted turn.
            chat.messages[:] = _strip_orphan_tool_uses(chat.messages)
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

            # Execute tool calls whenever they're present — even if the response stopped on
            # max_tokens — so every tool_use is always paired with a tool_result. Breaking
            # on stop_reason here was what left an orphaned tool_use (the 400) when a big
            # batch of tool calls hit the length limit.
            tool_use_blocks = [b for b in content if b.get("type") == "tool_use"]
            if not tool_use_blocks:
                if response.get("stop_reason") == "max_tokens":
                    ui.system_for(chat, "Heads up: the response hit the length limit and may be cut off.")
                break

            tool_results = []
            for block in tool_use_blocks:
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
                    # A tool may return image content blocks (e.g. capture_view); pass
                    # those through directly, otherwise stringify the status text.
                    "content": output if isinstance(output, list) else str(output),
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
