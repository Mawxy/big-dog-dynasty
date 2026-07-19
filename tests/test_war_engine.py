#!/usr/bin/env python3
"""
Invariants of the WAA/WAR engine and the played rule.

These lock down the methodology decisions recorded in PROJECT_NOTES.md ("settled
decisions — don't change casually") so a refactor can't quietly move them. Pure
stdlib, no fixtures, no network:

  python -m unittest discover -s tests -v

Anything that fails here is a change in what WAR *means*, not a broken test.
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from sleeper_war import build_week, norm_win_shift, slot_counts   # noqa: E402
from sleeper_pull import row_played                               # noqa: E402


# The league: 12 teams, QB/2RB/3WR/TE/FLEX/SUPER_FLEX.
LEAGUE = {
    "total_rosters": 12,
    "roster_positions": ["QB", "RB", "RB", "WR", "WR", "WR", "TE",
                         "FLEX", "SUPER_FLEX", "BN", "BN", "TAXI"],
}
CORE_SLOTS = {"QB": 12, "RB": 24, "WR": 36, "TE": 12, "FLEX": 12, "SUPER_FLEX": 12}


def make_pool(counts, start=100.0, step=-0.5):
    """A synthetic week: `counts` players per position on a descending points
    ladder, so ordering is unambiguous and ties never decide a slot."""
    points, positions, n = {}, {}, 0
    for pos, k in counts.items():
        for i in range(k):
            pid = f"{pos}{i}"
            points[pid] = start + step * n
            positions[pid] = pos
            n += 1
    return points, positions


class TestSlotCounts(unittest.TestCase):
    def test_league_wide_slots(self):
        """12-team superflex => 108 startable slots, bench/taxi excluded."""
        slots = slot_counts(LEAGUE)
        for pos, want in CORE_SLOTS.items():
            self.assertEqual(slots[pos], want, pos)
        self.assertEqual(sum(slots[p] for p in CORE_SLOTS), 108)


class TestBuildWeek(unittest.TestCase):
    def test_fills_every_slot_when_pool_is_deep(self):
        points, positions = make_pool({"QB": 40, "RB": 60, "WR": 80, "TE": 30})
        startable, _, _ = build_week(points, positions, CORE_SLOTS)
        self.assertEqual(len(startable), 108)

    def test_dedicated_slots_fill_before_flex(self):
        """The top 12 QBs are startable even though QBs cannot take a FLEX."""
        points, positions = make_pool({"QB": 40, "RB": 60, "WR": 80, "TE": 30})
        startable, _, _ = build_week(points, positions, CORE_SLOTS)
        qbs = sorted((p for p in points if positions[p] == "QB"),
                     key=lambda p: -points[p])
        for p in qbs[:12]:
            self.assertIn(p, startable)

    def test_flex_goes_to_the_best_leftovers(self):
        """Flex demand is settled empirically by points each week: with the
        dedicated slots exactly filled, the 24 remaining FLEX + SUPER_FLEX spots
        go to the top 24 leftovers regardless of their positions."""
        points, positions = make_pool(
            {"QB": 12, "RB": 24, "WR": 36, "TE": 12}, start=200.0)
        extras = []
        for i in range(30):                      # a clean 50, 49, ... 21 ladder
            pid = f"X{i}"
            points[pid] = 50.0 - i
            positions[pid] = ("RB", "WR", "TE")[i % 3]
            extras.append(pid)
        startable, _, _ = build_week(points, positions, CORE_SLOTS)
        for p in extras[:24]:
            self.assertIn(p, startable, f"{p} @ {points[p]} should have a flex")
        for p in extras[24:]:
            self.assertNotIn(p, startable, f"{p} @ {points[p]} should be benched")

    def test_dedicated_slots_outrank_points(self):
        """A dedicated slot is positional, not meritocratic: a weak TE holding
        one of the 12 TE slots is startable even while a higher-scoring RB is
        benched, because the RB's own dedicated slots are full and the flexes
        went to better players. This is intended — the pool models real lineup
        requirements, not a free-for-all leaderboard."""
        # 60 RBs for 24 dedicated + 12 FLEX + 12 SUPER_FLEX = 12 left over;
        # the 12 TEs sit at the bottom of the ladder yet all hold a TE slot
        points, positions = make_pool({"QB": 12, "RB": 60, "TE": 12}, start=100.0)
        startable, _, _ = build_week(points, positions, CORE_SLOTS)
        weakest_started_te = min(
            points[p] for p in startable if positions[p] == "TE")
        benched_rb = [points[p] for p in points
                      if positions[p] == "RB" and p not in startable]
        self.assertTrue(benched_rb, "expected some RBs to miss the pool")
        self.assertGreater(max(benched_rb), weakest_started_te)

    def test_qb_can_take_superflex_but_not_flex(self):
        """Only 12 dedicated QB slots exist, but SUPER_FLEX is QB-eligible, so a
        deep QB field can start more than 12 — and never via FLEX."""
        points, positions = make_pool({"QB": 40, "RB": 24, "WR": 36, "TE": 12})
        startable, _, _ = build_week(points, positions, CORE_SLOTS)
        started_qb = sum(1 for p in startable if positions[p] == "QB")
        # 12 dedicated + up to 12 SUPER_FLEX; RB/WR/TE exactly fill their own
        # slots here, so every SUPER_FLEX is available to a QB
        self.assertEqual(started_qb, 24)

    def test_replacement_is_best_player_left_out(self):
        """Weekly next-man-up: strictly the top scorer outside the pool."""
        points, positions = make_pool({"QB": 40, "RB": 60, "WR": 80, "TE": 30})
        startable, _, repl = build_week(points, positions, CORE_SLOTS)
        for pos in ("QB", "RB", "WR", "TE"):
            out = [points[p] for p in points
                   if positions[p] == pos and p not in startable]
            self.assertAlmostEqual(repl[pos], max(out), places=9, msg=pos)

    def test_replacement_is_below_every_starter_at_that_position(self):
        points, positions = make_pool({"QB": 40, "RB": 60, "WR": 80, "TE": 30})
        startable, _, repl = build_week(points, positions, CORE_SLOTS)
        for pos in ("QB", "RB", "WR", "TE"):
            started = [points[p] for p in startable if positions[p] == pos]
            self.assertLessEqual(repl[pos], min(started), pos)

    def test_average_baseline_is_mean_of_startable_at_position(self):
        """So points-above-average sums to zero across the pool, per position —
        the property that makes WAA a genuine 'above average'."""
        points, positions = make_pool({"QB": 40, "RB": 60, "WR": 80, "TE": 30})
        startable, avg, _ = build_week(points, positions, CORE_SLOTS)
        for pos in ("QB", "RB", "WR", "TE"):
            paa = [points[p] - avg[pos] for p in startable if positions[p] == pos]
            self.assertAlmostEqual(sum(paa), 0.0, places=6, msg=pos)

    def test_players_without_a_known_position_are_ignored(self):
        points, positions = make_pool({"QB": 13, "RB": 25})
        points["K1"] = 500.0          # kicker: no entry in `positions`
        startable, _, _ = build_week(points, positions, CORE_SLOTS)
        self.assertNotIn("K1", startable)


class TestWinShift(unittest.TestCase):
    def test_zero_margin_is_zero_wins(self):
        self.assertAlmostEqual(norm_win_shift(0.0, 25.0), 0.0, places=12)

    def test_non_positive_sigma_is_safe(self):
        self.assertEqual(norm_win_shift(10.0, 0.0), 0.0)
        self.assertEqual(norm_win_shift(10.0, -1.0), 0.0)

    def test_monotone_and_antisymmetric(self):
        self.assertLess(norm_win_shift(5.0, 25.0), norm_win_shift(10.0, 25.0))
        self.assertAlmostEqual(norm_win_shift(-8.0, 25.0),
                               -norm_win_shift(8.0, 25.0), places=12)

    def test_bounded_by_half_a_win(self):
        """A single week can never be worth more than half a win either way.
        (Asymptotic — erf saturates to exactly 0.5 in float at large margins.)"""
        self.assertLessEqual(norm_win_shift(10_000.0, 25.0), 0.5)
        self.assertGreaterEqual(norm_win_shift(-10_000.0, 25.0), -0.5)
        # a realistic blow-up stays strictly inside the bound
        self.assertLess(norm_win_shift(60.0, 25.0), 0.5)

    def test_same_margin_is_worth_more_in_a_low_scoring_week(self):
        """SETTLED: pure weekly sigma, no blending — big games in low-scoring
        weeks earn more. (PROJECT_NOTES methodology #3.)"""
        self.assertGreater(norm_win_shift(20.0, 15.0), norm_win_shift(20.0, 35.0))

    def test_matches_the_closed_form(self):
        z = 12.0 / (25.0 * math.sqrt(2))
        want = 0.5 * (1 + math.erf(z / math.sqrt(2))) - 0.5
        self.assertAlmostEqual(norm_win_shift(12.0, 25.0), want, places=12)


def row(pos, **stats):
    return {"player": {"position": pos}, "stats": stats}


class TestPlayedRule(unittest.TestCase):
    """The position-dependent rule settled 2026-07-17 (methodology #5)."""

    def test_qb_dressed_with_zero_snaps_is_dnp(self):
        """Malik Willis 2025 wk1: dressed, no offensive snaps => not a 0.00."""
        self.assertFalse(row_played(row("QB", gms_active=1, tm_off_snp=64,
                                        tm_def_snp=61, tm_st_snp=25)))

    def test_qb_with_snaps_played(self):
        self.assertTrue(row_played(row("QB", off_snp=58, pass_att=30)))

    def test_qb_with_stat_line_but_no_snap_record_played(self):
        self.assertTrue(row_played(row("QB", pass_att=3, pass_yd=21)))

    def test_rb_dressed_with_zero_snaps_is_a_played_zero(self):
        """Rotation positions: dressed = played, and a 0.00 accrues negatively."""
        self.assertTrue(row_played(row("RB", gms_active=1, tm_off_snp=64,
                                       tm_def_snp=61, tm_st_snp=25)))

    def test_receiver_with_stat_line_and_zero_snaps_played(self):
        """Chism 2025 wk18: a catch recorded with off_snp 0. Snaps OR stat line,
        never one alone — the branch that used to miss this."""
        self.assertTrue(row_played(row("WR", rec=1, rec_yd=9)))

    def test_special_teams_only_player_is_dressed(self):
        self.assertTrue(row_played(row("TE", st_snp=14)))

    def test_bare_gms_active_is_dnp_for_every_position(self):
        """IR / NFI / practice squad: gms_active fires but is never a played
        signal. tm_*_snp presence is the dressed discriminator."""
        for pos in ("QB", "RB", "WR", "TE"):
            self.assertFalse(row_played(row(pos, gms_active=1)), pos)

    def test_no_record_at_all_is_dnp(self):
        """Bye / game-day inactive / scratch: Sleeper emits nothing."""
        for pos in ("QB", "RB", "WR", "TE"):
            self.assertFalse(row_played(row(pos)), pos)

    def test_falls_back_to_fantasy_positions(self):
        r = {"player": {"fantasy_positions": ["QB"]}, "stats": {"gms_active": 1,
             "tm_off_snp": 64}}
        self.assertFalse(row_played(r), "QB via fantasy_positions is still QB")


if __name__ == "__main__":
    unittest.main()
