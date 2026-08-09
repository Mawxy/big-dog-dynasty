#!/usr/bin/env python3
"""
Invariants of the week-odds engine (scripts/week_odds.py).

These lock the two things that make a pregame line trustworthy: that it is
actually PREGAME, and that a projection never leaks across seasons. Pure
stdlib, no network, no committed fixtures — the seasons below are synthetic
site-data trees built in a temp directory, so nothing here needs a local
sleeper_pull run and everything runs in CI.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from week_odds import (best_lineup, pos_stats,          # noqa: E402
                       season_odds, snapshot_projections)
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


# ---------------------------------------------------------------------------
# The no-lookahead guarantee, exercised end to end on a synthetic season.
# ---------------------------------------------------------------------------
SEASON = "2025"
PLAYOFF_START = 15
# two teams, one starter each, three played weeks
PLAYERS_MIN = {"a": ["Starter A", "QB"], "b": ["Starter B", "QB"]}
TEAMS = [{"roster_id": 1, "players": ["a"]}, {"roster_id": 2, "players": ["b"]}]


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding="utf-8")


def build_season(root, week3=(25.0, 5.0), proj_history=None):
    """A site-data tree season_odds can read. `week3` is the only thing a
    caller varies: it is the FUTURE relative to weeks 1 and 2."""
    ld = Path(root) / "data"
    raw = Path(root) / "raw"
    # matchups entry layout: [week, ?, opponent rid, ?, starters]
    write_json(ld / SEASON / "matchups.json", {
        "playoff_start": PLAYOFF_START,
        "teams": {"1": [[wk, 0, 2, 0, ["a"]] for wk in (1, 2, 3)],
                  "2": [[wk, 0, 1, 0, ["b"]] for wk in (1, 2, 3)]}})
    write_json(ld / SEASON / "weekly.json", {
        "a": [[1, 20.0], [2, 18.0], [3, week3[0]]],
        "b": [[1, 10.0], [2, 12.0], [3, week3[1]]]})
    write_json(ld / SEASON / "teams.json", TEAMS)
    write_json(ld / "players_min.json", PLAYERS_MIN)
    write_json(raw / SEASON / "league.json",
               {"roster_positions": ["QB", "BN"], "total_rosters": 2})
    if proj_history:
        write_json(ld / SEASON / "proj_history.json", proj_history)
    return ld, raw


class TestNoLookahead(unittest.TestCase):
    """"Week W's numbers are built from weeks 1..W-1 only." A team that went
    on to win week 9 does not get to have known that in week 9's line — which
    is what makes an upset legible after the fact."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def odds(self, root=None, **kw):
        ld, raw = build_season(root or tempfile.mkdtemp(dir=self._tmp.name), **kw)
        return season_odds(SEASON, ld, raw, kw.pop("sproj", {}))

    def test_a_week_cannot_see_its_own_result(self):
        """Week 3's line is priced off weeks 1-2, so rewriting week 3's scores
        must leave week 3's own line — and every earlier one — untouched."""
        quiet = self.odds(week3=(25.0, 5.0))
        blowup = self.odds(week3=(200.0, 0.5))
        self.assertEqual(quiet["weeks"], blowup["weeks"])
        self.assertIn("3", quiet["weeks"])            # and it really was priced

    def test_form_from_earlier_weeks_does_move_the_line(self):
        """The complement: the test above must not be passing because the
        engine ignores form altogether."""
        strong = build_season(tempfile.mkdtemp(dir=self._tmp.name))
        weak = build_season(tempfile.mkdtemp(dir=self._tmp.name))
        write_json(weak[0] / SEASON / "weekly.json",
                   {"a": [[1, 2.0], [2, 2.0], [3, 25.0]],
                    "b": [[1, 10.0], [2, 12.0], [3, 5.0]]})
        s = season_odds(SEASON, *strong, {})["weeks"]["3"]["1"]
        w = season_odds(SEASON, *weak, {})["weeks"]["3"]["1"]
        self.assertGreater(s["mu"], w["mu"])
        self.assertGreater(s["wp"], w["wp"])

    def test_week_one_is_unpriced_rather_than_a_meaningless_fifty_percent(self):
        """No prior form and no archived projection means there is no
        forecast. Emitting a line here would print 50% for every game and read
        as one. Every season before snapshots existed lands in this branch."""
        got = self.odds()
        self.assertNotIn("1", got["weeks"])
        self.assertEqual(sorted(got["weeks"]), ["2", "3"])

    def test_an_archived_snapshot_is_what_makes_week_one_priceable(self):
        got = self.odds(proj_history={"1": {"a": 22.0, "b": 8.0}})
        wk1 = got["weeks"]["1"]
        self.assertEqual(wk1["1"]["mu"], 22.0)        # pure projection
        self.assertEqual(wk1["2"]["mu"], 8.0)
        self.assertGreater(wk1["1"]["wp"], 0.5)
        self.assertAlmostEqual(wk1["1"]["wp"] + wk1["2"]["wp"], 1.0, places=3)

    def test_a_past_week_never_reaches_for_todays_projections(self):
        """Sleeper serves only CURRENT projections. Pricing a 2022 game off
        them would read Travis Kelce's 22.9-per-game season at his 11.7 of
        today — a different player. A past week with no snapshot falls back to
        the positional prior instead."""
        root = tempfile.mkdtemp(dir=self._tmp.name)
        ld, raw = build_season(root)
        plain = season_odds(SEASON, ld, raw, {})
        loud = season_odds(SEASON, ld, raw,
                           {"a": {"ppg": 999.0}, "b": {"ppg": 0.01}})
        self.assertEqual(plain["weeks"], loud["weeks"])

    def test_the_snapshot_for_this_week_is_used_over_the_positional_prior(self):
        """And the snapshot that IS for this week does get used — otherwise
        the test above would pass on an engine that ignores projections."""
        got = self.odds(proj_history={"3": {"a": 60.0, "b": 5.0}})
        with_snap = got["weeks"]["3"]["1"]["mu"]
        without = self.odds()["weeks"]["3"]["1"]["mu"]
        self.assertGreater(with_snap, without)

    def test_the_regular_season_is_the_whole_scope(self):
        got = self.odds()
        self.assertEqual(got["meta"]["playoff_start"], PLAYOFF_START)
        self.assertTrue(all(int(w) < PLAYOFF_START for w in got["weeks"]))
        self.assertEqual(got["meta"]["projected"], [])


