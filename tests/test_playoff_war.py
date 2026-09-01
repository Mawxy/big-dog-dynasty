#!/usr/bin/env python3
"""
Invariants of playoff WAR (scripts/playoff_war.py).

Playoff WAR is the only figure on the playoffs page NOT conditioned on the
result — it credits production in a loss. These lock the two decisions that
make it trustworthy (METHODOLOGY.md, "Playoff WAR"):

  1. sigma is imported from the REGULAR season, never the playoff weeks
  2. elimination games only — no placement games, no consolation bracket

Pure stdlib, no network, no committed fixtures: the season dumps below are
synthetic Sleeper-shaped trees built in a temp directory, so nothing here
depends on a local sleeper_pull run and everything runs in CI.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import playoff_war as pw                                    # noqa: E402
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


# ---------------------------------------------------------------------------
# The two decisions above, exercised through playoff_war.py itself rather than
# through the engine it borrows. A synthetic Sleeper dump: `matchups/week_N.json`
# is a list of team objects, `bracket.json` carries the winners bracket.
# ---------------------------------------------------------------------------
PLAYOFF_START = 15


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding="utf-8")


def team(rid, points, starters=(), total=None):
    return {"roster_id": rid, "starters": list(starters), "players_points": points,
            "points": round(sum(points.values()), 2) if total is None else total}


class SeasonFixture:
    """One synthetic season on disk. `raw` is the sleeper_pull-shaped dump,
    `ld` the site-data root that owns bracket.json."""

    LEAGUE = {"season": "2025", "total_rosters": 4,
              # no FLEX/SUPER_FLEX: four dedicated slots per position keeps the
              # replacement baseline arithmetic obvious
              "roster_positions": ["QB", "RB", "WR", "TE", "BN"],
              "settings": {"playoff_week_start": PLAYOFF_START},
              "scoring_settings": {}}

    def __init__(self, tmp, regular_scores, playoff_teams, bracket_games,
                 played=None):
        self.raw, self.ld = Path(tmp) / "raw", Path(tmp) / "data"
        self.sdir = self.raw / "2025"
        write_json(self.sdir / "league.json", self.LEAGUE)
        for wk, scores in regular_scores.items():
            write_json(self.sdir / "matchups" / f"week_{wk}.json",
                       [{"roster_id": i + 1, "points": s}
                        for i, s in enumerate(scores)])
        for wk, teams in playoff_teams.items():
            write_json(self.sdir / "matchups" / f"week_{wk}.json", teams)
        # sleeper_pull's played map: pid -> nfl team, for the players the stats
        # feed says DRESSED. Absent for older dumps, which is a tested branch.
        for wk, pids in (played or {}).items():
            write_json(self.sdir / "played" / f"week_{wk:02d}.json",
                       {p: "KC" for p in pids})
        write_json(self.ld / "2025" / "bracket.json", {"winners": bracket_games})

    def run(self):
        return pw.season_war("2025", self.ld, self.raw, self.PLAYERS)

    # eight quarterbacks so the pool is deeper than the four QB slots and
    # replacement level is a real player rather than the 0.0 fallback
    PLAYERS = {f"q{i}": {"position": "QB"} for i in range(1, 9)}


# 14 regular-season weeks of four team scores, deliberately tight
REGULAR = {wk: [100.0, 105.0, 95.0, 110.0] for wk in range(1, 15)}
# the elimination week: q1..q4 start, q5..q8 sit on rosters and set replacement
WEEK16 = [team(1, {"q1": 30.0, "q5": 5.0}, ["q1"]),
          team(2, {"q2": 25.0, "q6": 4.0}, ["q2"]),
          team(3, {"q3": 22.0, "q7": 3.0}, ["q3"]),
          team(4, {"q4": 20.0, "q8": 2.0}, ["q4"])]
# the same week, but q2 DRESSED and scored exactly 0.00 in the final. His zero
# sorts below q5..q8, so replacement is 4.0 (q6) whether or not he is counted —
# which is what makes the two branches below directly comparable.
WEEK16_ZERO = [team(1, {"q1": 30.0, "q5": 5.0}, ["q1"]),
               team(2, {"q2": 0.0, "q6": 4.0}, ["q2"]),
               team(3, {"q3": 22.0, "q7": 3.0}, ["q3"]),
               team(4, {"q4": 20.0, "q8": 2.0}, ["q4"])]
# the final (p == 1) and the third-place game (p == 3) in the same week
FINAL = {"r": 3, "m": 1, "week": 16, "t1": 1, "t2": 2, "w": 1, "l": 2, "p": 1}
PLACEMENT = {"r": 3, "m": 2, "week": 16, "t1": 3, "t2": 4, "w": 3, "l": 4, "p": 3}


class TestRegularSeasonSigma(unittest.TestCase):
    """DEPARTURE 1. The points-per-win exchange rate comes from weeks 1..14
    only. Playoff weeks carry the consolation bracket's unset lineups, which
    read as variance and quietly make every marginal point worth FEWER wins —
    2025 week 15 measured 41.4 against a regular-season 29.3."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.sdir = Path(self._tmp.name) / "2025"
        self.addCleanup(self._tmp.cleanup)

    def weeks(self, by_week):
        for wk, scores in by_week.items():
            write_json(self.sdir / "matchups" / f"week_{wk}.json",
                       [{"roster_id": i + 1, "points": s}
                        for i, s in enumerate(scores)])

    def test_playoff_weeks_cannot_widen_the_spread(self):
        self.weeks(REGULAR)
        tight = pw.regular_season_sigma(self.sdir, PLAYOFF_START)
        # a consolation-inflated postseason: half the teams stopped setting a
        # lineup. An in-week sigma here would be enormous.
        self.weeks({15: [140.0, 20.0, 150.0, 18.0],
                    16: [160.0, 12.0, 155.0, 9.0]})
        self.assertEqual(pw.regular_season_sigma(self.sdir, PLAYOFF_START), tight)

    def test_the_boundary_week_is_the_first_excluded_one(self):
        """`>= playoff_start` — week 14 counts, week 15 does not."""
        self.weeks({14: [100.0, 105.0], 15: [400.0, 4.0]})
        with_14 = pw.regular_season_sigma(self.sdir, PLAYOFF_START)
        self.assertAlmostEqual(with_14, pw.regular_season_sigma(
            self.sdir, 15), places=9)
        # move the boundary up and week 14's own spread is what disappears
        self.assertEqual(pw.regular_season_sigma(self.sdir, 14), 0.0)

    def test_a_wider_regular_season_lowers_the_value_of_a_point(self):
        self.weeks(REGULAR)
        tight = pw.regular_season_sigma(self.sdir, PLAYOFF_START)
        self.weeks({wk: [60.0, 160.0, 55.0, 170.0] for wk in range(1, 15)})
        wide = pw.regular_season_sigma(self.sdir, PLAYOFF_START)
        self.assertGreater(wide, tight)
        self.assertGreater(norm_win_shift(20.0, tight), norm_win_shift(20.0, wide))

    def test_too_few_scores_is_zero_not_a_crash(self):
        self.weeks({1: [100.0]})
        self.assertEqual(pw.regular_season_sigma(self.sdir, PLAYOFF_START), 0.0)

    def test_unscored_weeks_contribute_nothing(self):
        """A week Sleeper has seeded but nobody has played reports 0 points,
        and a pile of zeros would read as an enormous spread."""
        self.weeks({wk: REGULAR[wk] for wk in range(1, 14)})
        base = pw.regular_season_sigma(self.sdir, PLAYOFF_START)
        self.weeks({14: [0, 0, 0, 0]})
        self.assertEqual(pw.regular_season_sigma(self.sdir, PLAYOFF_START), base)


