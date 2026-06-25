"""The Claude conversation loop that drives the CAD tools.

``run_turn`` runs on a background thread. CAD tool execution and all UI updates are
marshalled to Fusion's main thread through the dispatcher held by the UI object.
The Messages API is called via :mod:`claudecad.api` (standard library only).
"""

from . import api
from . import config
from . import policy
from . import tools


def _format_plan(tool_use_blocks):
    """A readable plan for the approval prompt: one line per pending tool call, with the
    ones that need confirmation marked."""
    lines = ["I'd like to run these operations:"]
    for b in tool_use_blocks:
        mark = "  • {}".format(policy.summarize_call(b["name"], b.get("input", {})))
        if policy.needs_confirmation(b["name"]):
            mark += "  — needs your OK"
        lines.append(mark)
    lines.append("Approve to proceed, or Reject and tell me what to change.")
    return "\n".join(lines)


def _await_approval(chat, ui, plan, alive, timeout=600.0):
    """Show the plan and block until the user approves/rejects in the panel.

    Returns True (approved), False (rejected/timed out), or None (cancelled via Discard or
    the turn is no longer current). Polls in short waits so Discard unblocks promptly, and
    auto-rejects after ``timeout`` so a closed/reloaded panel can never hang the turn.
    """
    event = ui.request_approval(chat, plan)
    waited = 0.0
    step = 0.5
    while not event.wait(step):
        waited += step
        if not alive():
            ui.clear_approval(chat)
            return None
        if waited >= timeout:
            ui.clear_approval(chat)
            ui.system_for(chat, "No response to the approval request — skipping it for safety.")
            return False
    if not alive():
        return None
    decision = ui.take_approval(chat)
    return bool(decision)


def _tool_names_in(messages):
    """All tool names already invoked across the conversation (from assistant tool_use blocks)."""
    names = set()
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name"):
                    names.add(block["name"])
    return names

