#!/usr/bin/env python3
"""
The nightly gate's newer checks, on synthetic league trees.

validate_data.py is the last step of data-refresh.yml and the only thing
standing between a bad run and `git add data`. The checks locked here are the
ones added after 2026-09-15, when the scalar projection arm rolled its seed
onto a one-game season: every file parsed, every floor cleared, and two arms of
the same model published different years under one column heading. A gate made
of floors alone cannot see that, so these checks are about AGREEMENT — between
the projection files, and between the two halves of a season's record.

Everything runs against a temp directory with validate_data.DATA repointed at
it. Nothing here reads the committed tree, and nothing runs a pipeline script.

  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import validate_data as vd                                       # noqa: E402

POINTS_MODEL = ("points-first: ppg and games from gradient-boosted trees on "
                "league history")


class Tree:
    """A league directory carrying only what the check under test reads."""

    def __init__(self, tmp, seasons=(2024, 2025, 2026), roster=2026, complete=(2024, 2025)):
        self.d = Path(tmp)
        self.seasons = [str(s) for s in seasons]
        self.write("meta.json", {"seasons": self.seasons, "latest": self.seasons[-1],
                                 "rosterSeason": str(roster)})
        self.write("leagues.json", {"default": "K", "leagues": [
            {"key": "K", "rosterSeason": str(roster), "seasons": self.seasons}]})
        for s in self.seasons:
            (self.d / str(s)).mkdir(parents=True, exist_ok=True)
        for s in complete:
            self.write(f"{s}/bracket.json", {"playoff_start": 15, "winners": [
                {"r": 3, "week": 17, "p": 1, "t1": 2, "t2": 6, "w": 2, "l": 6}]})

    def write(self, name, obj):
        p = self.d / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj), encoding="utf-8")

    # -- the projection chain -------------------------------------------------
    def projections(self, seed=2025, model=POINTS_MODEL, rows=None, **meta):
        rows = [{"pid": str(i), "src": "points", "composite": [1.0, 0.9, 0.8]}
                for i in range(220)] if rows is None else rows
        m = {"seed_season": seed, "roster_season": 2026,
             "years": [seed + 1, seed + 2, seed + 3], "model": model,
             "points_players": sum(1 for r in rows if r.get("src") == "points")}
        m.update(meta)
        self.write("projections.json", {"meta": m, "players": rows})

    def arm(self, name, seed=2025, years=True, key="seed_season"):
        m = {key: seed}
        if years:
            m["years"] = [seed + 1, seed + 2, seed + 3]
        self.write(name, {"meta": m, "players": []})

    def matrix(self, n=220, curve=None, seed=2025):
        curve = [0.5, 0.4, 0.3] if curve is None else curve
        rows = [dict({c: list(curve) for c in vd.CURVES},
                     pid=str(i), name=f"P{i}") for i in range(n)]
        self.write("projections_matrix.json", {
            "meta": {"curves": list(vd.CURVES), "horizon": 3,
                     "seed_season": seed, "years": [seed + 1, seed + 2, seed + 3]},
            "players": rows})

    # -- a season's two halves ------------------------------------------------
    def season(self, year, record=(1, 0, 0), weeks=(1,), playoff_start=15):
        w, l, t = record
        self.write(f"{year}/teams.json", [
            {"roster_id": 1, "wins": w, "losses": l, "ties": t},
            {"roster_id": 2, "wins": l, "losses": w, "ties": t}])
        self.write(f"{year}/matchups.json", {
            "playoff_start": playoff_start,
            "teams": {"1": [[k, 120.0, 2, 100.0, [], []] for k in weeks],
                      "2": [[k, 100.0, 1, 120.0, [], []] for k in weeks]}})

    def features(self, year, usage=200, winshare=80):
        self.write(f"{year}/usage.json", {
            str(i): {"reg": {"g": 1, "fp_exp_pg": 12.0}, "both": {"g": 1, "fp_exp_pg": 12.0}}
            for i in range(usage)})
        self.write(f"{year}/winshare.json", {
            "meta": {"wins": 6}, "players": {str(i): {"ws": 0.1, "gs": 1, "w": 1, "l": 0}
                                             for i in range(winshare)}})


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.t = Tree(self._tmp.name)
        self._saved = vd.DATA
        vd.DATA = self.t.d
        self.addCleanup(lambda: setattr(vd, "DATA", self._saved))

    def assertFails(self, fn, *a):
        with self.assertRaises(SystemExit) as cm:
            fn(*a)
        self.assertEqual(cm.exception.code, 1)


class ProjectionCoherence(Base):
    """Every arm has to project from the same season, and that season has to
    be one somebody finished."""

    def all_arms(self, seed=2025):
        self.t.projections(seed=seed)
        self.t.arm("projections_scalar.json", seed)
        self.t.arm("projections_knn_hybrid.json", seed, years=False)
        self.t.arm("projections_points.json", seed, key="as_of")
        self.t.matrix(seed=seed)

    def test_the_shape_of_2026_09_14_passes(self):
        """Seed 2025, years [2026, 2027, 2028], beside a 2026 roster — the
        state the chain was in the day before the rollover."""
        self.all_arms(2025)
        vd.check_projection_coherence()

    def test_the_shape_of_2026_09_15_fails(self):
        """THE BUG. The scalar arm rolled onto the season in progress and the
        analog arm did not."""
        self.all_arms(2025)
        self.t.projections(seed=2026)
        self.t.arm("projections_scalar.json", 2026)
        self.assertFails(vd.check_projection_coherence)

    def test_every_arm_rolling_together_still_fails_on_an_unfinished_season(self):
        """Agreement is not enough. If the whole chain seeded off the season
        being played, the figures would be internally consistent and still
        describe a year that has not happened."""
        self.all_arms(2026)
        self.assertFails(vd.check_projection_coherence)

    def test_the_offseason_shape_passes(self):
        """January: 2026 is finished, the roster season is still 2026 and year
        one is 2027. This is why the roster check is a window, not an equality
        — pinning it would fire every year between the title game and
        September's league rollover."""
        self.t = Tree(self._tmp.name, complete=(2024, 2025, 2026))
        vd.DATA = self.t.d
        self.all_arms(2026)
        vd.check_projection_coherence()

    def test_a_year_list_that_does_not_follow_its_own_seed_fails(self):
        self.all_arms(2025)
        self.t.projections(seed=2025, years=[2028, 2029, 2030])
        self.assertFails(vd.check_projection_coherence)

    def test_absent_optional_arms_are_tolerated(self):
        """The redraft league has no analog arm and projections_points.json is
        hand-run. Only projections.json is required."""
        self.t.projections(seed=2025)
        vd.check_projection_coherence()

    def test_the_required_file_must_stamp_a_seed(self):
        self.t.write("projections.json", {"meta": {"model": "x"}, "players": []})
        self.assertFails(vd.check_projection_coherence)

    def test_a_stale_arm_that_never_stamped_a_seed_is_skipped(self):
        """An older writer's file is not evidence of disagreement."""
        self.all_arms(2025)
        self.t.write("projections_knn_hybrid.json", {"meta": {}, "players": []})
        vd.check_projection_coherence()


