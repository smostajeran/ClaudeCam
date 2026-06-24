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
| `claudecad/chats.py` | Independent chat threads (`Chat` / `ChatManager`) — per-chat history, in-memory only. |
| `claudecad/api.py` | Minimal Claude Messages API client built on `urllib` (Python standard library) — no third-party packages. |
| `claudecad/tools.py` | Tool schemas exposed to Claude and dispatch to the CAD builder. |
| `claudecad/cad.py` | Fusion CAD operations (parameters, sketches, rectangles, circles, lines, extrudes) + session reset. |
| `claudecad/dispatcher.py` | Marshals CAD/UI calls onto Fusion's main thread (the API is main-thread only). |
| `claudecad/ui.py` | Chat palette + Fusion command/button wiring. |
| `resources/palette/` | The chat UI (HTML/CSS/JS). |

The Claude network call runs on a background thread so Fusion stays responsive; CAD operations and UI updates are marshalled back to the main thread via a registered Fusion custom event.

**No dependencies.** ClaudeCad calls the Claude API directly with Python's standard library (`urllib`), so there is nothing to `pip install`. This sidesteps a common Fusion problem: the `anthropic` SDK pulls in compiled wheels (notably `pydantic-core`) whose binaries are built for your system Python's version/ABI and fail to import inside Fusion's bundled interpreter.

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

The script copies the add-in into Fusion's AddIns folder. There is **no dependency install step** — ClaudeCad uses only Python's standard library. Then in Fusion: **Utilities → Add-Ins → Scripts and Add-Ins → select `ClaudeCad` → Run**, click the **gear icon**, and paste your API key.

### Manual install

1. **Copy the add-in** into your Fusion add-ins folder (or load it from here):
   - Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\`
   - macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/`

   The folder, the `.py`, and the `.manifest` must all be named `ClaudeCad`.

2. **No dependencies to install.** ClaudeCad talks to the Claude API using only Python's standard library, so there is nothing to `pip install` — skip straight to running the add-in.

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

## Chats

- Use the chat dropdown and **+ New** (above the message area) to keep separate conversation threads. Each chat has its own history and **never carries over** anything from another chat.
- Chats live only in memory for the current Fusion session — nothing is written to disk, so when you restart Fusion you start fresh with a single empty chat.
- While Claude is working you'll see an animated **Working…** indicator (with the current step, e.g. *Building: extrude…*), so it's clear it's actively thinking rather than stuck.
- Assistant replies render **formatted Markdown** (headings, bold, bullet/numbered lists, inline and fenced code) rather than showing raw `**`/`#`/`-` characters. Expression-like text (`2 * width`) and parameter names (`back_thickness`) are left untouched.
- Note: all chats build into the one active Fusion document (geometry is shared); chat isolation is about the *conversation*, not separate 3D models.

## What Claude can build

- **Parameters** that drive the model (`create_parameter`).
- **Sketches** with rectangles, circles, lines. Width/height/radius accept a parameter
  expression (e.g. `"width"`, `"2 * wall"`), so the sketch is **parameter-driven** —
  change the parameter and the part updates.
- **Features:** extrude (incl. cut for holes; symmetric and start-offset options), revolve,
  fillet/chamfer (all edges **or** specific edges by index), shell (hollow / open box),
  circular / rectangular patterns, and N-sided polygons.
