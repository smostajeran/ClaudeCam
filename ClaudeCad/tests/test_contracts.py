"""Offline contract tests for ClaudeCad — no Fusion (`adsk`) required.

These cover the pure-Python surfaces: tool schema <-> dispatch parity, input validation,
unit conversion, export filename sanitization, history compaction, and the orphan-tool-use
repair. Run from the add-in root:  python -m pytest tests  (or: python tests/test_contracts.py)

The Fusion-coupled behavior (real geometry, attribute-based rollback, in-place reload) is
exercised by the manual smoke tests in tests/SMOKE.md, since it needs the host.
"""

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from claudecad import agent, hardware, policy, tools, updater, util  # noqa: E402


# -- tool schema <-> dispatch parity ----------------------------------------

def _dispatch_names():
    src = __import__("inspect").getsource(tools.execute)
    return set(re.findall(r'name == "([^"]+)"', src))


def test_every_schema_tool_has_a_dispatch_branch():
    schema_names = {t["name"] for t in tools.TOOLS}
    missing = schema_names - _dispatch_names()
    assert not missing, "tools in TOOLS with no execute branch: {}".format(sorted(missing))


def test_every_dispatch_branch_has_a_schema():
    extra = _dispatch_names() - {t["name"] for t in tools.TOOLS}
    assert not extra, "execute branches with no schema in TOOLS: {}".format(sorted(extra))


def test_every_tool_is_risk_classified():
    unclassified = {t["name"] for t in tools.TOOLS} - set(policy.RISK)
    assert not unclassified, "tools missing from policy.RISK: {}".format(sorted(unclassified))


def test_schemas_are_wellformed():
    for t in tools.TOOLS:
        assert t.get("name") and isinstance(t.get("description"), str) and t["description"]
        assert t["input_schema"]["type"] == "object"


# -- input validation -------------------------------------------------------

def _rejects(name, ti):
    try:
        policy.validate(name, ti)
        return False
    except ValueError:
        return True


def test_validation_rejects_nonpositive_and_huge_dimensions():
    assert _rejects("draw_circle", {"radius": 0})
    assert _rejects("draw_circle", {"radius": -5})
    assert _rejects("draw_rectangle", {"width": 10, "height": 0})
    assert _rejects("extrude", {"sketch_id": "s1", "distance": 10_000_000})
    assert _rejects("shell", {"thickness": float("inf")})


def test_validation_rejects_bad_counts_and_sides():
    assert _rejects("draw_polygon", {"sketch_id": "s1", "sides": 2, "radius": 5})
    assert _rejects("circular_pattern", {"count": 0})
    assert _rejects("circular_pattern", {"count": 99999})
    assert _rejects("build_cabinet", {"width": 600, "height": 720, "depth": 580, "shelves": 999})
    assert _rejects("export_model", {"format": "dwg"})


def test_validation_passes_good_input_and_expressions():
    # Real numbers within range, and parameter-expression strings, are accepted.
    policy.validate("draw_circle", {"radius": 5})
    policy.validate("draw_rectangle", {"width": "width", "height": "2 * wall"})
    policy.validate("extrude", {"sketch_id": "s1", "distance": "height"})
    policy.validate("build_cabinet", {"width": 600, "height": 720, "depth": 580, "shelves": 2})
    policy.validate("inspect_model", {})  # read-only tool: nothing to validate


def test_destructive_classification():
    assert policy.is_destructive("combine_bodies")
    assert not policy.is_destructive("inspect_model")
    assert policy.risk("inspect_model") == policy.READ
    assert policy.risk("export_model") == policy.EXPORT


def test_metadata_shape_and_flags():
    m = policy.metadata("cut_hole")
    assert m["risk_level"] == policy.MODIFY
    assert m["requires_confirmation"] and m["requires_inspection"]
    assert policy.metadata("fillet_selection")["requires_selection"]
    assert not policy.metadata("inspect_model")["requires_confirmation"]


# -- runtime ordering rules -------------------------------------------------

def _blocked(name, called):
    try:
        policy.check_prerequisites(name, set(called))
        return False
    except ValueError:
        return True


