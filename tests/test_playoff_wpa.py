#!/usr/bin/env python3
"""
Invariants of the playoff WPA engine (scripts/playoff_wpa.py).

WPA is what the Playoff MVP is awarded on, so these lock the properties that
make the allocation defensible. Pure stdlib, no fixtures, no network:

  python -m unittest discover -s tests -v

A failure here is a change in what playoff WPA *means*, not a broken test.
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from playoff_wpa import (ROUND_WEIGHT, shapley_wpa, shrink,   # noqa: E402
                         win_prob)


class TestWinProb(unittest.TestCase):
    def test_even_teams_are_a_cointoss(self):
        self.assertAlmostEqual(win_prob(100.0, 400.0, 100.0, 400.0), 0.5)

    def test_favourite_is_favoured(self):
        self.assertGreater(win_prob(120.0, 400.0, 100.0, 400.0), 0.5)

    def test_certainty_when_no_variance_remains(self):
        self.assertAlmostEqual(win_prob(110.0, 0.0, 100.0, 0.0), 1.0)
        self.assertAlmostEqual(win_prob(90.0, 0.0, 100.0, 0.0), 0.0)


class TestShrink(unittest.TestCase):
    def test_no_games_is_the_positional_prior(self):
        self.assertEqual(shrink([], 12.0, 6.0), (12.0, 6.0))

    def test_more_games_pulls_toward_the_players_own_form(self):
        """A 20-point player looks more like himself the longer he does it."""
        few = shrink([20.0] * 2, 10.0, 5.0)[0]
        many = shrink([20.0] * 14, 10.0, 5.0)[0]
        self.assertLess(few, many)
        self.assertLess(many, 20.0)          # never all the way, by design

    def test_sd_has_a_floor(self):
        """Identical weeks must not make a player a certainty — that would
        hand him the entire swing of every game he plays."""
        _, sd = shrink([15.0] * 10, 10.0, 0.0)
        self.assertGreaterEqual(sd, 2.0)


class TestShapleyEfficiency(unittest.TestCase):
    """The property the whole method rests on: a game's realised swing is
    allocated in full to the players who caused it — nothing invented, nothing
    lost."""

    def _case(self, mus, sds, actuals, opp):
        vars_ = [s * s for s in sds]
        vals, base = shapley_wpa(mus, vars_, actuals, opp)
        won = sum(actuals) > opp
        return vals, base, won

    def test_sums_to_the_realised_swing(self):
        mus = [18.0, 14.0, 12.0, 11.0, 9.0]
        sds = [7.0, 6.0, 5.0, 5.0, 4.0]
        actuals = [31.0, 6.0, 15.0, 4.0, 22.0]
        vals, base, won = self._case(mus, sds, actuals, 74.0)
        self.assertAlmostEqual(sum(vals), (1.0 if won else 0.0) - base, places=9)

    def test_sums_to_the_realised_swing_when_losing(self):
        mus = [18.0, 14.0, 12.0]
        sds = [7.0, 6.0, 5.0]
        actuals = [4.0, 3.0, 6.0]
        vals, base, won = self._case(mus, sds, actuals, 90.0)
        self.assertFalse(won)
        self.assertAlmostEqual(sum(vals), 0.0 - base, places=9)

    def test_overperformers_gain_underperformers_lose(self):
        mus = [15.0, 15.0, 15.0]
        sds = [6.0, 6.0, 6.0]
        # one boom, one par, one bust — against a score they just clear
        actuals = [30.0, 15.0, 2.0]
        vals, _, _ = self._case(mus, sds, actuals, 44.0)
        self.assertGreater(vals[0], 0.0)
        self.assertLess(vals[2], 0.0)
        self.assertGreater(vals[0], vals[1])
        self.assertGreater(vals[1], vals[2])

    def test_identical_players_get_identical_credit(self):
        """Symmetry: same distribution, same result, same share."""
        vals, _, _ = self._case([12.0, 12.0], [5.0, 5.0], [20.0, 20.0], 30.0)
        self.assertAlmostEqual(vals[0], vals[1], places=12)

    def test_leverage_beats_volume(self):
        """The point of WPA over raw points: a huge score in a blowout is
        worth less than a modest one that decides a close game."""
        mus, sds = [15.0, 15.0, 15.0], [6.0, 6.0, 6.0]
        # same player line (32) in a rout vs in a one-point win
        rout, _, _ = self._case(mus, sds, [32.0, 30.0, 28.0], 20.0)
        close, _, _ = self._case(mus, sds, [32.0, 10.0, 8.0], 49.0)
        self.assertLess(rout[0], close[0])

    def test_empty_lineup_is_not_a_crash(self):
        vals, base = shapley_wpa([], [], [], 100.0)
        self.assertEqual(vals, [])
        self.assertEqual(base, 0.0)


class TestRoundWeights(unittest.TestCase):
    def test_later_rounds_count_for_more(self):
        """A bye costs the top seeds a game; without this the award drifts to
        whoever simply played the most rounds."""
        self.assertLess(ROUND_WEIGHT[1], ROUND_WEIGHT[2])
        self.assertLess(ROUND_WEIGHT[2], ROUND_WEIGHT[3])

    def test_round_one_is_the_unit(self):
        self.assertEqual(ROUND_WEIGHT[1], 1.0)


class TestPositionNeutrality(unittest.TestCase):
    def test_expected_production_earns_little(self):
        """A superflex QB scoring his usual 25 should not out-earn a TE who
        doubles his own expectation — this is why MVP moved off raw points."""
        qb, _, _ = TestShapleyEfficiency()._case(
            [25.0, 12.0], [8.0, 5.0], [25.0, 12.0], 36.0)
        te, _, _ = TestShapleyEfficiency()._case(
            [25.0, 12.0], [8.0, 5.0], [25.0, 24.0], 36.0)
        self.assertLess(qb[0], te[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
