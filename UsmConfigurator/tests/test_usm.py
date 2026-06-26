"""Offline contract tests for the USM Configurator — no Fusion (`adsk`) required.

These cover the pure-Python core: grid maths, panel-rule expansion, the bill of
materials, input validation, and the preset catalogue (load / filter / save).
The Fusion-coupled builder (real bodies, appearances) needs the host and is
checked manually (see tests/SMOKE.md).

Run from the add-in root:  python tests/test_usm.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from usm import geometry, presets  # noqa: E402


# -- grid maths --------------------------------------------------------------

def test_cumulative_node_coords():
    assert geometry._cumulative([750, 750, 750]) == [0.0, 750.0, 1500.0, 2250.0]
    assert geometry._cumulative([]) == [0.0]


def test_ball_and_tube_counts_match_grid():
    # 3 columns x 2 rows x 1 depth -> nodes 4 x 3 x 2
    spec = geometry.build_spec([750, 750, 750], [350, 350], [350], {})
    assert spec["bom"]["balls"] == 4 * 2 * 3
    # X edges + Y edges + Z edges
    expected_tubes = (3 * 2 * 3) + (3 * 1 * 4) + (2 * 2 * 4)
    assert spec["bom"]["tubes"] == expected_tubes
    assert spec["bom"]["overall"] == (2250.0, 350.0, 700.0)
    assert spec["bom"]["grid"] == (3, 1, 2)


def test_tube_lengths_are_positive_and_summed():
    spec = geometry.build_spec([500], [400], [300], {})
    assert all(t["length"] > 0 for t in spec["tubes"])
    assert spec["bom"]["tube_total_mm"] == round(sum(t["length"] for t in spec["tubes"]), 1)


# -- panel rules -------------------------------------------------------------

def _faces(spec):
    return [p["face"] for p in spec["panels"]]


def test_back_panels_rule():
    spec = geometry.build_spec([750, 750, 750], [350, 350], [350], {"back_panels": True})
    backs = [p for p in spec["panels"] if p["face"] == "back"]
    assert len(backs) == (3) * (2)  # (nx-1) columns x (nz-1) rows
    # every back panel sits on the rear (max-Y) plane
    ymax = spec["coords"]["y"][-1]
    for p in backs:
        assert abs((p["box"][1] + p["box"][4]) / 2.0 - ymax) < 1e-6


def test_shelves_rule_makes_interior_horizontal_dividers():
    spec = geometry.build_spec([500, 500], [350, 350, 350], [350], {"shelves": True})
    tops = [p for p in spec["panels"] if p["face"] == "top"]
    # interior levels (nz-2) x columns (nx-1) x depth bays (ny-1)
    assert len(tops) == (3 - 1) * (2) * (1)


def test_dividers_rule_makes_vertical_dividers():
    spec = geometry.build_spec([500, 500, 500], [400], [400], {"dividers": True})
    rights = [p for p in spec["panels"] if p["face"] == "right"]
    assert len(rights) == (3 - 1) * 1 * 1  # interior vertical lines


def test_explicit_panel_list_and_dedup():
    opts = {"back_panels": True, "panels": [
        {"ix": 0, "iy": 0, "iz": 0, "face": "back", "color": "USM Ruby Red"},  # duplicates a rule cell
        {"ix": 0, "iy": 0, "iz": 0, "face": "top"},
    ]}
    spec = geometry.build_spec([500, 500], [350], [350], opts)
    # the duplicate back cell collapses to one; the top is separate
    keys = {(p["ix"], p["iy"], p["iz"], p["face"]) for p in spec["panels"]}
    assert (0, 0, 0, "back") in keys and (0, 0, 0, "top") in keys
    assert len(keys) == len(spec["panels"])  # no duplicates


def test_unknown_color_falls_back_to_default():
    cells = geometry.expand_panels(2, 2, 2, {"back_panels": True, "color": "Neon Pink"})
    assert all(c["color"] == geometry.DEFAULT_COLOR for c in cells)


def test_oversized_inset_skips_degenerate_panels():
    # an inset larger than the bay would make a zero/negative panel -> skipped
    spec = geometry.build_spec([40], [40], [40], {"back_panels": True, "panel_inset": 50})
    assert spec["panels"] == []


# -- validation --------------------------------------------------------------

def _rejects(columns, rows, depths=None):
    try:
        geometry.build_spec(columns, rows, depths, {})
        return False
    except ValueError:
        return True


def test_build_spec_rejects_empty_and_nonpositive():
    assert _rejects([], [350])
    assert _rejects([500], [])
    assert _rejects([500, -10], [350])
    assert not _rejects([500], [350])


def test_summary_text_mentions_counts():
    spec = geometry.build_spec([750, 750], [350], [350], {"back_panels": True})
    text = geometry.summary_text(spec)
    assert "Ball connectors" in text and "Tubes" in text and "Panels" in text


# -- presets -----------------------------------------------------------------

def test_bundled_presets_load_and_have_sideboard():
    catalog = presets.load_catalog()
    assert catalog, "bundled preset catalogue should load"
    assert "usm-sideboard" in catalog
    sb = catalog["usm-sideboard"]
    assert sb["columns"] == [750, 750] and sb["back_panels"] is True


def test_every_bundled_preset_builds():
    for entry in presets.list_presets():
        spec = geometry.build_spec(entry["columns"], entry["rows"],
                                   entry.get("depths"), presets.to_options(entry))
        assert spec["bom"]["balls"] > 0, "preset {} produced no geometry".format(entry["id"])


def test_to_options_extracts_only_geometry_fields():
    opts = presets.to_options({"id": "x", "name": "X", "columns": [500], "rows": [350],
                               "back_panels": True, "color": "USM Green", "notes": "hi"})
    assert opts == {"back_panels": True, "color": "USM Green"}


def test_list_presets_filtered_and_sorted():
    shelves = presets.list_presets("bookshelf")
    assert shelves and all("bookshelf" in
        " ".join(str(e.get(k, "")) for k in ("id", "name", "notes")).lower() for e in shelves)
    names = [e.get("name") or e["id"] for e in presets.list_presets()]
    assert names == sorted(names)


def test_save_preset_roundtrip(tmp_home=None):
    old_home = os.environ.get("HOME")
    with tempfile.TemporaryDirectory() as d:
        os.environ["HOME"] = d
        try:
            presets.save_preset({"id": "my-unit", "name": "My Unit",
                                 "columns": [600, 600], "rows": [350], "back_panels": True})
            got = presets.get("my-unit")
            assert got and got["columns"] == [600, 600]
        finally:
            if old_home is not None:
                os.environ["HOME"] = old_home
            else:
                os.environ.pop("HOME", None)


def test_save_preset_requires_columns_and_rows():
    try:
        presets.save_preset({"id": "bad"})
        assert False, "expected missing columns/rows to be rejected"
    except ValueError:
        pass


if __name__ == "__main__":
    failures = 0
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print("ok   ", name)
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print("FAIL ", name, "->", exc)
    print("\n{} passed, {} failed".format(len(tests) - failures, failures))
    sys.exit(1 if failures else 0)
