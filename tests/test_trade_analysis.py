#!/usr/bin/env python3
"""
Invariants of the trade ledger (scripts/trade_analysis.py).

Two things are locked here.

THE LIVE SEASON IS COUNTED ONCE. A side's total is `war + future`, and those
two used to overlap in-season: `war` accrues week by week while `future`'s
first term is a FULL 13-game projection for the season being played. After
week 1 of 2026 that double-counted 12/13 of every held asset's year one, and
by week 14 it would have counted the whole of it twice. `stream_value`'s
`year1` factor is the correction; `season_remaining` derives it.

THE TIER AT THE TIME OF THE TRADE. `standing_tier` and `tier_then` decide what
a pick "looked like" on the day of a deal, which is the frozen THEN end of the
ledger's then-vs-now drawer. They are exercised here on synthetic standings —
including the no-opponent week that used to raise a TypeError.

Pure stdlib, no network, no fixtures: every input below is a dict.

  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from trade_analysis import (DELTA, season_remaining, standing_tier,  # noqa: E402
                            stream_value, tier_of_slot, tier_then,
                            weeks_played_of)


def season(playoff_start=15, played=(), teams=(1, 2), no_opponent=()):
    """A matchups.json for one season. `played` are the scored weeks; each
    team's points are 100 + its roster id, so team 1 loses every week. A rid
    in `no_opponent` gets None where the opponent's points go, which is what
    build_site_data writes for a week that paired it with nobody."""
    out = {}
    for rid in teams:
        rows = []
        for wk in played:
            opp = next((o for o in teams if o != rid), None)
            if rid in no_opponent:
                rows.append([wk, 100.0 + rid, None, None, [], []])
            else:
                rows.append([wk, 100.0 + rid, opp, 100.0 + opp, [], []])
        out[str(rid)] = rows
    return {"playoff_start": playoff_start, "teams": out}


class TestStreamValue(unittest.TestCase):
    """`DELTA` discounts by YEAR: 1, delta, delta^2. `lag` defers the whole
    stream; `year1` shortens only its first term."""

    def test_the_discount_ladder_is_unchanged(self):
        self.assertAlmostEqual(stream_value([1.0, 1.0, 1.0], 0.7),
                               1 + 0.7 + 0.49, places=9)

    def test_lag_defers_the_whole_stream(self):
        self.assertAlmostEqual(stream_value([1.0, 1.0], 0.7, lag=2),
                               0.49 + 0.343, places=9)

    def test_year_one_scales_only_the_first_term(self):
        half = stream_value([1.0, 1.0, 1.0], 0.7, year1=0.5)
        self.assertAlmostEqual(half, 0.5 + 0.7 + 0.49, places=9)

    def test_a_full_year_one_is_the_old_number_exactly(self):
        for stream in ([2.0], [1.0, 0.8, 0.6], [0.0, 1.0]):
            self.assertEqual(stream_value(stream, DELTA, year1=1.0),
                             stream_value(stream, DELTA), stream)

    def test_a_spent_year_one_leaves_only_the_later_years(self):
        self.assertAlmostEqual(stream_value([5.0, 1.0], 0.7, year1=0.0),
                               0.7, places=9)

    def test_proration_and_lag_compose(self):
        """A deferred stream's first year is still its own first year."""
        self.assertAlmostEqual(stream_value([1.0, 1.0], 0.7, lag=1, year1=0.5),
                               0.5 * 0.7 + 0.49, places=9)


class TestSeasonRemaining(unittest.TestCase):
    """The fraction of the roster season's REGULAR season still to be played
    — the year-1 factor. Read off matchups.json, which only carries a week
    once it has points, so its weeks are the played weeks."""

    def test_the_offseason_is_a_whole_season(self):
        self.assertEqual(season_remaining(season(played=())), 1.0)

    def test_a_missing_or_empty_file_is_a_whole_season(self):
        """The ledger must not start prorating because a file is absent."""
        self.assertEqual(season_remaining(None), 1.0)
        self.assertEqual(season_remaining({}), 1.0)

    def test_one_week_of_fourteen_is_gone(self):
        self.assertAlmostEqual(season_remaining(season(played=(1,))),
                               13 / 14, places=9)

    def test_it_falls_week_by_week(self):
        prev = 1.1
        for n in range(0, 15):
            cur = season_remaining(season(played=tuple(range(1, n + 1))))
            self.assertLess(cur, prev, f"{n} weeks played")
            prev = cur

    def test_a_finished_regular_season_has_nothing_left(self):
        self.assertEqual(season_remaining(season(played=tuple(range(1, 15)))),
                         0.0)

    def test_playoff_weeks_do_not_count_against_the_regular_season(self):
        """The bracket is not part of the 13-game projection's window."""
        reg_only = season(played=tuple(range(1, 15)))
        with_bracket = season(played=tuple(range(1, 18)))
        self.assertEqual(season_remaining(with_bracket),
                         season_remaining(reg_only))

    def test_it_follows_the_leagues_own_playoff_start(self):
        """A league whose bracket starts in week 15 has 14 regular weeks; one
        starting in week 13 has 12, and the same played count bites harder."""
        self.assertGreater(
            season_remaining(season(playoff_start=15, played=(1, 2))),
            season_remaining(season(playoff_start=13, played=(1, 2))))

    def test_weeks_played_reports_both_halves(self):
        self.assertEqual(weeks_played_of(season(played=(1, 2, 3))), (3, 14))
        self.assertEqual(weeks_played_of(season(playoff_start=13)), (0, 12))


