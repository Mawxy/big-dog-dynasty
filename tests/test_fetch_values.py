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
import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import backfill_ktc_history                                         # noqa: E402
import fetch_values                                                 # noqa: E402
from fetch_values import DELTA_DAYS, HISTORY_DAYS, update_history   # noqa: E402


TODAY = "2026-09-01"


def run(hist, vals, ktc_seen=(), fc_seen=(), today=TODAY, deltas=DELTA_DAYS):
    update_history(hist, vals, {"ktc": set(ktc_seen), "fc": set(fc_seen)},
                   today, deltas)
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
        """Sixty consecutive days up to today: only the window survives, and
        today's observation is the last row."""
        from datetime import date, timedelta
        d0 = date.fromisoformat(TODAY)
        hist = {"p1": [[(d0 - timedelta(days=59 - i)).isoformat(), 100 + i, None]
                       for i in range(60)]}
        run(hist, {"p1": {"ktc": 9000}}, ktc_seen=["p1"])
        self.assertLessEqual(len(hist["p1"]), HISTORY_DAYS)
        self.assertEqual(hist["p1"][-1][:2], [TODAY, 9000])
        oldest = (d0 - timedelta(days=HISTORY_DAYS)).isoformat()
        self.assertTrue(all(r[0] >= oldest for r in hist["p1"]))

    def test_a_delisted_players_rows_age_out_instead_of_living_forever(self):
        """THE OTHER HALF OF THE TRIM. `del h[:-45]` kept the 45 most recent
        ROWS, and a player nobody quotes any more never gets a 46th — so his
        last handful sat in values_history.json for good and the file only
        grew. Trimming by DATE retires him."""
        hist = {"gone": [["2026-06-01", 5000, None], ["2026-06-02", 5100, None]]}
        run(hist, {"gone": {"ktc": 5100}})        # no source listed him today
        self.assertNotIn("gone", hist)

    def test_a_row_inside_the_window_survives_a_missed_day(self):
        hist = {"quiet": [["2026-08-28", 5000, None]]}
        run(hist, {"quiet": {"ktc": 5000}})
        self.assertEqual(hist["quiet"], [["2026-08-28", 5000, None]])


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
        run(hist, vals, ktc_seen=["p1"], today="2026-09-02")
        self.assertEqual(vals["p1"]["ktcT"]["7"], 600)


class TestAsOf(unittest.TestCase):
    """A source that missed today does not blank the board (Max, 2026-09-08):
    the deltas are measured as of its last real observation and say so."""

    def test_a_missed_day_reports_the_delta_as_of_the_last_observation(self):
        hist = {"p1": [["2026-08-24", 5000, None], ["2026-08-31", 5600, None]]}
        _, vals = run(hist, {"p1": {"ktc": 5600}})       # KTC failed today
        self.assertEqual(vals["p1"]["ktcT"]["7"], 600)
        self.assertEqual(vals["p1"]["ktcAsOf"], "2026-08-31")

    def test_a_fresh_day_carries_no_as_of(self):
        hist = {"p1": [["2026-08-24", 5000, None]]}
        _, vals = run(hist, {"p1": {"ktc": 5600}}, ktc_seen=["p1"])
        self.assertEqual(vals["p1"]["ktcT"]["7"], 600)
        self.assertNotIn("ktcAsOf", vals["p1"])

    def test_too_stale_is_dropped(self):
        hist = {"p1": [["2026-08-10", 5000, None], ["2026-08-18", 5600, None]]}
        _, vals = run(hist, {"p1": {"ktc": 5600}})       # 14 days unanswered
        self.assertNotIn("ktcT", vals["p1"])
        self.assertNotIn("ktcAsOf", vals["p1"])

    def test_a_delta_never_spans_a_carried_forward_copy(self):
        # the only observation is the last one; there is nothing 7 days
        # before it to measure against, so no delta rather than a fake 0
        hist = {"p1": [["2026-08-31", 5600, None]]}
        _, vals = run(hist, {"p1": {"ktc": 5600}})
        self.assertNotIn("ktcT", vals["p1"])


# players_min.json shape: pid -> [name, pos, nfl team]
PLAYERS = {"1": ["Josh Allen", "QB", "BUF"], "2": ["Bijan Robinson", "RB", "ATL"],
           "3": ["Puka Nacua", "WR", "LAR"]}


