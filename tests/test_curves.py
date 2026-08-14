#!/usr/bin/env python3
"""Locks the curve layer: the vocabulary, the lookup, and the one equivalence
that makes this change reviewable.

DVI and CVI used to read one hardcoded number — projections.json's
`composite[0]`, the scalar model's year-1 composite. They now read whichever of
the six curves in projections_matrix.json is asked for. The equivalence pinned
below is that `scalar_composite` reproduces the old expression EXACTLY, because
without it a repricing bug and an intended model change look identical in the
output diff.

  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from curves import CURVES, DEFAULT_CURVE, fallback_flags, war_reader  # noqa: E402


def _write(d, name, obj):
    (d / name).write_text(json.dumps(obj), encoding="utf-8")


class CurveVocabulary(unittest.TestCase):
    def test_default_is_blend_composite(self):
        """The published default. Changing it reprices the whole site, so it
        should take a failing test to do it by accident."""
        self.assertEqual(DEFAULT_CURVE, "blend_composite")
        self.assertIn(DEFAULT_CURVE, CURVES)

    def test_vocabulary_matches_the_frontend(self):
        """CURVES mirrors MATRIX_CURVES in src/lib/types.ts. Two lists, one
        meaning: if they drift, the site asks for a curve the pipeline never
        wrote, and the figures silently fall back."""
        ts = (ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
        block = ts.split("MATRIX_CURVES = [", 1)[1].split("]", 1)[0]
        names = [c.strip().strip('",') for c in block.split() if c.strip().strip('",')]
        self.assertEqual(names, list(CURVES))

    def test_default_matches_the_frontend(self):
        """lib/model.ts publishes the same default to the masthead control."""
        ts = (ROOT / "src" / "lib" / "model.ts").read_text(encoding="utf-8")
        line = [l for l in ts.splitlines() if "DEFAULT_CURVE" in l and "=" in l][0]
        self.assertIn(DEFAULT_CURVE, line)


class CurveReader(unittest.TestCase):
    """A minimal league dir: three players, one of them absent from the matrix."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.d = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        _write(self.d, "projections.json", {"players": [
            {"pid": "1", "name": "A", "composite": [1.0, 0.9, 0.8]},
            {"pid": "2", "name": "B", "composite": [0.5, 0.4, 0.3]},
            {"pid": "3", "name": "C", "composite": [0.2, 0.2, 0.2]},
        ]})
        _write(self.d, "projections_matrix.json", {"players": [
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

    def test_returns_year_one_of_the_named_curve(self):
        self.assertEqual(war_reader(self.d, "analog_composite")["1"], 1.3)
        self.assertEqual(war_reader(self.d, "blend_natural")["1"], 1.25)
        self.assertEqual(war_reader(self.d, "scalar_composite")["1"], 1.0)

    def test_scalar_composite_equals_the_old_hardcoded_path(self):
        """THE equivalence lock. Every player's scalar_composite year-1 value
        must equal projections.json's own composite[0] — the expression both
        indices carried before this layer existed."""
        scalar = war_reader(self.d, "scalar_composite")
        for p in json.loads((self.d / "projections.json").read_text())["players"]:
            self.assertEqual(scalar[p["pid"]], p["composite"][0], p["pid"])

    def test_player_missing_from_the_matrix_falls_back(self):
        """pid 3 is in projections.json only. It must read as its own composite
        on every curve rather than vanishing or reading zero — zero is a real
        WAR and would price him as replacement level instead of as unknown."""
        for curve in CURVES:
            self.assertEqual(war_reader(self.d, curve)["3"], 0.2, curve)

    def test_no_analog_cohort_means_the_curves_repeat(self):
        """pid 2 has has_analog false, so its analog and blend WAR are the
        scalar WAR. This is a claim about the PROJECTION only — the published
        DVI still moves, because both indices clamp on percentiles of the whole
        field and changing the model reprices everyone around him."""
        by = {c: war_reader(self.d, c)["2"] for c in CURVES}
        self.assertEqual(by["analog_composite"], by["scalar_composite"])
        self.assertEqual(by["blend_composite"], by["scalar_composite"])
        self.assertEqual(by["analog_natural"], by["scalar_natural"])
        self.assertEqual(by["blend_natural"], by["scalar_natural"])

    def test_fallback_flags_read_both_columns(self):
        flags = fallback_flags(self.d)
        self.assertEqual(flags["1"], (True, True))
        self.assertEqual(flags["2"], (False, True))
        self.assertNotIn("3", flags)

    def test_unknown_curve_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown curve"):
            war_reader(self.d, "vibes_composite")


class MissingMatrix(unittest.TestCase):
    def test_falls_back_everywhere(self):
        """A deploy whose data predates the matrix still builds, on the scalar
        composite that was the only curve then."""
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            _write(d, "projections.json", {"players": [
                {"pid": "1", "composite": [0.7, 0.6, 0.5]}]})
            for curve in CURVES:
                self.assertEqual(war_reader(d, curve), {"1": 0.7}, curve)


if __name__ == "__main__":
    unittest.main()
