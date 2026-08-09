"""Locks the position overrides and the franchise-player definition.

Both encode judgements rather than derivations — which seasons a player was
eligible at which position, and what bar makes someone a franchise player — so
a change here is a change in what the figures MEAN.
"""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fp = _load("franchise_players")

MATTHEWS = "00-0031299"
HILL = "00-0033357"
THOMAS = "00-0031280"

# The analysis stack nfl_history.py pulls in lazily, inside pull_season. Only
# one of these going missing is a legitimate reason to skip the locks below.
OPTIONAL_DEPS = {"polars", "nflreadpy", "pyarrow", "pandas", "numpy"}


class PosOverrideTest(unittest.TestCase):
    """nfl_history imports polars lazily inside pull_season, so importing the
    module for these pure helpers is safe without the analysis stack."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.nh = _load("nfl_history")
        except ModuleNotFoundError as e:             # pragma: no cover
            # A missing heavy dependency is an environment fact and skipping is
            # right. ANYTHING else — a syntax error, a NameError, a module-level
            # import that should have stayed lazy — is a real regression, and
            # swallowing it silently disables every POS_OVERRIDE lock in this
            # class while the suite still reports green.
            if (e.name or "").split(".")[0] not in OPTIONAL_DEPS:
                raise
            raise unittest.SkipTest(f"optional dependency {e.name} missing: {e}")

    def test_matthews_is_a_receiver_through_his_productive_years(self):
        base = {MATTHEWS: "TE"}
        for y in (2014, 2015, 2016):
            self.assertEqual(self.nh.pos_for(base, MATTHEWS, y), "WR", y)

    def test_matthews_reverts_to_the_source_afterwards(self):
        base = {MATTHEWS: "TE"}
        self.assertEqual(self.nh.pos_for(base, MATTHEWS, 2018), "TE")

    def test_pinned_players_ignore_the_source_entirely(self):
        # a future nflverse reclassification must not rewrite their history
        self.assertEqual(self.nh.pos_for({HILL: "QB"}, HILL, 2021), "TE")
        self.assertEqual(self.nh.pos_for({THOMAS: "QB"}, THOMAS, 2014), "TE")

    def test_players_without_an_override_pass_through(self):
        self.assertEqual(self.nh.pos_for({"x": "WR"}, "x", 2015), "WR")
        self.assertIsNone(self.nh.pos_for({}, "missing", 2015))

    def test_dual_eligible_players_are_left_alone(self):
        # Patterson and Montgomery were startable at two positions for years;
        # asserting one would claim precision the data doesn't have
        self.assertNotIn("00-0030497", self.nh.POS_OVERRIDE)   # Patterson
        self.assertNotIn("00-0032209", self.nh.POS_OVERRIDE)   # Montgomery


class FranchiseBarTest(unittest.TestCase):
    def test_bars_are_the_agreed_values(self):
        self.assertEqual(fp.FRANCHISE_BAR,
                         {"QB": 1.00, "RB": 0.70, "WR": 0.85, "TE": 0.50})

    def test_te_bar_is_above_its_rank12_equivalent(self):
        """TE12 averages 0.29. The bar sits deliberately above it — at the
        rank-equivalent value the position admits fringe starters."""
        self.assertGreater(fp.FRANCHISE_BAR["TE"], 0.29)


def player(name, pos, war_by_season):
    from collections import Counter
    return {"name": name, "pos": Counter({pos: len(war_by_season)}),
            "war": war_by_season}


class QualifyTest(unittest.TestCase):
    def test_three_seasons_at_the_bar_qualifies_two_does_not(self):
        players = {
            "a": player("Three", "WR", {2020: 0.9, 2021: 0.86, 2022: 0.85}),
            "b": player("Two", "WR", {2020: 1.5, 2021: 1.4, 2022: 0.84}),
        }
        got = fp.qualify(players)
        self.assertEqual([r["name"] for r in got["WR"]], ["Three"])

    def test_the_bar_is_inclusive(self):
        players = {"a": player("Exact", "TE", {2020: 0.5, 2021: 0.5, 2022: 0.5})}
        self.assertEqual(len(fp.qualify(players)["TE"]), 1)

    def test_each_position_uses_its_own_bar(self):
        # 0.75 in three seasons: a franchise RB, not a franchise WR or QB
        seasons = {2020: 0.75, 2021: 0.75, 2022: 0.75}
        for pos, expected in (("RB", 1), ("WR", 0), ("QB", 0), ("TE", 1)):
            got = fp.qualify({"a": player("X", pos, dict(seasons))})
            self.assertEqual(len(got.get(pos) or []), expected, pos)

    def test_sorted_by_seasons_then_peak(self):
        # season count outranks peak: FourSeasons leads on 4 despite the
        # lowest peak. Among the two with three seasons, the higher peak wins.
        players = {
            "a": player("HighPeak", "QB", {2020: 2.5, 2021: 2.4, 2022: 1.1}),
            "b": player("FourSeasons", "QB", {y: 1.2 for y in range(2018, 2022)}),
            "c": player("LowPeak", "QB", {2020: 1.9, 2021: 1.8, 2022: 1.05}),
        }
        self.assertEqual([r["name"] for r in fp.qualify(players)["QB"]],
                         ["FourSeasons", "HighPeak", "LowPeak"])

    def test_seasons_below_the_bar_still_count_toward_career_total(self):
        players = {"a": player("X", "QB", {2020: 1.2, 2021: 1.1, 2022: 1.0,
                                           2023: -0.4})}
        row = fp.qualify(players)["QB"][0]
        self.assertEqual(row["seasons"], 3)
        self.assertAlmostEqual(row["career"], 2.9)
        self.assertNotIn(2023, row["years"])

    def test_min_seasons_is_configurable(self):
        players = {"a": player("X", "TE", {2020: 0.6, 2021: 0.6})}
        self.assertEqual(len(fp.qualify(players, min_seasons=2)["TE"]), 1)
        self.assertEqual(len(fp.qualify(players, min_seasons=3).get("TE") or []), 0)

    def test_non_core_positions_are_ignored(self):
        self.assertEqual(dict(fp.qualify({"a": player("K", "K", {2020: 9.0,
                                                                 2021: 9.0,
                                                                 2022: 9.0})})), {})


@unittest.skipUnless((ROOT / "nfl_history").exists(), "nfl_history/ not present")
class RealDataTest(unittest.TestCase):
    """Against the committed nfl_history/*.csv.

    These assert the SHAPE the published definition produces, not the exact
    counts it produced on one particular build. `war-history.yml` regenerates
    waa_war_<season>.csv from nflverse whenever a season completes or a
    POS_OVERRIDE is added, and every count below moves a little when it does —
    a pinned {"QB": 23, ...} would redden CI on a legitimate rebuild and teach
    everyone to edit the number without reading it.

    IF ONE OF THESE FAILS after a rebuild, that is a real finding: the bars
    are calibrated so QB/RB/WR land together near their rank-12 season value
    and TE lands materially below (METHODOLOGY.md, "Franchise players"). Check
    the new counts against that story first. Only widen a band here once you
    have decided the underlying data moved rather than the definition — and
    say so in the commit message.
    """

    def counts(self):
        return {p: len(r) for p, r in fp.qualify(fp.load()).items()}

    def test_every_core_position_produces_franchise_players(self):
        got = self.counts()
        self.assertEqual(set(got), {"QB", "RB", "WR", "TE"})
        # a bar that admitted nobody, or most of the position, would not be
        # measuring "a genuine starter, three times over"
        for pos, n in got.items():
            self.assertGreater(n, 5, pos)
            self.assertLess(n, 60, pos)

    def test_the_three_flat_bars_land_within_reach_of_each_other(self):
        """QB/RB/WR bars sit at their position's rank-12 season value, so they
        are supposed to return similar counts — 23/25/24 when this was
        written. That agreement IS the calibration."""
        got = self.counts()
        core = [got["QB"], got["RB"], got["WR"]]
        self.assertLessEqual(max(core) / min(core), 1.5)

    def test_tight_end_returns_materially_fewer_and_that_is_the_finding(self):
        """TE's bar is a judgement (0.50 against a rank-12 equivalent of 0.29)
        and still returns roughly half what the others do. **That gap is the
        finding, not an artefact to tune away** — the players do not exist."""
        got = self.counts()
        self.assertLess(got["TE"], min(got["QB"], got["RB"], got["WR"]))
        self.assertLessEqual(got["TE"] / min(got["QB"], got["RB"], got["WR"]), 0.8)

    def test_every_qualifier_really_cleared_its_positions_bar(self):
        """The definition itself, checked against the whole published set
        rather than against a synthetic player."""
        players = fp.load()
        for pos, rows in fp.qualify(players).items():
            bar = fp.FRANCHISE_BAR[pos]
            for r in rows:
                self.assertGreaterEqual(r["seasons"], fp.MIN_SEASONS, r["name"])
                self.assertEqual(len(r["years"]), r["seasons"], r["name"])
                war = players[r["gsis"]]["war"]
                for y in r["years"]:
                    self.assertGreaterEqual(war[y], bar, f"{r['name']} {y}")
                self.assertGreaterEqual(r["best"], bar, r["name"])

    def test_kelce_leads_tight_end_by_a_distance(self):
        te = fp.qualify(fp.load())["TE"]
        self.assertEqual(te[0]["name"], "Travis Kelce")
        self.assertGreaterEqual(te[0]["seasons"], 11)
        # more qualifying seasons than the bottom five of the position combined
        self.assertGreater(te[0]["seasons"], sum(r["seasons"] for r in te[-5:]) / 2)


if __name__ == "__main__":
    unittest.main()
