#!/usr/bin/env python3
"""
The in-season outlook: banked WAR plus what is left of the projection.

Year 1 of every projection curve is a FULL-SEASON figure for the roster season.
In week 4 that is four weeks of settled fact quoted as though they had not
happened yet, so the site shows

    outlook = banked + year1 * remaining_frac

and scripts/inseason.py owns every term of it. What these lock down is the
arithmetic at the edges, because the middle is obvious and the edges are where
a prorated figure stops being defensible:

  * week 0 -> the factor is exactly 1.0 and the outlook IS the projection. The
    offseason must be bit-for-bit what it was before this existed.
  * week 14 of 14 -> the factor is exactly 0.0 and the outlook IS the banked
    season. The projection describes games that have all already been played.
  * never negative. A factor below zero would print an outlook UNDER a player's
    banked WAR — the model subtracting production he has already delivered.
  * no block -> no proration, ever. Out of season, or when year 1 is not the
    roster season, there is nothing banked to add.

Everything here is synthetic: temp directories and literal matchup payloads,
no committed data, no network, no pipeline run.

  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import inseason                                                  # noqa: E402

TS = ROOT / "src" / "lib" / "outlook.ts"


def matchups(weeks, playoff_start=15, teams=("1", "2")):
    """A matchups.json payload that has scored `weeks`.

    Entries are build_site_data's own shape — [week, pts, opp, opp_pts, ...] —
    trimmed to what anything here reads.
    """
    return {"playoff_start": playoff_start,
            "teams": {t: [[w, 100.0 + w, 2, 99.0] for w in weeks] for t in teams}}


def summary(rows):
    """summary.json rows: [pid, pos, gp, pts, ppg, WAA, WAR, sdv, VoWP]."""
    return [[pid, pos, gp, 0.0, 0.0, 0.0, war, 0.0, None]
            for pid, pos, gp, war in rows]


class Tree:
    """A league directory carrying only what `block()` reads."""

    def __init__(self, tmp, season=2026, weeks=(1,), playoff_start=15,
                 champion=False):
        self.d = Path(tmp)
        (self.d / str(season)).mkdir(parents=True, exist_ok=True)
        self.write(f"{season}/matchups.json",
                   matchups(weeks, playoff_start) if weeks is not None else {})
        self.write("meta.json", {"seasons": [str(season)], "latest": str(season),
                                 "rosterSeason": str(season)})
        if champion:
            self.write(f"{season}/bracket.json", {"winners": [
                {"r": 3, "week": 17, "p": 1, "t1": 2, "t2": 6, "w": 2, "l": 6}]})

    def write(self, name, obj):
        p = self.d / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj), encoding="utf-8")


class RegWeeks(unittest.TestCase):
    """The LEAGUE's regular season, not the NFL's 18 weeks."""

    def test_big_dog_is_fourteen(self):
        self.assertEqual(inseason.reg_weeks(matchups([1], playoff_start=15)), 14)

    def test_an_earlier_bracket_shortens_it(self):
        self.assertEqual(inseason.reg_weeks(matchups([1], playoff_start=14)), 13)

    def test_a_file_with_no_playoff_start_falls_back_to_sleepers_default(self):
        """The same 15 build_site_data, week_odds and usage_stats fall back to."""
        self.assertEqual(inseason.reg_weeks({}), 14)
        self.assertEqual(inseason.reg_weeks(None), 14)

    def test_it_is_never_zero(self):
        """A bracket starting in week 1 leaves no regular season to prorate,
        and dividing by zero is not a better answer than one week."""
        self.assertEqual(inseason.reg_weeks(matchups([], playoff_start=1)), 1)


class WeeksPlayed(unittest.TestCase):
    """matchups.json IS the played record: build_site_data only writes a week
    once it has points, so a week in progress is not in it."""

    def test_before_kickoff_nothing_is_played(self):
        self.assertEqual(inseason.weeks_played(matchups([])), 0)
        self.assertEqual(inseason.weeks_played({}), 0)

    def test_week_one_scored_is_one(self):
        self.assertEqual(inseason.weeks_played(matchups([1])), 1)

    def test_weeks_are_counted_once_across_every_roster(self):
        """Twelve rosters carry a row each for the same week."""
        mw = matchups([1, 2, 3], teams=[str(i) for i in range(1, 13)])
        self.assertEqual(inseason.weeks_played(mw), 3)

    def test_a_team_missing_a_week_still_counts_it(self):
        mw = matchups([1, 2], teams=("1",))
        mw["teams"]["2"] = [[1, 88.0, 1, 90.0]]
        self.assertEqual(inseason.weeks_played(mw), 2)

    def test_playoff_weeks_are_not_regular_season_weeks(self):
        """The figure being prorated is regular-season WAR; summary.json stops
        at playoff_start and so does this."""
        self.assertEqual(inseason.weeks_played(matchups([13, 14, 15, 16])), 2)

    def test_a_malformed_row_is_skipped_not_raised(self):
        mw = matchups([1])
        mw["teams"]["3"] = [[], None, {"week": 2}]
        self.assertEqual(inseason.weeks_played(mw), 2)


class RemainingFraction(unittest.TestCase):
    def test_week_zero_is_the_whole_season(self):
        self.assertEqual(inseason.remaining_frac(matchups([])), 1.0)

    def test_week_four_of_fourteen_leaves_ten_fourteenths(self):
        """Max's own example: in week 4 we have four weeks of actual data and
        ten weeks of projection left."""
        self.assertAlmostEqual(inseason.remaining_frac(matchups([1, 2, 3, 4])),
                               10 / 14, places=12)

    def test_a_finished_regular_season_leaves_nothing(self):
        self.assertEqual(inseason.remaining_frac(matchups(range(1, 15))), 0.0)

    def test_it_is_never_negative(self):
        """More scored weeks than the regular season has (a mis-set
        playoff_start, a league that changed its bracket mid-year) must clamp
        to zero — a negative factor would SUBTRACT the projection from the
        player's banked production."""
        self.assertEqual(inseason.remaining_frac(matchups(range(1, 15),
                                                          playoff_start=10)), 0.0)
        self.assertEqual(inseason.frac_of(99, 14), 0.0)

    def test_it_is_never_above_one(self):
        self.assertEqual(inseason.frac_of(-3, 14), 1.0)

    def test_it_falls_one_week_at_a_time(self):
        seen = [inseason.frac_of(w, 14) for w in range(15)]
        self.assertEqual(seen, sorted(seen, reverse=True))
        for a, b in zip(seen, seen[1:]):
            self.assertAlmostEqual(a - b, 1 / 14, places=12)