class TestTierOfSlot(unittest.TestCase):
    """Thirds of a round, from the league's own size."""

    def test_a_twelve_team_round_splits_four_four_four(self):
        got = [tier_of_slot(s, 12) for s in range(1, 13)]
        self.assertEqual(got, ["Early"] * 4 + ["Mid"] * 4 + ["Late"] * 4)

    def test_the_ends_of_a_round_are_the_ends(self):
        for n in (3, 4, 6, 8, 10, 12, 14, 16):
            self.assertEqual(tier_of_slot(1, n), "Early", n)
            self.assertEqual(tier_of_slot(n, n), "Late", n)

    def test_the_tiers_never_go_backwards(self):
        order = {"Early": 0, "Mid": 1, "Late": 2}
        for n in (2, 4, 10, 12, 14):
            got = [order[tier_of_slot(s, n)] for s in range(1, n + 1)]
            self.assertEqual(got, sorted(got), n)

    def test_a_league_too_small_to_have_thirds_still_returns_a_tier(self):
        self.assertEqual(tier_of_slot(1, 1), "Early")
        self.assertEqual(tier_of_slot(2, 2), "Mid")


class TestStandingTier(unittest.TestCase):

    MW = {2026: season(played=(1, 2, 3, 4, 5), teams=(1, 2, 3, 4))}

    def test_four_weeks_in_it_reads_this_seasons_standing(self):
        # team 1 scores least and so loses every week: it picks first
        self.assertEqual(standing_tier(2026, 5, 1, self.MW, {}), "Early")
        self.assertEqual(standing_tier(2026, 5, 4, self.MW, {}), "Late")

    def test_before_week_four_it_reads_last_seasons_finish(self):
        prev = {2025: {1: 12, 2: 1}}
        self.assertEqual(standing_tier(2026, 3, 2, self.MW, prev), "Early")
        self.assertEqual(standing_tier(2026, 3, 1, self.MW, prev), "Late")

    def test_with_nothing_to_go_on_it_is_mid(self):
        """The league's first season, before four weeks — there is no finish
        anybody could have been looking at."""
        self.assertEqual(standing_tier(2026, 1, 1, self.MW, {}), "Mid")
        self.assertEqual(standing_tier(2026, 5, 99, self.MW, {}), "Mid")

    def test_only_weeks_up_to_the_trade_count(self):
        """No lookahead: a pick traded in week 4 is priced off weeks 1-4."""
        mw = {2026: season(played=(1, 2, 3, 4, 5, 6), teams=(1, 2, 3, 4))}
        self.assertEqual(standing_tier(2026, 4, 1, mw, {}),
                         standing_tier(2026, 6, 1, mw, {}))

    def test_playoff_weeks_never_enter_the_standing(self):
        mw = {2026: season(playoff_start=4, played=(1, 2, 3, 4, 5),
                           teams=(1, 2, 3, 4))}
        self.assertEqual(standing_tier(2026, 5, 1, mw, {}), "Early")

    def test_a_week_with_no_opponent_does_not_raise(self):
        """THE BUG. build_site_data writes None for the opponent's points when
        a week paired a team with nobody, and `e[1] > e[3]` raised TypeError on
        it — taking the whole ledger down rather than scoring one fewer week."""
        mw = {2026: season(played=(1, 2, 3, 4, 5), teams=(1, 2, 3, 4),
                           no_opponent=(3,))}
        self.assertIn(standing_tier(2026, 5, 3, mw, {}),
                      ("Early", "Mid", "Late"))
        # the team with no result still banks its points and so is not last
        self.assertEqual(standing_tier(2026, 5, 1, mw, {}), "Early")


class TestTierThen(unittest.TestCase):

    MW = {2026: season(played=(1, 2, 3, 4, 5), teams=(1, 2, 3, 4))}
    SLOTS = {2025: {7: 2}}                      # 2025's pick from rid 7 fell 2nd

    def pick(self, ps, orig, tier=None):
        return {"kind": "pick", "ps": ps, "orig": orig, "tier": tier}

    def trade(self, season=2026, week=5):
        return {"season": str(season), "week": week}

    def test_a_pick_already_drafted_prices_at_its_actual_slot(self):
        got = tier_then(self.pick(2025, 7), self.trade(), self.SLOTS, 12,
                        self.MW, {})
        self.assertEqual(got, "Early")          # slot 2 of 12

    def test_an_undrafted_pick_prices_off_the_standing(self):
        got = tier_then(self.pick(2027, 1), self.trade(), self.SLOTS, 12,
                        self.MW, {})
        self.assertEqual(got, "Early")          # rid 1 is last, so picks first

    def test_a_pick_with_no_provenance_keeps_its_own_tier(self):
        self.assertEqual(
            tier_then({"kind": "pick", "tier": "Late"}, self.trade(),
                      self.SLOTS, 12, self.MW, {}), "Late")
        self.assertEqual(
            tier_then({"kind": "pick"}, self.trade(), self.SLOTS, 12,
                      self.MW, {}), "Mid")

    def test_the_league_size_decides_where_the_thirds_fall(self):
        """Slot 2 is Early in a 12-team round and Mid in a 3-team one — which
        is why n_teams must come from the league and not from a constant."""
        self.assertEqual(tier_then(self.pick(2025, 7), self.trade(),
                                   self.SLOTS, 12, self.MW, {}), "Early")
        self.assertEqual(tier_then(self.pick(2025, 7), self.trade(),
                                   self.SLOTS, 3, self.MW, {}), "Mid")

    def test_a_same_season_pick_is_not_treated_as_already_drafted(self):
        """`ps < season` is the test: a 2026 pick traded during 2026 is priced
        off the standing, not off a slot that may not exist yet."""
        slots = {2026: {1: 1}}
        got = tier_then(self.pick(2026, 1), self.trade(), slots, 12,
                        self.MW, {})
        self.assertEqual(got, standing_tier(2026, 5, 1, self.MW, {}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
