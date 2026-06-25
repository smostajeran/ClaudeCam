# ClaudeCad manual smoke tests (Fusion-coupled)

The offline suite (`python tests/test_contracts.py`) covers the pure-Python surfaces.
The items below need the Fusion host and a human, since they touch real geometry, the
attribute-based rollback, document locking, and the in-place reload. Run after an update.

## Canonical models
1. **Box with lid** — "a 100×60×20 mm box with 3 mm walls, open top" → shell leaves the top open.
2. **Bracket with holes** — "80×40 mm base, 5 mm thick, two 6 mm holes 60 mm apart" → holes land correctly.
3. **Cabinet (parametric, grooved back)** — "600×720×580 mm cabinet, one shelf, screws":
   - 6 bodies (2 sides, bottom, top, back, 1 shelf), positioned to fit.
   - Parameters `cab_w/cab_h/cab_d/cab_t/cab_back` exist (Modify → Change Parameters).
   - Back has a tongue seated into a groove in each side (rotate to inspect the rear corners).
   - `change_parameter cab_h = 800 mm` → cabinet grows in height and stays assembled.
4. **Edit existing face** — select a face in the viewport, "round these edges 2 mm".
5. **Export** — "export as STEP" → file in home folder; a second export auto-suffixes (`_1`).

## Safety / lifecycle
6. **Rollback ownership** — manually sketch+extrude a body in Fusion, THEN build a cabinet,
   THEN Discard. The manually-created body must SURVIVE; only ClaudeCad's panels are removed.
7. **Document lock** — start a build in chat A, switch to chat B mid-build and send a request.
   B should say "ClaudeCad is busy with another chat" rather than interleaving.
8. **Joinery prompt** — "build a cabinet 600×720×580" with no joinery stated → it must ASK
   (screws/dowels/dado/auto) and wait, not build.
9. **Material** — "list wood materials", then "make all panels oak" → all bodies get the material.
10. **Auto-reload** — Settings → Check for updates on a build ≥ 1.7.7 → panel reloads itself;
    Settings shows the new version without a manual Stop/Run.
11. **Context hygiene** — do several capture_view checks in one chat; the conversation keeps
    working (older screenshots are dropped from history, so it doesn't bloat/slow down).
12. **Approval gate** — request a cabinet / hole / export. An approval bar (Approve / Reject)
    must appear and the operation must NOT run until you click Approve. Reject → nothing is
    built and the agent asks what to change. Discard while the bar is shown → turn aborts cleanly.
13. **Document switch** — build in document A, switch the active document to B, send another
    request → expect a clear "active document changed" error, not edits to B.
14. **Undo last** — build a cabinet, then drill some holes, then "undo that" → only the holes
    are removed, the cabinet remains. Then "undo again" → the cabinet is removed.
15. **Cut list / DXF** — "export the cut list" → CSV in home folder with parts + quantities;
    "export DXF panels" → a claudecad_dxf/ folder with one .dxf per panel.
16. **Cabinet fronts (experimental)** — after a cabinet, "add a face frame", "add 2 overlay
    doors", "add 3 drawers" → fronts/boxes appear positioned on the front; check fit.
17. **Components (experimental)** — "make this a real assembly" → each panel becomes its own
    component in the browser tree.


