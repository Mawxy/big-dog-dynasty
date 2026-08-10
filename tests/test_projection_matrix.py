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

from project_matrix import (composite, trust_of,                  # noqa: E402
                            PAD_PENALTY, PTS13_FLOOR, W_MAX, W_MIN)
from project_war import BLEND_W                                   # noqa: E402


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
    def test_pts13_floor_is_not_a_null_check(self):
        """A `pts13` of 0, 1 or 9 is Sleeper having no opinion, not a forecast
        of nearly zero points. The pts->WAR line crosses zero near 127 points,
        so treating those as real prices a benchable backup at about -1.37 WAR."""
        self.assertGreater(PTS13_FLOOR, 10.0)

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


if __name__ == "__main__":
    unittest.main()
