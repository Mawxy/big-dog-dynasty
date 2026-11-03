#!/usr/bin/env python3
"""
Invariants of the WAA/WAR engine and the played rule.

These lock down the methodology decisions recorded in PROJECT_NOTES.md ("settled
decisions — don't change casually") so a refactor can't quietly move them. Pure
stdlib, no fixtures, no network:

  python -m unittest discover -s tests -v

Anything that fails here is a change in what WAR *means*, not a broken test.
"""
import json
import math
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from build_site_data import site_pos                              # noqa: E402
from sleeper_war import (build_week, core_position,               # noqa: E402
                         norm_win_shift, nth_best_unrostered, player_pos,
                         run_season, slot_counts, WAIVER_RANK)
from sleeper_pull import (effective_week, row_played, save,       # noqa: E402
                          week_complete)


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

    def test_known_values_of_the_standard_normal(self):
        """Oracles, not a second copy of the formula. Restating
        `0.5*(1+erf(z/sqrt2)) - 0.5` here would let a shared sign or factor
        error pass both. A margin of sigma*sqrt(2) is exactly z = 1, so the
        answer is the textbook Phi(z) - 0.5.

        Phi(1) - 0.5 = 0.341345, Phi(2) - 0.5 = 0.477250, and the probable
        error z = 0.6744898 is by definition a quarter.
        """
        root2 = math.sqrt(2)
        for sigma in (15.0, 25.0, 41.4):
            self.assertAlmostEqual(norm_win_shift(1.0 * sigma * root2, sigma),
                                   0.3413447, places=6, msg=sigma)
            self.assertAlmostEqual(norm_win_shift(2.0 * sigma * root2, sigma),
                                   0.4772499, places=6, msg=sigma)
            self.assertAlmostEqual(norm_win_shift(0.6744898 * sigma * root2, sigma),
                                   0.25, places=6, msg=sigma)

    def test_the_margin_only_matters_in_units_of_sigma(self):
        """The conversion has one free quantity, points/(sigma*sqrt2). This is
        the same claim as 'a low-scoring week is worth more', stated so that a
        change to the denominator fails even if the numerator changes with it."""
        self.assertAlmostEqual(norm_win_shift(20.0, 25.0),
                               norm_win_shift(40.0, 50.0), places=12)


class TestWaiverBaseline(unittest.TestCase):
    """VoWP: the same win-shift conversion, but measured against the Nth-best
    UNROSTERED player rather than against replacement level (METHODOLOGY.md,
    "VoWP"). The single best free agent each week is boom-noise, so the anchor
    sits deeper — 'what you'd actually land after the obvious guy goes'."""

    POS = {f"q{i}": "QB" for i in range(1, 7)}

    def test_the_waiver_anchor_is_the_third_best_free_agent(self):
        self.assertEqual(WAIVER_RANK, 3)

    def test_it_reads_the_nth_best_unrostered_player(self):
        pts = {"q1": 30.0, "q2": 25.0, "q3": 20.0, "q4": 12.0, "q5": 9.0}
        got = nth_best_unrostered(pts, self.POS, rostered={"q1"})
        self.assertEqual(got["QB"], 12.0)      # q2, q3, q4 free -> 3rd is q4

    def test_rostered_players_are_invisible_however_well_they_scored(self):
        pts = {"q1": 99.0, "q2": 98.0, "q3": 20.0, "q4": 12.0, "q5": 9.0}
        rostered = {"q1", "q2"}
        self.assertEqual(nth_best_unrostered(pts, self.POS, rostered)["QB"], 9.0)

    def test_a_thin_wire_falls_back_to_the_deepest_available(self):
        """Fewer than N free agents scored: take the last one rather than
        pretending the wire was deeper than it was."""
        pts = {"q1": 30.0, "q2": 7.0}
        self.assertEqual(nth_best_unrostered(pts, self.POS, {"q1"})["QB"], 7.0)

    def test_an_empty_wire_is_zero(self):
        """The bottom of the ladder: nobody unrostered scored at all."""
        got = nth_best_unrostered({"q1": 30.0}, self.POS, {"q1"})
        for pos in ("QB", "RB", "WR", "TE"):
            self.assertEqual(got[pos], 0.0, pos)

    def test_every_core_position_always_gets_a_baseline(self):
        got = nth_best_unrostered({"q1": 30.0}, self.POS, set())
        self.assertEqual(set(got), {"QB", "RB", "WR", "TE"})

    def test_the_rank_is_configurable_and_deeper_is_harsher_to_nobody(self):
        """A deeper anchor can only be a LOWER score, so VoWP never falls as
        the wire is searched further down."""
        pts = {f"q{i}": 30.0 - i for i in range(1, 7)}
        first = nth_best_unrostered(pts, self.POS, set(), n=1)["QB"]
        third = nth_best_unrostered(pts, self.POS, set(), n=3)["QB"]
        self.assertGreater(first, third)