def test_selection_edit_requires_prior_get_selection():
    assert _blocked("fillet_selection", set())
    assert not _blocked("fillet_selection", {"get_selection"})


def test_index_edit_requires_prior_inspection():
    assert _blocked("cut_hole", set())
    assert _blocked("combine_bodies", {"draw_rectangle", "extrude"})
    assert not _blocked("cut_hole", {"list_faces"})
    assert not _blocked("combine_bodies", {"inspect_model"})


def test_build_tools_have_no_prerequisites():
    for name in ("create_sketch", "draw_circle", "extrude", "build_cabinet"):
        assert not _blocked(name, set())


# -- unit conversion --------------------------------------------------------

def _make_staged(root, version="9.9.9", complete=True):
    os.makedirs(os.path.join(root, "claudecad"), exist_ok=True)
    files = {"ClaudeCad.py": "x", "ClaudeCad.manifest": "{}",
             "VERSION": version + "\n", os.path.join("claudecad", "__init__.py"): ""}
    if not complete:
        del files["VERSION"]
    for rel, content in files.items():
        with open(os.path.join(root, rel), "w") as fh:
            fh.write(content)
    return list(files.keys())


def test_updater_validate_staged_complete_and_version():
    with tempfile.TemporaryDirectory() as d:
        _make_staged(d, "9.9.9")
        assert updater._validate_staged(d, "9.9.9") == "9.9.9"


def test_updater_validate_rejects_incomplete_or_mismatched():
    with tempfile.TemporaryDirectory() as d:
        _make_staged(d, complete=False)
        try:
            updater._validate_staged(d, "9.9.9")
            assert False, "expected incomplete archive to be rejected"
        except RuntimeError:
            pass
    with tempfile.TemporaryDirectory() as d:
        _make_staged(d, "1.0.0")
        try:
            updater._validate_staged(d, "9.9.9")
            assert False, "expected version mismatch to be rejected"
        except RuntimeError:
            pass


def test_updater_install_with_backup_copies_files():
    with tempfile.TemporaryDirectory() as staging, tempfile.TemporaryDirectory() as dest:
        rels = _make_staged(staging, "9.9.9")
        # a pre-existing file in dest should be overwritten (and could be rolled back)
        with open(os.path.join(dest, "VERSION"), "w") as fh:
            fh.write("old\n")
        count = updater._install_with_backup(staging, dest, rels)
        assert count == len(rels)
        with open(os.path.join(dest, "VERSION")) as fh:
            assert fh.read().strip() == "9.9.9"
        assert os.path.isfile(os.path.join(dest, "claudecad", "__init__.py"))


def test_updater_install_rollback_removes_created_dirs_and_chains():
    with tempfile.TemporaryDirectory() as staging, tempfile.TemporaryDirectory() as dest:
        os.makedirs(os.path.join(staging, "pkg"))
        with open(os.path.join(staging, "pkg", "a.txt"), "w") as fh:
            fh.write("a")
        # The 2nd rel has no backing file in staging, so the copy fails after a.txt and the
        # nested dirs (dest/pkg, dest/ghost) have been created.
        rels = [os.path.join("pkg", "a.txt"), os.path.join("ghost", "b.txt")]
        try:
            updater._install_with_backup(staging, dest, rels)
            assert False, "expected the install to fail and roll back"
        except RuntimeError as exc:
            assert exc.__cause__ is not None  # original error preserved via chaining
        # rollback removed the file and the directories it created — dest is clean
        assert not os.path.exists(os.path.join(dest, "pkg"))
        assert not os.path.exists(os.path.join(dest, "ghost"))
        assert os.listdir(dest) == []


def test_turn_guard_one_at_a_time_and_clear():
    g = util.TurnGuard()
    a, b = (1, 0), (2, 0)
    assert g.try_begin(a) is True
    assert g.try_begin(b) is False          # one turn at a time
    assert g.end(b) is False                # only the owner can end
    # Stop/Discard frees the slot by owner even though chat a's worker hasn't ended.
    assert g.clear_owner(1) is True
    assert g.try_begin(b) is True           # b can now run
    # a's stale worker ending must not clobber b's slot.
    assert g.end(a) is False
    assert g.active() == b


