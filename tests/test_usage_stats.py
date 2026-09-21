#!/usr/bin/env python3
"""
Invariants of the usage/efficiency slice (scripts/usage_stats.py).

THE LEAGUE'S WINDOWS, AND ONLY THE PART OF THEM THAT HAS BEEN PLAYED. The
script exists because nflverse's season is weeks 1-18 and the league's regular
season stops at 14 — two windows pretending to be one. In September 2026 it
had the same fault from the other end: `reg` ran to week 14 by the schedule
while the league had played week 1, so 236 players read g:2 (nflverse had
played two) against a league that had played one. `windows()` now ends each
phase at the last week the LEAGUE has scored.

`aggregate()` turns one window's weekly rows into the figures the site shows:
season rates (totals divided), the two nflverse shares averaged over touched
weeks, and a snap share summed on both sides so a week with no snap line drops
out of numerator and denominator together.

Pure stdlib — the CSV rows below are plain dicts of strings, which is what
csv.DictReader hands the script.

  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from usage_stats import aggregate, num, windows                   # noqa: E402


def mw(playoff_start=15, played=()):
    """a matchups.json carrying exactly the weeks the league has scored"""
    return {"playoff_start": playoff_start,
            "teams": {"1": [[wk, 100.0, 2, 90.0, [], []] for wk in played],
                      "2": [[wk, 90.0, 1, 100.0, [], []] for wk in played]}}


def wk(week, **cols):
    """one features_weekly row, as csv.DictReader produces it"""
    row = {"week": str(week)}
    row.update({k: ("" if v is None else str(v)) for k, v in cols.items()})
    return row


class TestWindows(unittest.TestCase):

    def test_a_finished_season_is_the_three_full_phases(self):
        got = windows(mw(played=range(1, 18)))
        self.assertEqual(got, [("reg", 1, 14), ("post", 15, 17), ("both", 1, 17)])

    def test_one_week_played_is_one_week_of_regular_season(self):
        """THE BUG. `reg` used to end at playoff_start-1 whatever the date, so
        every nflverse week up to today landed in a window the league had not
        reached — 236 players at g:2 against a league that had played [1]."""
        self.assertEqual(windows(mw(played=(1,))),
                         [("reg", 1, 1), ("both", 1, 1)])

    def test_the_bracket_window_appears_only_once_it_has_a_week(self):
        self.assertEqual([n for n, _, _ in windows(mw(played=range(1, 15)))],
                         ["reg", "both"])
        self.assertEqual([n for n, _, _ in windows(mw(played=range(1, 16)))],
                         ["reg", "post", "both"])

    def test_a_season_with_nothing_played_has_no_windows(self):
        self.assertEqual(windows(mw(played=())), [])
        self.assertEqual(windows({}), [])

    def test_no_window_ever_runs_backwards(self):
        for n in range(0, 18):
            for name, lo, hi in windows(mw(played=range(1, n + 1))):
                self.assertLessEqual(lo, hi, f"{name} after {n} weeks")

    def test_both_spans_the_other_two(self):
        got = dict((n, (lo, hi)) for n, lo, hi in windows(mw(played=range(1, 18))))
        self.assertEqual(got["both"][0], got["reg"][0])
        self.assertEqual(got["both"][1], got["post"][1])

    def test_it_follows_the_leagues_own_playoff_start(self):
        got = windows(mw(playoff_start=13, played=range(1, 15)))
        self.assertEqual(got, [("reg", 1, 12), ("post", 13, 14), ("both", 1, 14)])

    def test_a_missing_playoff_start_falls_back_to_fifteen(self):
        got = windows({"teams": {"1": [[w, 0, 2, 0, [], []] for w in range(1, 18)]}})
        self.assertEqual(got[0], ("reg", 1, 14))


class TestNum(unittest.TestCase):

    def test_blanks_and_nans_are_not_figures(self):
        for cell in ("", None, "nan", "nope"):
            self.assertIsNone(num(cell), repr(cell))

    def test_a_number_is_a_float(self):
        self.assertEqual(num("3"), 3.0)
        self.assertEqual(num("-0.25"), -0.25)


class TestAggregate(unittest.TestCase):

    def test_an_empty_window_is_absent_not_a_row_of_zeros(self):
        self.assertIsNone(aggregate("WR", []))

    def test_games_are_the_touched_weeks_in_the_window(self):
        rows = [wk(1, tgt=5, rec=3), wk(2, tgt=7, rec=4)]
        self.assertEqual(aggregate("WR", rows)["g"], 2)

    def test_per_game_figures_divide_by_those_games(self):
        rows = [wk(1, tgt=4, rec=2, rec_ay=40), wk(2, tgt=8, rec=5, rec_ay=60)]
        got = aggregate("WR", rows)
        self.assertEqual(got["tgt_pg"], 6.0)
        self.assertEqual(got["adot"], round(100 / 12, 2))    # season rate

    def test_only_the_positions_own_five_ship(self):
        rows = [wk(1, att=30, car=3, pass_epa=5.0, sacks=2, cpoe=1.5,
                   tgt=0, fp_exp=18.0, fp_act=20.0)]
        qb = aggregate("QB", rows)
        self.assertIn("att_pg", qb)
        self.assertNotIn("tgt_share", qb)      # a QB's target share is not a figure
        self.assertIn("epa_db", qb)
        self.assertEqual(qb["epa_db"], round(5.0 / 32, 4))   # attempts + sacks

    def test_cpoe_is_attempt_weighted(self):
        """A three-throw game must not count as much as a forty-throw one."""
        rows = [wk(1, att=40, cpoe=5.0), wk(2, att=4, cpoe=-5.0)]
        self.assertEqual(aggregate("QB", rows)["cpoe"],
                         round((40 * 5.0 + 4 * -5.0) / 44, 3))

    def test_a_week_with_no_attempts_cannot_vote_on_cpoe(self):
        rows = [wk(1, att=30, cpoe=2.0), wk(2, att=0, cpoe=-40.0)]
        self.assertEqual(aggregate("QB", rows)["cpoe"], 2.0)

    def test_the_shares_are_meaned_over_the_weeks_that_have_one(self):
        rows = [wk(1, tgt=5, tgt_share=0.20), wk(2, tgt=5, tgt_share=0.30),
                wk(3, tgt=5, tgt_share=None)]
        self.assertEqual(aggregate("WR", rows)["tgt_share"], 0.25)

    def test_expected_points_are_absent_when_the_source_has_none(self):
        got = aggregate("WR", [wk(1, tgt=5, rec=3)])
        self.assertNotIn("fp_exp_pg", got)
        self.assertNotIn("fp_diff_pg", got)

    def test_vs_expected_is_actual_minus_expected_per_game(self):
        rows = [wk(1, tgt=5, fp_exp=10.0, fp_act=14.0),
                wk(2, tgt=5, fp_exp=10.0, fp_act=8.0)]
        got = aggregate("WR", rows)
        self.assertEqual(got["fp_exp_pg"], 10.0)
        self.assertEqual(got["fp_diff_pg"], 1.0)

    def test_snap_share_sums_both_sides_over_the_weeks_that_have_one(self):
        rows = [wk(1, tgt=5, snaps=40, team_snaps=60),
                wk(2, tgt=5, snaps=20, team_snaps=40)]
        self.assertEqual(aggregate("WR", rows)["snap_pct"], round(60 / 100, 4))

    def test_a_week_the_crosswalk_missed_drops_out_of_both_sides(self):
        """Not a zero-snap week he never had: numerator and denominator lose
        it together, so the share stays what the covered weeks say."""
        rows = [wk(1, tgt=5, snaps=40, team_snaps=60),
                wk(2, tgt=5, snaps=None, team_snaps=None)]
        self.assertEqual(aggregate("WR", rows)["snap_pct"], round(40 / 60, 4))

    def test_no_snap_column_at_all_means_no_snap_figure(self):
        """Every season but the one data-refresh rebuilds nightly lacks the
        columns; the figure must be absent rather than 0%."""
        self.assertNotIn("snap_pct", aggregate("WR", [wk(1, tgt=5, rec=3)]))

    def test_rb_touch_share_is_a_running_backs_figure_only(self):
        rows = [wk(1, car=10, rec=2, team_car=25, team_rb_touch=20)]
        self.assertIn("rb_touch_share", aggregate("RB", rows))
        self.assertNotIn("rb_touch_share", aggregate("WR", rows))

    def test_carry_share_is_his_carries_over_the_teams(self):
        rows = [wk(1, car=10, team_car=25), wk(2, car=5, team_car=25)]
        self.assertEqual(aggregate("RB", rows)["car_share"], round(15 / 50, 4))


if __name__ == "__main__":
    unittest.main(verbosity=2)
