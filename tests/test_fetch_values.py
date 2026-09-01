#!/usr/bin/env python3
"""
Invariants of the market-value history recorder (fetch_values.update_history).

The rule: a number nobody quoted today is not an observation of today.

values.json carries the previous run's price forward so the site still shows one
for a player who dropped off a source (retired, renamed, or a name that stopped
matching). That is right for the PRICE and wrong for the HISTORY. The freshness
guard used to be per-SOURCE — "did KTC answer at all" — so a carried-forward
player got yesterday's number re-stamped under today's date on every run, and
the delta scan then compared that number against itself: his 7/14/30-day moves
flattened to ~0 and stayed there for good instead of going N/A.

Network-free: update_history is pure dict-shuffling over inputs main() has
already fetched.

  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from fetch_values import update_history                            # noqa: E402


TODAY = "2026-09-01"
CUTOFFS = {7: "2026-08-25", 14: "2026-08-18", 30: "2026-08-02"}


def run(hist, vals, ktc_seen=(), fc_seen=(), today=TODAY, cutoffs=None):
    update_history(hist, vals, {"ktc": set(ktc_seen), "fc": set(fc_seen)},
                   today, CUTOFFS if cutoffs is None else cutoffs)
    return hist, vals


class TestWhoGetsRecorded(unittest.TestCase):

    def test_a_player_the_source_listed_today_is_recorded(self):
        hist, _ = run({}, {"p1": {"ktc": 5000, "fc": 4000}},
                      ktc_seen=["p1"], fc_seen=["p1"])
        self.assertEqual(hist["p1"], [[TODAY, 5000, 4000]])

    def test_a_carried_forward_value_is_not_recorded(self):
        """THE BUG. p1 still has a price — carried from the last run — but no
        source listed him today, so no row may be written under today's date."""
        hist = {"p1": [["2026-08-20", 5000, 4000]]}
        run(hist, {"p1": {"ktc": 5000, "fc": 4000}})
        self.assertEqual(hist["p1"], [["2026-08-20", 5000, 4000]])

    def test_one_source_can_be_fresh_while_the_other_is_carried(self):
        hist, _ = run({}, {"p1": {"ktc": 5000, "fc": 4000}}, fc_seen=["p1"])
        self.assertEqual(hist["p1"], [[TODAY, None, 4000]])

    def test_a_source_that_failed_outright_records_nothing_for_anyone(self):
        hist, _ = run({}, {"p1": {"ktc": 5000}, "p2": {"ktc": 3000}})
        self.assertEqual(hist, {})

    def test_an_unlisted_player_gets_no_empty_history_entry(self):
        hist, _ = run({}, {"p1": {"ktc": 5000}, "p2": {"ktc": 3000}},
                      ktc_seen=["p1"])
        self.assertEqual(list(hist), ["p1"])

    def test_a_second_run_on_the_same_day_does_not_blank_a_source(self):
        hist = {"p1": [[TODAY, 5000, 4000]]}
        run(hist, {"p1": {"ktc": 5100, "fc": 4000}}, ktc_seen=["p1"])
        self.assertEqual(hist["p1"], [[TODAY, 5100, 4000]])

    def test_history_is_trimmed_to_the_recent_window(self):
        hist = {"p1": [[f"2026-0{1 + i // 28}-{1 + i % 28:02d}", 100 + i, None]
                       for i in range(60)]}
        run(hist, {"p1": {"ktc": 9000}}, ktc_seen=["p1"])
        self.assertEqual(len(hist["p1"]), 45)
        self.assertEqual(hist["p1"][-1][:2], [TODAY, 9000])


class TestDeltas(unittest.TestCase):

    def test_a_fresh_player_gets_aligned_deltas(self):
        hist = {"p1": [["2026-07-01", 4000, None],     # older than 30d
                       ["2026-08-15", 4200, None],     # older than 14d
                       ["2026-08-20", 4500, None]]}    # older than 7d
        _, vals = run(hist, {"p1": {"ktc": 5000}}, ktc_seen=["p1"])
        self.assertEqual(vals["p1"]["ktcT"], {"7": 500, "14": 800, "30": 1000})

    def test_it_reads_the_newest_row_old_enough_not_the_oldest(self):
        hist = {"p1": [["2026-08-01", 1000, None],
                       ["2026-08-24", 4500, None]]}
        _, vals = run(hist, {"p1": {"ktc": 5000}}, ktc_seen=["p1"])
        self.assertEqual(vals["p1"]["ktcT"]["7"], 500)

    def test_a_carried_forward_players_deltas_go_away_rather_than_flatten(self):
        """He is no longer quoted, so there is no move to report. N/A beats
        yesterday's delta relabelled as today's — and beats the ~0 the
        re-recorded snapshot used to manufacture."""
        hist = {"p1": [["2026-08-20", 5000, None]]}
        _, vals = run(hist, {"p1": {"ktc": 5000, "ktcT": {"7": 12}}})
        self.assertNotIn("ktcT", vals["p1"])

    def test_a_stale_source_is_dropped_while_a_fresh_one_survives(self):
        hist = {"p1": [["2026-08-01", 5000, 3000]]}
        _, vals = run(hist, {"p1": {"ktc": 5000, "fc": 4000,
                                    "ktcT": {"7": 12}, "fcT": {"7": 8}}},
                      fc_seen=["p1"])
        self.assertNotIn("ktcT", vals["p1"])
        self.assertEqual(vals["p1"]["fcT"], {"7": 1000, "14": 1000, "30": 1000})

    def test_a_native_trend_survives_when_the_source_did_list_him(self):
        """KTC's own 7-day figure is the labeled fallback until our history is
        deep enough to compute an aligned one."""
        _, vals = run({}, {"p1": {"ktc": 5000, "ktcT": {"7": 42}}},
                      ktc_seen=["p1"])
        self.assertEqual(vals["p1"]["ktcT"], {"7": 42})

    def test_the_gap_heals_on_the_next_run_that_sees_him(self):
        hist = {"p1": [["2026-08-01", 5000, None]]}
        vals = {"p1": {"ktc": 5000, "ktcT": {"7": 12}}}
        run(hist, vals)                                  # missed today
        self.assertNotIn("ktcT", vals["p1"])
        vals["p1"]["ktc"] = 5600
        run(hist, vals, ktc_seen=["p1"], today="2026-09-02",
            cutoffs={7: "2026-08-26", 14: "2026-08-19", 30: "2026-08-03"})
        self.assertEqual(vals["p1"]["ktcT"]["7"], 600)


if __name__ == "__main__":
    unittest.main()
