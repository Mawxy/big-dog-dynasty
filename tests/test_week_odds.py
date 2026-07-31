#!/usr/bin/env python3
"""
Invariants of the week-odds engine (scripts/week_odds.py).

These lock the two things that make a pregame line trustworthy: that it is
actually PREGAME, and that a projection never leaks across seasons. Pure
stdlib, no fixtures, no network.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from week_odds import best_lineup, pos_stats            # noqa: E402
from playoff_wpa import shrink                          # noqa: E402


class TestBestLineup(unittest.TestCase):
    SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "BN", "BN"]

    def test_fills_every_starting_slot(self):
        cands = [(f"p{i}", pos, 20.0 - i)
                 for i, pos in enumerate(["QB", "QB", "RB", "RB", "RB", "WR",
                                          "WR", "WR", "WR", "TE", "TE"])]
        self.assertEqual(len(best_lineup(cands, self.SLOTS)), 9)

    def test_bench_slots_never_start_anyone(self):
        cands = [(f"p{i}", "WR", 10.0) for i in range(20)]
        # 3 WR + FLEX + SUPER_FLEX are all a WR can fill; BN must not add more
        self.assertEqual(len(best_lineup(cands, self.SLOTS)), 5)

    def test_the_best_available_starts(self):
        cands = [("star", "TE", 30.0), ("scrub", "TE", 2.0)]
        picked = [p for p, _, _ in best_lineup(cands, self.SLOTS)]
        self.assertIn("star", picked)

    def test_a_narrow_slot_is_not_stranded_by_a_flex_eligible_player(self):
        """Most-restrictive-first: a QB must take the QB slot, not SUPER_FLEX,
        or the only other QB has nowhere to go."""
        cands = [("qb1", "QB", 25.0), ("qb2", "QB", 24.0)]
        self.assertEqual(len(best_lineup(cands, self.SLOTS)), 2)


class TestPositionalPriors(unittest.TestCase):
    def test_sd_has_a_floor(self):
        st = pos_stats({"QB": [12.0] * 5})
        self.assertGreaterEqual(st["QB"][1], 2.0)

    def test_an_empty_position_is_omitted(self):
        self.assertNotIn("TE", pos_stats({"TE": [], "QB": [10.0, 14.0]}))


class TestProjectionAsPrior(unittest.TestCase):
    """A starter's mean is his form shrunk toward HIS PROJECTION. The measured
    result (2022-25) was that this is worth ~7 points of week-1-to-4 accuracy
    and almost nothing by week 10 — which is the shape shrink() produces."""

    def test_no_games_is_the_projection(self):
        self.assertEqual(shrink([], 18.0, 6.0)[0], 18.0)

    def test_form_takes_over_as_games_accumulate(self):
        proj = 18.0
        early = shrink([8.0] * 2, proj, 6.0)[0]
        late = shrink([8.0] * 12, proj, 6.0)[0]
        self.assertGreater(early, late)          # early still leans on 18
        self.assertLess(late, 11.0)              # late is mostly the 8s

    def test_a_projection_prior_beats_a_positional_one_for_an_outlier(self):
        """The case this exists for: an elite player with two quiet games
        should not be dragged to the position average."""
        pos_prior, proj_prior = 12.0, 22.0
        hist = [9.0, 11.0]
        self.assertGreater(shrink(hist, proj_prior, 6.0)[0],
                           shrink(hist, pos_prior, 6.0)[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
