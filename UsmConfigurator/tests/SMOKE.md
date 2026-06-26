# USM Configurator — manual smoke test (in Fusion)

The offline suite (`python tests/test_usm.py`) covers the geometry/preset core.
These steps exercise the Fusion-coupled builder, which needs the host.

1. **Install & run.** Copy the add-in in (or run `install.sh` / `install.ps1`),
   then Utilities → Add-Ins → Scripts and Add-Ins → `UsmConfigurator` → **Run**.
   A **USM Configurator** button appears in the Add-Ins panel.

2. **Open a design** (parametric is the default) and click the button. The dialog
   shows: Preset, Columns/Column width, Rows/Row height, Depth, Ball Ø, Tube Ø,
   Panel thickness, Back panels / Shelves / Vertical dividers, Panel colour.

3. **Custom build.** Leave Preset = *Custom*, defaults (2 columns, 1 row),
   Back panels + Shelves on. **OK.** Expect: a chrome lattice of balls + tubes
   with back panels, and a message box with the bill of materials
   (12 balls, tube count + total length, panel count + area).

4. **Counts sanity.** The BOM ball count must equal
   `(columns+1) × (depths+1) × (rows+1)`. For the defaults that's `3 × 2 × 2 = 12`.

5. **Presets.** Re-open, choose **Sideboard 2x2** → OK. Expect a 1500 × 700 mm
   two-by-two unit with orange back panels and a shelf. Try **Bookshelf Tall**
   (open, no backs, with dividers) and **Accent Shelf (mixed colours)** (two
   differently-coloured back panels).

6. **Colour.** Build with Panel colour = *USM Pure Orange*; the panels should
   render orange (chrome frame unchanged). If your material libraries lack a
   recolourable base appearance, panels build uncoloured — that's the documented
   best-effort fallback, not a failure.

7. **Engine reuse.** With the sibling **ClaudeCad** add-in installed, the BOM
   message has no "engine not found" note and bodies carry a physical material.
   Without it, the note appears and geometry is identical.

8. **Direct vs parametric.** Switch the design to Direct Modelling and build
   again — bodies are added directly (no base feature) and still appear.

9. **Clear.** (Optional, via the API) `UsmBuilder(app).clear()` removes the
   tagged bodies of a previous build and leaves your own geometry untouched.
