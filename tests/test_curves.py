"""
Locks the curve layer: the vocabulary, the lookup, and the one equivalence that
makes this change reviewable — scalar_composite must reproduce, exactly, the
hardcoded projections.json path DVI and CVI used before curves.py existed.

Without that lock, a repricing bug and an intended model change look identical
in the output diff.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from curves import CURVES, DEFAULT_CURVE, fallback_flags, war_reader  # noqa: E402


def _write(d, name, obj):
    (d / name).write_text(json.dumps(obj), encoding="utf-8")


@pytest.fixture
def data_dir(tmp_path):
    """A minimal league dir: three players, one of them absent from the matrix."""
    _write(tmp_path, "projections.json", {"players": [
        {"pid": "1", "name": "A", "composite": [1.0, 0.9, 0.8]},
        {"pid": "2", "name": "B", "composite": [0.5, 0.4, 0.3]},
        {"pid": "3", "name": "C", "composite": [0.2, 0.2, 0.2]},
    ]})
    _write(tmp_path, "projections_matrix.json", {"players": [
        {"pid": "1", "has_analog": True, "has_sleeper": True,
         "scalar_natural": [1.1, 1.0, 0.9], "scalar_composite": [1.0, 0.9, 0.8],
         "analog_natural": [1.4, 1.3, 1.2], "analog_composite": [1.3, 1.2, 1.1],
         "blend_natural": [1.25, 1.15, 1.05], "blend_composite": [1.15, 1.05, 0.95]},
        # no analog cohort: its analog/blend curves ARE the scalar curve
        {"pid": "2", "has_analog": False, "has_sleeper": True,
         "scalar_natural": [0.6, 0.5, 0.4], "scalar_composite": [0.5, 0.4, 0.3],
         "analog_natural": [0.6, 0.5, 0.4], "analog_composite": [0.5, 0.4, 0.3],
         "blend_natural": [0.6, 0.5, 0.4], "blend_composite": [0.5, 0.4, 0.3]},
    ]})
    return tmp_path


def test_default_is_blend_composite():
    """The published default. Changing it reprices the whole site, so it should
    take a failing test to do it by accident."""
    assert DEFAULT_CURVE == "blend_composite"
    assert DEFAULT_CURVE in CURVES


def test_curve_vocabulary_matches_the_frontend():
    """CURVES mirrors MATRIX_CURVES in src/lib/types.ts. Two lists, one meaning:
    if they drift, the site asks for a curve the pipeline never wrote."""
    ts = (ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
    block = ts.split("MATRIX_CURVES = [", 1)[1].split("]", 1)[0]
    assert [c.strip().strip('",') for c in block.split() if c.strip().strip('",')] == list(CURVES)


def test_reader_returns_year_one_of_the_named_curve(data_dir):
    assert war_reader(data_dir, "analog_composite")["1"] == 1.3
    assert war_reader(data_dir, "blend_natural")["1"] == 1.25
    assert war_reader(data_dir, "scalar_composite")["1"] == 1.0


def test_scalar_composite_equals_the_old_hardcoded_path(data_dir):
    """THE equivalence lock. Every player's scalar_composite year-1 value must
    equal projections.json's own composite[0] — the expression both indices
    carried before this layer existed."""
    scalar = war_reader(data_dir, "scalar_composite")
    for p in json.loads((data_dir / "projections.json").read_text())["players"]:
        assert scalar[p["pid"]] == p["composite"][0], p["pid"]


def test_player_missing_from_the_matrix_falls_back(data_dir):
    """pid 3 is in projections.json only. It must read as its own composite on
    every curve rather than vanishing or reading zero — zero is a real WAR and
    would price him as replacement level instead of as unknown."""
    for curve in CURVES:
        assert war_reader(data_dir, curve)["3"] == 0.2


def test_no_analog_cohort_means_the_curves_repeat(data_dir):
    """pid 2 has has_analog false, so its analog and blend WAR are the scalar
    WAR. This is a claim about the PROJECTION only — the published DVI still
    moves, because both indices clamp on percentiles of the whole field."""
    by = {c: war_reader(data_dir, c)["2"] for c in CURVES}
    assert by["analog_composite"] == by["scalar_composite"] == by["blend_composite"]
    assert by["analog_natural"] == by["scalar_natural"] == by["blend_natural"]


def test_fallback_flags_read_both_columns(data_dir):
    flags = fallback_flags(data_dir)
    assert flags["1"] == (True, True)
    assert flags["2"] == (False, True)
    assert "3" not in flags


def test_missing_matrix_falls_back_everywhere(tmp_path):
    """A deploy whose data predates the matrix still builds, on the scalar
    composite that was the only curve then."""
    _write(tmp_path, "projections.json", {"players": [
        {"pid": "1", "composite": [0.7, 0.6, 0.5]}]})
    for curve in CURVES:
        assert war_reader(tmp_path, curve) == {"1": 0.7}


def test_unknown_curve_is_rejected(data_dir):
    with pytest.raises(ValueError, match="unknown curve"):
        war_reader(data_dir, "vibes_composite")