def test_unit_conversion_roundtrip():
    assert util.cm_to_mm(util.mm_to_cm(123.4)) == 123.4
    assert util.mm_to_cm(10) == 1.0   # 10 mm == 1 cm
    assert util.cm_to_mm(1) == 10.0


# -- export filename sanitization -------------------------------------------

def test_export_extension():
    assert util.export_extension("step") == ".step"
    assert util.export_extension("STL") == ".stl"
    assert util.export_extension("dwg") is None


def test_export_basename_blocks_traversal_and_absolute_paths():
    assert util.safe_export_basename("../../etc/passwd") == "passwd"
    assert util.safe_export_basename("/etc/shadow") == "shadow"
    assert util.safe_export_basename("a/b/c") == "c"
    assert util.safe_export_basename("my model*v2.step") == "my_model_v2"
    assert util.safe_export_basename("") == "claudecad_export"
    assert util.safe_export_basename("..") == "claudecad_export"
    # the result never contains a path separator
    assert os.sep not in util.safe_export_basename("x/y/../z")


# -- cut-list CSV -----------------------------------------------------------

def test_cut_list_groups_identical_parts_and_quantifies():
    parts = [
        {"name": "Left Side", "length": 720, "width": 580, "thickness": 18, "material": "Plywood"},
        {"name": "Right Side", "length": 720, "width": 580, "thickness": 18, "material": "Plywood"},
        {"name": "Bottom", "length": 564, "width": 574, "thickness": 18, "material": "Plywood"},
    ]
    csv = util.cut_list_csv(parts)
    lines = csv.strip().split("\n")
    assert lines[0].startswith("Qty,Length")
    # the two identical sides collapse to one row with qty 2; bottom is its own row
    assert len(lines) == 3
    sides = [ln for ln in lines if ln.startswith("2,")][0]
    assert "Left Side; Right Side" in sides


def test_cut_list_quotes_cells_with_commas():
    parts = [{"name": "Panel, A", "length": 100, "width": 50, "thickness": 18, "material": "MDF"}]
    csv = util.cut_list_csv(parts)
    assert '"Panel, A"' in csv


def test_bom_numbers_items_and_groups_by_part():
    parts = [
        {"name": "Side", "length": 720, "width": 580, "thickness": 18, "material": "Ply"},
        {"name": "Side", "length": 720, "width": 580, "thickness": 18, "material": "Ply"},
        {"name": "Shelf", "length": 564, "width": 560, "thickness": 18, "material": "Ply"},
    ]
    csv = util.bom_csv(parts)
    lines = csv.strip().split("\n")
    assert lines[0].startswith("Item,Qty,Part")
    assert len(lines) == 3  # header + 2 grouped rows
    assert lines[1].startswith("1,2,Side")  # item 1, qty 2
    assert lines[2].startswith("2,1,Shelf")


# -- history compaction -----------------------------------------------------

def _img_msg():
    return {"role": "user", "content": [{
        "type": "tool_result", "tool_use_id": "t1",
        "content": [{"type": "text", "text": "Current viewport:"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}],
    }]}


def test_compaction_strips_old_screenshots_but_keeps_recent():
    msgs = [_img_msg() for _ in range(8)]
    agent._compact_history(msgs, keep_tail=3)
    # Older messages: image replaced with a text placeholder.
    old_blocks = msgs[0]["content"][0]["content"]
    assert all(b["type"] != "image" for b in old_blocks)
    assert any("omitted" in b.get("text", "") for b in old_blocks)
    # Recent tail untouched: image still present.
    recent_blocks = msgs[-1]["content"][0]["content"]
    assert any(b["type"] == "image" for b in recent_blocks)


def test_compaction_truncates_huge_text_results():
    big = "x" * 20000
    msgs = [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": big}]}
            for _ in range(8)]
    agent._compact_history(msgs, keep_tail=2)
    assert len(msgs[0]["content"][0]["content"]) < len(big)
    assert msgs[0]["content"][0]["content"].endswith("[truncated to save context]")


