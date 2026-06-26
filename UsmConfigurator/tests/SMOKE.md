# USM Configurator — manual smoke test (in Fusion)

The offline suites cover the pure core: `python tests/test_payload.py` (engine
payload → Fusion primitives, against a real captured `/api/build` payload) and
`python tests/test_usm.py` (offline-fallback geometry/presets). These steps
exercise the live engine path + the Fusion-coupled builder, which need the host.

1. **Install & run.** Copy the add-in in (or run `install.sh` / `install.ps1`),
   then Utilities → Add-Ins → Scripts and Add-Ins → `UsmConfigurator` → **Run**.
   The **USM Haller** palette docks on the right; a **USM Configurator** button is
   in the Add-Ins panel for re-opening it.

2. **Set the engine.** Open **⚙**. The **usm-engine URL** defaults to the known
   deployment; add an auth **token** if your deployment requires one. Click
   **Test** → expect `Engine OK — {"ok":true,...}`. (The add-in runs on your Mac,
   which must be able to reach the engine URL.)

3. **Build.** Defaults (Width 750, Height 350, Depth 350, 2 columns, 1 row, Cell
   = *Closed box*), pick a colour, **Build**. Expect a chrome lattice (balls +
   tubes + feet) with the closed-cell panels, and the status line: *Built N frame
   parts … and M panel(s)*. For these defaults the engine returns 12 connectors,
   20 tubes, 6 feet, 5 panels.

4. **Cell content.** Re-build with Cell = *Shelf*, then *Door*, then *Glass* —
   the placed parts should change accordingly (a horizontal shelf; a front door
   panel; a translucent glass pane). *Open* yields just the frame.

5. **Colour.** Build with Panel colour = *USM Pure Orange* → panels render orange,
   the chrome frame unchanged. If your material libraries lack a recolourable base
   appearance, panels build uncoloured — the documented best-effort fallback.

6. **Conflicts.** Try a tall, shallow unit (e.g. Width 250, Depth 250, Rows 6) →
   the engine flags a tipping warning and the status line reports it.

7. **Engine reuse.** With the sibling **ClaudeCad** add-in installed, bodies carry
   a physical material and there's no "engine not found" note. Without it,
   geometry is identical and the note appears.

8. **Direct vs parametric.** Switch the design to Direct Modelling and build again
   — bodies are added directly (no base feature) and still appear.

9. **Clear.** **Clear** removes the tagged bodies of a previous build and leaves
   your own geometry untouched.

10. **Engine errors.** Set a bad URL in ⚙ and Build → the status line shows a clear
    error (unreachable / HTTP code / auth) rather than failing silently.