def fc_row(sid, name, value, pos="QB"):
    return {"player": {"sleeperId": sid, "name": name, "position": pos},
            "value": value, "overallRank": 1, "positionRank": 1}


def ktc_row(name, pos, value):
    return {"playerName": name, "position": pos, "slug": name.lower().replace(" ", "-"),
            "superflexValues": {"value": value, "rank": 1, "positionalRank": 1}}


def ktc_page(rows):
    return (f'<script id="ktc-players" type="application/json">'
            f'{json.dumps(rows)}</script>')


FC_GOOD = [fc_row("1", "Josh Allen", 9000), fc_row("2", "Bijan Robinson", 8000),
           fc_row("FP_2027_1", "2027 1st", 6000, "PICK")]
KTC_GOOD = [ktc_row("Josh Allen", "QB", 9500), ktc_row("Bijan Robinson", "RB", 8500),
            ktc_row("2027 Mid 1st", "RDP", 6100)]


class MainCase(unittest.TestCase):
    """main() end to end, network stubbed. Holds no tests of its own."""

    def run_main(self, fc=None, ktc=None, prev=None, hist=None):
        """main() end to end on fixtures. fc/ktc: a payload, or an Exception."""
        def fake_get(url):
            got = fc if url == fetch_values.FC_URL else ktc
            if isinstance(got, Exception):
                raise got
            return got

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / "players_min.json").write_text(json.dumps(PLAYERS), encoding="utf-8")
        self.out = d / "values.json"
        self.hist = d / "values_history.json"
        if prev is not None:
            self.out.write_text(json.dumps(prev), encoding="utf-8")
        if hist is not None:
            self.hist.write_text(json.dumps(hist), encoding="utf-8")
        log = io.StringIO()
        argv = ["fetch_values.py", "--players", str(d / "players_min.json"),
                "--out", str(self.out)]
        with mock.patch.object(fetch_values, "get", fake_get), \
                mock.patch.object(fetch_values, "MIN_MATCHED", 2), \
                mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(log):
            fetch_values.main()
        return log.getvalue()

    PREV = {"fetched": "2026-10-01", "sources": ["FantasyCalc", "KeepTradeCut"],
            "picks": {"ktc": [["2027 Mid 1st", 5000]], "fc": [["2027 1st", 5000]]},
            "players": {"1": {"ktc": 7000, "fc": 7000},
                        "2": {"ktc": 6000, "fc": 6000},
                        "3": {"ktc": 4000, "fc": 4000}}}

    def values(self):
        return json.loads(self.out.read_text(encoding="utf-8"))


