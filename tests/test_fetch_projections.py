#!/usr/bin/env python3
"""
Invariants of the Sleeper projection pull (scripts/fetch_projections.py).

THE CURRENT WEEK'S FLOOR. `get(...) or []` swallows a 404 or an empty body for
one position on one week, and the existing `empty` guard only notices a
position missing from ALL eighteen. So if the live week's QB call fails, every
QB simply has no line for that week — and week_odds prices "no line for this
week" at 0.00 (Max, 2026-09-15) and its snapshot is first-write-wins, which
freezes the zeros as that week's pregame record forever. `thin_week_positions`
catches it before anything is written; `current_regular_week` decides whether
there is a live week to check at all.

`score_line` is the other half: league points for a projected stat line, with
the TE reception premium applied to tight ends and nobody else.

No network — every input here is a dict.

  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from fetch_projections import (MIN_WEEK_LINES, current_regular_week,  # noqa: E402
                               score_line, thin_week_positions)


# Big Dog: PPR with a half-point TE reception premium.
SCORING = {"pass_yd": 0.04, "pass_td": 4.0, "pass_int": -2.0,
           "rush_yd": 0.1, "rush_td": 6.0, "rec": 1.0, "rec_yd": 0.1,
           "rec_td": 6.0, "bonus_rec_te": 0.5}


# the thinnest real week on the committed 2026 file, per position
FULL = {"QB": 32, "RB": 94, "WR": 156, "TE": 97}


def board(counts=None, week=2, other_weeks=(1, 3), drop=()):
    """A proj_sleeper-shaped players dict: `counts` players per position, each
    carrying a line for `week` and for the other weeks — so the existing
    all-eighteen-weeks guard would never fire and only the live-week check can.
    A position in `drop` keeps its other weeks and loses this one, which is
    exactly what a failed position-week call leaves behind."""
    out, n = {}, 0
    for pos, k in (FULL if counts is None else counts).items():
        for _ in range(k):
            n += 1
            wkmap = {str(w): 10.0 for w in other_weeks}
            if pos not in drop:
                wkmap[str(week)] = 12.0
            out[f"p{n}"] = {"pos": pos, "wk": wkmap}
    return out


class TestCurrentRegularWeek(unittest.TestCase):

    def test_the_live_regular_season_week(self):
        state = {"season": "2026", "season_type": "regular", "week": 3}
        self.assertEqual(current_regular_week(state, 2026), 3)
        self.assertEqual(current_regular_week(state, "2026"), 3)

    def test_the_preseason_and_offseason_have_no_week_to_check(self):
        """Every week of a season that hasn't started is equally preseason;
        there is no 'this week' whose gap would freeze into a snapshot."""
        for st in ("pre", "post", "off", None):
            state = {"season": "2026", "season_type": st, "week": 3}
            self.assertEqual(current_regular_week(state, 2026), 0, st)

    def test_another_season_is_not_this_one(self):
        state = {"season": "2026", "season_type": "regular", "week": 3}
        self.assertEqual(current_regular_week(state, 2025), 0)

    def test_no_state_at_all_checks_nothing(self):
        self.assertEqual(current_regular_week(None, 2026), 0)
        self.assertEqual(current_regular_week({}, 2026), 0)

    def test_a_junk_week_is_no_week(self):
        for w in (None, 0, "", "soon"):
            state = {"season": "2026", "season_type": "regular", "week": w}
            self.assertEqual(current_regular_week(state, 2026), 0, repr(w))


class TestThinWeekPositions(unittest.TestCase):

    def test_a_full_week_is_clean(self):
        self.assertEqual(thin_week_positions(board(), 2), {})

    def test_a_position_that_came_back_empty_is_caught(self):
        """THE BUG: one failed position-week call, and every QB prices at 0.00
        for that week — in the matchup line, in the season sim, and frozen in
        the odds snapshot."""
        got = thin_week_positions(board(drop=("QB",)), 2)
        self.assertEqual(got, {"QB": 0})

    def test_a_position_that_came_back_partial_is_caught_too(self):
        got = thin_week_positions(board({**FULL, "TE": 4}), 2)
        self.assertEqual(got, {"TE": 4})

    def test_several_thin_positions_are_all_named(self):
        got = thin_week_positions(board({**FULL, "RB": 3}, drop=("QB",)), 2)
        self.assertEqual(sorted(got), ["QB", "RB"])

    def test_the_floor_sits_under_a_real_bye_heavy_week(self):
        """Measured on the committed 2026 file: QB is the thinnest position-
        week at 28-32 lines. The floor must clear a genuine week comfortably."""
        self.assertLess(MIN_WEEK_LINES, 28)
        self.assertGreater(MIN_WEEK_LINES, 0)
        self.assertEqual(thin_week_positions(board({**FULL, "QB": 28}), 2), {})

    def test_a_players_other_weeks_do_not_cover_for_the_one_asked_about(self):
        players = board(week=2, other_weeks=(1, 3), drop=("QB",))
        self.assertEqual(thin_week_positions(players, 2), {"QB": 0})
        self.assertEqual(thin_week_positions(players, 3), {})

    def test_a_row_with_no_week_map_counts_for_nothing(self):
        """`src:"season"` rows carry a season total and no weekly lines."""
        players = {f"s{i}": {"pos": "QB", "ppg": 15.0} for i in range(40)}
        self.assertEqual(thin_week_positions(players, 2)["QB"], 0)


class TestScoreLine(unittest.TestCase):

    def test_scoring_dotted_with_the_stat_line(self):
        stats = {"pass_yd": 300, "pass_td": 2, "pass_int": 1}
        self.assertAlmostEqual(score_line(stats, SCORING, "QB"),
                               300 * 0.04 + 2 * 4.0 - 2.0, places=9)

    def test_the_te_premium_applies_to_tight_ends_only(self):
        stats = {"rec": 6, "rec_yd": 70}
        te = score_line(stats, SCORING, "TE")
        wr = score_line(stats, SCORING, "WR")
        self.assertAlmostEqual(te - wr, 6 * 0.5, places=9)

    def test_a_null_reception_count_does_not_raise(self):
        """The guard is on the STAT, not the product: `scoring * stats.get(...)
        or 0.0` binds `or` to the product and still raises on a present null."""
        self.assertEqual(score_line({"rec": None}, SCORING, "TE"), 0.0)
        self.assertEqual(score_line({}, SCORING, "TE"), 0.0)

    def test_stats_the_league_does_not_score_are_ignored(self):
        self.assertEqual(score_line({"adp_dd_ppr": 42, "gp": 17}, SCORING, "WR"),
                         0.0)

    def test_a_non_numeric_stat_is_ignored_rather_than_crashing(self):
        self.assertAlmostEqual(score_line({"rec_yd": "lots", "rec": 3},
                                          SCORING, "WR"), 3.0, places=9)

    def test_a_league_with_no_te_premium_scores_a_te_like_anyone_else(self):
        plain = {k: v for k, v in SCORING.items() if k != "bonus_rec_te"}
        stats = {"rec": 6, "rec_yd": 70}
        self.assertEqual(score_line(stats, plain, "TE"),
                         score_line(stats, plain, "WR"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