def row(pos, **stats):
    return {"player": {"position": pos}, "stats": stats}


# The two shapes that used to fall out of the pool, as Sleeper serves them.
HUNTER = {"position": "DB", "fantasy_positions": ["DB", "WR"], "first_name": "Travis",
          "last_name": "Hunter"}
FULLBACK = {"position": "FB", "fantasy_positions": ["RB"], "first_name": "Kyle",
            "last_name": "Juszczyk"}


class TestPlayerPosition(unittest.TestCase):
    """A core `position`, else the first core entry of `fantasy_positions`."""

    def test_a_two_way_player_scores_at_his_core_position(self):
        self.assertEqual(player_pos({"h": HUNTER}, "h"), "WR")

    def test_a_fullback_scores_as_a_running_back(self):
        self.assertEqual(player_pos({"f": FULLBACK}, "f"), "RB")

    def test_a_core_position_wins_over_the_fantasy_list(self):
        """Live map: a TE listed ['DL'], a WR listed ['DB', 'WR']. Neither moves."""
        self.assertEqual(core_position({"position": "TE", "fantasy_positions": ["DL"]}), "TE")
        self.assertEqual(core_position({"position": "WR", "fantasy_positions": ["RB", "WR"]}), "WR")

    def test_no_core_entry_stays_out_of_the_pool(self):
        for rec in ({"position": "DB", "fantasy_positions": ["DB"]},
                    {"position": "K", "fantasy_positions": ["K"]},
                    {"position": "DEF"},
                    {}):
            self.assertIsNone(core_position(rec), rec)

    def test_a_pid_the_map_does_not_know_is_none(self):
        self.assertIsNone(player_pos({}, "nobody"))

    def test_the_nflverse_corpus_record_reads_as_it_always_did(self):
        """nfl_history.py writes a core `position` and no fantasy list, and only
        for core players, so the corpus path through this engine cannot move."""
        for pos in ("QB", "RB", "WR", "TE"):
            self.assertEqual(player_pos({"g": {"position": pos, "first_name": "A",
                                               "last_name": "B"}}, "g"), pos)

    def test_the_site_column_follows_the_rule_and_keeps_everyone_else(self):
        """players_min.json's position, which week_odds.pos_of reads and which
        the site files him under. A kicker keeps his label and no pool."""
        self.assertEqual(site_pos(HUNTER), "WR")
        self.assertEqual(site_pos(FULLBACK), "RB")
        self.assertEqual(site_pos({"position": "K", "fantasy_positions": ["K"]}), "K")
        self.assertIsNone(site_pos({}))

    def test_both_shapes_reach_the_weekly_rows(self):
        """End to end through the engine: they accrue WAR at their core position."""
        lg = {"season": "2026", "total_rosters": 4,
              "roster_positions": ["QB", "RB", "WR", "TE", "BN"],
              "settings": {"playoff_week_start": 15}}
        week = [{"roster_id": 1, "points": 100.0, "players_points": {"h": 20.0, "w": 5.0}},
                {"roster_id": 2, "points": 90.0, "players_points": {"f": 12.0, "r": 4.0}},
                {"roster_id": 3, "points": 110.0, "players_points": {"k": 9.0}},
                {"roster_id": 4, "points": 80.0, "players_points": {}}]
        players = {"h": HUNTER, "f": FULLBACK, "w": {"position": "WR"},
                   "r": {"position": "RB"}, "k": {"position": "K"}}
        with tempfile.TemporaryDirectory() as tmp:
            sd = Path(tmp)
            (sd / "matchups").mkdir()
            (sd / "league.json").write_text(json.dumps(lg), encoding="utf-8")
            (sd / "matchups" / "week_01.json").write_text(json.dumps(week), encoding="utf-8")
            _, _, acc, rows, _, _ = run_season(
                sd, players, types.SimpleNamespace(include_playoffs=False))
        by_pid = {r[2]: r for r in rows}
        self.assertEqual(by_pid["h"][4], "WR")
        self.assertEqual(by_pid["f"][4], "RB")
        self.assertNotIn("k", by_pid)
        self.assertEqual(acc["h"]["gp"], 1)