class BankedWar(unittest.TestCase):
    """summary.json's WAR column, which is regular-season only already."""

    ROWS = summary([("4046", "QB", 1, 0.212), ("3198", "RB", 1, 0.249),
                    ("9999", "WR", 0, -0.118)])

    def test_the_war_column_is_column_six(self):
        got = inseason.banked_war(self.ROWS)
        self.assertAlmostEqual(got["4046"][0], 0.212)
        self.assertAlmostEqual(got["3198"][0], 0.249)

    def test_games_played_rides_along(self):
        self.assertEqual(inseason.banked_war(self.ROWS)["4046"][1], 1)

    def test_a_dressed_zero_point_game_can_bank_negative(self):
        """The played rule (PROJECT_NOTES §5): dressed is played, and a dressed
        zero is a real negative rather than an absence."""
        self.assertLess(inseason.banked_war(self.ROWS)["9999"][0], 0.0)

    def test_a_player_with_no_row_is_absent_not_zero(self):
        """Callers supply the 0.0 — a dict of zeros over every player alive
        would be most of the file and none of the information."""
        self.assertNotIn("12345", inseason.banked_war(self.ROWS))

    def test_a_short_or_broken_row_is_skipped(self):
        self.assertEqual(inseason.banked_war([["1", "QB", 1], None, "nonsense",
                                              ["2", "QB", "x", 0, 0, 0, "y"]]), {})

    def test_an_empty_season_banks_nothing(self):
        self.assertEqual(inseason.banked_war([]), {})
        self.assertEqual(inseason.banked_war(None), {})


