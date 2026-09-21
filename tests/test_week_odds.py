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

from week_odds import (best_lineup, first_round_byes, pos_stats,   # noqa: E402
                       run_bracket, season_odds, season_sim,
                       snapshot_projections, snapshot_week)
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

    def test_a_starter_missing_from_the_snapshot_is_priced_at_zero(self):
        """THE PREGAME LINE OF RECORD MUST NOT MOVE (2026-09-21). A player
        with no line for the week is zero in the live path (Max, 2026-09-15).
        A snapshot is a complete record of the lines that were quoted, so
        absence from it means the same thing — it used to mean the positional
        mean, ~10 phantom points that appeared the moment the week flipped
        from upcoming to played."""
        both = self.odds(proj_history={"3": {"a": 22.0, "b": 8.0}})
        only_a = self.odds(proj_history={"3": {"a": 22.0}})
        no_snap = self.odds()
        self.assertLess(only_a["weeks"]["3"]["2"]["mu"],
                        both["weeks"]["3"]["2"]["mu"])
        # and below the positional-prior fallback, which is what it used to get
        self.assertLess(only_a["weeks"]["3"]["2"]["mu"],
                        no_snap["weeks"]["3"]["2"]["mu"])
        # the player who IS in the snapshot is unaffected by the other's gap
        self.assertEqual(only_a["weeks"]["3"]["1"]["mu"],
                         both["weeks"]["3"]["1"]["mu"])


class TestSnapshotFirstWriteWins(unittest.TestCase):
    """`--snapshot` archives today's projections under the current NFL week.
    Sleeper's nfl_state week does not advance until after the week completes,
    so the pipeline's daily run would otherwise overwrite a week's snapshot
    with numbers taken AFTER its games were played — exactly the lookahead
    proj_history.json exists to prevent."""

    SPROJ = {"a": {"wk": {"5": 18.0}}, "b": {"wk": {"5": 9.0}}}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ld = Path(self._tmp.name) / "data"
        (self.ld / SEASON).mkdir(parents=True)
        self.f = self.ld / SEASON / "proj_history.json"

    def hist(self):
        return json.loads(self.f.read_text(encoding="utf-8"))

    def snap(self, week, sproj=...):
        return snapshot_projections(SEASON, self.ld,
                                    self.SPROJ if sproj is ... else sproj, week)

    def test_the_first_snapshot_of_a_week_is_the_one_that_survives(self):
        self.assertTrue(self.snap(5))
        first = self.hist()
        # Monday's run: the same NFL week, but these numbers now know the
        # results. It must be refused.
        self.assertFalse(self.snap(5, {"a": {"wk": {"5": 99.0}},
                                       "b": {"wk": {"5": 0.5}}}))
        self.assertEqual(self.hist(), first)
        self.assertEqual(self.hist()["5"]["a"], 18.0)

    def test_a_new_week_is_appended_and_the_old_ones_are_left_alone(self):
        self.snap(5)
        self.assertTrue(self.snap(6, {"a": {"wk": {"6": 21.0}},
                                      "b": {"wk": {"6": 7.0}}}))
        self.assertEqual(sorted(self.hist()), ["5", "6"])
        self.assertEqual(self.hist()["5"]["a"], 18.0)
        self.assertEqual(self.hist()["6"]["a"], 21.0)

    def test_the_refusal_does_not_depend_on_the_new_numbers_differing(self):
        self.snap(5)
        self.assertFalse(self.snap(5))

    def test_every_player_with_a_line_is_kept_rostered_or_not(self):
        """The snapshot used to be trimmed to the players rostered that
        Tuesday. A waiver add on Wednesday starts on Sunday and was missing
        from it — and a hole in a snapshot reads as "no line", which the
        engine prices at 0 while the week is upcoming and used to price at the
        positional mean once it was played. The pregame line of record must
        not move after the fact, so the snapshot records everyone quoted."""
        self.snap(5, {"a": {"wk": {"5": 18.0}}, "b": {"wk": {"5": 9.0}},
                      "waiver_add": {"wk": {"5": 11.0}}})
        self.assertEqual(sorted(self.hist()["5"]), ["a", "b", "waiver_add"])

    def test_nothing_to_archive_writes_nothing(self):
        self.assertFalse(self.snap(None))
        self.assertFalse(self.snap(5, {}))
        self.assertFalse(self.snap(5, {"a": {"wk": {"9": 30.0}}}))  # other week
        self.assertFalse(self.f.exists())

    def test_players_without_a_line_for_this_week_are_dropped_not_zeroed(self):
        self.snap(5, {"a": {"wk": {"5": 18.0}}, "b": {"wk": {}}})
        self.assertEqual(sorted(self.hist()["5"]), ["a"])

    def test_a_season_row_is_never_archived_as_a_weeks_line(self):
        """`src:"season"` rows carry `ppg` — the season total over 17 — and no
        week map. That figure never drops to zero on a bye and is not a
        projection for any week, so archiving it put a season average where a
        week's line belongs (Max, 2026-09-15 made the live path say so; the
        snapshot path kept doing it)."""
        self.assertFalse(self.snap(5, {"season_only": {"ppg": 12.0}}))
        self.assertTrue(self.snap(5, {"a": {"wk": {"5": 18.0}},
                                      "season_only": {"ppg": 12.0}}))
        self.assertEqual(sorted(self.hist()["5"]), ["a"])


