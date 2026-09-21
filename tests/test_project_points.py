#!/usr/bin/env python3
"""What the points-first model reads, and what it is allowed to publish.

Three failures this file exists to stop, all of which ran green for days:

  * THE CORPUS GLOB. `features_*.csv` also matches features_weekly_<yr>.csv
    (added 2026-09-16), which parses to the same season; the sort key was the
    year alone, so whichever file the filesystem listed last overwrote the
    other. On 2025 that was the weekly file, and every player's SEASON row
    became his LAST SINGLE WEEK — 0 of 572 kept an fp_exp_pg, Ja'Marr Chase's
    target share read 0.2632 instead of 0.3207. Glob order is arbitrary on
    Linux, so the corpus the model trained on differed by year and by machine.
  * THE META. projections.json inherited `years` and `seed_season` from the
    scalar frame while carrying this model's streams, so the published file
    said [2027, 2028, 2029] over rows holding 2026-2028 values.
  * NaN. A horizon year with no fitted model predicted nan, max(nan, 0.0) is
    nan, and json.dumps writes a bare `NaN` — not JSON, so the site's
    JSON.parse throws and the board renders empty.

Stdlib only, and deliberately so: neither numpy nor scikit-learn is installed
in the test job, so `import project_points` has to work without them.

  python -m unittest discover -s tests
"""
import csv
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import project_points as pp  # noqa: E402

HIST = ROOT / "nfl_history"
CHASE = "00-0036900"          # Ja'Marr Chase, the audit's worked example