SYSTEM_PROMPT = """You are ClaudeCad, a CAD design assistant embedded inside Autodesk Fusion 360.
You turn a user's natural-language requirements into parametric 3D models by calling CAD tools.

Follow this workflow:
1. Analyze the requirement. If something material is missing or ambiguous (dimensions,
   units, quantities, orientation, intended use), ask concise clarifying questions BEFORE
   modeling. Ask only what you genuinely need; don't interrogate.
   For a cabinet / carcass / casework request specifically, you MUST confirm the joinery
   method (screws / dowels / dado / auto) — and any unstated key dimensions — and WAIT for
   the user's answer before calling build_cabinet. Never guess or silently default the
   joinery method.
2. Every design starts with sketches. Create sketches first, then features.
3. Make the design pragmatic to adjust later: before drawing, create named user parameters
   for the key dimensions with create_parameter, then pass those parameter names as the
   width/height/radius/distance on the drawing and feature tools (e.g. width="width",
   distance="height"). The geometry becomes parameter-driven, so changing a parameter
   updates the model. Tell the user which parameter drives each dimension.
4. Geometry tool inputs are in millimetres unless the user specifies another unit. Build
   features with the right tool: extrude, revolve, fillet_all_edges, chamfer_all_edges,
   shell, circular_pattern / rectangular_pattern, and draw_polygon. Use extrude with
   operation "cut" for holes. To EDIT an existing model: change_parameter resizes it;
   fillet_edges / chamfer_edges / cut_hole act on specific edges/faces you found with
   list_edges / list_faces; combine_bodies does booleans (join/cut/intersect) and move_body
   repositions a body. export_model writes STEP/STL/IGES/F3D to the user's home folder when
   they ask to export; export_cut_list writes a CSV cut list (parts, quantities, material).
   If a step goes wrong, undo_last removes just the most recent operation's features — prefer
   it over asking the user to discard everything. For shapes extrude/revolve can't make, use loft (blend through
   profiles on offset planes) or sweep (profile along a path sketch). add_thread taps a
   cylindrical face (a hole or shaft). set_material + get_mass_properties give realistic
   mass/volume/centre-of-mass — material names vary by install, so call list_materials to
   find a valid name before set_material rather than guessing (set all_bodies on set_material
   to apply one material to every body, e.g. all of a cabinet's panels). mesh_to_solid
   converts an imported mesh where supported.
   For a cabinet / carcass / casework, use build_cabinet: from the overall size it creates
   the named panels (Left/Right Side, Bottom, Top, Back, optional shelves) already
   positioned to fit, and returns a cut list + joinery plan. Do NOT call build_cabinet with
   a guessed joinery method — if the user hasn't explicitly chosen one, ask them (screws /
   dowels / dado / auto), explain the trade-offs briefly, and wait for their answer first.
   Pay attention to the BACK panel: by default (back_joint='groove') the back is built with a
   tongue on its left and right edges that seats into a groove cut into each side panel, which
   squares the carcass — prefer this over a flush back unless the user asks for 'inset' or
   'overlay'. build_cabinet builds fixed geometry by default; only pass parametric=true if the
   user explicitly wants named parameters (it's still being validated). To add dowel /
   shelf-pin / fastener holes, prefer drill_holes (absolute coordinates + boolean cut) over
   cut_hole — it's deterministic, won't be thrown off by a panel's frame; pass numeric mm.
   After a cabinet, you can add fronts with add_face_frame / add_doors / add_drawers (pass the
   same width/height/depth you built it with), promote_to_components to make a real assembly,
   and export_cut_list / export_dxf for the shop. These casework-front tools are EXPERIMENTAL.
   When the user refers to something they clicked ("this edge", "the face I picked",
   "these"), call get_selection to read their Fusion viewport selection, then act with
   fillet_selection / chamfer_selection / cut_hole_selection.
4a. POSITION parts in a single coherent coordinate system so they assemble correctly —
   do NOT leave parts floating apart. Decide an origin and where each part sits, then place
   it there: sketch on an offset plane (create_sketch offset=...) for parts at a height (a
   lid on top, a peg on a face), use the in-plane center_x/center_y to position within a
   plane, and use extrude start_offset / symmetric to control where a feature begins. To add
   material to an existing body use extrude/revolve operation "join". Sketch on xz or yz for
   vertical walls/panels. Before finishing, capture_view and check the parts actually fit
   together.
5. You can READ the document, not just write to it. Call inspect_model to see what already
   exists — your own work, geometry the user added, and imported meshes (with sizes and
   bounding boxes) — and list_faces / list_edges to find specific faces/edges. Do this at
   the start when the request refers to existing geometry, when you need real dimensions/
   positions rather than a guess, or to verify before finishing. Note: mesh bodies are not
   parametric and can't be edited by these tools — design around them.
6. Use capture_view to take a screenshot and visually verify your work (proportions,
   placement, that holes/features landed correctly). If something looks wrong, fix it and
   check again. inspect_model gives exact numbers; capture_view gives the visual.
7. When the build is complete, give a brief summary of what you created and list the key
   parameters, then explicitly ask the user to approve the design.
8. If the user approves, thank them and ask whether they'd like any feedback or refinements.
   Do not delete or rebuild anything after approval unless they ask.
9. Never delete the user's work yourself. Discarding and starting fresh is handled by the
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


_MAX_TOOL_RESULT_CHARS = 6000


def _compact_history(messages, keep_tail=6):
    """Shrink older context in place to bound token growth over a long conversation.

    For messages older than the most recent ``keep_tail``: replace screenshot image
    blocks in tool results with a short placeholder (they were only needed for the turn
    right after the capture), and truncate oversized text tool results. The recent tail
    is left intact so the model still has full fidelity on what it's actively working on.
    """
    cutoff = max(0, len(messages) - keep_tail)
    for i in range(cutoff):
        msg = messages[i]
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            inner = block.get("content")
            if isinstance(inner, list):
                new_inner = []
                changed = False
                for sub in inner:
                    if isinstance(sub, dict) and sub.get("type") == "image":
                        new_inner.append({"type": "text", "text": "[screenshot omitted to save context]"})
                        changed = True
                    else:
                        new_inner.append(sub)
                if changed:
                    block["content"] = new_inner
            elif isinstance(inner, str) and len(inner) > _MAX_TOOL_RESULT_CHARS:
                block["content"] = inner[:_MAX_TOOL_RESULT_CHARS] + "\n…[truncated to save context]"
    return messages


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
                # Drop the orphaned tool_use blocks (and the now-moot thinking that
                # preceded them) but keep any text so the model still sees what it said.
                # Drop the whole message only if nothing usable remains.
                kept = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]
                if kept:
                    repaired = dict(message)
                    repaired["content"] = kept
                    result.append(repaired)
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

    # Document-level guard: only one turn may mutate the shared Fusion design at a time.
    # Taken non-blocking so a second chat is told to wait rather than silently queuing
    # and interleaving tool calls into the same document.
    lock = getattr(cad, "turn_lock", None)
    if lock is not None and not lock.acquire(blocking=False):
        ui.system_for(chat, "ClaudeCad is busy with another chat — please wait for it to finish.")
        return

    gen = chat.generation

    def alive():
        return chat.generation == gen

    chat.busy = True
    ui.status(chat, True, "Thinking…")
    try:
        chat.messages.append({"role": "user", "content": user_text})

        while alive():
            # Repair orphaned tool_use from an interrupted turn, then compact old context.
            chat.messages[:] = _strip_orphan_tool_uses(chat.messages)
            _compact_history(chat.messages)
            if not alive():
                return  # Discard happened between the loop check and the request
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

            # Note truncation whether or not tool calls were emitted.
            if response.get("stop_reason") == "max_tokens":
                ui.system_for(chat, "Heads up: the response hit the length limit and may be cut off.")

            # Execute tool calls whenever they're present — even if the response stopped on
            # max_tokens — so every tool_use is always paired with a tool_result. Breaking
            # on stop_reason here was what left an orphaned tool_use (the 400) when a big
            # batch of tool calls hit the length limit.
            tool_use_blocks = [b for b in content if b.get("type") == "tool_use"]
            if not tool_use_blocks:
                break

            # Tools invoked so far this conversation + everything in this batch, used to
            # enforce ordering rules (inspect-before-edit, selection-before-selection-edit).
            called = _tool_names_in(chat.messages) | {b.get("name") for b in tool_use_blocks}

            # Preview -> approve -> execute: if this batch contains any tool that needs
            # confirmation, present the plan and wait for the user's Approve/Reject before
            # running ANYTHING in the batch. Declining returns errors so the model re-plans.
            confirm_blocks = [b for b in tool_use_blocks if policy.needs_confirmation(b["name"])]
            if confirm_blocks:
                plan = _format_plan(tool_use_blocks)
                approved = _await_approval(chat, ui, plan, alive)
                if approved is None:
                    return  # cancelled (Discard) or interrupted while waiting
                if not approved:
                    chat.messages.append({"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": b["id"],
                         "content": "The user declined this operation. Do not run it; ask what they'd like to change.",
                         "is_error": True}
                        for b in tool_use_blocks
                    ]})
                    ui.system_for(chat, "Declined. Tell me what you'd like to change and I'll revise the plan.")
                    continue

            tool_results = []
            for block in tool_use_blocks:
                if not alive():
                    return
                ui.status(chat, True, "Building: {}…".format(block.get("name")))
                try:
                    policy.check_prerequisites(block["name"], called)  # runtime safety rules
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
        if lock is not None:
            try:
                lock.release()
            except Exception:
                pass
