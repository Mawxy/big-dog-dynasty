#!/usr/bin/env python3
"""
Invariants of the value stack: DVI, CVI, Bridge A and Bridge B.

This half of the pipeline runs unattended every night and its outputs are
traded on, so the weights and shares below are locked the same way
FRANCHISE_BAR is in tests/test_franchise.py — they are published decisions
(METHODOLOGY.md, "DVI", "CVI", "Pick values"), not tuning knobs, and moving
one changes what the figure MEANS.

Pure stdlib, no fixtures, no network. The modules are imported for their
constants and pure helpers only; nothing here runs a `main()`.

NOTE on coverage. Bridge A's outcome rule — "a player-season with no source is
skipped, a player who is out of the league is a real 0.0" — lives in `war_of`,
a closure inside `pick_value.main()`, and cannot be imported. What is locked
here instead is the rule's guard (`load_sources` only reports a season as a
source when its waa_war CSV exists) and its consequence at the aggregation
layer (`summarize` publishes a skipped season as absent, a zeroed one as a
real observation that moves `raw`). See the report accompanying this suite.
"""
import sys
import unittest
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import blend_values as bv                                  # noqa: E402
import contender_index as ci                               # noqa: E402
import pick_value as pv                                    # noqa: E402
import value_bridge as vb                                  # noqa: E402


class DviWeightsTest(unittest.TestCase):
    """DVI = 0.50 x market + 0.50 x non-market, non-market weighted
    war 1.0 / roster 1.0 / start 1.2."""

    def test_market_takes_exactly_half(self):
        """MARKET_SHARE = 0.50 is what makes DVI a second opinion rather than
        a KTC echo. KTC and FantasyCalc are ONE market between them."""
        self.assertEqual(bv.MARKET_SHARE, 0.50)

    def test_non_market_weights_are_the_published_ones(self):
        self.assertEqual(bv.WEIGHTS_NM, {"war": 1.0, "roster": 1.0, "start": 1.2})

    def test_start_rate_outweighs_the_other_two_non_market_signals(self):
        """start% is the only signal that sees real starter usage, so it is
        deliberately the heaviest of the three."""
        self.assertGreater(bv.WEIGHTS_NM["start"], bv.WEIGHTS_NM["war"])
        self.assertGreater(bv.WEIGHTS_NM["start"], bv.WEIGHTS_NM["roster"])

    def test_the_two_halves_sum_to_one(self):
        self.assertAlmostEqual(bv.MARKET_SHARE + (1 - bv.MARKET_SHARE), 1.0)

    def test_roster_percent_is_clamped_early_because_it_saturates(self):
        self.assertEqual(bv.CLAMP["roster"], (0.30, 0.90))
        self.assertEqual(bv.CLAMP["start"], (0.05, 0.85))

    def test_markets_keep_a_higher_ceiling_than_production(self):
        """war clamps at p95, the markets at p99 — the top-end spread comes
        from the markets, which is exactly the channel CVI has to replace."""
        self.assertEqual(bv.CLAMP["war"], ("p10", "p95"))
        self.assertEqual(bv.CLAMP["ktc"], ("p10", "p99"))
        self.assertEqual(bv.CLAMP["fc"], ("p10", "p99"))


class StartRateScheduleTest(unittest.TestCase):
    """start% trusts the snapshot early and the season average from week 8 —
    so one injured week never tanks a value."""

    def test_the_offseason_and_week_one_are_snapshot_only(self):
        self.assertEqual(bv.snap_weight(0), 1.0)
        self.assertEqual(bv.snap_weight(None), 1.0)
        self.assertEqual(bv.snap_weight(1), 1.0)

    def test_week_eight_is_fully_the_season_average(self):
        for wk in (8, 9, 14, 18):
            self.assertEqual(bv.snap_weight(wk), 0.0, wk)

    def test_the_schedule_only_ever_shifts_toward_the_season_average(self):
        weights = [bv.snap_weight(w) for w in range(1, 9)]
        self.assertEqual(weights, sorted(weights, reverse=True))

    def test_injury_skip_stops_where_the_snapshot_stops_driving(self):
        """The two knobs are one decision: skip the start component only while
        the snapshot still dominates it."""
        self.assertEqual(bv.INJURY_SKIP_BEFORE_WEEK, 8)
        self.assertEqual(bv.snap_weight(bv.INJURY_SKIP_BEFORE_WEEK), 0.0)

    def test_a_player_with_no_start_data_at_all_has_no_component(self):
        self.assertIsNone(bv.start_value({}, 5))

    def test_no_season_data_yet_falls_back_to_the_snapshot(self):
        self.assertEqual(bv.start_value({"start_rate_now": 0.8, "start_obs": 0}, 5), 0.8)

    def test_the_blend_is_the_scheduled_mix_of_snapshot_and_season(self):
        s = {"start_rate": 0.20, "start_rate_now": 1.0, "start_obs": 4}
        self.assertAlmostEqual(bv.start_value(s, 5),
                               0.50 * 1.0 + 0.50 * 0.20)     # SNAP_SCHEDULE[5]
        self.assertAlmostEqual(bv.start_value(s, 9), 0.20)   # season average only