# -- orphan tool_use repair -------------------------------------------------

def test_strip_orphan_tool_use_keeps_text_drops_unanswered_call():
    messages = [
        {"role": "user", "content": "make a box"},
        {"role": "assistant", "content": [
            {"type": "text", "text": "Sure."},
            {"type": "tool_use", "id": "abc", "name": "extrude", "input": {}},
        ]},
        # no tool_result follows -> the tool_use is orphaned
    ]
    repaired = agent._strip_orphan_tool_uses(messages)
    last = repaired[-1]
    assert all(b["type"] != "tool_use" for b in last["content"])
    assert any(b["type"] == "text" for b in last["content"])


def test_build_user_content_plain_text():
    assert agent._build_user_content("make a box") == "make a box"
    assert agent._build_user_content("make a box", None) == "make a box"


def test_build_user_content_with_image():
    content = agent._build_user_content("build this", {"media_type": "image/jpeg", "data": "QUJD"})
    assert isinstance(content, list) and len(content) == 2
    assert content[0]["type"] == "image"
    assert content[0]["source"]["data"] == "QUJD"
    assert content[1]["type"] == "text" and content[1]["text"] == "build this"


def test_build_user_content_image_default_prompt():
    content = agent._build_user_content("", {"media_type": "image/png", "data": "QUJD"})
    assert content[1]["text"]  # falls back to a default build instruction when text is empty


def test_hardware_catalog_loads_and_has_a_hinge():
    catalog = hardware.load_catalog()
    assert catalog, "bundled hardware catalog should load"
    assert "euro_hinge_cup_35" in catalog
    cup = catalog["euro_hinge_cup_35"]
    assert cup["holes"][0]["diameter"] == 35.0


def test_hardware_grouped_holes_anchors_and_groups_by_bore():
    entry = {"holes": [
        {"du": 0, "dv": 0, "diameter": 35, "depth": 12},
        {"du": -64, "dv": 0, "diameter": 5},
        {"du": 64, "dv": 0, "diameter": 5},
    ]}
    groups = hardware.grouped_holes(entry, 100, 50)
    assert groups[(35.0, 12.0)] == [(100, 50)]
    assert sorted(groups[(5.0, None)]) == [(36, 50), (164, 50)]  # anchored at u=100, +/-64


def test_hardware_list_filter():
    hinges = hardware.list_hardware("hinge")
    assert hinges and all("hinge" in
        " ".join(str(e.get(k, "")) for k in ("id", "brand", "category", "name")).lower() for e in hinges)


def test_strip_orphan_keeps_properly_answered_tool_use():
    messages = [
        {"role": "assistant", "content": [{"type": "tool_use", "id": "abc", "name": "extrude", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "abc", "content": "ok"}]},
    ]
    repaired = agent._strip_orphan_tool_uses(messages)
    assert any(b.get("type") == "tool_use" for b in repaired[0]["content"])


# -- mock CadBuilder: dispatch wiring end-to-end (no Fusion) -----------------

class MockCad:
    """Records calls; any method name returns a status string (mimics CadBuilder's API)."""
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return "ok:" + name
        return record