class PointsModelCount(Base):
    def test_a_real_run_passes(self):
        self.t.projections(seed=2025)
        vd.check_points_model()

    def test_the_scalar_models_file_is_not_counted(self):
        """Before project_points.py --site runs, projections.json is the
        per-13 rate model's and carries no points count. That is not a fault."""
        self.t.projections(seed=2025, model="per-13 rate + capital-shrinkage")
        del_meta = json.loads((self.t.d / "projections.json").read_text())
        del_meta["meta"].pop("points_players")
        self.t.write("projections.json", del_meta)
        vd.check_points_model()

    def test_a_points_first_file_without_the_count_fails(self):
        self.t.projections(seed=2025)
        doc = json.loads((self.t.d / "projections.json").read_text())
        doc["meta"].pop("points_players")
        self.t.write("projections.json", doc)
        self.assertFails(vd.check_points_model)

    def test_a_count_that_disagrees_with_the_rows_fails(self):
        self.t.projections(seed=2025, points_players=999)
        self.assertFails(vd.check_points_model)

    def test_a_run_that_priced_almost_nobody_fails(self):
        """The silent-empty case: every row kept on the scalar, the file still
        full-shaped and still labelled points-first."""
        rows = [{"pid": str(i), "src": "scalar", "composite": [1.0, 0.9, 0.8]}
                for i in range(220)]
        rows[0]["src"] = "points"
        self.t.projections(seed=2025, rows=rows)
        self.assertFails(vd.check_points_model)