- **Editing existing models:** `change_parameter` (resize), `cut_hole` on a chosen face
  (refuses an oversized diameter relative to the face span — evaluating expression-valued
  diameters first — so a runaway value can't gut a panel),
  `combine_bodies` (boolean join/cut/intersect), and `move_body` (reposition).
- **Drilling:** `drill_holes` adds dowel / shelf-pin / fastener holes into a body by
  **absolute coordinates** — each hole is a cylinder (entry point → axis → depth) boolean-cut
  from the target, with no construction-plane or face-frame guesswork, so it's deterministic
  regardless of how the body was built. It refuses a diameter too large for the body.
- **Advanced shapes:** `loft` (blend through profiles), `sweep` (profile along a path).
- **Casework / cabinets:** `build_cabinet` builds a frameless carcass from its overall size —
  the named panels (Left/Right Side, Bottom, Top, Back, optional shelves) positioned to fit
  together — and returns a cut list plus a joinery plan for the method you choose
  (screws / dowels / dado / auto). It builds fixed geometry by default; an **experimental**
  `parametric` option creates named parameters (`cab_w`/`cab_h`/`cab_d`/`cab_t`/`cab_back`) to
  resize later — still being validated, so off by default. The **back panel** is handled
  properly: by default it's
  built with a tongue on its left and right edges that seats into a groove cut into each side
  (`back_joint='groove'`, which squares the carcass), with `inset` (flush) and `overlay`
  alternatives. Other joinery is a plan for now (pocket holes / dados aren't cut yet).
- **Threads:** `add_thread` taps a cylindrical face (hole or shaft) with a standard metric thread.
- **Material + mass:** `list_materials` lists the materials actually available in your Fusion
  install (so names aren't guessed); `set_material` assigns a physical material to a body (or
  all bodies at once via `all_bodies`, handy for a cabinet's panels); `get_mass_properties`
  reports mass / volume / surface area / centre of mass.
- **Mesh → solid:** `mesh_to_solid` converts an imported mesh to an editable body where the
  Fusion version supports it.
- **Pick-in-viewport:** select faces/edges in Fusion and act on them by chat — `get_selection`,
  `fillet_selection`, `chamfer_selection`, `cut_hole_selection` ("round these edges 2 mm").
- **Export:** `export_model` writes STEP / STL / IGES / F3D to your home folder. The filename
  is sanitized (path components stripped, confined to the home folder) and never overwrites an
  existing file — it auto-suffixes (`name_1.step`, …) instead.
- **3D placement:** sketches can be created on an **offset** construction plane so parts are
  positioned at the right height/location and assemble together rather than overlapping at
  the origin.
- **Read-back / inspection:** `inspect_model` reports units, parameters, every solid body
  (size, face/edge counts, volume) and every **mesh body** (size + triangle count), so Claude
  can see what already exists — its own work, geometry you added, and imported meshes — instead
  of building blind. `list_faces` / `list_edges` enumerate a body's faces/edges (type, size,
  location) for targeting. Meshes are detected but aren't parametric, so they can't be edited.
- **Vision:** `capture_view` screenshots the viewport so Claude can *see* the model and
  self-correct before asking you to approve.

## Updating

- The current version shows next to the logo (and in **Settings**). It's read from the `VERSION` file and bumped on each change.
- **Update from inside the app:** Settings (gear) → **Check for updates**. ClaudeCad downloads the latest `ClaudeCad/` from GitHub (`main`), installs it over itself, and then **reloads itself in place** — it tears down and rebuilds the panel from the new code so you don't have to Stop/Run by hand. (The persistent main-thread event bridge is reused rather than re-registered, which is what makes the live reload safe.) If the in-place reload can't complete, it falls back to asking you to **Stop, then Run** the add-in manually. Note: the *first* update to a build that has this feature still needs a manual Stop/Run, because the old code (without auto-reload) is the one performing that update; auto-reload kicks in from then on.
- Self-update pulls from `smostajeran/ClaudeCam` via the GitHub API. If that repo is **private**, paste a GitHub token (fine-grained PAT with **Contents: Read**) into the **GitHub token** field in Settings — or set `GITHUB_TOKEN` / add `"github_token"` to `~/.claudecad/config.json`. Otherwise make the repo public. Your API key and settings are untouched by an update.

## Notes & limitations

- Tool geometry inputs are **millimetres** (Fusion's internal unit is cm; the add-in converts).
- Fillet/chamfer/shell act on **all edges / the top face** of the most recent body (no
  per-edge selection yet). The architecture is built to extend: add a method to `cad.py`,
  a schema to `tools.py`, and a branch to `tools.execute`.
- **Discard & start over** deletes only the geometry ClaudeCad created — every feature it makes is tagged with a Fusion attribute, and Discard removes only tagged items plus the parameters it added. Geometry you create yourself is never deleted, even if you add it after the add-in starts.
- **Preview → approve → execute:** before running an operation that materially changes the document or filesystem (cabinet build, holes, booleans, body moves, mesh conversion, export), the panel shows the plan and an **Approve / Reject** bar — nothing runs until you approve. Reject and the assistant re-plans.
- **One turn at a time per document:** a document-level lock means only one chat can run a CAD turn against the active design at once; a second chat is told to wait rather than interleaving operations into the shared model.
- **Document binding:** a chat binds to the Fusion document it started in; if the active document changes, operations are refused with a clear message rather than landing on the wrong design.
- **Safety boundary:** tool arguments are validated before any geometry is created (a bad call fails cleanly instead of half-building), and tools are risk-classified (read / build / modify / export) with policy metadata (destructive / requires-confirmation / requires-selection / requires-inspection). Runtime rules are enforced: editing existing geometry requires a prior `inspect_model`/`list_faces`/`list_edges`, and selection edits require a prior `get_selection` — otherwise the call is refused and the model is told to inspect first.
- **Context stays lean:** older screenshots are dropped from the conversation history after they've been used and oversized tool results are truncated, so long sessions don't balloon.
- **Tests:** `python tests/test_contracts.py` runs the offline contract suite (no Fusion needed); `tests/SMOKE.md` is the manual in-Fusion checklist.
- All chats share the one active Fusion document (and one CAD builder), so Discard in one chat rolls back the shared geometry and sketch ids — chat isolation is about the conversation, not separate models.
- Requires an active Fusion design in **parametric** (timeline) mode.