class TestSnapshotFirstWriteWins(unittest.TestCase):
    """`--snapshot` archives today's projections under the current NFL week.
    Sleeper's nfl_state week does not advance until after the week completes,
    so the pipeline's daily run would otherwise overwrite a week's snapshot
    with numbers taken AFTER its games were played — exactly the lookahead
    proj_history.json exists to prevent."""

    SPROJ = {"a": {"ppg": 18.0}, "b": {"ppg": 9.0}}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ld = Path(self._tmp.name) / "data"
        (self.ld / SEASON).mkdir(parents=True)
        self.f = self.ld / SEASON / "proj_history.json"

    def hist(self):
        return json.loads(self.f.read_text(encoding="utf-8"))

    def snap(self, week, sproj=..., teams=TEAMS):
        return snapshot_projections(SEASON, self.ld,
                                    self.SPROJ if sproj is ... else sproj,
                                    week, teams)

    def test_the_first_snapshot_of_a_week_is_the_one_that_survives(self):
        self.assertTrue(self.snap(5))
        first = self.hist()
        # Monday's run: the same NFL week, but these numbers now know the
        # results. It must be refused.
        self.assertFalse(self.snap(5, {"a": {"ppg": 99.0}, "b": {"ppg": 0.5}}))
        self.assertEqual(self.hist(), first)
        self.assertEqual(self.hist()["5"]["a"], 18.0)

    def test_a_new_week_is_appended_and_the_old_ones_are_left_alone(self):
        self.snap(5)
        self.assertTrue(self.snap(6, {"a": {"ppg": 21.0}, "b": {"ppg": 7.0}}))
        self.assertEqual(sorted(self.hist()), ["5", "6"])
        self.assertEqual(self.hist()["5"]["a"], 18.0)
        self.assertEqual(self.hist()["6"]["a"], 21.0)

    def test_the_refusal_does_not_depend_on_the_new_numbers_differing(self):
        self.snap(5)
        self.assertFalse(self.snap(5))

    def test_only_rostered_players_are_kept(self):
        """The unrostered ~2,700 are never starters and cannot affect a line;
        trimming is what keeps the file small enough to live in the repo."""
        self.snap(5, {"a": {"ppg": 18.0}, "b": {"ppg": 9.0},
                      "ghost": {"ppg": 30.0}})
        self.assertEqual(sorted(self.hist()["5"]), ["a", "b"])

    def test_nothing_to_archive_writes_nothing(self):
        self.assertFalse(self.snap(None))
        self.assertFalse(self.snap(5, {}))
        self.assertFalse(self.snap(5, {"ghost": {"ppg": 30.0}}))
        self.assertFalse(self.snap(5, self.SPROJ, teams=[]))
        self.assertFalse(self.f.exists())

    def test_players_without_a_projection_are_dropped_not_zeroed(self):
        self.snap(5, {"a": {"ppg": 18.0}, "b": {"ppg": None}})
        self.assertEqual(sorted(self.hist()["5"]), ["a"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
