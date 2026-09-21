#!/usr/bin/env python3
"""Locks what a player shard contains and how it is rebuilt.

The shard exists for one reason: a player page must not download a league-wide
file to render one man's row. Two properties keep that true, and both fail
QUIETLY when they break, which is why they are pinned here:

  * WHAT IS IN IT. Enough that Player.tsx needs no whole-file fetch, and no
    more than that — the analog row is carried as a subset because `near` is
    most of why projections_knn_hybrid.json is 788 KB. A field is ABSENT, never
    null, when the player has no row in that source.
  * HOW IT IS WRITTEN. This used to rmtree the directory and then make ~800
    write_text calls, so a crash anywhere in the loop left the COMMITTED shard
    tree gutted and the commit step published the hole. Shards are now written
    atomically in place and pruned only after every write lands.

Pure and synthetic — no network, no sleeper_data, no committed data read.

  python -m unittest discover -s tests
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import shard_players  # noqa: E402

YEARS = [2026, 2027, 2028]
CURVES = ["scalar_natural", "scalar_composite", "analog_natural",
          "analog_composite", "blend_natural", "blend_composite"]


def _mx_row(pid, name):
    row = {"pid": pid, "name": name, "pos": "QB", "team": "Some Team", "age": 30,
           "has_analog": True, "has_sleeper": True, "sleeper_war": 1.4,
           "pts13": 260.7, "trust": 0.6, "w_sleeper": 0.5, "d_med": 0.86,
           "padded": False, "totals": {c: 4.4 for c in CURVES}}
    row.update({c: [1.5, 1.4, 1.4] for c in CURVES})
    return row


def _knn_row(pid, name):
    """A full analog row — deliberately fatter than what a shard should keep."""
    return {
        "pid": pid, "gsis": "00-000", "name": name, "pos": "QB", "age": 30,
        "exp": 8, "seen": [3.1, 2.9, 3.2], "gps": [13, 13, 13],
        "n": 18, "eff_n": 12.0, "n_scored": [18, 17, 15], "d_med": 0.86,
        "d_max": 1.09, "padded": False, "sim_med": 65,
        "avail": 0.9, "fitted": [1.4], "median_flat": [1.3], "expected": [1.2],
        "proj": [1.5, 1.4, 1.4], "proj_mean": [1.5, 1.4, 1.4],
        "low": [1.2, 0.9, 1.0], "high": [1.9, 1.9, 1.9],
        "raw_median": [1.5], "share_useful": [0.8, 0.7, 0.7], "total": 4.3,
        "near": [{"name": "Someone Else", "season": 2022, "age": 27, "d": 0.57,
                  "sim": 83, "seen": [3.1, 2.5, 3.2], "gps": [13, 13, 13],
                  "then": [1.2, None, 1.5], "then_gp": [13, 0, 13]}],
    }


#: the roster season's meta block, as project_matrix.py publishes it while the
#: season is being played (scripts/inseason.py). None out of season.
INSEASON = {"season": 2026, "weeks_played": 4, "reg_weeks": 14,
            "remaining_frac": 0.714286}


def _fixture(d, *, reachable=("1", "2", "3", "4"),
             proj_ids=("1", "2"), sproj_ids=("1", "3"),
             mx_ids=("1",), knn_ids=("1", "4"), inseason=None, banked=0.249):
    """A data root shaped like the real one, minus leagues.json.

    Without a registry DataDir's league key is "", so every path resolves
    straight into the root — which is exactly the pre-multi-league layout and
    keeps the fixture readable.
    """
    w = lambda n, o: (d / n).write_text(json.dumps(o), encoding="utf-8")
    w("projections.json", {
        "meta": {"years": YEARS},
        "players": [{"pid": p, "name": f"P{p}", "composite": [1.0, 1.0, 1.0],
                     "career": [[2025, 1.1]]} for p in proj_ids]})
    w("proj_sleeper.json", {
        "meta": {}, "players": {p: {"pos": "QB", "pts13": 200.0, "ppg": 15.4,
                                    "raw_pts": 200.0} for p in sproj_ids}})
    mx_rows = [_mx_row(p, f"P{p}") for p in mx_ids]
    if inseason:
        for r in mx_rows:
            r["banked"], r["gp"] = banked, 1
    w("projections_matrix.json", {
        "meta": {"curves": CURVES, "blend_w": [0.9, 0.5, 0.1],
                 "inseason": inseason},
        "players": mx_rows})
    w("projections_knn_hybrid.json", {
        "meta": {"space": "hybrid"},
        # a corpus row that never joined to a Sleeper id — nothing can link to
        # him, and he must not become a shard named "None.json"
        "players": [_knn_row(p, f"P{p}") for p in knn_ids]
                   + [dict(_knn_row("x", "Unjoined"), pid=None)]})
    w("players_min.json", {p: [f"P{p}", "QB", "BUF"] for p in reachable})
    return d


def _run(root):
    argv = sys.argv
    sys.argv = ["shard_players.py", "--out", str(root)]
    try:
        with redirect_stdout(io.StringIO()) as out:
            shard_players.main()
        return out.getvalue()
    finally:
        sys.argv = argv


def _shards(root):
    return {f.stem: json.loads(f.read_text(encoding="utf-8"))
            for f in (root / "player").glob("*.json")}


class ShardContents(unittest.TestCase):
    def test_enriched_shard_carries_the_matrix_row_and_the_analog_read(self):
        """The whole point of the change: the player page's two whole-file
        fetches (1 MB between them) become fields of a file it already asks
        for."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            s = _shards(d)["1"]
            self.assertEqual(s["years"], YEARS)
            self.assertIsNotNone(s["proj"])
            self.assertIsNotNone(s["sproj"])
            self.assertEqual(s["mx"]["name"], "P1")
            # every curve, or the six-curve table has nothing to draw
            for c in CURVES:
                self.assertEqual(len(s["mx"][c]), 3)
            # meta.blend_w rides along: it is the one figure the page reads out
            # of the matrix file's HEADER, and without it the Sleeper-weight
            # tooltip silently falls back to a hardcoded 0.9
            self.assertEqual(s["blend_w"], [0.9, 0.5, 0.1])
            self.assertEqual([n["name"] for n in s["knn"]["near"]], ["Someone Else"])

    def test_analog_read_is_a_subset_not_the_whole_row(self):
        """`near` is most of why the analog file is 788 KB; the fitted paths and
        the cohort's own diagnostics are not on screen anywhere. Carrying the
        whole row would put ~450 wasted bytes in every shard."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            self.assertEqual(set(_shards(d)["1"]["knn"]),
                             set(shard_players.KNN_KEYS))

    def test_the_subset_matches_the_frontend_type(self):
        """KNN_KEYS mirrors `KnnShard` in src/lib/types.ts. Two lists, one
        meaning: if they drift, the page reads a field the pipeline stopped
        writing and the comparables table goes blank with no error."""
        ts = (ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
        block = ts.split("KnnShard = Pick<KnnProjection,", 1)[1].split(">", 1)[0]
        names = [k.strip().strip('"') for k in block.split("|")]
        self.assertEqual(sorted(names), sorted(shard_players.KNN_KEYS))

    def test_absence_is_a_missing_field_not_a_null(self):
        """Player 2 is projected and nothing else. The page reads
        `shard?.mx ?? null` either way, so an absent key costs nothing to
        consume and keeps the ~200 analog-only shards small."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            s = _shards(d)["2"]
            self.assertNotIn("mx", s)
            self.assertNotIn("blend_w", s)
            self.assertNotIn("knn", s)
            self.assertIsNone(s["sproj"])

    def test_an_analog_only_player_still_gets_a_shard(self):
        """Player 4 has no projection of any kind, only a cohort. Before the
        shard carried `knn` his comparables table came out of the whole-file
        fetch; gating shards on the projection sources alone would delete that
        table from ~200 pages and call it a performance fix."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            s = _shards(d)
            self.assertIn("4", s)
            self.assertIsNone(s["4"]["proj"])
            self.assertIsNone(s["4"]["sproj"])
            self.assertIn("knn", s["4"])

    def test_unreachable_and_unjoined_ids_never_become_shards(self):
        """The gate is players_min.json — the ids the site can actually name.
        A corpus row with pid null is a historical player nothing links to."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t), reachable=("1", "2"))
            _run(d)
            self.assertEqual(set(_shards(d)), {"1", "2"})
            self.assertFalse((d / "player" / "None.json").exists())

    def test_serialization_stays_compact(self):
        """Compact separators, no trailing newline. ~800 files a night: the
        whitespace is not free and the site diffs these on every run."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            raw = (d / "player" / "1.json").read_text(encoding="utf-8")
            self.assertNotIn(", ", raw)
            self.assertNotIn('": ', raw)
            self.assertFalse(raw.endswith("\n"))


class InSeasonFields(unittest.TestCase):
    """The in-season outlook needs three things on a player page: the league's
    week count, his banked WAR, and his year-1 projection. The third is already
    in `mx`; the first two are copied here so the page still fetches one file.

        outlook = banked + year1 * remaining_frac

    (scripts/inseason.py, src/lib/outlook.ts — the shard is what the browser
    reads them out of.)
    """

    def test_the_block_and_the_banked_figure_ride_along(self):
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t), inseason=INSEASON)
            _run(d)
            s = _shards(d)["1"]
            self.assertEqual(s["inseason"], INSEASON)
            self.assertEqual(s["banked"], 0.249)
            self.assertEqual(s["gp"], 1)
            # and the matrix row still carries them, because the shard copies
            # the row whole — one producer, two places to read it
            self.assertEqual(s["mx"]["banked"], 0.249)

    def test_a_player_who_has_not_played_carries_a_real_zero(self):
        """0.0 is a figure, not an absence: he has dressed for nobody. Written
        with `is not None` rather than truthiness, or every unplayed player's
        outlook would silently lose its banked term."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t), inseason=INSEASON, banked=0.0)
            _run(d)
            s = _shards(d)["1"]
            self.assertIn("banked", s)
            self.assertEqual(s["banked"], 0.0)

    def test_out_of_season_the_shard_is_what_it_always_was(self):
        """No block, no banked, no gp — and the page shows the projection."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            s = _shards(d)["1"]
            for k in ("inseason", "banked", "gp"):
                self.assertNotIn(k, s)

    def test_a_shard_with_no_matrix_row_carries_neither(self):
        """Nothing to prorate: without a year-1 curve there is no outlook, and
        a block alone would only be a label with no figure under it."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t), inseason=INSEASON)
            _run(d)
            s = _shards(d)["2"]
            self.assertNotIn("inseason", s)
            self.assertNotIn("banked", s)

    def test_the_shard_carries_the_fields_the_frontend_reads(self):
        """`InSeason` in src/lib/outlook.ts is the consumer of this block; the
        four keys ARE the contract between the pipeline and the page."""
        ts = (ROOT / "src" / "lib" / "outlook.ts").read_text(encoding="utf-8")
        block = ts.split("export type InSeason = {", 1)[1].split("};", 1)[0]
        for k in INSEASON:
            self.assertIn(k, block, k)


