#!/usr/bin/env python3
"""
Invariants of the six-curve projection matrix.

The matrix exists to publish a DISAGREEMENT between two models. Most of what can
go wrong with it is not an exception — it is the six curves quietly collapsing
into one number, or a composite landing somewhere none of its inputs support.
These lock down the decisions that keep it six curves.

  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from project_matrix import (sleeper_scale, trust_of,             # noqa: E402
                            PAD_PENALTY, PTS13_FLOOR, PTS13_FULL,
                            W_MAX, W_MIN)
# THE composite formula lives in project_war.py and is imported by the matrix,
# not duplicated in it. It used to exist in both, and the copies drifted by the
# corpus->league ratio — the same player read 1.502 on his page and 1.547 on the
# value board. These tests follow it to its one home.
from project_war import BLEND_W, composite_path                   # noqa: E402


def composite(natural, ext, w1, decay):
    """Argument order the older tests were written against."""
    return composite_path(natural, ext, decay, w1)


class TestTrust(unittest.TestCase):
    """`trust` is how much the analog's cohort is worth. It drives both the
    blend of the two naturals and the analog composite's Sleeper weight, so its
    direction is the whole design: tighter cohort -> more analog."""

    D_REF = {"RB": 0.94}

    def t(self, d_med, padded=False):
        return trust_of({"pos": "RB", "d_med": d_med, "padded": padded}, self.D_REF)

    def test_tight_cohort_is_trusted_more_than_a_loose_one(self):
        self.assertGreater(self.t(0.60), self.t(0.94))
        self.assertGreater(self.t(0.94), self.t(1.40))

    def test_at_the_reference_distance_trust_is_one_half(self):
        self.assertAlmostEqual(self.t(0.94), 0.5, places=6)

    def test_bounded_to_the_unit_interval(self):
        for d in (0.01, 0.5, 1.0, 3.76, 50.0):
            self.assertGreaterEqual(self.t(d), 0.0)
            self.assertLessEqual(self.t(d), 1.0)

    def test_an_uncomparable_player_collapses_to_nearly_zero(self):
        # McCaffrey: d_med 3.76 against an RB reference of 0.94, and padded.
        # He has no comparables, and the weight has to say so rather than
        # merely leaning.
        self.assertLess(self.t(3.76, padded=True), 0.01)

    def test_padding_costs_exactly_the_penalty(self):
        self.assertAlmostEqual(self.t(0.94, padded=True),
                               self.t(0.94) * PAD_PENALTY, places=9)

    def test_sleeper_weight_moves_opposite_to_trust(self):
        w = lambda t: W_MIN + (W_MAX - W_MIN) * (1 - t)
        self.assertAlmostEqual(w(1.0), W_MIN, places=9)
        self.assertAlmostEqual(w(0.0), W_MAX, places=9)
        self.assertGreater(w(self.t(3.76, True)), w(self.t(0.60)))


class TestComposite(unittest.TestCase):
    """A composite blends a natural with Sleeper's year-1 read, aged forward
    along the SCALAR path's decay."""

    SCALAR = [1.00, 0.80, 0.60]

    def test_year_one_is_exactly_the_stated_mix(self):
        out = composite([0.40, 0.40, 0.40], 1.40, 0.50, self.SCALAR)
        self.assertAlmostEqual(out[0], 0.5 * 1.40 + 0.5 * 0.40, places=3)

    def test_sleeper_weight_decays_across_the_horizon(self):
        """Sleeper knows this year's depth chart and nothing about year 3, so
        its pull has to shrink. Measured as distance moved off the natural."""
        nat = [0.0, 0.0, 0.0]
        out = composite(nat, 1.0, 0.9, [0.0, 0.0, 0.0])
        self.assertGreater(out[0], out[1])
        self.assertGreater(out[1], out[2])

    def test_zero_weight_returns_the_natural_untouched(self):
        nat = [0.30, 0.20, 0.10]
        self.assertEqual(composite(nat, 9.9, 0.0, self.SCALAR), nat)

    def test_aging_uses_the_scalar_shape_not_the_blended_curve(self):
        """THE McCAFFREY CASE. A curve we distrust enough to down-weight cannot
        also be the curve we borrow a decay shape from. His analog natural fell
        1.752 -> 1.001, and aging Sleeper along that step produced a year-2
        composite of 0.638 — below the natural, below the scalar and below
        Sleeper, supported by nothing."""
        analog = [1.752, 1.001, 0.937]
        scalar = [0.974, 0.979, 0.861]
        out = composite(analog, 1.025, 0.899, scalar)
        self.assertGreater(out[1], 0.95)
        # and it must sit between the two things it is actually mixing
        self.assertGreaterEqual(out[1], min(analog[1], 1.025) - 0.05)
        self.assertLessEqual(out[1], max(analog[1], 1.025) + 0.05)

    def test_a_signed_natural_does_not_flip_the_path(self):
        """The additive-vs-ratio bug project_war.py already hit: a near-zero or
        negative first year makes a ratio decay sign-flip and amplify."""
        out = composite([-0.90, -0.60, -0.30], 0.80, 0.90, [0.01, 0.00, -0.01])
        self.assertTrue(all(abs(v) < 2.0 for v in out), out)
        # year 1 leans on Sleeper, so it must land above the natural
        self.assertGreater(out[0], -0.90)