class MatrixFloors(Base):
    def test_a_full_matrix_passes(self):
        self.t.matrix()
        vd.check_matrix()

    def test_a_gutted_matrix_fails(self):
        self.t.matrix(n=5)
        self.assertFails(vd.check_matrix)

    def test_a_null_in_a_curve_fails(self):
        """A null here is not a figure the site can dash out — the index
        models would price the player at nothing."""
        self.t.matrix()
        doc = json.loads((self.t.d / "projections_matrix.json").read_text())
        doc["players"][3]["blend_composite"] = [0.5, None, 0.3]
        self.t.write("projections_matrix.json", doc)
        self.assertFails(vd.check_matrix)

    def test_a_short_curve_fails(self):
        self.t.matrix()
        doc = json.loads((self.t.d / "projections_matrix.json").read_text())
        doc["players"][1]["scalar_natural"] = [0.5]
        self.t.write("projections_matrix.json", doc)
        self.assertFails(vd.check_matrix)

    def test_an_absurd_war_fails(self):
        self.t.matrix()
        doc = json.loads((self.t.d / "projections_matrix.json").read_text())
        doc["players"][2]["analog_natural"] = [0.5, 0.4, 99.0]
        self.t.write("projections_matrix.json", doc)
        self.assertFails(vd.check_matrix)

    def test_a_curve_list_that_drifted_from_curves_py_fails(self):
        self.t.matrix()
        doc = json.loads((self.t.d / "projections_matrix.json").read_text())
        doc["meta"]["curves"] = list(vd.CURVES)[:-1]
        self.t.write("projections_matrix.json", doc)
        self.assertFails(vd.check_matrix)


class CurrentSeasonFeatures(Base):
    def test_a_normal_week_passes(self):
        self.t.features(2026)
        vd.check_current_season_features(2026, True)

    def test_absent_files_are_skipped(self):
        """The redraft league has neither, and validate only ever runs on the
        default league."""
        vd.check_current_season_features(2026, True)

    def test_an_unscored_season_is_skipped(self):
        """September, before kickoff: nothing to summarise yet, and a floor
        would fire on an empty calendar rather than on a gutted run."""
        self.t.features(2026, usage=0, winshare=0)
        vd.check_current_season_features(2026, False)

    def test_a_gutted_usage_file_fails(self):
        self.t.features(2026, usage=5)
        self.assertFails(vd.check_current_season_features, 2026, True)

    def test_a_null_usage_metric_fails(self):
        self.t.features(2026)
        doc = json.loads((self.t.d / "2026" / "usage.json").read_text())
        doc["7"]["reg"]["fp_exp_pg"] = None
        self.t.write("2026/usage.json", doc)
        self.assertFails(vd.check_current_season_features, 2026, True)

    def test_a_gutted_winshare_file_fails(self):
        self.t.features(2026, winshare=3)
        self.assertFails(vd.check_current_season_features, 2026, True)

    def test_a_null_win_share_fails(self):
        self.t.features(2026)
        doc = json.loads((self.t.d / "2026" / "winshare.json").read_text())
        doc["players"]["4"]["ws"] = None
        self.t.write("2026/winshare.json", doc)
        self.assertFails(vd.check_current_season_features, 2026, True)


