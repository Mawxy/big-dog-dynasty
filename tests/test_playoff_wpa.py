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

from playoff_wpa import (ROUND_WEIGHT, mvp_score, shapley_wpa,   # noqa: E402
                         shrink, win_prob, win_shares)


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
    """1 = quarterfinal, 2 = semifinal, 3 = final."""

    def test_later_rounds_count_for_more(self):
        """A bye costs the top seeds a game; without this the award drifts to
        whoever simply played the most rounds."""
        self.assertLess(ROUND_WEIGHT[1], ROUND_WEIGHT[2])
        self.assertLess(ROUND_WEIGHT[2], ROUND_WEIGHT[3])

    def test_quarterfinal_is_the_unit(self):
        self.assertEqual(ROUND_WEIGHT[1], 1.0)

    def test_final_is_double_a_quarterfinal(self):
        self.assertAlmostEqual(ROUND_WEIGHT[3], 2 * ROUND_WEIGHT[1])

    def test_final_is_half_again_a_semifinal(self):
        self.assertAlmostEqual(ROUND_WEIGHT[3], 1.5 * ROUND_WEIGHT[2])


class TestWinShares(unittest.TestCase):
    """Win share is in UNITS OF WINS: one game pays out exactly 1.0 to the
    side that won it. That is what makes "he accounted for 1.4 of his team's
    3 playoff wins" a true sentence rather than a figure of speech.

    The 1.0 is split between LEVERAGE (Shapley WPA) and PRODUCTION (points
    over positional replacement), PRODUCTION_BLEND deciding the mix."""

    # leverage values, production values — deliberately disagreeing
    LEV = [0.40, 0.20, -0.10]
    PAR = [5.0, 30.0, 12.0]

    def test_a_win_pays_exactly_one(self):
        self.assertAlmostEqual(sum(win_shares(self.LEV, self.PAR, True)), 1.0)

    def test_a_loss_pays_nothing(self):
        self.assertEqual(win_shares(self.LEV, self.PAR, False), [0.0, 0.0, 0.0])

    def test_pure_leverage_ignores_production(self):
        a = win_shares(self.LEV, self.PAR, True, blend=0.0)
        b = win_shares(self.LEV, [1.0, 1.0, 1.0], True, blend=0.0)
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y)

    def test_pure_production_ignores_leverage(self):
        a = win_shares(self.LEV, self.PAR, True, blend=1.0)
        b = win_shares([9.0, 1.0, 1.0], self.PAR, True, blend=1.0)
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y)

    def test_the_blend_sits_between_its_ends(self):
        """The reason the blend exists: a big line in a rout claims almost no
        leverage, so production has to speak for it — but not alone."""
        lev = win_shares(self.LEV, self.PAR, True, blend=0.0)[1]
        mid = win_shares(self.LEV, self.PAR, True, blend=0.5)[1]
        prod = win_shares(self.LEV, self.PAR, True, blend=1.0)[1]
        self.assertLess(lev, mid)
        self.assertLess(mid, prod)

    def test_blended_still_pays_exactly_one(self):
        for b in (0.0, 0.25, 0.5, 0.75, 1.0):
            self.assertAlmostEqual(sum(win_shares(self.LEV, self.PAR, True, blend=b)), 1.0)

    def test_a_drag_on_both_counts_gets_nothing(self):
        """Negative on leverage AND below replacement: no slice of the win."""
        shares = win_shares([0.5, -0.2], [20.0, -6.0], True)
        self.assertEqual(shares[1], 0.0)
        self.assertAlmostEqual(shares[0], 1.0)

    def test_a_win_nobody_earned_splits_evenly(self):
        """Every starter under water, carried by the opponent's collapse:
        the win happened, so the credit still has to land."""
        shares = win_shares([-0.3, -0.2, -0.5], [-4.0, -9.0, -2.0], True)
        self.assertAlmostEqual(sum(shares), 1.0)
        self.assertAlmostEqual(shares[0], shares[1])

    def test_missing_production_falls_back_to_leverage(self):
        """Raw dumps unavailable: degrade to the pure-leverage split rather
        than silently mis-weighting."""
        a = win_shares(self.LEV, [], True)
        b = win_shares(self.LEV, None, True, blend=0.0)
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y)

    def test_blowout_and_nailbiter_pay_the_same(self):
        """Two games, same shape of contribution, wildly different drama —
        the same 1.0 gets handed out either way."""
        nail = win_shares([0.30, 0.15, 0.05], self.PAR, True)
        rout = win_shares([0.06, 0.03, 0.01], self.PAR, True)
        for x, y in zip(nail, rout):
            self.assertAlmostEqual(x, y)

    def test_empty_lineup_is_not_a_crash(self):
        self.assertEqual(win_shares([], [], True), [])


class TestMvpScore(unittest.TestCase):
    """The award scale. WPA stays raw; these two adjustments live here."""

    def test_the_record_run_is_a_hundred(self):
        self.assertEqual(mvp_score(0.94, 0.94), 100.0)

    def test_the_scale_is_historical_not_per_season(self):
        """A thin year must score thin. If each season were renormalised to
        its own best, every winner would read 100 and the figure would say
        nothing across years — which is the entire reason it exists."""
        anchor = 0.94                       # best postseason on record
        strong_year_winner = mvp_score(0.897, anchor)
        thin_year_winner = mvp_score(0.418, anchor)
        self.assertGreater(strong_year_winner, 90)
        self.assertLess(thin_year_winner, 50)

    def test_negatives_are_not_floored(self):
        """The bottom table ranks who cost their team — clipping at zero
        would flatten it into a row of ties."""
        self.assertLess(mvp_score(-0.196, 0.94), 0)

    def test_proportional(self):
        self.assertAlmostEqual(mvp_score(0.47, 0.94), 50.0)

    def test_no_anchor_is_not_a_crash(self):
        self.assertEqual(mvp_score(0.5, 0.0), 0.0)


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