def _csv(path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


class _TempCorpus(unittest.TestCase):
    """Points HIST / HIST_EARLY at a synthetic nfl_history tree."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hist = Path(self.tmp.name) / "nfl_history"
        self.early = self.hist / "early"
        self.early.mkdir(parents=True)
        self._saved = (pp.HIST, pp.HIST_EARLY)
        pp.HIST, pp.HIST_EARLY = self.hist, self.early
        self.addCleanup(self._restore)

    def _restore(self):
        pp.HIST, pp.HIST_EARLY = self._saved
        self.tmp.cleanup()

    def season_csv(self, path, pid="p1", **cols):
        vals = {"tgt_share": 0.3207, "fp_exp_pg": 19.16, "car_pg": 0.19,
                "tgt_pg": 11.56, "games": 16, "wk_hurt": 1}
        vals.update(cols)
        _csv(path, ["player_id", "name", "pos"] + list(vals),
             [[pid, "Ja'Marr Chase", "WR"] + list(vals.values())])

    def weekly_csv(self, path, pid="p1"):
        """The weekly file's real shape: no fp_exp_pg, no per-game columns, and
        one row per week, so the LAST row is what an overwrite would leave."""
        _csv(path, ["player_id", "name", "pos", "season", "week", "tgt_share", "tgt", "car"],
             [[pid, "Ja'Marr Chase", "WR", 2025, 1, 0.4000, 9, 0],
              [pid, "Ja'Marr Chase", "WR", 2025, 17, 0.2632, 5, 0]])


class TestFeatureGlob(_TempCorpus):

    def test_the_weekly_file_is_not_a_season_file(self):
        self.season_csv(self.hist / "features_2025.csv")
        self.weekly_csv(self.hist / "features_weekly_2025.csv")
        self.assertEqual([f.name for f in pp.hist_files("features")],
                         ["features_2025.csv"])

    def test_the_season_row_survives_a_weekly_file_beside_it(self):
        self.season_csv(self.hist / "features_2025.csv")
        self.weekly_csv(self.hist / "features_weekly_2025.csv")
        row = pp.load_features()[2025]["p1"]
        self.assertAlmostEqual(row["tgt_share"], 0.3207)     # not 0.2632
        self.assertAlmostEqual(row["fp_exp_pg"], 19.16)      # not nan
        for c in ("car_pg", "tgt_pg", "games", "wk_hurt"):
            self.assertFalse(math.isnan(row[c]), f"{c} went nan")

    def test_a_weekly_only_season_loads_nothing_rather_than_week_rows(self):
        """No season file: the year is absent, never a season of one week."""
        self.weekly_csv(self.hist / "features_weekly_2025.csv")
        self.assertEqual(pp.load_features(), {})

    def test_the_early_corpus_is_still_read(self):
        self.season_csv(self.early / "features_2013.csv")
        self.season_csv(self.hist / "features_2014.csv")
        self.weekly_csv(self.early / "features_weekly_2013.csv")
        self.assertEqual(sorted(pp.load_features()), [2013, 2014])

    def test_the_snap_era_wins_a_season_both_folders_hold(self):
        self.season_csv(self.early / "features_2014.csv", fp_exp_pg=1.0)
        self.season_csv(self.hist / "features_2014.csv", fp_exp_pg=2.0)
        self.assertEqual(pp.load_features()[2014]["p1"]["fp_exp_pg"], 2.0)

    def test_files_come_back_oldest_first(self):
        for yr in (2016, 2014, 2015):
            self.season_csv(self.hist / f"features_{yr}.csv")
        self.season_csv(self.early / "features_2013.csv")
        self.assertEqual([pp.hist_year(f) for f in pp.hist_files("features")],
                         [2013, 2014, 2015, 2016])


class TestSeasonGlob(_TempCorpus):

    def war_csv(self, path, pid="p1", pts=200.0, gp=14):
        _csv(path, ["player_id", "name", "pos", "gp", "pts", "WAR"],
             [[pid, "Ja'Marr Chase", "WR", gp, pts, 1.5]])

    def test_the_career_file_is_not_a_season(self):
        self.war_csv(self.hist / "waa_war_2025.csv")
        self.war_csv(self.hist / "waa_war_career.csv", pts=900.0)
        self.assertEqual([f.name for f in pp.hist_files("waa_war")],
                         ["waa_war_2025.csv"])
        self.assertEqual(sorted(pp.load_seasons()), [2025])

    def test_early_and_main_seasons_both_load(self):
        self.war_csv(self.early / "waa_war_2011.csv")
        self.war_csv(self.hist / "waa_war_2012.csv")
        self.assertEqual(sorted(pp.load_seasons()), [2011, 2012])

    def test_a_pattern_never_reaches_a_sibling_prefix(self):
        """waa_war_* must not pick up a future waa_war_weekly_<yr>.csv either."""
        self.war_csv(self.hist / "waa_war_2025.csv")
        self.war_csv(self.hist / "waa_war_weekly_2025.csv", pts=12.0)
        self.assertEqual([f.name for f in pp.hist_files("waa_war")],
                         ["waa_war_2025.csv"])
        self.assertEqual(pp.load_seasons()[2025]["p1"]["pts"], 200.0)


class TestCommittedCorpus(unittest.TestCase):
    """Read-only, against the tracked corpus — the file the model actually
    trains on. features_2025.csv and features_weekly_2025.csv are both in
    git, so this runs everywhere the suite does."""

    def test_the_tracked_corpus_has_both_files(self):
        self.assertTrue((HIST / "features_2025.csv").exists())
        self.assertTrue((HIST / "features_weekly_2025.csv").exists(),
                        "the over-matching sibling is gone; keep the glob strict anyway")

    def test_a_known_player_keeps_his_season_row(self):
        feats = pp.load_features()
        row = feats[2025][CHASE]
        self.assertAlmostEqual(row["tgt_share"], 0.3207, places=4)
        self.assertFalse(math.isnan(row["fp_exp_pg"]))
        for c in ("car_pg", "tgt_pg", "wk_hurt", "wk_bench", "games"):
            self.assertFalse(math.isnan(row[c]), f"{c} is nan — a weekly row won")

    def test_the_whole_season_keeps_its_expected_points(self):
        """fp_exp_pg is the single most used feature in every POS_COLS set;
        the weekly file does not carry it, so an overwrite zeroed it out for
        all 572 players at once."""
        rows = pp.load_features()[2025]
        have = sum(1 for r in rows.values() if not math.isnan(r["fp_exp_pg"]))
        self.assertGreater(have, 0.9 * len(rows))


class TestNaNGuard(unittest.TestCase):
    """A horizon year the corpus could not fit has no read. Zero is a read;
    nan is a file the browser cannot parse."""

    NO_MODELS = {"WR": {k: {"ppg": None, "games": None} for k in range(pp.HORIZON)}}

    def test_max_does_not_filter_a_nan(self):
        # why the guard is needed at all, not a test of project_points
        self.assertTrue(math.isnan(max(math.nan, 0.0)))
        self.assertTrue(math.isnan(min(max(math.nan, 0.0), pp.FULL_GP)))

    def test_an_unfitted_horizon_predicts_zero_not_nan(self):
        pred = pp.predict(self.NO_MODELS, "WR", None)
        self.assertEqual(pred, [(0.0, 0.0)] * pp.HORIZON)

    def test_the_prediction_survives_a_strict_json_dump(self):
        ppg = [round(p, 2) for p, _ in pp.predict(self.NO_MODELS, "WR", None)]
        self.assertEqual(json.dumps(ppg, allow_nan=False), "[0.0, 0.0, 0.0]")
        with self.assertRaises(ValueError):
            json.dumps([math.nan], allow_nan=False)


class TestScalarFrame(unittest.TestCase):
    """Which model wrote a projections.json. The old test was `meta.model
    startswith "per-13 rate"` — an edit to project_war.py's prose would have
    silently stopped the scalar copy and left the comparison lens frozen."""

    def test_an_explicit_engine_wins(self):
        self.assertTrue(pp.is_scalar_frame({"engine": "scalar", "model": "anything"}))
        self.assertFalse(pp.is_scalar_frame({"engine": pp.ENGINE,
                                             "model": "per-13 rate + ..."}))

    def test_the_prose_is_the_fallback(self):
        self.assertTrue(pp.is_scalar_frame({"model": "per-13 rate + capital-shrinkage"}))
        self.assertFalse(pp.is_scalar_frame({"model": "points-first: ppg and games"}))

    def test_a_frame_with_no_meta_is_not_the_scalar(self):
        for m in ({}, None, {"model": ""}, {"model": None}):
            self.assertFalse(pp.is_scalar_frame(m))

    def test_our_own_output_is_never_mistaken_for_the_scalar(self):
        meta = pp.site_meta({"model": "per-13 rate + x"}, 2025, [], 0)
        self.assertEqual(meta["engine"], pp.ENGINE)
        self.assertFalse(pp.is_scalar_frame(meta))

    def test_the_committed_scalar_file_still_reads_as_the_scalar(self):
        """project_war.py stamps no engine yet, so the committed file is the
        prose branch's one real case. When its owner adds engine:"scalar",
        this keeps passing through the other branch."""
        for f in (ROOT / "data" / "leagues").glob("*/projections_scalar.json"):
            meta = json.loads(f.read_text(encoding="utf-8")).get("meta")
            self.assertTrue(pp.is_scalar_frame(meta), f"{f} no longer reads as the scalar")


class TestSiteMeta(unittest.TestCase):
    """meta describes the STREAMS in the file, not the frame they were poured
    into."""

    SCALAR = {"generated": "2026-09-01", "seed_season": 2025, "roster_season": 2026,
              "horizon": 3, "years": [2026, 2027, 2028], "players": 365,
              "model": "per-13 rate + capital-shrinkage + availability"}
    ROWS = [{"pos": "WR", "src": "points"}, {"pos": "QB", "src": "rookie"},
            {"pos": "TE", "src": "scalar"}]

    def test_years_and_seed_come_from_this_model(self):
        meta = pp.site_meta(dict(self.SCALAR, years=None, seed_season=9999),
                            2025, self.ROWS, 2)
        self.assertEqual(meta["years"], [2026, 2027, 2028])
        self.assertEqual(meta["seed_season"], 2025)
        self.assertEqual(meta["horizon"], pp.HORIZON)

    def test_a_scalar_frame_on_other_years_is_refused(self):
        with self.assertRaises(SystemExit) as cm:
            pp.site_meta(dict(self.SCALAR, years=[2027, 2028, 2029], seed_season=2026),
                         2025, self.ROWS, 2)
        msg = str(cm.exception)
        self.assertIn("2027", msg)
        self.assertIn("2026", msg)
        self.assertIn("--site", msg)

    def test_agreeing_years_are_published(self):
        meta = pp.site_meta(self.SCALAR, 2025, self.ROWS, 2)
        self.assertEqual(meta["years"], self.SCALAR["years"])

    def test_the_streams_are_never_relabelled_silently(self):
        """The live bug: a 2026-seeded scalar frame around 2025-seeded streams
        published as [2027, 2028, 2029]. Whatever happens, it is not that."""
        try:
            meta = pp.site_meta(dict(self.SCALAR, years=[2027, 2028, 2029]),
                                2025, self.ROWS, 2)
        except SystemExit:
            return
        self.fail(f"relabelled the streams as {meta['years']}")

    def test_the_frame_metadata_is_inherited(self):
        meta = pp.site_meta(self.SCALAR, 2025, self.ROWS, 2)
        self.assertEqual(meta["roster_season"], 2026)

    def test_the_model_line_is_this_model(self):
        meta = pp.site_meta(self.SCALAR, 2025, self.ROWS, 2)
        self.assertTrue(meta["model"].startswith("points-first"))
        self.assertEqual(meta["engine"], pp.ENGINE)

    def test_the_counts_add_up(self):
        meta = pp.site_meta(self.SCALAR, 2025, self.ROWS, 2)
        self.assertEqual(meta["players"], 3)
        self.assertEqual(meta["points_players"], 1)
        self.assertEqual(meta["rookie_players"], 1)
        self.assertEqual(meta["scalar_players"], 1)
        self.assertEqual(meta["points_players"] + meta["rookie_players"]
                         + meta["scalar_players"], meta["players"])


class TestImportsWithoutNumpy(unittest.TestCase):
    """The fitting needs numpy and scikit-learn; loading, the era level, the
    NaN guard and the meta do not. CI installs neither in the test job, so a
    module-level `import numpy` would take the whole suite down with an
    ImportError rather than a skip."""

    def test_numpy_is_not_a_module_global(self):
        self.assertFalse(hasattr(pp, "np"),
                         "numpy is bound at module scope again — import it on use")

    def test_the_pure_helpers_are_reachable(self):
        for name in ("hist_files", "hist_year", "load_features", "load_seasons",
                     "load_meta", "era", "targets", "predict", "win_shift",
                     "is_scalar_frame", "check_years", "site_meta"):
            self.assertTrue(callable(getattr(pp, name)), name)


if __name__ == "__main__":
    unittest.main()