class RecordVsMatchups(Base):
    def test_a_week_one_league_agrees(self):
        self.t.season(2026, record=(1, 0, 0), weeks=(1,))
        vd.check_record_vs_matchups(2026)

    def test_a_full_regular_season_agrees(self):
        self.t.season(2026, record=(8, 6, 0), weeks=tuple(range(1, 15)))
        vd.check_record_vs_matchups(2026)

    def test_a_tie_counts_as_a_game(self):
        self.t.season(2026, record=(7, 6, 1), weeks=tuple(range(1, 15)))
        vd.check_record_vs_matchups(2026)

    def test_playoff_weeks_are_not_counted(self):
        """matchups.json carries weeks 15-17; Sleeper's record does not."""
        self.t.season(2026, record=(8, 6, 0), weeks=tuple(range(1, 18)))
        vd.check_record_vs_matchups(2026)

    def test_a_record_lagging_the_matchups_fails(self):
        """THE MID-WEEK CASE: scoring has started on week 2 while the roster
        still says 1-0. WAR is summed off the matchups and records off the
        rosters, so the season page would disagree with itself."""
        self.t.season(2026, record=(1, 0, 0), weeks=(1, 2))
        self.assertFails(vd.check_record_vs_matchups, 2026)

    def test_a_season_with_no_matchups_file_is_skipped(self):
        self.t.write("2026/teams.json", [{"roster_id": 1, "wins": 0,
                                          "losses": 0, "ties": 0}])
        vd.check_record_vs_matchups(2026)


