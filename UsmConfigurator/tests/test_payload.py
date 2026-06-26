"""Offline tests for the usm-engine payload mapping (usm/payload.py).

Verified against a real payload captured from the engine's /api/build
(tests/fixtures/engine_build_sample.json) — no Fusion, no network.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from usm import payload  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "engine_build_sample.json")


def _fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def test_quaternion_rotation_of_unit_axes():
    # identity leaves a vector unchanged
    assert payload._qrot([0, 0, 0, 1], (0, 1, 0)) == (0, 1, 0)
    # 90° about Z maps local +Y to the world X axis (the width-tube case)
    out = payload._qrot([0, 0, -math.sqrt(0.5), math.sqrt(0.5)], (0, 1, 0))
    assert abs(out[0] - 1) < 1e-6 and abs(out[1]) < 1e-6 and abs(out[2]) < 1e-6


def test_rk_to_fusion_is_z_up_cm():
    # RealityKit metres (Y-up) -> Fusion cm (Z-up): y(up) becomes z, -z becomes y
    assert payload.rk_to_fusion_cm((0.75, 0.03, -0.35)) == (75.0, 35.0, 3.0)


def test_parse_counts_match_engine_families():
    parsed = payload.parse(_fixture())
    c = parsed["counts"]
    # the fixture is a 2-column x 1-row unit: closed box + a shelf
    assert c["connector"] == 12 and c["support"] == 6
    assert c["tube"] == 20 and c["panel"] == 6


def test_parse_primitive_kinds():
    parsed = payload.parse(_fixture())
    kinds = {}
    for p in parsed["primitives"]:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    # connectors -> spheres; tubes + feet -> cylinders; panels -> boxes
    assert kinds["sphere"] == 12
    assert kinds["cylinder"] == 20 + 6
    assert kinds["panel"] == 6


def test_tube_length_matches_part_id():
    parsed = payload.parse(_fixture())
    for p in parsed["primitives"]:
        if p["kind"] == "cylinder" and p.get("label", "").startswith("Tube 750"):
            assert abs(math.dist(p["p0"], p["p1"]) - 75.0) < 1e-3  # 750 mm -> 75 cm (quat is truncated)
            return
    raise AssertionError("no 750 mm tube primitive found")


def test_panels_are_upright_and_thin():
    parsed = payload.parse(_fixture())
    panels = [p for p in parsed["primitives"] if p["kind"] == "panel"]
    assert panels
    for p in panels:
        assert 0 < p["thickness_cm"] <= 2.0
        assert len(p["corners"]) == 4


def test_panel_colour_applied_to_non_glass():
    parsed = payload.parse(_fixture(), {"panel_rgb": (224, 106, 40)})
    panels = [p for p in parsed["primitives"] if p["kind"] == "panel" and not p["glass"]]
    assert panels and all(tuple(p["rgb"]) == (224, 106, 40) for p in panels)


def test_summary_reports_frame_and_panel_counts():
    parsed = payload.parse(_fixture())
    text = payload.summary_text(parsed)
    assert "frame parts" in text and "panel" in text


def test_parse_tolerates_empty_payload():
    parsed = payload.parse({})
    assert parsed["primitives"] == [] and parsed["counts"] == {}


# -- catalogue part placement ------------------------------------------------

def test_part_size_from_dims_then_id():
    assert payload._part_size_mm("door-element-175x500", [175, 500]) == (175.0, 500.0)
    assert payload._part_size_mm("glass-350x250", []) == (350.0, 250.0)   # parsed from id
    assert payload._part_size_mm("tube-750", []) == (750.0, 750.0)        # single number
    assert payload._part_size_mm("ball-connector", []) == (350.0, 350.0)  # fallback


def test_catalog_primitive_by_family():
    ball = payload.catalog_primitive("ball-connector", "connector", [], 0)
    assert ball["kind"] == "sphere" and ball["frame"]
    tube = payload.catalog_primitive("tube-750", "tube", [], 0)
    assert tube["kind"] == "cylinder"
    assert abs(math.dist(tube["p0"], tube["p1"]) - 75.0) < 1e-6  # 750 mm -> 75 cm
    door = payload.catalog_primitive("door-element-350x500", "door", [350, 500], 0)
    assert door["kind"] == "box"
    assert abs(door["size"][0] - 35.0) < 1e-6 and abs(door["size"][2] - 50.0) < 1e-6  # vertical
    shelf = payload.catalog_primitive("tablar-750", "shelf", [750, 350], 0)
    assert shelf["size"][2] < shelf["size"][0]  # horizontal slab: thin in Z


def test_catalog_primitive_rows_by_index():
    a = payload.catalog_primitive("door-element-350x500", "door", [350, 500], 0)
    b = payload.catalog_primitive("door-element-350x500", "door", [350, 500], 2)
    assert b["center"][0] > a["center"][0]  # later index placed further along X


def test_catalog_primitive_glass_uses_chrome_thin():
    g = payload.catalog_primitive("glass-350x350", "glass", [350, 350], 0)
    assert g["glass"] and g["size"][1] <= payload.GLASS_T * payload.MM_TO_CM + 1e-9


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