class TestGates(unittest.TestCase):
    def test_there_is_no_points_floor_on_the_shipped_path(self):
        """This test used to assert the opposite. I had gated Sleeper at 25
        points believing a low projection was an artifact being extrapolated;
        the corpus says it is a real forecast sitting inside the line's support,
        and a backup projected for 32 points IS projected below replacement.
        Projected WAR is production, not worth — the optionality that makes such
        a player valuable is DVI and CVI's job."""
        from project_matrix import SLEEPER_GATE
        self.assertEqual(SLEEPER_GATE, "none")
        self.assertEqual(sleeper_scale(4.28), 1.0)

    def test_the_analog_composite_is_not_the_scalar_composite(self):
        """At the scalar model's flat 0.9 the two composites agree to a mean of
        0.020 WAR — one curve published twice. The trust scaling is what makes
        the analog composite a sixth curve rather than a duplicate."""
        scalar = [1.00, 0.80, 0.60]
        analog = [0.40, 0.40, 0.40]
        sl = 1.30
        flat = composite(analog, sl, BLEND_W[0], scalar)
        trusted = composite(analog, sl, W_MIN + (W_MAX - W_MIN) * (1 - 0.80), scalar)
        self.assertGreater(abs(flat[0] - trusted[0]), 0.15)


class TestSleeperGate(unittest.TestCase):
    """What counts as a Sleeper projection.

    The shipped gate is `none`: every positive projection counts at full
    weight. A floor was tried at 25 points and removed after measuring it — the
    pts->WAR line is fit ON sub-replacement seasons (620 of 1041 QB seasons sit
    below its zero crossing), so a backup's low projection is in-support, not an
    extrapolation. `hard` and `taper` survive only so that measurement can be
    re-run.
    """

    def test_a_forecast_cannot_be_negative_points(self):
        for gate in ("none", "hard", "taper"):
            self.assertEqual(sleeper_scale(-0.31, gate), 0.0, gate)
            self.assertEqual(sleeper_scale(0.0, gate), 0.0, gate)
            self.assertEqual(sleeper_scale(None, gate), 0.0, gate)

    def test_none_admits_every_positive_projection(self):
        for pts in (0.5, 4.28, 24.9, 25.1, 127.0, 271.0):
            self.assertEqual(sleeper_scale(pts, "none"), 1.0, pts)

    def test_hard_is_a_cliff_and_that_is_why_it_lost(self):
        self.assertEqual(sleeper_scale(24.93, "hard"), 0.0)
        self.assertEqual(sleeper_scale(25.10, "hard"), 1.0)

    def test_taper_ramps_between_the_two_anchors(self):
        self.assertEqual(sleeper_scale(PTS13_FLOOR, "taper"), 0.0)
        self.assertEqual(sleeper_scale(PTS13_FULL, "taper"), 1.0)
        mid = sleeper_scale((PTS13_FLOOR + PTS13_FULL) / 2, "taper")
        self.assertAlmostEqual(mid, 0.5, places=6)

    def test_taper_is_monotone(self):
        xs = [26, 40, 60, 90, 120, 128, 200]
        ss = [sleeper_scale(x, "taper") for x in xs]
        self.assertEqual(ss, sorted(ss))


class TestOneOwnerPerNumber(unittest.TestCase):
    """The matrix must not be a second opinion about a number that already has
    an owner — see the note on the composite import above."""

    def test_the_matrix_does_not_define_its_own_composite(self):
        import project_matrix
        self.assertFalse(
            "def composite(" in Path(project_matrix.__file__).read_text(encoding="utf-8"),
            "project_matrix has re-grown its own composite formula")

    def test_scalar_composite_matches_projections_json(self):
        """The shipped gate reads project_war's number verbatim."""
        import json
        from leaguepaths import DataDir
        d = DataDir(Path(__file__).resolve().parent.parent / "data")
        f_s, f_m = d / "projections.json", d / "projections_matrix.json"
        if not (f_s.exists() and f_m.exists()):
            self.skipTest("no built data")
        sc = {str(p["pid"]): p for p in json.loads(f_s.read_text())["players"]}
        for m in json.loads(f_m.read_text())["players"]:
            p = sc.get(m["pid"])
            if not p:
                continue
            self.assertEqual(m["scalar_natural"], p["proj"], m["name"])
            self.assertEqual(m["scalar_composite"], p["composite"], m["name"])


if __name__ == "__main__":
    unittest.main()
