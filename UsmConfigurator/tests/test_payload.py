"""Offline tests for the usm-engine geometry mapping (usm/payload.py).

Verified against a real payload captured from the engine's /api/build
(tests/fixtures/engine_build_sample.json) — no Fusion, no network. No primitives
are fabricated: the add-in places the engine's real placement + real meshes, so
these cover placement extraction and the mesh transform (m/Y-up -> Fusion cm/Z-up).
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


# -- quaternion / frame helpers ---------------------------------------------

def test_quaternion_rotation_of_unit_axes():
    assert payload._qrot([0, 0, 0, 1], (0, 1, 0)) == (0, 1, 0)
    # 90° about Z maps local +Y to world +X (the width-tube case)
    out = payload._qrot([0, 0, -math.sqrt(0.5), math.sqrt(0.5)], (0, 1, 0))
    assert abs(out[0] - 1) < 1e-6 and abs(out[1]) < 1e-6 and abs(out[2]) < 1e-6


def test_rk_to_fusion_is_z_up_cm():
    # RealityKit metres (Y-up) -> Fusion cm (Z-up): up(y)->z, -z->y, scaled x100
    assert payload.rk_to_fusion_cm((0.75, 0.03, -0.35)) == (75.0, 35.0, 3.0)


# -- placement extraction ----------------------------------------------------

def test_placement_parts_extracts_real_parts():
    placed = payload.placement_parts(_fixture())
    # the fixture is a 2-column x 1-row unit (closed + shelf): 44 placed parts
    assert len(placed) == 44
    for p in placed:
        assert p["part"] and len(p["pos"]) == 3 and len(p["quat"]) == 4
    fams = {p["family"] for p in placed}
    assert {"connector", "tube", "support", "panel"} <= fams


def test_unique_part_ids_dedup_preserves_order():
    placed = payload.placement_parts(_fixture())
    ids = payload.unique_part_ids(placed)
    assert len(ids) == len(set(ids))            # unique
    assert "ball-connector-standard" in ids and any(i.startswith("tube-") for i in ids)
    assert len(ids) < len(placed)               # far fewer unique meshes than instances


def test_placement_skips_parts_without_pos():
    payloadlike = {"parts": [
        {"part": "x", "family": "panel", "pos": [0, 0, 0], "quat": [0, 0, 0, 1]},
        {"part": "y", "family": "panel"},  # no pos -> skipped
    ]}
    assert len(payload.placement_parts(payloadlike)) == 1


# -- mesh transform ----------------------------------------------------------

def test_transform_mesh_identity_preserves_native_zup_axes():
    # The part mesh is native Z-up; with an identity pose it maps straight to
    # Fusion (also Z-up), axis-for-axis, scaled m->cm. Up stays up — no tipping.
    flat = payload.transform_mesh([[0.4, 0.3, 0.5]], [0, 0, 0, 1], [0, 0, 0])
    assert flat == [40.0, 30.0, 50.0]


def test_transform_mesh_width_quat_lays_native_z_rod_along_fusion_x():
    # A native +Z rod, rotated by the width-tube quat, should run along Fusion X.
    q = [0, 0, -math.sqrt(0.5), math.sqrt(0.5)]
    flat = payload.transform_mesh([[0.0, 0.0, 1.0]], q, [0, 0, 0])
    assert abs(flat[0] - 100.0) < 1e-4 and abs(flat[1]) < 1e-4 and abs(flat[2]) < 1e-4


def test_transform_mesh_flattens_all_vertices():
    flat = payload.transform_mesh([[0, 0, 0], [0.1, 0.2, 0.3]], [0, 0, 0, 1], [0, 0, 0])
    assert len(flat) == 6


# -- colour / conflict helpers ----------------------------------------------

def test_rgb_for_frame_vs_panel():
    assert payload.rgb_for("tube") == payload.CHROME_RGB
    assert payload.rgb_for("connector") == payload.CHROME_RGB
    assert payload.rgb_for("panel", (224, 106, 40)) == (224, 106, 40)
    assert payload.rgb_for("panel") == payload.DEFAULT_PANEL_RGB


def test_conflict_summary():
    assert payload.conflict_summary({}) == ""
    assert "severe" in payload.conflict_summary({"conflicts": {"counts": {"severe": 1, "warning": 2}}})


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