class Outlook(unittest.TestCase):
    """banked + year1 * remaining_frac. Mirrored by outlookY1 in outlook.ts."""

    WK4 = {"season": 2026, "weeks_played": 4, "reg_weeks": 14,
           "remaining_frac": 10 / 14}

    def test_week_four_adds_the_banked_half_to_the_prorated_half(self):
        self.assertAlmostEqual(inseason.outlook(1.40, 0.35, self.WK4),
                               0.35 + 1.40 * 10 / 14, places=12)

    def test_week_zero_is_exactly_the_projection(self):
        blk = {"season": 2026, "weeks_played": 0, "reg_weeks": 14,
               "remaining_frac": 1.0}
        self.assertEqual(inseason.outlook(1.40, 0.0, blk), 1.40)

    def test_a_finished_regular_season_is_exactly_what_was_banked(self):
        blk = {"season": 2026, "weeks_played": 14, "reg_weeks": 14,
               "remaining_frac": 0.0}
        self.assertEqual(inseason.outlook(1.40, 1.92, blk), 1.92)

    def test_no_block_returns_the_projection_untouched(self):
        """The offseason path, and the one thing this feature must not break."""
        for blk in (None, {}, False):
            self.assertEqual(inseason.outlook(1.40, 0.35, blk), 1.40, blk)

    def test_no_projection_is_no_outlook(self):
        """Never fall back to the banked figure alone — that would publish a
        number the model never said, under the model's own heading."""
        self.assertIsNone(inseason.outlook(None, 0.35, self.WK4))
        self.assertIsNone(inseason.outlook(None, None, None))

    def test_a_player_who_has_not_played_banks_a_real_zero(self):
        self.assertAlmostEqual(inseason.outlook(1.40, None, self.WK4),
                               1.40 * 10 / 14, places=12)
        self.assertAlmostEqual(inseason.outlook(1.40, 0.0, self.WK4),
                               1.40 * 10 / 14, places=12)

    def test_a_negative_projection_still_only_loses_what_is_left(self):
        """A backup projected below replacement has already banked part of it;
        the rest shrinks toward zero as the season runs out, it does not
        double."""
        self.assertGreater(inseason.outlook(-1.40, -0.30, self.WK4), -1.40)

    def test_the_outlook_walks_from_the_projection_to_the_banked_season(self):
        y1, banked = 1.40, 0.50
        path = [inseason.outlook(y1, banked, {"remaining_frac": inseason.frac_of(w, 14)})
                for w in range(15)]
        self.assertAlmostEqual(path[0], banked + y1)
        self.assertAlmostEqual(path[-1], banked)
        self.assertEqual(path, sorted(path, reverse=True))