class TestSnapshotIsRegularSeasonOnly(unittest.TestCase):
    """The gate in front of first-write-wins. Sleeper's /state/nfl reports
    season_type "pre" through August with `week` counting PREseason weeks — so
    an ungated August run archives preseason projections under week 1, 2 and 3
    of the regular season, and because the FIRST write of a week wins, the
    honest pregame snapshot is refused when that week actually arrives. This
    poisoned 2026's proj_history.json (three preseason weeks, committed
    2026-08-07/16/24) before the gate existed."""

    SEASONS = [SEASON]

    def state(self, **kw):
        return {"season": SEASON, "season_type": "regular", "week": 3, **kw}

    def test_the_regular_season_snapshots(self):
        self.assertEqual(snapshot_week(self.state(), self.SEASONS), (SEASON, 3))

    def test_the_preseason_does_not(self):
        """`week` here counts PREseason weeks, not regular-season ones."""
        self.assertIsNone(snapshot_week(self.state(season_type="pre"),
                                        self.SEASONS))

    def test_the_postseason_and_offseason_do_not(self):
        for st in ("post", "off"):
            self.assertIsNone(snapshot_week(self.state(season_type=st),
                                            self.SEASONS), st)

    def test_a_state_with_no_type_at_all_does_not(self):
        s = self.state()
        del s["season_type"]
        self.assertIsNone(snapshot_week(s, self.SEASONS))
        self.assertIsNone(snapshot_week({}, self.SEASONS))
        self.assertIsNone(snapshot_week(None, self.SEASONS))

    def test_a_season_that_is_not_built_does_not(self):
        self.assertIsNone(snapshot_week(self.state(season="2099"), self.SEASONS))

    def test_week_zero_or_missing_does_not(self):
        self.assertIsNone(snapshot_week(self.state(week=0), self.SEASONS))
        self.assertIsNone(snapshot_week(self.state(week=None), self.SEASONS))


