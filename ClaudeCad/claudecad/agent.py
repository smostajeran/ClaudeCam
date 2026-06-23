"""The Claude conversation loop that drives the CAD tools.

``run_turn`` runs on a background thread. CAD tool execution and all UI updates are
marshalled to Fusion's main thread through the dispatcher held by the UI object.
"""

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
    """Holds the running conversation and the cached Anthropic client."""

    def __init__(self):
        self.messages = []
        self.busy = False
        self.client = None

    def reset(self):
        self.messages = []
        self.busy = False


def run_turn(session, user_text, ui, cad, dispatcher):
    """Process one user message: call Claude, run any tool calls, surface replies."""
    if session.busy:
        ui.system("ClaudeCad is still working on the previous request — please wait.")
        return

    key = config.get_api_key()
    if not key:
        ui.system(
            "No Anthropic API key found. Set the ANTHROPIC_API_KEY environment variable, "
            "or create ~/.claudecad/config.json containing {\"api_key\": \"sk-ant-...\"}, "
            "then reopen ClaudeCad."
        )
        return

    try:
        import anthropic
    except Exception:
        ui.system(
            "The 'anthropic' package is not installed in Fusion's Python. See the README: "
            "install it into the add-in's lib/ folder, e.g. "
            "pip install anthropic -t \"<addin>/lib\"."
        )
        return

    session.busy = True
    ui.status(True, "Thinking…")
    try:
        if session.client is None:
            session.client = anthropic.Anthropic(api_key=key)

        session.messages.append({"role": "user", "content": user_text})

        while True:
            response = session.client.messages.create(
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=tools.TOOLS,
                thinking={"type": "adaptive"},
                messages=session.messages,
            )
            # Preserve the full response (including thinking blocks) in history.
            session.messages.append({"role": "assistant", "content": response.content})

            for block in response.content:
                if getattr(block, "type", None) == "text" and block.text.strip():
                    ui.assistant(block.text)

            if response.stop_reason != "tool_use":
                break

            tool_results = []
            for block in response.content:
                if getattr(block, "type", None) != "tool_use":
                    continue
                ui.status(True, "Building: {}…".format(block.name))
                try:
                    output = dispatcher.run(lambda b=block: tools.execute(b.name, b.input, cad))
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(output),
                    })
                except Exception as exc:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": "Error: {}".format(exc),
                        "is_error": True,
                    })

            session.messages.append({"role": "user", "content": tool_results})

    except Exception as exc:
        ui.system("Something went wrong talking to Claude: {}".format(exc))
    finally:
        session.busy = False
        ui.status(False, "")