class CviWeightsTest(unittest.TestCase):
    """CVI = 0.50 x FantasyPros ECR + 0.50 x non-market, non-market weighted
    war 1.0 / roster 0.4 / start 1.4. DVI's opposite number."""

    def test_the_consensus_takes_exactly_half(self):
        self.assertEqual(ci.CONSENSUS_SHARE, 0.50)
        self.assertEqual(ci.CONSENSUS_SHARE, bv.MARKET_SHARE)

    def test_non_market_weights_are_the_published_ones(self):
        self.assertEqual(ci.WEIGHTS_NM, {"war": 1.0, "roster": 0.4, "start": 1.4})

    def test_start_outranks_roster_the_reverse_of_dvi(self):
        """roster% partly measures FUTURE interest — managers roster stashes
        they never intend to start — so a win-now index demotes it and
        promotes its win-now analogue. This inversion IS the index."""
        self.assertGreater(ci.WEIGHTS_NM["start"], ci.WEIGHTS_NM["roster"])
        self.assertLess(ci.WEIGHTS_NM["roster"], bv.WEIGHTS_NM["roster"])
        self.assertGreater(ci.WEIGHTS_NM["start"], bv.WEIGHTS_NM["start"])

    def test_the_shared_machinery_is_shared_not_copied(self):
        """start% must not drift between the two indices."""
        self.assertIs(ci.start_value, bv.start_value)
        self.assertIs(ci.snap_weight, bv.snap_weight)
        self.assertIs(ci.CLAMP, bv.CLAMP)

    def test_the_redraft_consensus_is_the_superflex_one(self):
        self.assertEqual(ci.DEFAULT_FORMAT, "ppr-superflex")

    def test_ecr_rides_the_war_curve_rather_than_a_linear_percentile(self):
        """Rank 1 and rank 12 are one apart as integers and worlds apart as
        players. Borrowing the projected-WAR shape keeps the top end spread."""
        wars = [5.0, 3.0, 1.0, 0.5]
        got = ci.ecr_to_war(["a", "b", "c", "d"], wars)
        self.assertEqual(got, {"a": 5.0, "b": 3.0, "c": 1.0, "d": 0.5})

    def test_more_ranked_players_than_war_values_clamps_at_the_tail(self):
        got = ci.ecr_to_war(["a", "b", "c"], [5.0, 3.0])
        self.assertEqual(got["c"], 3.0)