# ---------------------------------------------------------------------------
# The bracket, and the season simulation that rides it.
# ---------------------------------------------------------------------------
class TestBracketShape(unittest.TestCase):
    """`run_bracket` replaced hand-written 4 / 6 / 8 branches that dropped a
    survivor at 10, raised a ValueError at 12, and put the 3 seed out of a
    3-team bracket without ever playing it."""

    @staticmethod
    def play(n, winner=min):
        field = list(range(1, n + 1))
        seed_of = {r: i + 1 for i, r in enumerate(field)}
        played = []

        def game(a, b):
            played.append((a, b))
            return winner(a, b)
        return run_bracket(field, seed_of, game), played

    def test_the_better_seed_always_winning_puts_one_and_two_in_the_final(self):
        for n in range(2, 17):
            self.assertEqual(self.play(n)[0], (1, 2), f"{n}-team bracket")

    def test_the_worse_seed_always_winning_still_returns_two_finalists(self):
        for n in range(2, 17):
            f1, f2 = self.play(n, winner=max)[0]
            self.assertNotEqual(f1, f2, f"{n}-team bracket")

    def test_six_teams_is_exactly_the_bracket_this_league_plays(self):
        """Byes for 1-2, then 3v6 and 4v5, then the 1 seed against the LOWER
        of the two winners. Unchanged from the hand-written branch."""
        self.assertEqual(first_round_byes(6), 2)
        _, played = self.play(6)
        self.assertEqual(played, [(3, 6), (4, 5), (1, 4), (2, 3)])

    def test_every_team_that_is_not_on_bye_plays_round_one(self):
        # from 3 up: a two-team "bracket" is the final, with no round one
        for n in range(3, 17):
            byes = first_round_byes(n)
            _, played = self.play(n)
            first = played[:(n - byes) // 2]
            self.assertEqual(sorted(r for g in first for r in g),
                             list(range(byes + 1, n + 1)), f"{n}-team bracket")

    def test_byes_fill_the_bracket_to_a_power_of_two(self):
        for n, want in ((2, 0), (3, 1), (4, 0), (5, 3), (6, 2), (7, 1),
                        (8, 0), (10, 6), (12, 4), (16, 0)):
            self.assertEqual(first_round_byes(n), want, n)


SIM_PS = 4                      # playoffs start week 4: weeks 1-3 are the season


def sim_inputs(n_teams=8, played=(1,), upcoming=(2, 3), playoff_teams=6):
    """A tiny league: `n_teams` franchises, some weeks scored and some still
    on the schedule, with a per-week line for each. Team `r` scores 100+r
    every week, so the seeding is unambiguous."""
    rids = list(range(1, n_teams + 1))
    pairs = [[rids[i], rids[i + 1]] for i in range(0, len(rids), 2)]
    teams = {str(r): [] for r in rids}
    for wk in played:
        for a, b in pairs:
            teams[str(a)].append([wk, 100.0 + a, b, 100.0 + b, [], []])
            teams[str(b)].append([wk, 100.0 + b, a, 100.0 + a, [], []])
    mw = {"playoff_start": SIM_PS, "teams": teams,
          "schedule": {str(wk): pairs for wk in upcoming}}
    odds = {str(wk): {str(r): {"mu": 100.0 + r, "sd": 20.0, "proj": True}
                      for r in rids}
            for wk in upcoming}
    return mw, odds, {"settings": {"playoff_teams": playoff_teams}}


class TestSeasonSim(unittest.TestCase):
    """The Monte Carlo over the rest of the season. Seeded, so these are
    exact claims rather than tolerances on a random draw."""

    def test_the_same_seed_gives_the_same_table(self):
        mw, odds, lg = sim_inputs()
        self.assertEqual(season_sim(mw, odds, lg, seed=7),
                         season_sim(mw, odds, lg, seed=7))

    def test_a_different_seed_moves_it(self):
        mw, odds, lg = sim_inputs()
        self.assertNotEqual(season_sim(mw, odds, lg, seed=1),
                            season_sim(mw, odds, lg, seed=2))

    def test_exactly_six_teams_make_it_two_rest_two_reach_the_final(self):
        """Every simulated season fills the same number of slots, so the
        probabilities sum to the size of each stage."""
        got = season_sim(*sim_inputs(), seed=1)
        for field, want in (("playoff", 6), ("bye", 2), ("final", 2),
                            ("title", 1)):
            self.assertAlmostEqual(sum(t[field] for t in got.values()), want,
                                   places=2, msg=field)

    def test_every_probability_is_a_probability(self):
        got = season_sim(*sim_inputs(), seed=1)
        for rid, t in got.items():
            for k, v in t.items():
                self.assertGreaterEqual(v, 0.0, f"{rid}.{k}")
                self.assertLessEqual(v, 1.0, f"{rid}.{k}")
            # you cannot win a title you did not reach the final of, nor reach
            # a final without making the field
            self.assertLessEqual(t["title"], t["final"] + 1e-9, rid)
            self.assertLessEqual(t["final"], t["playoff"] + 1e-9, rid)
            self.assertLessEqual(t["bye"], t["playoff"] + 1e-9, rid)

    def test_the_strongest_team_is_the_favorite(self):
        got = season_sim(*sim_inputs(), seed=1)
        best = max(got, key=lambda r: got[r]["title"])
        self.assertEqual(best, "8")            # team 8 scores the most
        self.assertGreater(got["8"]["playoff"], got["1"]["playoff"])

    def test_a_six_team_league_puts_everyone_in_the_bracket(self):
        got = season_sim(*sim_inputs(n_teams=6), seed=1)
        for rid, t in got.items():
            self.assertEqual(t["playoff"], 1.0, rid)

    def test_the_awkward_bracket_sizes_run_at_all(self):
        """3, 5, 7, 10 and 12 used to drop a survivor, raise a ValueError, or
        quietly hand the final to the top two seeds without a game."""
        for n_po in (2, 3, 4, 5, 6, 7, 8, 10, 12):
            got = season_sim(*sim_inputs(n_teams=12, playoff_teams=n_po), seed=1)
            self.assertAlmostEqual(sum(t["playoff"] for t in got.values()),
                                   n_po, places=2, msg=f"playoff_teams={n_po}")
            self.assertAlmostEqual(sum(t["title"] for t in got.values()), 1,
                                   places=2, msg=f"playoff_teams={n_po}")

    def test_a_nonsense_playoff_field_is_clamped_rather_than_crashing(self):
        for n_po in (0, 1, 99):
            got = season_sim(*sim_inputs(n_teams=8, playoff_teams=n_po), seed=1)
            self.assertAlmostEqual(sum(t["title"] for t in got.values()), 1,
                                   places=2, msg=f"playoff_teams={n_po}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
