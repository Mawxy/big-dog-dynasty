#!/usr/bin/env python3
"""
Invariants of the aging-curve fit, specifically the production weighting.

The thing being locked down: a season in which a player dressed and produced
nothing must not count as a full observation of what players like him do next
year. MIN_GP used to enforce that by filtering on `gp`, and the played rule
redefined `gp` from "games he produced in" to "games he dressed for", which
silently disabled the gate. These tests fail if the weighting is removed or
inverted.

  python -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import aging_curves as A                                          # noqa: E402


class TestFitWeighting(unittest.TestCase):
    """fit_curve accepts an optional third element per row: the weight."""

    def test_unweighted_rows_still_work(self):
        rows = [(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)]
        f = A.fit_curve(rows)
        self.assertAlmostEqual(f["a"], 0.0, places=3)
        self.assertAlmostEqual(f["b"], 1.0, places=3)

    def test_a_weight_of_one_matches_no_weight(self):
        rows = [(0.0, 0.1), (1.0, 0.9), (2.0, 2.2)]
        bare = A.fit_curve(rows)
        wtd = A.fit_curve([(x, y, 1.0) for x, y in rows])
        self.assertEqual((bare["a"], bare["b"]), (wtd["a"], wtd["b"]))

    def test_zero_weight_rows_do_not_move_the_line(self):
        """The whole point. A contaminating cluster at zero weight has to leave
        the fit exactly where the real observations put it."""
        real = [(1.0, 1.0, 1.0), (2.0, 2.0, 1.0), (3.0, 3.0, 1.0)]
        junk = [(-1.0, -0.9, 0.0)] * 50
        clean = A.fit_curve(real)
        polluted = A.fit_curve(real + junk)
        self.assertAlmostEqual(clean["a"], polluted["a"], places=6)
        self.assertAlmostEqual(clean["b"], polluted["b"], places=6)

    def test_unweighted_the_same_junk_does_move_the_line(self):
        """Control for the test above: without weights the cluster bites. If
        this ever passes, the fixture stopped exercising anything."""
        real = [(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)]
        junk = [(-1.0, -0.9)] * 50
        self.assertNotAlmostEqual(A.fit_curve(real)["b"],
                                  A.fit_curve(real + junk)["b"], places=3)

    def test_eff_n_reports_what_the_weights_are_really_worth(self):
        rows = [(1.0, 1.0, 1.0), (2.0, 2.0, 1.0)] + [(-1.0, -1.0, 0.0)] * 98
        self.assertEqual(A.fit_curve(rows)["n"], 100)
        self.assertAlmostEqual(A.fit_curve(rows)["eff_n"], 2.0, places=1)

    def test_all_zero_weights_fall_back_rather_than_divide_by_zero(self):
        rows = [(0.0, 0.0, 0.0), (1.0, 1.0, 0.0), (2.0, 2.0, 0.0)]
        f = A.fit_curve(rows)
        self.assertAlmostEqual(f["b"], 1.0, places=3)


class TestResidualBands(unittest.TestCase):
    """p20/p80 have to be weighted the way the LINE is.

    They were not: the slope and intercept honored --fit-weight and the bands
    came from an UNWEIGHTED residual quantile, so the same dressed-zero
    population the weighting exists to keep out of the fit still fully decided
    how wide the band around it was. Measured on the committed nfl_history CSVs
    that narrowed the published bands by 10-45%.
    """

    # a weighted fit of exactly y = x, with residuals of exactly -1 and +1
    REAL = [(0.0, -1.0, 1.0), (0.0, 1.0, 1.0),
            (1.0, 0.0, 1.0), (1.0, 2.0, 1.0),
            (2.0, 1.0, 1.0), (2.0, 3.0, 1.0)]
    # 200 seasons that dressed and produced nothing: zero weight in the fit,
    # and sitting exactly on the line so an unweighted quantile collapses to 0
    JUNK = [(1.0, 1.0, 0.0)] * 200

    def test_the_bands_are_the_weighted_residual_quantiles(self):
        f = A.fit_curve(self.REAL)
        self.assertAlmostEqual(f["a"], 0.0, places=6)
        self.assertAlmostEqual(f["b"], 1.0, places=6)
        self.assertAlmostEqual(f["p20"], -1.0, places=6)
        self.assertAlmostEqual(f["p80"], 1.0, places=6)

    def test_a_zero_weight_cluster_cannot_narrow_the_band(self):
        """The whole point, and the mirror of
        test_zero_weight_rows_do_not_move_the_line."""
        clean = A.fit_curve(self.REAL)
        polluted = A.fit_curve(self.REAL + self.JUNK)
        self.assertAlmostEqual(clean["p20"], polluted["p20"], places=6)
        self.assertAlmostEqual(clean["p80"], polluted["p80"], places=6)

    def test_unweighted_the_same_cluster_does_collapse_the_band(self):
        """Control for the test above: at weight 1.0 the cluster owns both
        quantiles. If this ever passes, the fixture stopped exercising
        anything."""
        f = A.fit_curve(self.REAL + [(x, y, 1.0) for x, y, _ in self.JUNK])
        self.assertAlmostEqual(f["p20"], 0.0, places=6)
        self.assertAlmostEqual(f["p80"], 0.0, places=6)

    def test_unweighted_rows_still_produce_a_band(self):
        f = A.fit_curve([(0.0, -1.0), (0.0, 1.0), (1.0, 0.0),
                         (1.0, 2.0), (2.0, 1.0), (2.0, 3.0)])
        self.assertAlmostEqual(f["p20"], -1.0, places=6)
        self.assertAlmostEqual(f["p80"], 1.0, places=6)

    def test_the_band_brackets_the_line(self):
        f = A.fit_curve(self.REAL + self.JUNK)
        self.assertLessEqual(f["p20"], 0.0)
        self.assertGreaterEqual(f["p80"], 0.0)

    def test_all_zero_weights_still_produce_a_band(self):
        """The sw <= 0 fallback re-weights every row to 1.0 for the fit; the
        bands have to come off that same fallback rather than divide by zero."""
        f = A.fit_curve([(0.0, -1.0, 0.0), (1.0, 1.0, 0.0), (2.0, 3.0, 0.0)])
        self.assertIsInstance(f["p20"], float)
        self.assertLessEqual(f["p20"], f["p80"])


class TestProductionWeight(unittest.TestCase):
    """prod_w turns a season's points into "how much of a season is this"."""

    def setUp(self):
        self._fw = A.FIT_WEIGHT
        self._ref = dict(A.PROD_REF)
        A.PROD_REF.update({"QB": 250.0})

    def tearDown(self):
        A.FIT_WEIGHT = self._fw
        A.PROD_REF.clear()
        A.PROD_REF.update(self._ref)

    def row(self, pts):
        # (pos, age, exp, pick, level, next_rate, next_gp, pts)
        return ("QB", 28, 5, 10, 1.0, 1.0, 13, pts)

    def test_off_by_default_arg_returns_one(self):
        A.FIT_WEIGHT = "none"
        self.assertEqual(A.prod_w(self.row(0.0)), 1.0)
        self.assertEqual(A.prod_w(self.row(250.0)), 1.0)

    def test_a_dressed_zero_point_season_is_worth_nothing(self):
        A.FIT_WEIGHT = "production"
        self.assertEqual(A.prod_w(self.row(0.0)), 0.0)

    def test_a_full_season_is_worth_one_and_caps_there(self):
        A.FIT_WEIGHT = "production"
        self.assertEqual(A.prod_w(self.row(250.0)), 1.0)
        self.assertEqual(A.prod_w(self.row(900.0)), 1.0)

    def test_partial_seasons_scale(self):
        A.FIT_WEIGHT = "production"
        self.assertAlmostEqual(A.prod_w(self.row(125.0)), 0.5, places=6)

    def test_negative_points_do_not_produce_a_negative_weight(self):
        A.FIT_WEIGHT = "production"
        self.assertEqual(A.prod_w(self.row(-40.0)), 0.0)

    def test_a_missing_position_reference_does_not_explode(self):
        A.FIT_WEIGHT = "production"
        r = ("XX", 28, 5, 10, 1.0, 1.0, 13, 5.0)
        self.assertGreaterEqual(A.prod_w(r), 0.0)
        self.assertLessEqual(A.prod_w(r), 1.0)


