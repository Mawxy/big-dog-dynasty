#!/usr/bin/env python3
"""
project_war.py's joins to its inputs: the nflverse name match, and which season
proj_sleeper.json is allowed to price.

A missed name match raises nothing. The player gets a default age, pick 999 and
no analog cohort, and all of that reads as a plausible projection: Chris Godwin
published at 27 when he is 30, because Sleeper started calling him "Chris Godwin
Jr." and the manual key stopped matching. The corpus's `common` column already
held the answer for most of these and nothing read it.

The rule the tests below lock is that `common` may only fill a MISS. Every match
that already resolved has to resolve to the same man.

Network-free, on a small players_meta.csv written to a temp dir.

  python -m unittest discover -s tests
"""
import contextlib
import csv
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import project_war                                                   # noqa: E402

# gsis, name, common, pos, birth_date, draft_season, draft_pick
META = [
    ("g-godwin", "Rod Godwin", "Chris Godwin", "WR", "1996-02-27", "2017", "84"),
    ("g-terry", "Terry Godwin", "Terry Godwin", "WR", "1996-10-23", "2019", "237"),
    ("g-deebo", "Tyshun Samuel", "Deebo Samuel", "WR", "1996-01-15", "2019", "36"),
    ("g-other-samuel", "Curtis Samuel", "Curtis Samuel", "WR", "1996-08-11", "2017", "40"),
    ("g-warren", "Derrell Warren", "Jaylen Warren", "RB", "1998-11-01", "", ""),
    ("g-zach", "Zach Warren", "Zach Warren", "RB", "1990-01-01", "", ""),
    ("g-cj", "De'Carlo Donaldson", "C.J. Donaldson", "RB", "2004-07-09", "", ""),
    ("g-herb", "Herb Donaldson", "Herb Donaldson", "RB", "1985-12-13", "", ""),
    # one Smith at WR under the legal name, so a lookup takes the singleton path
    ("g-alan", "Alan Smith", "Alan Smith", "WR", "1999-01-01", "2021", "50"),
    # ...and a man whose common name says "Bob Smith" under another legal surname
    ("g-zed", "Zed Quinn", "Bob Smith", "WR", "2001-01-01", "2023", "10"),
    # a legal "Joe Bar", and a younger man who merely goes by the same name
    ("g-joe", "Joe Bar", "Joe Bar", "TE", "1990-01-01", "2012", "20"),
    ("g-joey", "Joseph Baz", "Joe Bar", "TE", "2002-01-01", "2024", "30"),
    # two men with one common name and no legal match: youngest wins, as it does
    # for every other tie in match_meta
    ("g-old", "Fred Moss", "Tank Lake", "RB", "1980-01-01", "2002", "90"),
    ("g-new", "Fran Moss", "Tank Lake", "RB", "2003-01-01", "2025", "60"),
]


def write_meta(root):
    d = Path(root) / "nfl_history"
    d.mkdir()
    with open(d / "players_meta.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["gsis_id", "name", "common", "pos", "birth_date",
                    "draft_season", "draft_round", "draft_pick"])
        for g, n, c, p, b, ds, pk in META:
            w.writerow([g, n, c, p, b, ds, "1" if pk else "", pk])


class MatchTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        write_meta(tmp.name)
        with mock.patch.object(project_war, "ROOT", Path(tmp.name)):
            cls.idx = project_war.build_meta_index()

    def gsis(self, name, pos):
        m = project_war.match_meta(name, pos, self.idx)
        return m[3] if m else None

    def test_a_suffix_on_sleepers_name_still_reaches_the_manual_key(self):
        """THE BUG. Both keys went stale when Sleeper added the suffix."""
        self.assertEqual(self.gsis("Chris Godwin Jr.", "WR"), "g-godwin")
        self.assertEqual(self.gsis("Deebo Samuel Sr.", "WR"), "g-deebo")

    def test_the_bare_manual_key_still_works(self):
        self.assertEqual(self.gsis("Chris Godwin", "WR"), "g-godwin")
        self.assertEqual(self.gsis("Deebo Samuel", "WR"), "g-deebo")

    def test_every_manual_key_survives_normalization(self):
        """Two keys collapsing onto one normalized form would lose one silently."""
        self.assertEqual(len(project_war.MANUAL_BY_NORM), len(project_war.MANUAL_NAMES))

    def test_common_resolves_a_name_the_legal_tiers_miss(self):
        self.assertEqual(self.gsis("Jaylen Warren", "RB"), "g-warren")
        self.assertEqual(self.gsis("CJ Donaldson", "RB"), "g-cj")

    def test_a_match_carries_his_real_age_and_pick(self):
        birth, season, pick, gsis = project_war.match_meta(
            "Chris Godwin Jr.", "WR", self.idx)
        self.assertEqual((birth.year, season, pick, gsis), (1996, 2017, 84, "g-godwin"))
        self.assertEqual(project_war.age_on_sep1(birth, 2026), 30)

    def test_common_does_not_change_a_legal_singleton(self):
        """Alan is the only Smith at WR, so the singleton path has always given
        him any Smith at all. Zed's common name must not take that over, and must
        not turn Alan's list into a two-man tie-break either."""
        self.assertEqual(self.gsis("Bob Smith", "WR"), "g-alan")
        self.assertEqual(self.gsis("Alan Smith", "WR"), "g-alan")
        self.assertEqual(len(self.idx[("smith", "WR")]), 1)

    def test_an_exact_legal_name_beats_a_younger_common_namesake(self):
        self.assertEqual(self.gsis("Joe Bar", "TE"), "g-joe")

    def test_a_common_tie_goes_to_the_youngest(self):
        self.assertEqual(self.gsis("Tank Lake", "RB"), "g-new")

    def test_common_is_scoped_to_the_position(self):
        self.assertIsNone(self.gsis("Jaylen Warren", "QB"))

    def test_no_prefix_or_nickname_guessing_on_common(self):
        """Exact only. The tiers above guess because they are choosing among men
        who share a surname; this one has no such evidence to lean on."""
        self.assertIsNone(self.gsis("Tankard Lake", "RB"))

    def test_a_name_nobody_has_still_misses(self):
        self.assertIsNone(self.gsis("Nobody Here", "WR"))


class SleeperSeasonTest(unittest.TestCase):
    """Year 1 takes 90% of its composite from proj_sleeper.json, so the file has
    to be for the season year 1 is."""

    PLAYERS = {"1": {"pts13": 200.0}}

    def call(self, doc, year):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            got = project_war.sleeper_players(doc, year)
        return got, out.getvalue()

    def test_the_matching_season_is_read_quietly(self):
        got, log = self.call({"meta": {"season": 2026}, "players": self.PLAYERS}, 2026)
        self.assertEqual(got, self.PLAYERS)
        self.assertEqual(log, "")

    def test_last_seasons_lines_are_not_next_seasons_year_one(self):
        """THE BUG: after the title game the seed rolls to 2026, year 1 becomes
        2027, and the file still holds 2026 until Sleeper publishes."""
        got, log = self.call({"meta": {"season": 2026}, "players": self.PLAYERS}, 2027)
        self.assertEqual(got, {})
        self.assertIn("::warning", log)

    def test_a_season_stamped_as_a_string_still_compares(self):
        got, _ = self.call({"meta": {"season": "2026"}, "players": self.PLAYERS}, 2026)
        self.assertEqual(got, self.PLAYERS)

    def test_a_file_with_no_stamp_is_read_as_before(self):
        got, log = self.call({"players": self.PLAYERS}, 2027)
        self.assertEqual(got, self.PLAYERS)
        self.assertEqual(log, "")


if __name__ == "__main__":
    unittest.main()
