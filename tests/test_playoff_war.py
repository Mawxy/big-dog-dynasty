#!/usr/bin/env python3
"""
Invariants of playoff WAR (scripts/playoff_war.py).

Playoff WAR is the only figure on the playoffs page NOT conditioned on the
result — it credits production in a loss. These lock the two decisions that
make it trustworthy. Pure stdlib, no fixtures, no network.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from sleeper_war import build_week, norm_win_shift          # noqa: E402


class TestReplacementBaselineIgnoresLineups(unittest.TestCase):
    """The reason a playoff baseline is safe at all: build_week reads the
    PLAYER POOL, never anyone's starting lineup. A consolation team benching
    its stars cannot move replacement level, because the benched star is still
    in the pool at his real score."""

    SLOTS = {"QB": 2, "RB": 2, "WR": 2, "TE": 1}

    def test_baseline_is_a_function_of_the_pool_only(self):
        pts = {"a": 30.0, "b": 22.0, "c": 14.0, "d": 9.0}
        pos = {k: "QB" for k in pts}
        _, _, repl = build_week(pts, pos, self.SLOTS)
        # two QB slots -> a and b start, c is the best who did not: replacement
        self.assertEqual(repl["QB"], 14.0)

    def test_who_actually_started_is_never_consulted(self):
        """Same pool, and there is no argument that could carry a lineup."""
        pts = {"a": 30.0, "b": 22.0, "c": 14.0, "d": 9.0}
        pos = {k: "QB" for k in pts}
        first = build_week(pts, pos, self.SLOTS)[2]["QB"]
        second = build_week(dict(reversed(list(pts.items()))), pos, self.SLOTS)[2]["QB"]
        self.assertEqual(first, second)

    def test_an_empty_position_falls_back_to_zero(self):
        _, _, repl = build_week({"a": 12.0}, {"a": "QB"}, self.SLOTS)
        self.assertEqual(repl["RB"], 0.0)


class TestPointsToWins(unittest.TestCase):
    """The conversion sigma feeds. Playoff WAR imports sigma from the REGULAR
    season: consolation lineups inflate the playoff-week spread, and a larger
    spread makes every marginal point worth fewer wins."""

    def test_scoring_over_replacement_is_worth_wins(self):
        self.assertGreater(norm_win_shift(20.0, 27.0), 0.0)

    def test_scoring_under_replacement_costs_wins(self):
        self.assertLess(norm_win_shift(-20.0, 27.0), 0.0)

    def test_a_wider_spread_makes_a_point_worth_less(self):
        """This is exactly what an uncorrected playoff sigma would do — 2025
        week 15 measured 41.4 against a regular-season 29.3, which would have
        discounted every quarterfinal by roughly a third."""
        self.assertGreater(norm_win_shift(20.0, 29.3), norm_win_shift(20.0, 41.4))

    def test_replacement_level_production_is_worth_nothing(self):
        self.assertEqual(norm_win_shift(0.0, 27.0), 0.0)

    def test_no_spread_is_not_a_crash(self):
        self.assertEqual(norm_win_shift(20.0, 0.0), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