class InSeasonBlock(Base):
    """projections_matrix.json's `meta.inseason`, which the site turns into

        outlook = banked + year1 * remaining_frac

    The gate cannot check the outlook itself — that arithmetic happens in the
    browser — so it checks the only two things that can make it wrong: a
    fraction that is not what the season's own matchups.json says, and a row
    with no banked figure to add.
    """

    def matrix_with(self, blk, *, banked=0.12, drop=None, weeks=(1,)):
        """A full matrix carrying `blk`, beside a 2026 season that has `weeks`."""
        self.t.season(2026, record=(len(weeks), 0, 0), weeks=weeks)
        self.t.matrix()
        mx = json.loads((self.t.d / "projections_matrix.json")
                        .read_text(encoding="utf-8"))
        mx["meta"]["inseason"] = blk
        for r in mx["players"]:
            r["banked"], r["gp"] = banked, 1
        if drop is not None:
            mx["players"][3].pop(drop, None)
        self.t.write("projections_matrix.json", mx)
        return mx

    @staticmethod
    def block(played=1, reg=14, season=2026, frac=None):
        return {"season": season, "weeks_played": played, "reg_weeks": reg,
                "remaining_frac": (reg - played) / reg if frac is None else frac}

    def test_week_one_of_the_live_season_passes(self):
        """Where 2026 is as this ships: one week scored, 13/14 still to come."""
        self.matrix_with(self.block(1))
        vd.check_inseason()

    def test_week_four_of_fourteen_passes(self):
        self.matrix_with(self.block(4), weeks=(1, 2, 3, 4))
        vd.check_inseason()

    def test_an_absent_block_is_the_offseason_and_passes(self):
        """Today's committed file predates the block entirely — the gate must
        not fail on a file that simply has nothing to say."""
        self.t.matrix()
        vd.check_inseason()
        self.matrix_with(None)
        vd.check_inseason()

    def test_a_negative_fraction_fails(self):
        """The one that would print an outlook BELOW a player's banked WAR."""
        self.matrix_with(self.block(1, frac=-0.1))
        self.assertFails(vd.check_inseason)

    def test_a_fraction_above_one_fails(self):
        self.matrix_with(self.block(1, frac=1.5))
        self.assertFails(vd.check_inseason)

    def test_a_fraction_that_is_not_its_own_weeks_fails(self):
        self.matrix_with(self.block(1, frac=0.5))
        self.assertFails(vd.check_inseason)

    def test_a_week_count_the_season_does_not_support_fails(self):
        """A block carried over from last night's run: the file says four weeks
        are banked, matchups.json scores one, and every outlook on the site is
        prorated to the wrong fraction."""
        self.matrix_with(self.block(4), weeks=(1,))
        self.assertFails(vd.check_inseason)

    def test_a_regular_season_length_that_disagrees_fails(self):
        self.matrix_with(self.block(1, reg=17))
        self.assertFails(vd.check_inseason)

    def test_a_block_for_a_season_with_no_matchups_fails(self):
        self.t.matrix()
        mx = json.loads((self.t.d / "projections_matrix.json")
                        .read_text(encoding="utf-8"))
        mx["meta"]["inseason"] = self.block(1, season=2099)
        for r in mx["players"]:
            r["banked"] = 0.0
        self.t.write("projections_matrix.json", mx)
        self.assertFails(vd.check_inseason)

    def test_a_missing_field_in_the_block_fails(self):
        blk = self.block(1)
        del blk["reg_weeks"]
        self.matrix_with(blk)
        self.assertFails(vd.check_inseason)

    def test_zero_weeks_played_is_not_a_block(self):
        """The pipeline publishes no block before kickoff; one that says zero
        weeks is a producer that forgot the condition, not an offseason file."""
        self.matrix_with(self.block(0), weeks=())
        self.assertFails(vd.check_inseason)

    def test_a_row_with_no_banked_war_fails(self):
        """The site reads a missing banked as 0 and would publish a star's
        outlook as his remaining projection alone."""
        self.matrix_with(self.block(1), drop="banked")
        self.assertFails(vd.check_inseason)

    def test_a_banked_figure_that_is_not_a_number_fails(self):
        self.matrix_with(self.block(1))
        mx = json.loads((self.t.d / "projections_matrix.json")
                        .read_text(encoding="utf-8"))
        mx["players"][7]["banked"] = "0.4"
        self.t.write("projections_matrix.json", mx)
        self.assertFails(vd.check_inseason)

    def test_an_absurd_banked_war_fails(self):
        self.matrix_with(self.block(1))
        mx = json.loads((self.t.d / "projections_matrix.json")
                        .read_text(encoding="utf-8"))
        mx["players"][7]["banked"] = 99.0
        self.t.write("projections_matrix.json", mx)
        self.assertFails(vd.check_inseason)

    def test_a_player_who_has_not_played_banks_zero_and_passes(self):
        """0.0 is a real banked figure — he has dressed for nobody — and must
        not read as a missing one."""
        self.matrix_with(self.block(1), banked=0.0)
        vd.check_inseason()

    def test_a_negative_banked_war_passes(self):
        """The played rule: a dressed zero-point game accrues negative value."""
        self.matrix_with(self.block(1), banked=-0.4)
        vd.check_inseason()


class ValuesOnlyPath(unittest.TestCase):
    """The values-refresh workflow runs `--values-only`, which must stay a
    market-values check. None of the league checks above may reach it — that
    workflow runs at 11:00 UTC against a tree whose league files are whatever
    last night left behind."""

    def test_values_only_calls_no_league_check(self):
        src = Path(vd.__file__).read_text(encoding="utf-8")
        body = src.split("def check_values(", 1)[1].split("\ndef ", 1)[0]
        for name in ("check_projection_coherence", "check_points_model",
                     "check_matrix", "check_current_season_features",
                     "check_record_vs_matchups"):
            self.assertNotIn(name, body, f"{name} leaked into the values-only path")


if __name__ == "__main__":
    unittest.main()
