# ClaudeCad

A Fusion 360 add-in that designs **parametric 3D models from a chat conversation**, powered by Claude.

You describe what you want; Claude analyzes the requirement, asks clarifying questions when needed, builds the model **sketch-first and parametric** so it's easy to change later, then asks you to approve the design before finishing.

## Workflow

1. **Chat** — you send a requirement in the panel.
2. **Analyze** — Claude reads it and asks for any missing info (dimensions, units, etc.).
3. **Design** — every design starts with sketches; key dimensions become **user parameters** so they can be adjusted later, and extrude depths reference those parameters.
4. **Approve** — Claude summarizes the result and asks you to approve. If you approve, it asks for feedback. If not, use **Discard & start over** to roll back everything created this session and begin fresh.

## How it works

| Piece | Responsibility |
|-------|----------------|
| `ClaudeCad.py` | Fusion entry point (`run`/`stop`); sets up `sys.path`. |
| `claudecad/agent.py` | Claude conversation + tool loop (`claude-opus-4-8`, adaptive thinking). Runs on a worker thread. |
| `claudecad/tools.py` | Tool schemas exposed to Claude and dispatch to the CAD builder. |
| `claudecad/cad.py` | Fusion CAD operations (parameters, sketches, rectangles, circles, lines, extrudes) + session reset. |
| `claudecad/dispatcher.py` | Marshals CAD/UI calls onto Fusion's main thread (the API is main-thread only). |
| `claudecad/ui.py` | Chat palette + Fusion command/button wiring. |
| `resources/palette/` | The chat UI (HTML/CSS/JS). |

The Claude network call runs on a background thread so Fusion stays responsive; CAD operations and UI updates are marshalled back to the main thread via a registered Fusion custom event.

## Install

### Quick install (recommended)

Get the `ClaudeCad/` folder onto your machine (clone the repo, or download the branch ZIP and unzip), then from a terminal **inside the `ClaudeCad/` folder** run:

- **macOS:**
  ```bash
  bash install.sh
  ```
- **Windows (PowerShell):**
  ```powershell
  powershell -ExecutionPolicy Bypass -File install.ps1
  ```

The script copies the add-in into Fusion's AddIns folder and installs the `anthropic` SDK into `lib/`. Then in Fusion: **Utilities → Add-Ins → Scripts and Add-Ins → select `ClaudeCad` → Run**, click the **gear icon**, and paste your API key.

### Manual install

1. **Copy the add-in** into your Fusion add-ins folder (or load it from here):
   - Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\`
   - macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/`

   The folder, the `.py`, and the `.manifest` must all be named `ClaudeCad`.

2. **Install the Anthropic SDK into the add-in's `lib/` folder** (Fusion's Python can't see your system packages):

   ```bash
   cd ClaudeCad
   python -m pip install anthropic -t lib
   ```

   `lib/` is git-ignored. If the SDK is missing, the panel tells you exactly this.

3. In Fusion: **Utilities → Add-Ins → Scripts and Add-Ins**, select **ClaudeCad**, click **Run**. The chat panel opens (also re-openable from the **Add-Ins** panel button).

4. **Provide your Anthropic API key.** Easiest: click the **gear icon** (top-right of the panel), paste your key, and **Save** — it's stored locally in `~/.claudecad/config.json` (owner-readable only). If no key is set, the Settings screen opens automatically.

   Alternatively, set the `ANTHROPIC_API_KEY` environment variable (this takes precedence over the saved key), or create `~/.claudecad/config.json` yourself:
   ```json
   { "api_key": "sk-ant-..." }
   ```

## Example prompts

- "A 100×60×20 mm enclosure with 3 mm walls and a 30 mm hole centered in the lid."
- "A mounting bracket: 80×40 mm base, 5 mm thick, with two 6 mm bolt holes 60 mm apart."
- "A simple spur-gear blank, 50 mm diameter, 8 mm thick, 10 mm center bore."

## Notes & limitations

- Tool geometry inputs are **millimetres** (Fusion's internal unit is cm; the add-in converts).
- The current tool set covers parameters, sketches, rectangles/circles/lines, and extrudes — enough for a wide range of prismatic parts. The architecture is built to extend: add a method to `cad.py`, a schema to `tools.py`, and a branch to `tools.execute`.
- **Discard & start over** deletes the timeline features and parameters created during the session (rolling back to where the session began) — it does not touch pre-existing geometry.
- Requires an active Fusion design in **parametric** (timeline) mode.
