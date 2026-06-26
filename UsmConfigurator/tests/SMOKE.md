# USM Configurator — manual smoke test (in Fusion)

The offline suite (`python tests/test_usm.py`) covers the geometry/preset core.
These steps exercise the Fusion-coupled builder, which needs the host.

1. **Install & run.** Copy the add-in in (or run `install.sh` / `install.ps1`),
   then Utilities → Add-Ins → Scripts and Add-Ins → `UsmConfigurator` → **Run**.
   A **USM Configurator** button appears in the Add-Ins panel.

2. **Open a design** (parametric is the default). The **USM Haller** palette
   docks on the right (Base forms, Width/Depth modules, Columns/Rows steppers,
   Components, Panel colour, Build/Clear, a live BOM line).

3. **Custom build.** Leave Base = *Open*, defaults (Width 750, 2 columns, 1 row),
   toggle **Back** on, pick a colour, **Build**. Expect: a chrome lattice of
   balls + tubes with back panels, and the BOM line updates to the result
   (12 balls, 20 tubes, panel count + area).

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