class Block(unittest.TestCase):
    """When the pipeline publishes a block at all — the three conditions, each
    of which exists because prorating outside it would be wrong rather than
    merely pointless."""

    def blk(self, **kw):
        year1 = kw.pop("year1", 2026)
        with tempfile.TemporaryDirectory() as t:
            tree = Tree(t, **kw)
            return inseason.block(tree.d, kw.get("season", 2026), year1)

    def test_a_live_season_publishes_the_four_facts(self):
        got = self.blk(weeks=(1, 2, 3, 4))
        self.assertEqual(set(got), set(inseason.BLOCK_KEYS))
        self.assertEqual(got["season"], 2026)
        self.assertEqual(got["weeks_played"], 4)
        self.assertEqual(got["reg_weeks"], 14)
        self.assertAlmostEqual(got["remaining_frac"], 10 / 14, places=5)

    def test_week_one_publishes_a_block(self):
        """Where the 2026 season actually is as this ships."""
        got = self.blk(weeks=(1,))
        self.assertEqual((got["weeks_played"], got["reg_weeks"]), (1, 14))

    def test_before_kickoff_there_is_no_block(self):
        """remaining_frac 1.0 and every banked 0.0 changes no figure; a block
        that does nothing is only a thing to get wrong."""
        self.assertIsNone(self.blk(weeks=()))

    def test_a_season_with_a_champion_has_no_block(self):
        """Once the title game is decided the projection has rolled forward and
        year 1 is next season — nothing of it has been banked."""
        self.assertIsNone(self.blk(weeks=tuple(range(1, 15)), champion=True))

    def test_a_projection_whose_year_one_is_not_the_roster_season_has_none(self):
        """January-to-September: the roster still says 2026, year 1 is 2027.
        Adding 2026's banked WAR to a 2027 projection would be nonsense."""
        self.assertIsNone(self.blk(weeks=(1, 2), year1=2027))

    def test_a_missing_matchups_file_is_not_an_in_season_league(self):
        with tempfile.TemporaryDirectory() as t:
            tree = Tree(t, weeks=None)
            self.assertIsNone(inseason.block(tree.d, 2026, 2026))

    def test_no_roster_season_or_no_year_one_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as t:
            tree = Tree(t)
            self.assertIsNone(inseason.block(tree.d, None, 2026))
            self.assertIsNone(inseason.block(tree.d, 2026, None))
            self.assertIsNone(inseason.block(tree.d, "n/a", 2026))

    def test_string_seasons_are_the_same_season(self):
        """meta.json spells seasons as strings and the projection files as
        ints; the block must not be dropped over that."""
        with tempfile.TemporaryDirectory() as t:
            tree = Tree(t, weeks=(1, 2))
            self.assertIsNotNone(inseason.block(tree.d, "2026", 2026))

    def test_the_caller_may_hand_over_the_matchups_it_already_loaded(self):
        with tempfile.TemporaryDirectory() as t:
            tree = Tree(t, weeks=(1,))
            got = inseason.block(tree.d, 2026, 2026, mw=matchups([1, 2, 3]))
            self.assertEqual(got["weeks_played"], 3)

    def test_the_published_fraction_is_the_one_the_outlook_uses(self):
        """The block carries a ROUNDED fraction and both languages compute the
        outlook from that same published number, so the site and a Python
        reader cannot differ in the last digit."""
        got = self.blk(weeks=(1, 2, 3, 4))
        self.assertEqual(got["remaining_frac"], round(inseason.frac_of(4, 14), 6))
        self.assertAlmostEqual(inseason.outlook(1.0, 0.0, got),
                               got["remaining_frac"], places=12)


class LabelText(unittest.TestCase):
    def test_one_week_is_singular(self):
        self.assertEqual(inseason.label({"season": 2026, "weeks_played": 1}),
                         "2026 outlook · 1 wk banked")

    def test_more_than_one_is_plural(self):
        self.assertEqual(inseason.label({"season": 2026, "weeks_played": 4}),
                         "2026 outlook · 4 wks banked")

    def test_no_block_says_nothing(self):
        self.assertEqual(inseason.label(None), "")


class LockstepWithTheFrontEnd(unittest.TestCase):
    """scripts/inseason.py and src/lib/outlook.ts hold the same formula in two
    languages, on purpose: the pipeline publishes the facts and the browser
    does the arithmetic. Nothing can execute the TypeScript here, so what is
    checked is that the two files still describe the same thing — the block's
    field names (which ARE the JSON contract) and the pointer each carries to
    the other.
    """

    def setUp(self):
        if not TS.exists():
            self.fail(f"{TS} is missing — the front-end mirror")
        self.ts = TS.read_text(encoding="utf-8")

    def test_the_typescript_declares_every_published_field(self):
        block = self.ts.split("export type InSeason = {", 1)[1].split("};", 1)[0]
        for k in inseason.BLOCK_KEYS:
            self.assertIn(k, block, k)

    def test_each_file_names_the_other(self):
        py = Path(inseason.__file__).read_text(encoding="utf-8")
        self.assertIn("src/lib/outlook.ts", py)
        self.assertIn("scripts/inseason.py", self.ts)

    def test_both_say_they_are_in_lockstep(self):
        py = Path(inseason.__file__).read_text(encoding="utf-8")
        self.assertIn("lockstep", py.lower())
        self.assertIn("lockstep", self.ts.lower())

    def test_the_typescript_carries_the_same_formula(self):
        """`banked + y1 * remaining_frac`, however it is spelled there."""
        body = self.ts.split("export function outlookY1", 1)[1]
        self.assertIn("remaining_frac", body)
        self.assertIn("* inseason.remaining_frac", body.replace("\n", " "))


if __name__ == "__main__":
    unittest.main()