class Rebuild(unittest.TestCase):
    def test_a_player_who_drops_out_loses_his_shard(self):
        """Otherwise the site serves last season's projection forever."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            self.assertIn("3", _shards(d))
            _fixture(d, reachable=("1", "2", "4"), sproj_ids=("1",))
            _run(d)
            self.assertNotIn("3", _shards(d))
            self.assertIn("1", _shards(d))

    def test_a_crash_mid_rebuild_leaves_the_committed_shards_standing(self):
        """The bug this replaced: rmtree, then ~800 write_text calls. A crash,
        a job timeout or a canceled run anywhere in that loop left the
        directory gutted and the commit step published the hole. Every shard is
        self-contained, so a half-finished rebuild is a directory of valid
        files — which is the property worth having, not atomicity across the
        whole set."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            before = _shards(d)
            self.assertEqual(set(before), {"1", "2", "3", "4"})

            real = shard_players.atomic_write
            calls = []

            def boom(path, text, **kw):
                calls.append(path)
                if len(calls) > 1:
                    raise OSError("disk went away")
                return real(path, text, **kw)

            shard_players.atomic_write = boom
            try:
                with self.assertRaises(OSError):
                    _run(d)
            finally:
                shard_players.atomic_write = real

            after = _shards(d)
            self.assertEqual(set(after), set(before))
            # and nothing half-written: every file still parses, which is what
            # the assertion above already proves by loading them
            self.assertEqual(after["4"], before["4"])
            # no temp litter left inside a directory the commit step stages
            self.assertEqual([f.name for f in (d / "player").iterdir()
                              if f.suffix != ".json"], [])

    def test_a_stale_temp_file_is_swept(self):
        """ioutil cleans its own temp file on a normal failure, but a hard kill
        can leave one — and data-refresh stages this whole directory."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            (d / "player" / "1.json.abc123.tmp").write_text("{", encoding="utf-8")
            _run(d)
            self.assertEqual([f.name for f in (d / "player").iterdir()
                              if f.suffix != ".json"], [])


class Guards(unittest.TestCase):
    def test_missing_player_map_refuses_rather_than_wiping(self):
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            (d / "players_min.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(SystemExit):
                _run(d)
            self.assertEqual(len(_shards(d)), 4)

    def test_missing_projection_inputs_refuse_rather_than_wiping(self):
        """A local run in a tree without projections.json / proj_sleeper.json is
        the silent data-loss mode this guard exists for. The analog file alone
        must not be enough to authorise a rebuild — it would strip the
        projection out of every shard while looking like a successful run."""
        with tempfile.TemporaryDirectory() as t:
            d = _fixture(Path(t))
            _run(d)
            (d / "projections.json").unlink()
            (d / "proj_sleeper.json").unlink()
            with self.assertRaises(SystemExit):
                _run(d)
            self.assertEqual(len(_shards(d)), 4)
            self.assertIsNotNone(_shards(d)["1"]["proj"])


if __name__ == "__main__":
    unittest.main()