class BridgeBMonotonicityTest(unittest.TestCase):
    """Bridge B is an ISOTONIC fit: value -> WAR is non-decreasing by
    construction, so implied WAR across the pick board (1.01 down to 4.12,
    i.e. descending market value) is non-increasing. A pick board that read
    non-monotone would price a later pick above an earlier one."""

    # a noisy but broadly increasing market -> WAR relationship
    SAMPLE = [(120, 0.1), (300, 0.9), (450, 0.4), (700, 1.1), (900, 0.8),
              (1400, 1.9), (2100, 1.6), (3000, 2.6), (4200, 3.1), (6000, 2.9),
              (8000, 4.4), (9500, 4.1)]

    def setUp(self):
        self.knots = vb.pav(self.SAMPLE)

    def test_the_fit_is_non_decreasing_in_war(self):
        wars = [w for _v, w in self.knots]
        self.assertEqual(wars, sorted(wars))

    def test_the_knots_ascend_in_value(self):
        vals = [v for v, _w in self.knots]
        self.assertEqual(vals, sorted(vals))

    def test_the_fit_smooths_the_violations_rather_than_following_them(self):
        """450 dips below 300 in the raw data; the fit must not."""
        self.assertLess(len(self.knots), len(self.SAMPLE))

    def test_input_order_does_not_change_the_fit(self):
        self.assertEqual(vb.pav(list(reversed(self.SAMPLE))), self.knots)

    def test_prediction_is_non_decreasing_in_market_value(self):
        prev = None
        for v in range(0, 11000, 250):
            got = vb.interp(self.knots, v)
            if prev is not None:
                self.assertGreaterEqual(got, prev, v)
            prev = got

    def test_implied_war_never_rises_as_the_pick_gets_later(self):
        """The published shape: `picks` is priced by interpolating the market's
        own pick values, which descend from 1.01 to 4.12."""
        board = [("1.01", 9500), ("1.02", 8000), ("1.06", 6000), ("1.12", 4200),
                 ("2.01", 3000), ("2.06", 2100), ("3.01", 1400), ("3.06", 900),
                 ("4.01", 450), ("4.12", 120)]
        implied = [vb.interp(self.knots, val) for _label, val in board]
        self.assertEqual(implied, sorted(implied, reverse=True))

    def test_the_ends_are_clamped_not_extrapolated(self):
        """A pick priced above the richest player in the join must not be
        extrapolated into a WAR nobody has ever produced."""
        self.assertEqual(vb.interp(self.knots, 10 ** 9), self.knots[-1][1])
        self.assertEqual(vb.interp(self.knots, -5), self.knots[0][1])

    def test_a_flat_market_fits_flat(self):
        knots = vb.pav([(100, 1.0), (200, 1.0), (300, 1.0)])
        self.assertEqual([w for _v, w in knots], [1.0])

    def test_spearman_reads_a_perfect_monotone_join_as_one(self):
        self.assertEqual(vb.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertEqual(vb.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1.0)


class BridgeASlotsTest(unittest.TestCase):
    """Bridge A's published shape: every slot 1.01-4.12 individually, plus
    Early/Mid/Late bands per round."""

    def test_the_board_is_four_rounds_of_twelve(self):
        self.assertEqual(pv.MAX_PICK, 48)
        self.assertEqual(len(pv.PICK_ORDER), 48)
        self.assertEqual(pv.PICK_ORDER[0], "1.01")
        self.assertEqual(pv.PICK_ORDER[-1], "4.12")

    def test_bands_are_picks_1_4_5_8_and_9_12(self):
        self.assertEqual([pv.band_key(p) for p in (1, 4)], ["1E", "1E"])
        self.assertEqual([pv.band_key(p) for p in (5, 8)], ["1M", "1M"])
        self.assertEqual([pv.band_key(p) for p in (9, 12)], ["1L", "1L"])
        self.assertEqual(pv.band_key(13), "2E")
        self.assertEqual(pv.band_slots("2M"), "2.05–2.08")

    def test_the_first_priced_class_is_2019(self):
        self.assertEqual(pv.FIRST_CLASS, 2019)

    def test_a_hit_is_one_war_over_three_seasons(self):
        self.assertEqual(pv.HIT_WAR, 1.0)

    def test_the_observation_bar_is_looser_only_for_round_four(self):
        """Not every league in the corpus drafts four rounds, so those slots
        have structurally fewer contributors."""
        self.assertEqual(pv.MIN_OBS_BY_ROUND, {1: 10, 2: 10, 3: 10, 4: 7})
        self.assertLess(pv.MIN_OBS_BY_ROUND[4], pv.MIN_OBS_BY_ROUND[3])

    def test_the_franchise_bars_come_from_one_place(self):
        """pick_value imports them rather than restating them, so the Draft
        page's franchise rate and the Franchise page cannot disagree."""
        import franchise_players as fp
        self.assertIs(pv.FRANCHISE_BAR, fp.FRANCHISE_BAR)
        self.assertEqual(pv.FRANCHISE_SEASONS, fp.MIN_SEASONS)

    def test_the_crawl_budget_is_spent_exactly_not_floored(self):
        self.assertEqual((pv.CRAWL_MIN, pv.CRAWL_BUDGET), (3, 40))


class BridgeAOutcomeRuleTest(unittest.TestCase):
    """"No source is SKIPPED, out of the league is a real 0.0."

    The decision itself lives in a closure and cannot be imported (see the
    module docstring). These lock the guard in front of it and the difference
    it makes to the published figure.
    """

    ONE_SLOT = ["1.01"]

    def summarize(self, cells, *, years=(1,), outs=None, hits=None, out_years=()):
        outs = outs or {"1.01": {k: 0 for k in years}}
        return pv.summarize(self.ONE_SLOT, cells, hits or {}, list(years),
                            outs, list(out_years))[0]

    def test_a_zeroed_season_and_a_skipped_one_publish_different_figures(self):
        """This is why the rule matters: zeroing a player-season with no
        source would drag the slot's mean toward zero, which is a claim about
        the pick rather than about the data."""
        zeroed = self.summarize({"1.01": {1: [0.0, 0.0, 1.5]}})
        skipped = self.summarize({"1.01": {1: [1.5]}})
        self.assertEqual(zeroed["n"][1], 3)
        self.assertEqual(zeroed["raw"][1], 0.5)
        self.assertEqual(skipped["n"][1], 1)
        self.assertEqual(skipped["raw"][1], 1.5)

    def test_a_year_with_nothing_behind_it_publishes_no_figure(self):
        """Absent, not 0.00 — the em-dash convention, at the source."""
        row = self.summarize({"1.01": {1: []}})
        self.assertEqual(row["n"][1], 0)
        self.assertNotIn(1, row["raw"])
        self.assertNotIn(1, row["dist"])

    def test_a_real_zero_is_an_observation_that_counts(self):
        row = self.summarize({"1.01": {1: [0.0]}})
        self.assertEqual(row["n"][1], 1)
        self.assertEqual(row["raw"][1], 0.0)

    def test_negative_seasons_are_carried_not_floored(self):
        """Raw values only (Max's call): each season counts at its actual WAR."""
        row = self.summarize({"1.01": {1: [-0.8, 0.8]}})
        self.assertEqual(row["raw"][1], 0.0)
        self.assertEqual(row["dist"][1], [-0.8, 0.8])

    def test_hit_rate_is_the_share_clearing_HIT_WAR(self):
        row = self.summarize({"1.01": {1: [0.0]}},
                             hits={"1.01": [0.99, 1.0, 2.0, -1.0]})
        self.assertEqual(row["hit_rate"], 0.5)
        self.assertEqual(row["hit_n"], 4)

    def test_out_rate_publishes_only_for_matured_years(self):
        """Deeper years are class-thin survivor noise: not yet available,
        rather than wrong."""
        row = self.summarize({"1.01": {1: [0.0, 1.0], 2: [0.0, 0.0]}},
                             years=(1, 2), outs={"1.01": {1: 1, 2: 2}},
                             out_years=(1,))
        self.assertEqual(row["out_rate"], {1: 0.5})
        self.assertEqual(pv.OUT_MIN_CLASSES, 4)

    def load_sources(self, last):
        # load_sources reads its CSVs with a bare open() and never closes them,
        # so calling it raises ResourceWarning at collection. That is the
        # script's business, not this test's — suppress it here rather than
        # let it become noise in every run.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            return pv.load_sources(last)

    def test_a_missing_history_file_is_not_a_source(self):
        """The guard in front of the rule: a season only counts as a source
        when its waa_war CSV exists, so running before war-history regenerates
        cannot poison a whole column with zeros."""
        self.assertEqual(self.load_sources(pv.FIRST_CLASS)[3], {pv.FIRST_CLASS})
        self.assertEqual(self.load_sources(pv.FIRST_CLASS + 2)[3],
                         {pv.FIRST_CLASS, pv.FIRST_CLASS + 1, pv.FIRST_CLASS + 2})

    def test_a_player_with_no_history_id_is_real_war_only(self):
        """Travis Hunter is a CB to nflverse and absent from the corpus, so
        his pre-league seasons have no source and must be skipped."""
        self.assertIn("Travis Hunter", pv.NO_GSIS)
        self.assertNotIn("Travis Hunter", pv.ZEROES)

    def test_known_busts_resolve_to_a_zero_output_not_a_skip(self):
        self.assertTrue(pv.ZEROES)
        self.assertFalse(pv.ZEROES & pv.NO_GSIS)


if __name__ == "__main__":
    unittest.main()