# One valid sample input per tool, used to drive execute() against the mock.
SAMPLES = {
    "create_parameter": {"name": "width", "expression": "40 mm"},
    "create_sketch": {},
    "draw_rectangle": {"sketch_id": "s1", "width": 10, "height": 20},
    "draw_circle": {"sketch_id": "s1", "radius": 5},
    "draw_line": {"sketch_id": "s1", "x1": 0, "y1": 0, "x2": 10, "y2": 0},
    "extrude": {"sketch_id": "s1", "distance": 10},
    "revolve": {"sketch_id": "s1"},
    "fillet_all_edges": {"radius": 2},
    "chamfer_all_edges": {"distance": 2},
    "shell": {"thickness": 2},
    "circular_pattern": {"count": 4},
    "rectangular_pattern": {"count_x": 3, "spacing_x": 10},
    "capture_view": {},
    "inspect_model": {},
    "list_faces": {},
    "list_edges": {},
    "change_parameter": {"name": "width", "expression": "50 mm"},
    "fillet_edges": {"edge_indices": [0, 1], "radius": 2},
    "chamfer_edges": {"edge_indices": [0], "distance": 2},
    "cut_hole": {"face_index": 0, "diameter": 6},
    "combine_bodies": {"target_index": 0, "tool_indices": [1]},
    "move_body": {"body_index": 0, "dx": 5},
    "draw_polygon": {"sketch_id": "s1", "sides": 6, "radius": 10},
    "export_model": {"format": "step"},
    "loft": {"sketch_ids": ["s1", "s2"]},
    "sweep": {"profile_sketch_id": "s1", "path_sketch_id": "s2"},
    "mesh_to_solid": {},
    "add_thread": {"face_index": 0},
    "get_mass_properties": {},
    "set_material": {"name": "Steel"},
    "list_materials": {},
    "get_selection": {},
    "fillet_selection": {"radius": 2},
    "chamfer_selection": {"distance": 2},
    "cut_hole_selection": {"diameter": 6},
    "build_cabinet": {"width": 600, "height": 720, "depth": 580, "joinery": "screws"},
    "build_kitchen_cabinet": {"width": 600, "cabinet_type": "base", "front": "doors", "joinery": "screws"},
    "drill_holes": {"body_index": 0, "holes": [{"x": 10, "y": 37, "z": 100, "axis": "x", "depth": 12, "diameter": 5}]},
    "drill_holes_on_face": {"body_index": 0, "face_index": 2, "diameter": 5, "depth": 12,
                            "points": [{"u": 37, "v": 100}, {"u": 37, "v": 132}]},
    "add_face_frame": {"width": 600, "height": 720},
    "add_doors": {"width": 600, "height": 720, "count": 2},
    "add_drawers": {"width": 600, "height": 720, "depth": 580, "count": 3},
    "promote_to_components": {},
    "export_dxf": {},
    "rename_body": {"body_index": 0, "name": "Lid"},
    "explode_assembly": {"factor": 0.6},
    "animate_assembly": {"steps": 12, "direction": "assemble"},
    "reassemble": {},
    "export_bom": {},
    "list_hardware": {},
    "hardware_info": {"hardware_id": "euro_hinge_cup_35"},
    "drill_for_hardware": {"hardware_id": "euro_hinge_cup_35", "body_index": 0, "face_index": 2, "u": 100, "v": 100},
    "add_hardware": {"id": "my_part", "holes": [{"du": 0, "dv": 0, "diameter": 5, "depth": 12}]},
    "import_model": {"path": "/tmp/part.step"},
    "place_hardware": {"hardware_id": "euro_hinge_cup_35"},
    "undo_last": {},
    "export_cut_list": {},
    "get_design_summary": {},
}


def test_samples_cover_every_tool():
    assert SAMPLES.keys() == {t["name"] for t in tools.TOOLS}


# Tools that are served by the catalog module directly, not the CadBuilder.
_MODULE_TOOLS = {"list_hardware", "hardware_info", "add_hardware"}


def test_execute_routes_every_tool_to_a_cad_method():
    for name in SAMPLES:
        cad = MockCad()
        result = tools.execute(name, SAMPLES[name], cad)
        assert result is not None, "execute({}) returned None".format(name)
        if name not in _MODULE_TOOLS:
            assert cad.calls, "execute({}) did not call any CadBuilder method".format(name)


def test_execute_validates_before_dispatch():
    cad = MockCad()
    try:
        tools.execute("draw_circle", {"sketch_id": "s1", "radius": -1}, cad)
        assert False, "expected validation to reject a negative radius"
    except ValueError:
        pass
    assert not cad.calls, "no CAD method should run when validation fails"


if __name__ == "__main__":
    failures = 0
    for fn_name, fn in sorted(globals().items()):
        if fn_name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok   ", fn_name)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print("FAIL ", fn_name, "->", exc)
    print("\n{} passed, {} failed".format(
        sum(1 for n, f in globals().items() if n.startswith("test_") and callable(f)) - failures, failures))
    sys.exit(1 if failures else 0)