class TestSourceGate(MainCase):
    """A source that answered is not a source that worked. A KTC payload whose
    shape moved raises nothing and matches nobody; carry-forward then freezes
    every price, `sources` still names KTC, and the run is green."""

    def test_a_healthy_run_lists_both_sources_quietly(self):
        log = self.run_main(json.dumps(FC_GOOD), ktc_page(KTC_GOOD), self.PREV)
        v = self.values()
        self.assertEqual(v["sources"], ["FantasyCalc", "KeepTradeCut"])
        self.assertEqual(v["players"]["1"]["ktc"], 9500)
        self.assertNotIn("::warning", log)

    def test_a_payload_whose_shape_moved_counts_as_failed(self):
        """THE BUG. superflexValues gone: no exception, matched 0."""
        moved = [{"playerName": "Josh Allen", "position": "QB", "values": {"sf": 9500}}]
        log = self.run_main(json.dumps(FC_GOOD), ktc_page(moved), self.PREV)
        v = self.values()
        self.assertEqual(v["sources"], ["FantasyCalc"])
        self.assertEqual(v["players"]["1"]["ktc"], 7000)      # carried
        self.assertIn("::warning", log)
        self.assertIn("KeepTradeCut", log)

    def test_a_failed_sources_carried_price_is_not_an_observation(self):
        moved = [{"playerName": "Josh Allen", "position": "QB"}]
        self.run_main(json.dumps(FC_GOOD), ktc_page(moved), self.PREV)
        hist = json.loads(self.hist.read_text(encoding="utf-8"))
        self.assertIsNone(hist["1"][-1][1])
        self.assertEqual(hist["1"][-1][2], 9000)

    def test_a_short_pull_leaves_nothing_behind(self):
        """One match against a floor of two. Merged, that one player would read
        as observed today and its pick row would shadow the carried ladder."""
        partial = [ktc_row("Josh Allen", "QB", 9500), ktc_row("2027 Mid 1st", "RDP", 1)]
        self.run_main(json.dumps(FC_GOOD), ktc_page(partial), self.PREV)
        v = self.values()
        self.assertEqual(v["sources"], ["FantasyCalc"])
        self.assertEqual(v["players"]["1"]["ktc"], 7000)
        self.assertEqual(v["picks"]["ktc"], [["2027 Mid 1st", 5000]])

    def test_a_hard_failure_warns_rather_than_just_printing(self):
        log = self.run_main(json.dumps(FC_GOOD), OSError("connection reset"), self.PREV)
        self.assertEqual(self.values()["sources"], ["FantasyCalc"])
        self.assertIn("::warning", log)
        self.assertIn("connection reset", log)

    def test_either_source_is_gated(self):
        log = self.run_main(json.dumps([]), ktc_page(KTC_GOOD), self.PREV)
        v = self.values()
        self.assertEqual(v["sources"], ["KeepTradeCut"])
        self.assertEqual(v["players"]["1"]["fc"], 7000)
        self.assertIn("FantasyCalc", log)

    def test_nothing_answering_keeps_the_previous_file_whole(self):
        log = self.run_main(OSError("down"), OSError("down"), self.PREV)
        self.assertEqual(self.values(), self.PREV)
        self.assertIn("No sources succeeded", log)

    def test_the_real_floor_sits_well_below_a_normal_day(self):
        """About 456 KTC and 396 FantasyCalc. A floor at or above those would
        fail every night; one near zero would not catch a gutted payload."""
        self.assertLess(fetch_values.MIN_MATCHED, 300)
        self.assertGreater(fetch_values.MIN_MATCHED, 50)


class TestScrub(MainCase):
    """Only digits are a Sleeper player id. 48 DP_* rows sat in values.json as
    players, drew impWar and joined the FC clamp population."""

    def test_synthetic_ids_are_scrubbed_from_the_carried_file(self):
        prev = json.loads(json.dumps(self.PREV))
        prev["players"].update({"DP_0_0": {"fc": 6851}, "FP_2026_1": {"fc": 6000},
                                "RESERVED_1": {"fc": 10}})
        self.run_main(json.dumps(FC_GOOD), ktc_page(KTC_GOOD), prev)
        self.assertEqual(sorted(self.values()["players"]), ["1", "2", "3"])

    def test_a_synthetic_id_listed_today_is_not_kept_either(self):
        fc = FC_GOOD + [fc_row("DP_1_0", "Pick 1.01", 5000)]
        self.run_main(json.dumps(fc), ktc_page(KTC_GOOD), self.PREV)
        self.assertNotIn("DP_1_0", self.values()["players"])
        self.assertNotIn("DP_1_0", json.loads(self.hist.read_text(encoding="utf-8")))

    def test_a_real_player_carried_from_last_run_keeps_his_price(self):
        """The scrub is about ids, not age. Puka was not listed today and has no
        history to age him by, so his price stays (see TestPriceExpiry)."""
        self.run_main(json.dumps(FC_GOOD), ktc_page(KTC_GOOD), self.PREV)
        self.assertEqual(self.values()["players"]["3"]["ktc"], 4000)