class TestEliminationGamesOnly(unittest.TestCase):
    """DEPARTURE 2. A player accrues playoff WAR for a quarterfinal, semifinal
    or final — not for a placement game and not for the consolation bracket.
    The filter is `g["p"] > 1`: Sleeper tags the title game p=1 and every
    placement game with the place it decides."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def fixture(self, games, week16=WEEK16, regular=REGULAR):
        return SeasonFixture(self._tmp.name, regular, {16: week16}, games)

    def test_a_placement_game_credits_nobody(self):
        war, _ = self.fixture([FINAL, PLACEMENT]).run()
        self.assertEqual(sorted(war), ["q1", "q2"])       # not q3 / q4

    def test_the_title_game_is_p_equals_1_and_counts(self):
        """p is not a placement marker for the final — 1 is the title itself,
        and `> 1` is what keeps it in."""
        war, _ = self.fixture([FINAL]).run()
        self.assertIn("q1", war)

    def test_an_untagged_bracket_game_is_an_elimination_game(self):
        """Quarterfinals and semifinals carry no `p` at all."""
        qf = {"r": 1, "m": 1, "week": 16, "t1": 3, "t2": 4, "w": 3, "l": 4}
        war, _ = self.fixture([qf]).run()
        self.assertEqual(sorted(war), ["q3", "q4"])

    def test_the_loser_is_credited_too(self):
        """The whole reason this figure exists: production in a loss counts."""
        war, _ = self.fixture([FINAL]).run()
        self.assertGreater(war["q2"]["war"], 0.0)         # q2 lost to q1
        self.assertEqual(war["q2"]["rid"], 2)

    def test_par_is_points_over_the_best_player_left_out_of_the_pool(self):
        """Four QB slots, eight QBs in the pool: replacement is the 5th, at
        5.0. Lineups never enter the pool — q5..q8 were benched and still set
        the baseline."""
        war, sigma = self.fixture([FINAL]).run()
        self.assertAlmostEqual(war["q1"]["par"], 30.0 - 5.0, places=6)
        self.assertAlmostEqual(war["q1"]["war"],
                               round(norm_win_shift(25.0, sigma), 4), places=4)

    def test_the_sigma_used_is_the_regular_seasons(self):
        war, sigma = self.fixture([FINAL]).run()
        self.assertEqual(sigma, round(
            pw.regular_season_sigma(Path(self._tmp.name) / "raw" / "2025",
                                    PLAYOFF_START), 2))
        # The same players, but the consolation half stopped setting a lineup:
        # team totals now range 9..250, which an in-week sigma would read as
        # colossal variance and which must not touch anything here.
        consolation = [
            team(1, {"q1": 30.0, "q5": 5.0}, ["q1"], total=250.0),
            team(2, {"q2": 25.0, "q6": 4.0}, ["q2"], total=240.0),
            team(3, {"q3": 22.0, "q7": 3.0}, ["q3"], total=12.0),
            team(4, {"q4": 20.0, "q8": 2.0}, ["q4"], total=9.0)]
        with tempfile.TemporaryDirectory() as td:
            war2, sigma2 = SeasonFixture(td, REGULAR, {16: consolation},
                                         [FINAL]).run()
        self.assertEqual(sigma2, sigma)
        self.assertAlmostEqual(war2["q1"]["war"], war["q1"]["war"], places=9)

    def test_a_season_with_no_regular_season_spread_is_skipped(self):
        """sigma <= 0 has no exchange rate, so there is no honest figure."""
        with tempfile.TemporaryDirectory() as td:
            self.assertIsNone(SeasonFixture(td, {1: [100.0]}, {16: WEEK16},
                                            [FINAL]).run())


class TestADressedZeroIsAPlayedZero(unittest.TestCase):
    """The played rule (PROJECT_NOTES methodology #5, settled 2026-08-07) is
    position-INDEPENDENT: dressed = played, and a dressed 0.00 is a real zero
    that accrues NEGATIVE points above replacement. playoff_war used to drop
    any starter whose points were falsy, so a dressed zero in an elimination
    game accrued nothing — disagreeing with sleeper_war, with playoff_wpa, and
    with the rule itself.

    `played/week_NN.json` is the evidence, and sleeper_pull writes it for
    playoff weeks too. WITHOUT one (older dumps) there is no way to tell a
    dressed zero from a bye, so the old 0.00 = DNP fallback stands — the same
    fallback sleeper_war keeps."""

    ALL_EIGHT = [f"q{i}" for i in range(1, 9)]

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def run_week(self, played=None):
        return SeasonFixture(tempfile.mkdtemp(dir=self._tmp.name), REGULAR,
                             {16: WEEK16_ZERO}, [FINAL],
                             {16: played} if played else None).run()

    def test_with_a_played_file_the_zero_is_credited_and_it_is_negative(self):
        """q2 dressed and scored 0.00 in the final. Replacement that week is
        4.0 (q6, the best QB left out of the four slots), so he is 4.0 points
        BELOW replacement and the wins that converts to are negative."""
        war, sigma = self.run_week(self.ALL_EIGHT)
        self.assertIn("q2", war)
        self.assertAlmostEqual(war["q2"]["par"], -4.0, places=6)
        self.assertLess(war["q2"]["war"], 0.0)
        self.assertEqual(war["q2"]["gp"], 1)
        self.assertAlmostEqual(war["q2"]["war"],
                               round(norm_win_shift(-4.0, sigma), 4), places=4)

    def test_without_a_played_file_the_zero_stays_a_dnp(self):
        """Nothing distinguishes it from a bye, and inventing a penalty out of
        a dump that cannot support one is worse than the omission."""
        war, _ = self.run_week()
        self.assertNotIn("q2", war)
        self.assertIn("q1", war)                       # and the week did price

    def test_a_starter_the_feed_says_did_not_dress_is_still_excluded(self):
        """The file is a played SET, not a licence to count everyone: q2 is
        listed nowhere in it, so his 0.00 is a bye/inactive and accrues
        nothing."""
        war, _ = self.run_week([p for p in self.ALL_EIGHT if p != "q2"])
        self.assertNotIn("q2", war)

    def test_the_zero_does_not_move_the_replacement_baseline(self):
        """A 0.00 can only enter the pool below everyone already in it, so
        every other starter's figure is untouched by the fix."""
        with_file, _ = self.run_week(self.ALL_EIGHT)
        without, _ = self.run_week()
        self.assertAlmostEqual(with_file["q1"]["par"], 30.0 - 4.0, places=6)
        self.assertAlmostEqual(with_file["q1"]["war"], without["q1"]["war"],
                               places=9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
