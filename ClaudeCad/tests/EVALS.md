# ClaudeCad agent evals (canonical CAD requests)

A checklist of representative prompts with the tool sequence we expect the agent to use.
Run these in Fusion (or against a recorded transcript) to catch regressions in planning,
ordering rules, the approval gate, and parametric output. Tool names refer to `tools.TOOLS`.

Legend: → ordered calls; [approve] = the preview/approve gate should appear.

1. **Simple box**
   - Prompt: "a 100×60×20 mm box with 3 mm walls, open top"
   - Expect: create_parameter ×(dims) → create_sketch → draw_rectangle → extrude → shell(remove_top=true) → capture_view → asks to approve.

2. **Bracket with holes**
   - Prompt: "80×40 mm base, 5 mm thick, two 6 mm holes 60 mm apart"
   - Expect: parameters → sketch → draw_rectangle → extrude → list_faces → cut_hole ×2 (each [approve], inspection satisfied by list_faces) → capture_view.

3. **Cabinet with shelves (parametric, grooved back)**
   - Prompt: "600×720×580 mm cabinet, 1 shelf"
   - Expect: agent ASKS joinery first (no guess) → build_cabinet [approve] → reports cab_w/cab_h/cab_d/cab_t/cab_back + cut list + groove back.

4. **Resize a built cabinet**
   - Prompt: "make it 800 tall"
   - Expect: inspect_model → change_parameter(cab_h, "800 mm") (inspection satisfied) → capture_view.

5. **Edit selected face**
   - Prompt (with a face picked): "cut a 10 mm hole here"
   - Expect: get_selection → cut_hole_selection [approve] (selection prerequisite satisfied).

6. **Fillet selected edges**
   - Prompt (edges picked): "round these 2 mm"
   - Expect: get_selection → fillet_selection.

7. **Edit without inspecting (negative)**
   - Prompt: "move body 2 up 10 mm" with no prior inspection
   - Expect: move_body is REFUSED with a message to inspect first → agent calls inspect_model → retries move_body [approve].

8. **Discard after user geometry**
   - Build something, manually add a body in Fusion, then Discard.
   - Expect: only ClaudeCad's tagged features are removed; the manual body survives.

9. **Switch Fusion document mid-session**
   - Build in doc A, switch active document to B, send another request.
   - Expect: a clear "the active document changed" error, not silent edits to B.

10. **Export**
    - Prompt: "export as STEP"
    - Expect: export_model [approve] → file in home folder; a second export auto-suffixes (_1).

11. **Reject flow**
    - At any [approve], click Reject.
    - Expect: nothing is built; agent asks what to change and re-plans.