class TestFitWindow(unittest.TestCase):
    """--end defaults to the corpus, so a new season needs no edit here."""

    def test_the_newest_csv_sets_the_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for name in ("waa_war_2024.csv", "waa_war_2026.csv", "waa_war_x.csv",
                         "players_meta.csv"):
                (d / name).write_text("", encoding="utf-8")
            self.assertEqual(A.newest_corpus_season(d), 2026)

    def test_an_empty_corpus_has_no_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(A.newest_corpus_season(Path(tmp)))


class TestWarHistoryChain(unittest.TestCase):
    """A rebuild has to refit the curves, on the new CSVs, and check the fit
    before it can reach the nightly. Reading the workflow is the only way to
    pin the order."""

    def test_collect_then_refit_then_check_then_commit(self):
        wf = (ROOT / ".github" / "workflows" / "war-history.yml").read_text(encoding="utf-8")
        steps = [wf.index(s) for s in ("name: Collect outputs",
                                       "run: python scripts/aging_curves.py",
                                       '-p "test_aging_curves.py"',
                                       "name: Commit history CSVs")]
        self.assertEqual(steps, sorted(steps))


class TestShippedCurves(unittest.TestCase):
    """The committed artifact should be the weighted fit, not the raw one.

    war-history.yml runs this file after every refit and before its push, so
    these are also what stops a bad fit reaching the nightly."""

    def test_every_position_has_curves_and_a_points_bridge(self):
        """project_war.py skips a position with no curves, which would empty it
        from the projections without an error."""
        import json
        f = ROOT / "nfl_history" / "aging_curves.json"
        if not f.exists():
            self.skipTest("no aging_curves.json")
        d = json.loads(f.read_text(encoding="utf-8"))
        for p in A.AGE_GROUPS:
            self.assertTrue(d["curves"].get(p), f"no {p} curves")
            self.assertIn(p, d["pts_to_war"])

    def test_the_fit_reaches_the_newest_corpus_season(self):
        """Caveat 5: a corpus rebuild used to leave the curves behind it."""
        import json
        f = ROOT / "nfl_history" / "aging_curves.json"
        if not f.exists():
            self.skipTest("no aging_curves.json")
        seasons = json.loads(f.read_text(encoding="utf-8"))["meta"]["seasons"]
        self.assertEqual(seasons.split("-")[1],
                         str(A.newest_corpus_season(ROOT / "nfl_history")))

    def test_committed_curves_carry_the_weighted_diagnostics(self):
        import json
        f = Path(__file__).resolve().parent.parent / "nfl_history" / "aging_curves.json"
        if not f.exists():
            self.skipTest("no aging_curves.json")
        d = json.loads(f.read_text(encoding="utf-8"))
        qb = d["curves"]["QB"]
        self.assertTrue(qb, "no QB curves")
        for g in qb:
            self.assertIn("eff_n", g)
            # weighting must actually be biting: a bucket where every season
            # counted fully would have eff_n == n
            self.assertLess(g["eff_n"], g["n"])

    def test_the_grid_is_not_shipped(self):
        """It is a measured negative (de-biased mae 0.485 vs 0.476) and it costs
        220 KB. --emit-grid still reproduces it."""
        import json
        f = Path(__file__).resolve().parent.parent / "nfl_history" / "aging_curves.json"
        if not f.exists():
            self.skipTest("no aging_curves.json")
        self.assertNotIn("curve_grid", json.loads(f.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
