#!/usr/bin/env python3
"""
Which season a projection is allowed to seed from.

This is the rule that broke on 2026-09-15. `meta.latest` flips to the new
season the moment its first week freezes, project_war.py seeded off it, and the
scalar arm started projecting 2027-2029 from a single played game while every
other arm still projected 2026-2028. Nothing threw, nothing was empty, and the
default blend curve averaged two different years under one heading.

So the rule gets its own module and its own tests: a season is complete when
its winners bracket has a decided champion, and an in-progress season is never
a seed. Synthetic league trees only — no committed data, no network.

  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from seasons import (completed_seasons, last_completed_season,    # noqa: E402
                     league_seasons, season_complete)


def champ_game(winner=2):
    """A decided championship game, in bracket.json's shape."""
    return {"r": 3, "week": 17, "p": 1, "t1": 2, "t2": 6, "w": winner, "l": 6}


def seeded_game():
    """What Sleeper serves months before kickoff: a bracket with no result."""
    return {"r": 3, "week": 17, "p": 1, "t1": None, "t2": None, "w": None, "l": None}


class LeagueTree:
    """A throwaway league directory in the committed tree's shape."""

    def __init__(self, tmp, seasons, roster=None):
        self.d = Path(tmp)
        self.seasons = [str(s) for s in seasons]
        (self.d / "meta.json").write_text(json.dumps({
            "seasons": self.seasons, "latest": self.seasons[-1],
            "rosterSeason": str(roster or self.seasons[-1])}), encoding="utf-8")
        for s in self.seasons:
            (self.d / s).mkdir(parents=True, exist_ok=True)

    def bracket(self, season, games):
        (self.d / str(season) / "bracket.json").write_text(
            json.dumps({"playoff_start": 15, "winners": games}), encoding="utf-8")

    def franchises(self, finishes):
        """finishes: {season: {fkey: place}}"""
        out = {}
        for season, places in finishes.items():
            for fkey, place in places.items():
                out.setdefault(str(fkey), {"seasons": []})["seasons"].append(
                    {"season": str(season), "finish": place})
        (self.d / "franchises.json").write_text(json.dumps(out), encoding="utf-8")


class SeasonComplete(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.lg = LeagueTree(self._tmp.name, [2024, 2025, 2026])
        self.d = self.lg.d

    def test_a_decided_title_game_completes_the_season(self):
        self.lg.bracket(2025, [champ_game()])
        self.assertTrue(season_complete(self.d, 2025))

    def test_a_seeded_but_unplayed_bracket_does_not(self):
        """Sleeper mints the bracket long before the playoffs. A bracket
        existing is not a postseason having happened — the same distinction
        build_site_data.py draws before it hands out a FINISH."""
        self.lg.bracket(2026, [seeded_game()])
        self.assertFalse(season_complete(self.d, 2026))

    def test_playoff_rounds_without_the_title_game_do_not(self):
        """Mid-December: rounds 1 and 2 are decided and the final is not. The
        season is being played, so it cannot be the seed."""
        self.lg.bracket(2026, [
            {"r": 1, "week": 15, "p": None, "t1": 9, "t2": 11, "w": 9, "l": 11},
            {"r": 2, "week": 16, "p": 5, "t1": 8, "t2": 11, "w": 8, "l": 11},
        ])
        self.assertFalse(season_complete(self.d, 2026))

    def test_no_bracket_at_all_is_not_complete(self):
        """An in-progress September season has no bracket file. Absent must
        read as unfinished, not as 'nothing to object to'."""
        self.assertFalse(season_complete(self.d, 2026))

    def test_franchises_finish_one_stands_in_for_a_missing_bracket(self):
        """build_site_data only ever assigns finish 1 off the same decided
        game, so a league whose bracket file was never committed still answers."""
        self.lg.franchises({2024: {"1": 1, "2": 2}, 2025: {"1": 3, "2": 4}})
        self.assertTrue(season_complete(self.d, 2024))
        self.assertFalse(season_complete(self.d, 2025))

    def test_a_null_finish_is_not_a_first_place(self):
        self.lg.franchises({2026: {"1": None, "2": None}})
        self.assertFalse(season_complete(self.d, 2026))


class LastCompleted(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.lg = LeagueTree(self._tmp.name, [2022, 2023, 2024, 2025, 2026])
        self.d = self.lg.d
        for y in (2022, 2023, 2024, 2025):
            self.lg.bracket(y, [champ_game()])

    def test_the_in_progress_season_is_never_the_seed(self):
        """THE 2026-09-15 CASE. meta.latest is 2026 and week 1 is scored; the
        seed has to stay 2025."""
        self.assertEqual(last_completed_season(self.d), 2025)

    def test_it_advances_the_moment_the_title_game_is_played(self):
        """And in the offseason the seed IS the roster season — which is what
        meta.latest used to get right, and why this is not simply 'never the
        newest season'."""
        self.lg.bracket(2026, [champ_game()])
        self.assertEqual(last_completed_season(self.d), 2026)

    def test_completed_seasons_lists_them_in_order(self):
        self.assertEqual(completed_seasons(self.d), [2022, 2023, 2024, 2025])

    def test_an_explicit_season_list_is_respected(self):
        self.assertEqual(last_completed_season(self.d, [2022, 2023]), 2023)

    def test_no_finished_season_answers_none_rather_than_guessing(self):
        """A league in its first year. None is a real answer; the caller
        chooses the fallback instead of being handed a year nobody played."""
        with tempfile.TemporaryDirectory() as tmp:
            LeagueTree(tmp, [2026])
            self.assertIsNone(last_completed_season(Path(tmp)))

    def test_a_missing_meta_falls_back_to_the_season_directories(self):
        (self.d / "meta.json").unlink()
        self.assertEqual(league_seasons(self.d), [2022, 2023, 2024, 2025, 2026])
        self.assertEqual(last_completed_season(self.d), 2025)

    def test_unreadable_json_is_not_a_completed_season(self):
        (self.d / "2026" / "bracket.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(last_completed_season(self.d), 2025)


class AgainstTheCommittedTree(unittest.TestCase):
    """The default league, read-only. 2026 is in progress today."""

    def test_the_default_league_seeds_from_a_finished_season(self):
        from leaguepaths import DataDir
        data = DataDir(ROOT / "data")
        seed = last_completed_season(data)
        self.assertIsNotNone(seed)
        # whatever the seed is, the season after it must still be unfinished —
        # otherwise the helper stopped short of a season that has a champion
        self.assertFalse(season_complete(data, seed + 1))


if __name__ == "__main__":
    unittest.main()