class TestSaveIsAtomic(unittest.TestCase):
    """sleeper_pull.save goes through ioutil's replace, so a job killed mid-write
    leaves the previous dump, not half a JSON file where it was."""

    def test_it_writes_the_same_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "a" / "b.json"
            save({"x": 1}, p)
            self.assertEqual(p.read_text(encoding="utf-8"), json.dumps({"x": 1}, indent=2))
            self.assertEqual([f.name for f in p.parent.iterdir()], ["b.json"])

    def test_a_failed_write_leaves_the_old_file_and_no_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "b.json"
            save({"x": 1}, p)
            with mock.patch("ioutil.os.replace", side_effect=OSError("killed")):
                with self.assertRaises(OSError):
                    save({"x": 2}, p)
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"x": 1})
            self.assertEqual([f.name for f in Path(tmp).iterdir()], ["b.json"])


class TestPlayedRule(unittest.TestCase):
    """The position-INDEPENDENT rule settled 2026-08-07 (methodology #5):
    dressed = played everywhere, and a dressed 0.00 accrues negative value.

    Supersedes the 2026-07-17 QB carve-out, which excluded a dressed QB because
    every team dresses a QB2 so dressing carried no signal — an argument about
    opportunity. WAR measures production against replacement, not opportunity:
    a backup QB can be valuable to own and unproductive at the same time, and
    ownership value is what DVI, CVI and market price measure."""

    def test_qb_dressed_with_zero_snaps_is_a_played_zero(self):
        """Malik Willis 2025 wk1: dressed, no offensive snaps. He was startable
        and produced nothing, so it is a played 0.00 — the case the rule change
        exists for."""
        self.assertTrue(row_played(row("QB", gms_active=1, tm_off_snp=64,
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
        """Position no longer changes the answer, but it is still read — the
        fallback has to keep working for anything downstream that uses it."""
        r = {"player": {"fantasy_positions": ["QB"]}, "stats": {"gms_active": 1,
             "tm_off_snp": 64}}
        self.assertTrue(row_played(r), "dressed is played at every position")

    def test_hurt_and_inactive_still_accrue_nothing(self):
        """The change is about the ACTIVE who did not play. A player on IR or
        inactive has no tm_*_snp record, so he stays excluded — absence stays
        absence, per METHODOLOGY.md."""
        for pos in ("QB", "RB", "WR", "TE"):
            self.assertFalse(row_played(row(pos, gms_active=1)), f"{pos} on IR")
            self.assertFalse(row_played(row(pos)), f"{pos} inactive/bye")


# ---------------------------------------------------------------------------
# WHEN A WEEK IS FINAL, AND WHICH WEEK IS "NOW" (sleeper_pull)
#
# These two decide what the dump freezes. week_complete gates the whole
# played/allstats/matchups branch — freeze a week mid-Sunday and the Thu games
# have points while the Sun-night players read 0, which is a bad sigma and a
# row of real players marked DNP, committed as final. effective_week decides
# which week's SET lineups are captured, and its September rule exists because
# Sleeper's state does not say "regular / week 1" until kickoff week while
# managers set week-1 lineups well before that.
# ---------------------------------------------------------------------------
def state(season="2026", season_type="regular", week=3):
    return {"season": season, "season_type": season_type, "week": week}


class TestWeekComplete(unittest.TestCase):

    def test_in_season_only_the_weeks_before_the_live_one_are_final(self):
        st = state(week=3)
        self.assertTrue(week_complete("2026", 1, st))
        self.assertTrue(week_complete("2026", 2, st))
        self.assertFalse(week_complete("2026", 3, st), "the LIVE week")
        self.assertFalse(week_complete("2026", 4, st))

    def test_the_preseason_has_finished_nothing(self):
        for wk in (1, 5, 18):
            self.assertFalse(week_complete("2026", wk, state(season_type="pre")),
                             wk)

    def test_once_the_regular_season_is_over_every_week_is_final(self):
        for st in ("post", "off"):
            self.assertTrue(week_complete("2026", 14, state(season_type=st)), st)
            self.assertTrue(week_complete("2026", 1, state(season_type=st)), st)

    def test_a_past_season_is_done_and_a_future_one_is_not(self):
        st = state(season="2026")
        self.assertTrue(week_complete("2025", 17, st))
        self.assertTrue(week_complete("2022", 1, st))
        self.assertFalse(week_complete("2027", 1, st))

    def test_no_state_fails_closed_on_the_season_in_progress(self):
        """An external caller with no state must not be told the live week is
        final. The one thing provable without state is that the CALENDAR has
        put a season behind us — and an NFL season runs Sep into Feb, so
        before March the season in progress is still last year's."""
        import datetime as dt
        today = dt.date.today()
        current = today.year if today.month >= 3 else today.year - 1
        self.assertFalse(week_complete(str(current), 1, None))
        self.assertFalse(week_complete(str(current + 1), 1, None))
        self.assertTrue(week_complete(str(current - 1), 17, None))
        self.assertTrue(week_complete(str(current - 4), 1, None))

    def test_an_unknown_season_keeps_the_old_behavior(self):
        self.assertTrue(week_complete("unknown", 1, state()))
        self.assertTrue(week_complete("unknown", 1, None))

    def test_a_state_with_no_week_finalizes_nothing_in_season(self):
        for wk_now in (None, 0):
            self.assertFalse(week_complete("2026", 1, state(week=wk_now)),
                             repr(wk_now))


class TestEffectiveWeek(unittest.TestCase):

    def test_in_season_it_is_simply_the_live_week(self):
        self.assertEqual(effective_week("2026", state(week=6)), 6)

    def test_another_season_is_never_current(self):
        self.assertIsNone(effective_week("2025", state()))
        self.assertIsNone(effective_week("2027", state()))

    def test_no_state_is_no_week(self):
        self.assertIsNone(effective_week("2026", None))
        self.assertIsNone(effective_week("2026", {}))

    def test_a_regular_season_state_with_no_week_is_no_week(self):
        self.assertIsNone(effective_week("2026", state(week=0)))
        self.assertIsNone(effective_week("2026", state(week=None)))

    def test_from_september_the_upcoming_week_one_counts_as_current(self):
        """Max, 2026-08-31: managers set week-1 lineups before Sleeper's state
        rolls over to regular/1, and those lineups are decisions worth pricing.
        (2026 is safely in the past from September 2026 on, so this claim does
        not drift with the calendar.)"""
        for st in ("pre", "off"):
            self.assertEqual(effective_week("2026", state(season="2026",
                                                          season_type=st)), 1, st)

    def test_before_september_of_that_season_it_is_still_nothing(self):
        """The same branch on a season whose September has not arrived."""
        for st in ("pre", "off"):
            self.assertIsNone(effective_week("2099", state(season="2099",
                                                           season_type=st)), st)

    def test_a_non_numeric_season_cannot_reach_the_september_rule(self):
        self.assertIsNone(effective_week("unknown",
                                         state(season="unknown",
                                               season_type="off")))


if __name__ == "__main__":
    unittest.main()
