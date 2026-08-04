"""Locks slot pricing — the lineup-slot analogue of Bridge A.

`raw` being the MEDIAN and `hit_rate` being measured against the position's
starter bar are both decisions about what the published figure means, so they
are pinned here rather than left to the reader of the script.
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sv = _load("slot_value")
sc = _load("sleeper_crawl")
FIELDS = sc.ROW_FIELDS


def roster(rid, **slots):
    row = [0] * len(FIELDS)
    row[0] = rid
    for k, v in slots.items():
        row[FIELDS.index(k)] = v
    return row


def season(champ, rosters, lid="L", yr=2024):
    return {"lid": lid, "chain": lid, "season": yr, "champ": champ,
            "rosters": rosters}


class CollectTest(unittest.TestCase):
    def test_champion_and_field_are_separated(self):
        rows = [season(1, [roster(1, rb1_war=1.5), roster(2, rb1_war=0.4)])]
        got, nc, nf = sv.collect(rows, FIELDS)
        self.assertEqual(got["RB1"]["champ"], [1.5])
        self.assertEqual(got["RB1"]["field"], [0.4])
        self.assertEqual(sorted(got["RB1"]["all"]), [0.4, 1.5])
        self.assertEqual((nc, nf), (1, 1))

    def test_an_unfinished_season_contributes_to_all_but_no_verdict(self):
        """champ is None while a bracket is live. Those rosters still price the
        slot, but calling any of them 'field' would count a future champion as
        one of the teams that lost."""
        rows = [season(None, [roster(1, rb1_war=1.0), roster(2, rb1_war=0.5)])]
        got, nc, nf = sv.collect(rows, FIELDS)
        self.assertEqual(sorted(got["RB1"]["all"]), [0.5, 1.0])
        self.assertEqual(got["RB1"]["champ"], [])
        self.assertEqual(got["RB1"]["field"], [])
        self.assertEqual((nc, nf), (0, 0))

    def test_rows_of_the_wrong_width_are_skipped(self):
        good = roster(1, rb1_war=1.0)
        rows = [season(1, [good, good[:6]])]
        got, _, nf = sv.collect(rows, FIELDS)
        self.assertEqual(got["RB1"]["all"], [1.0])
        self.assertEqual(nf, 0)

    def test_every_slot_is_collected(self):
        rows = [season(1, [roster(1, **{f"{s.lower()}_war": 1.0
                                        for s, _ in sv.SLOTS})])]
        got, _, _ = sv.collect(rows, FIELDS)
        for slot, _pos in sv.SLOTS:
            self.assertEqual(got[slot]["all"], [1.0], slot)


class SummarizeTest(unittest.TestCase):
    def test_raw_is_the_median_not_the_mean(self):
        # one superteam must not move the published figure
        vals = {"all": [0.5] * 9 + [9.0], "champ": [], "field": []}
        row = sv.summarize(vals, "RB")
        self.assertEqual(row["raw"]["all"], 0.5)
        self.assertGreater(row["mean"]["all"], 1.0)

    def test_hit_rate_uses_the_positions_starter_bar(self):
        # RB bar is 0.70: three of four clear it
        vals = {"all": [0.69, 0.70, 0.90, 1.50] * 2, "champ": [], "field": []}
        self.assertAlmostEqual(sv.summarize(vals, "RB")["hit_rate"]["all"], 0.75)

    def test_qb2_is_judged_against_the_qb_bar(self):
        """A superflex starter is a starting quarterback. Grading QB2 on a
        softer bar would conceal the hole the slot is measuring."""
        self.assertEqual(dict(sv.SLOTS)["QB2"], "QB")

    def test_a_thin_slot_publishes_null_rather_than_a_noisy_median(self):
        vals = {"all": [1.0] * (sv.MIN_OBS - 1), "champ": [], "field": []}
        row = sv.summarize(vals, "TE")
        self.assertIsNone(row["raw"]["all"])
        self.assertEqual(row["n"]["all"], sv.MIN_OBS - 1)

    def test_quartiles_bracket_the_median(self):
        vals = {"all": [float(i) for i in range(20)], "champ": [], "field": []}
        row = sv.summarize(vals, "WR")
        self.assertLess(row["q1"]["all"], row["raw"]["all"])
        self.assertGreater(row["q3"]["all"], row["raw"]["all"])

    def test_dist_is_sorted_for_the_box_plot(self):
        vals = {"all": [3.0, 1.0, 2.0] * 4, "champ": [], "field": []}
        d = sv.summarize(vals, "WR")["dist"]["all"]
        self.assertEqual(d, sorted(d))


class LoadTest(unittest.TestCase):
    def test_a_league_season_in_two_shards_is_counted_once(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            row = season(1, [roster(1, rb1_war=1.0)])
            for i in (0, 1):
                Path(td, f"c_{i}.json").write_text(
                    json.dumps({"rows": [row]}), encoding="utf-8")
            self.assertEqual(len(sv.load_rows([str(Path(td, "c_*.json"))])), 1)


@unittest.skipUnless((ROOT / "scratch" / "sample_corpus_0.json").exists(),
                     "no sample corpus present")
class RealCorpusTest(unittest.TestCase):
    def test_champion_medians_beat_the_field_in_every_slot(self):
        rows = sv.load_rows([str(ROOT / "scratch" / "sample_corpus_0.json")])
        got, _, _ = sv.collect(rows, FIELDS)
        for slot, pos in sv.SLOTS:
            r = sv.summarize(got[slot], pos)
            self.assertGreater(r["raw"]["champ"], r["raw"]["field"], slot)


if __name__ == "__main__":
    unittest.main()