class TestPriceExpiry(MainCase):
    """A carried price lasts 30 days past its source's last quote (Max, 2026-11-02).
    Joe Mixon held a KTC 1569 from Oct 6 against FantasyCalc's 110."""

    TODAY = "2026-11-02"

    def expire(self, row, rows):
        vals = {"9": dict(row)}
        gone = fetch_values.expire_stale_prices(vals, {"9": rows}, self.TODAY)
        return vals, gone

    def test_thirty_days_is_kept_and_thirty_one_is_not(self):
        row = {"ktc": 1569}
        kept, gone = self.expire(row, [["2026-10-03", 1569, None]])
        self.assertEqual(kept["9"]["ktc"], 1569)
        self.assertEqual(gone["ktc"], 0)
        dropped, gone = self.expire(row, [["2026-10-02", 1569, None]])
        self.assertEqual(dropped, {})
        self.assertEqual(gone["ktc"], 1)

    def test_each_source_ages_on_its_own_and_takes_all_its_fields(self):
        row = {"ktc": 1569, "ktcRank": 300, "ktcPosRank": 80, "ktcTep": 1600, "ktcTepp": 1610,
               "ktcTeppp": 1620, "ktcT": {"7": -5}, "ktcAsOf": "2026-09-01",
               "fc": 110, "fcRank": 400, "fcPosRank": 90, "impWar": 0.1}
        vals, gone = self.expire(row, [["2026-09-01", 1569, 110], ["2026-11-01", None, 110]])
        self.assertEqual(vals["9"], {"fc": 110, "fcRank": 400, "fcPosRank": 90, "impWar": 0.1})
        self.assertEqual(gone, {"ktc": 1, "fc": 0})

    def test_a_row_with_no_price_left_goes_with_its_derived_figures(self):
        vals, _ = self.expire({"fc": 50, "fcRank": 9, "impWar": 0.2, "modelWar": 0.1},
                              [["2026-09-01", None, 50]])
        self.assertEqual(vals, {})

    def test_no_history_row_for_that_source_means_older_than_the_window(self):
        vals, gone = self.expire({"ktc": 2826, "fc": 300}, [["2026-11-01", None, 300]])
        self.assertEqual(vals["9"], {"fc": 300})
        self.assertEqual(gone["ktc"], 1)

    def test_a_row_that_never_had_a_price_is_left_alone(self):
        vals, gone = self.expire({"impWar": 0.2}, [])
        self.assertEqual(vals["9"], {"impWar": 0.2})
        self.assertEqual(gone, {"ktc": 0, "fc": 0})

    def test_the_limit_stays_inside_the_history_it_reads(self):
        self.assertLess(fetch_values.MAX_PRICE_AGE_DAYS, HISTORY_DAYS)

    def days_ago(self, n):
        return (date.today() - timedelta(days=n)).isoformat()

    def test_main_drops_only_the_price_past_the_limit(self):
        hist = {"3": [[self.days_ago(40), 4000, 4000]], "1": [[self.days_ago(1), 7000, 7000]]}
        log = self.run_main(json.dumps(FC_GOOD), ktc_page(KTC_GOOD), self.PREV, hist=hist)
        v = self.values()["players"]
        self.assertNotIn("3", v)                  # unquoted for 40 days, by both
        self.assertIn("expired past 30 days", log)

    def test_main_carries_a_recent_price_through_a_missed_day(self):
        hist = {"3": [[self.days_ago(5), 4000, 4000]]}
        self.run_main(json.dumps(FC_GOOD), ktc_page(KTC_GOOD), self.PREV, hist=hist)
        self.assertEqual(self.values()["players"]["3"]["ktc"], 4000)

    def test_with_no_history_at_all_the_age_is_unknown_so_nothing_goes(self):
        log = self.run_main(json.dumps(FC_GOOD), ktc_page(KTC_GOOD), self.PREV)
        self.assertEqual(self.values()["players"]["3"]["ktc"], 4000)
        self.assertNotIn("expired past", log)


class TestBackfillPaths(unittest.TestCase):
    """The hand-run backfill still parsed the inline playersArray KTC dropped on
    2026-09-08, and read players_min.json from a directory that has none."""

    PAGE = ktc_page([ktc_row("Josh Allen", "QB", 9500),
                     ktc_row("2027 Mid 1st", "RDP", 6100)])

    def test_player_links_reads_the_current_layout(self):
        with mock.patch.object(backfill_ktc_history, "get", lambda url: self.PAGE), \
                contextlib.redirect_stdout(io.StringIO()):
            links = backfill_ktc_history.player_links()
        self.assertEqual(links, [("Josh Allen", "josh-allen")])

    def test_it_shares_fetch_values_parser(self):
        self.assertIs(backfill_ktc_history.ktc_players, fetch_values.ktc_players)

    def test_the_two_files_it_touches_route_correctly(self):
        data = backfill_ktc_history.DATA
        self.assertEqual((data / "values_history_deep.json").parent, data.root)
        self.assertEqual((data / "players_min.json").parent, data.league)


if __name__ == "__main__":
    unittest.main()
