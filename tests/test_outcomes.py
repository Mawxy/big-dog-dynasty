"""Locks the outcomes crawl's pure logic against Big Dog's own 2024 season.

These are the three functions that decide what every benchmark means, so a
change here is a change in what "champion", "held a first" and "homegrown"
report — not a broken build. The fixtures are the real Sleeper payloads the
crawler would fetch, so a Sleeper shape change fails here first.

WHAT ACTUALLY RUNS IN CI. Four tests in this file are gated on
`sleeper_data/` — the raw Sleeper dump — which is gitignored and therefore
absent on every clone, CI included. They run ONLY on a machine that has done
a local `sleeper_pull.py` first. Treat them as a local-only extra: everything
CI verifies is in the ungated tests, and a change that breaks only the gated
ones will go green on a pull request.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# sleeper_crawl imports its sibling franchise_players; running it as a script
# puts scripts/ on the path for free, loading it here does not.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import crawl_guard  # noqa: E402
import merge_trade_corpus  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "sleeper_data" / "2024"

_spec = importlib.util.spec_from_file_location(
    "sleeper_crawl", ROOT / "scripts" / "sleeper_crawl.py")
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)


def load(name):
    return json.loads((RAW / f"{name}.json").read_text(encoding="utf-8"))


class ChampionTest(unittest.TestCase):
    @unittest.skipUnless(RAW.exists(), "sleeper_data/2024 not present (gitignored)")
    def test_reads_the_title_game_not_a_consolation(self):
        w, l = sc.champ_of(load("winners_bracket"))
        # Bijan al-Gaib (roster 2) beat The Hurt Locker (roster 11) in 2024
        self.assertEqual(w, 2)
        self.assertEqual(l, 11)

    def test_bracket_without_a_title_game_returns_none(self):
        # every game an earlier round: in progress, no champion yet
        self.assertEqual(sc.champ_of([{"m": 1, "r": 1, "w": 4, "l": 5}]), (None, None))

    def test_placement_3_is_not_mistaken_for_the_title(self):
        self.assertEqual(sc.champ_of([{"p": 3, "w": 8, "l": 1}]), (None, None))

    def test_empty_and_none(self):
        self.assertEqual(sc.champ_of([]), (None, None))
        self.assertEqual(sc.champ_of(None), (None, None))


class PickHoldingsTest(unittest.TestCase):
    def test_every_roster_starts_with_its_own_pick_in_each_round(self):
        held, sold = sc.pick_holdings([1, 2], [], 2027)
        self.assertEqual(held[1], {1: 1, 2: 1, 3: 1, 4: 1})
        self.assertFalse(sold[1])

    def test_a_move_debits_the_original_owner_and_credits_the_holder(self):
        traded = [{"season": "2027", "round": 1, "roster_id": 1, "owner_id": 2,
                   "previous_owner_id": 1}]
        held, sold = sc.pick_holdings([1, 2], traded, 2027)
        self.assertEqual(held[1][1], 0)
        self.assertEqual(held[2][1], 2)      # its own plus the acquired one
        self.assertTrue(sold[1])             # roster 1 sold its own first
        self.assertFalse(sold[2])

    def test_other_seasons_and_deep_rounds_are_ignored(self):
        traded = [{"season": "2028", "round": 1, "roster_id": 1, "owner_id": 2,
                   "previous_owner_id": 1},
                  {"season": "2027", "round": 9, "roster_id": 1, "owner_id": 2,
                   "previous_owner_id": 1}]
        held, sold = sc.pick_holdings([1, 2], traded, 2027)
        self.assertEqual(held[1], {1: 1, 2: 1, 3: 1, 4: 1})
        self.assertFalse(sold[1])

    def test_reacquiring_your_own_pick_is_not_a_sale(self):
        # Sleeper resolves a re-acquired pick to owner == original, one row
        traded = [{"season": "2027", "round": 1, "roster_id": 1, "owner_id": 1,
                   "previous_owner_id": 2}]
        held, sold = sc.pick_holdings([1, 2], traded, 2027)
        self.assertEqual(held[1][1], 1)
        self.assertFalse(sold[1])

    def test_unknown_rosters_are_skipped_not_crashed(self):
        traded = [{"season": "2027", "round": 1, "roster_id": 99, "owner_id": 2,
                   "previous_owner_id": 99}]
        held, _ = sc.pick_holdings([1, 2], traded, 2027)
        self.assertEqual(held[2][1], 1)

    def test_malformed_season_is_skipped(self):
        traded = [{"season": None, "round": 1, "roster_id": 1, "owner_id": 2}]
        held, _ = sc.pick_holdings([1, 2], traded, 2027)
        self.assertEqual(held[1][1], 1)

    @unittest.skipUnless(RAW.exists(), "sleeper_data/2024 not present")
    def test_holdings_conserve_picks_on_real_data(self):
        rosters = load("rosters")
        rids = [r["roster_id"] for r in rosters]
        held, _ = sc.pick_holdings(rids, load("traded_picks"), 2025)
        # picks are conserved: 12 rosters x 4 rounds, however they moved
        self.assertEqual(sum(sum(v.values()) for v in held.values()), len(rids) * 4)
        self.assertTrue(all(v >= 0 for h in held.values() for v in h.values()))


class PlacementsTest(unittest.TestCase):
    def test_bracket_placements_win_and_the_loser_takes_the_next_slot(self):
        pl = sc.placements_of([{"p": 1, "w": 2, "l": 11, "t1": 2, "t2": 11},
                               {"p": 3, "w": 5, "l": 8, "t1": 5, "t2": 8}],
                              [2, 11, 5, 8])
        self.assertEqual(pl, {2: 1, 11: 2, 5: 3, 8: 4})

    def test_non_playoff_rosters_rank_underneath_by_record(self):
        pl = sc.placements_of([{"p": 1, "w": 2, "l": 11, "t1": 2, "t2": 11}],
                              [2, 11, 7, 9])
        self.assertEqual(pl[7], 3)
        self.assertEqual(pl[9], 4)

    def test_no_bracket_falls_back_to_the_standings(self):
        self.assertEqual(sc.placements_of([], [4, 1, 3]), {4: 1, 1: 2, 3: 3})

    @unittest.skipUnless(RAW.exists(), "sleeper_data/2024 not present")
    def test_real_2024_playoff_places_match_but_below_is_by_record(self):
        """Where the winners bracket decides, `place` must equal the published
        `finish`. Below it the two are ALLOWED to differ — franchises.json reads
        the consolation bracket and `place` deliberately doesn't (see
        placements_of). Asserting both halves is what stops the difference from
        being mistaken for drift later.
        """
        rosters = load("rosters")
        st = {r["roster_id"]: r.get("settings") or {} for r in rosters}
        rank = sorted(st, key=lambda i: (-((st[i].get("wins") or 0)
                                           + 0.5 * (st[i].get("ties") or 0)),
                                         -float(st[i].get("fpts") or 0)))
        wb = load("winners_bracket")
        pl = sc.placements_of(wb, rank)
        fr = json.loads((ROOT / "data" / "leagues" / "814608002207334400"
                         / "franchises.json").read_text(encoding="utf-8"))
        published = {int(rid): s["finish"] for rid, f in fr.items()
                     for s in f["seasons"] if s["season"] == "2024" and s["finish"]}
        playoff = {r for g in wb for r in (g.get("t1"), g.get("t2")) if r}
        for rid in playoff:
            self.assertEqual(pl[rid], published[rid], f"roster {rid}")
        # everyone placed exactly once, no ties, no gaps
        self.assertEqual(sorted(pl.values()), list(range(1, len(rosters) + 1)))
        # and the non-playoff teams are in record order
        below = sorted((rid for rid in pl if rid not in playoff), key=lambda i: pl[i])
        self.assertEqual(below, [rid for rid in rank if rid not in playoff])


def mkrow(rid, place, *, w=7, l=7, fpts=1600, picks=(1, 1, 1, 1), kept=1,
          hg=5, n=20, qb=3, rb=6, wr=8, te=3, exp_sum=60, exp_n=20,
          sqb=0, srb=0, swr=0, ste=0, eqb=0, erb=0, ewr=0, ete=0,
          fqb=0, frb=0, fwr=0, fte=0, slots=None):
    row = [rid, w, l, fpts, *picks, kept, hg, n, place, qb, rb, wr, te,
           exp_sum, exp_n, sqb, srb, swr, ste, eqb, erb, ewr, ete,
           fqb, frb, fwr, fte, *(slots or [0.0] * len(sc.SLOT_FIELDS))]
    assert len(row) == len(sc.ROW_FIELDS), "fixture drifted from ROW_FIELDS"
    return row


class TierIndexTest(unittest.TestCase):
    """The Sleeper <-> nflverse join. A name match silently loses the players
    who decide titles, so this pins the key that doesn't."""

    def test_last_name_strips_suffixes_and_punctuation(self):
        self.assertEqual(sc._last("Amon-Ra St. Brown"), "brown")
        self.assertEqual(sc._last("Odell Beckham Jr."), "beckham")
        self.assertEqual(sc._last("Ja'Marr Chase"), "chase")

    @unittest.skipUnless((ROOT / "nfl_history" / "players_meta.csv").exists(),
                         "nfl_history/ not present")
    def test_legal_name_mismatches_still_resolve(self):
        """nflverse says Joshua Allen, Sleeper says Josh Allen. Keying on name
        loses him, Brady, DK Metcalf, Deebo Samuel, Hockenson and Watson —
        20% of elite seasons and the best players in the set."""
        raw = json.loads((ROOT / "sleeper_data" / "players.json").read_text(encoding="utf-8")) \
            if (ROOT / "sleeper_data" / "players.json").exists() else None
        if not raw:
            self.skipTest("sleeper_data/players.json not present")
        pmeta = {pid: {"name": f"{p.get('first_name','')} {p.get('last_name','')}".strip(),
                       "pos": p.get("position"), "dob": p.get("birth_date")}
                 for pid, p in raw.items() if isinstance(p, dict)}
        idx, _became = sc.tier_index(pmeta)
        self.assertGreater(len(idx), 400)
        names = {pmeta[pid]["name"] for (_s, pid) in idx}
        for who in ("Josh Allen", "Tom Brady", "Deebo Samuel"):
            self.assertIn(who, names, who)

    def test_slot_wars_take_the_best_n_at_each_position(self):
        wars = {(2024, "a"): ("RB", 1.5), (2024, "b"): ("RB", 0.9),
                (2024, "c"): ("RB", 0.3), (2024, "d"): ("QB", 2.0)}
        got = sc.slot_wars(["a", "b", "c", "d"], wars, 2024)
        slot = dict(zip(sc.SLOT_FIELDS, got))
        self.assertEqual(slot["rb1_war"], 1.5)
        self.assertEqual(slot["rb2_war"], 0.9)      # third-best RB is ignored
        self.assertEqual(slot["qb1_war"], 2.0)

    def test_an_unfilled_slot_is_zero_not_dropped(self):
        """A superflex team carrying one QB really did field nothing in QB2.
        Skipping it would flatter exactly the rosters that were short."""
        got = sc.slot_wars(["d"], {(2024, "d"): ("QB", 2.0)}, 2024)
        slot = dict(zip(sc.SLOT_FIELDS, got))
        self.assertEqual(slot["qb1_war"], 2.0)
        self.assertEqual(slot["qb2_war"], 0.0)
        self.assertEqual(slot["te1_war"], 0.0)

    def test_players_absent_from_history_contribute_nothing(self):
        self.assertEqual(sc.slot_wars(["ghost"], {}, 2024),
                         [0.0] * len(sc.SLOT_FIELDS))

    def test_slots_mirror_a_superflex_lineup(self):
        self.assertEqual(sc.LINEUP_SLOTS,
                         [("QB", 1), ("QB", 2), ("RB", 1), ("RB", 2),
                          ("WR", 1), ("WR", 2), ("WR", 3), ("TE", 1)])

    def test_missing_history_yields_an_empty_index_not_a_crash(self):
        real = sc.ROOT
        try:
            sc.ROOT = Path("/nonexistent")
            self.assertEqual(sc.tier_index({}), ({}, {}))
        finally:
            sc.ROOT = real


class SummarizeTest(unittest.TestCase):
    """Counts must be additive so the four shards merge by summing."""

    def row(self, champ, rosters, lid="x", season=2025, playoff_teams=None):
        # `playoff_teams` decides who counts as the field — the rest of the
        # BRACKET, not the rest of the league. Fixtures default to a bracket
        # wide enough to hold every roster they define, so a test that does not
        # care about the distinction behaves as it always did.
        return {"lid": lid, "season": season, "teams": len(rosters),
                "champ": champ, "runner": None, "rosters": rosters,
                "playoff_teams": len(rosters) if playoff_teams is None
                else playoff_teams}

    def test_counts_are_additive_across_shards(self):
        a = self.row(1, [mkrow(1, 1, w=10, l=4, picks=(2, 1, 1, 1)),
                         mkrow(2, 2, w=4, l=10, kept=0)], lid="a")
        b = self.row(2, [mkrow(1, 2), mkrow(2, 1, w=9, l=5)], lid="b")
        one = sc.summarize_outcomes([a, b], 0, 1)["counts"]
        split = [sc.summarize_outcomes([a], 0, 2)["counts"],
                 sc.summarize_outcomes([b], 1, 2)["counts"]]
        for k, v in one.items():
            self.assertEqual(v, sum(s.get(k, 0) for s in split), k)

    def test_champion_pick_posture(self):
        s = sc.summarize_outcomes(
            [self.row(1, [mkrow(1, 1, picks=(2, 1, 1, 1))])], 0, 1)["counts"]
        self.assertEqual(s["champ_bought"], 1)
        self.assertEqual(s["champ_sold"], 0)
        self.assertEqual(s["champ_net_picks"], 1)
        self.assertEqual(s["champ_kept_own_1st"], 1)

    def test_construction_is_sums_and_counts_never_a_mean(self):
        s = sc.summarize_outcomes(
            [self.row(1, [mkrow(1, 1, hg=5, n=20), mkrow(2, 2, hg=15, n=20)])],
            0, 1)["counts"]
        # champion: 5 of 20 homegrown. The field is the OTHER bracket roster —
        # the champion is not part of the group it is being compared against.
        self.assertEqual((s["champ_homegrown_sum"], s["champ_roster_sum"]), (5, 20))
        self.assertEqual((s["field_homegrown_sum"], s["field_roster_sum"]), (15, 20))
        self.assertEqual(s["champ_roster_n"], 1)
        self.assertEqual(s["field_roster_n"], 1)
        self.assertEqual(s["champ_rb_sum"], 6)
        self.assertEqual(s["field_rb_sum"], 6)

    def test_the_field_is_the_bracket_not_the_league(self):
        """A title is won against the playoff teams. Rosters that missed the
        bracket are not the comparison, and neither is the champion itself."""
        rosters = [mkrow(1, 1, hg=5, n=20),      # champion
                   mkrow(2, 2, hg=15, n=20),     # made the 4-team bracket
                   mkrow(3, 4, hg=15, n=20),     # made it, last seed
                   mkrow(4, 9, hg=1, n=20)]      # missed — must not count
        s = sc.summarize_outcomes(
            [self.row(1, rosters, playoff_teams=4)], 0, 1)["counts"]
        self.assertEqual(s["field_roster_n"], 2)
        self.assertEqual(s["field_homegrown_sum"], 30)
        self.assertEqual(s["champ_roster_n"], 1)
        # the missed-the-bracket roster still feeds the league-wide stacking
        # denominators, which ask a different question
        self.assertEqual(s["rb_start0_rosters"], 4)

    def test_a_season_with_no_bracket_records_no_field(self):
        s = sc.summarize_outcomes(
            [self.row(1, [mkrow(1, 1), mkrow(2, 2)], playoff_teams=0)],
            0, 1)["counts"]
        self.assertEqual(s["champ_roster_n"], 1)
        self.assertEqual(s.get("field_roster_n", 0), 0)

    def test_each_tier_carries_both_halves_of_the_fraction(self):
        s = sc.summarize_outcomes([self.row(1, [mkrow(1, 1, erb=2),
                                                mkrow(2, 2, erb=0)])], 0, 1)["counts"]
        self.assertEqual(s["rb_elite2_rosters"], 1)
        self.assertEqual(s["rb_elite2_champs"], 1)
        self.assertEqual(s["rb_elite0_rosters"], 1)
        self.assertEqual(s.get("rb_elite0_champs", 0), 0)

    def test_rows_from_an_older_schema_are_dropped_not_misread(self):
        """State and CI caches outlive a column addition. A short row indexed
        by F[...] silently reads the wrong field, so it must be discarded."""
        good = mkrow(1, 1)
        opp = mkrow(2, 2)                            # the field, full width
        stale = mkrow(3, 3)[:len(good) - 4]          # written before the slots
        rows = [self.row(1, [good, opp, stale], playoff_teams=3)]
        s = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertEqual(s["champ_slot_n"], 1)
        self.assertEqual(s["field_slot_n"], 1)       # the stale row is gone

    def test_a_season_of_only_stale_rows_is_skipped_entirely(self):
        stale = mkrow(1, 1)[:5]
        s = sc.summarize_outcomes([self.row(1, [stale])], 0, 1)["counts"]
        self.assertEqual(s.get("league_seasons", 0), 0)

    def test_slot_war_sums_are_integers_in_milli_war(self):
        # stored x1000 so shard merges stay exact integer addition
        row = mkrow(1, 1, slots=[1.234, 0.5, 0, 0, 0, 0, 0, 0])
        s = sc.summarize_outcomes([self.row(1, [row])], 0, 1)["counts"]
        self.assertEqual(s["champ_qb1_war_sum"], 1234)
        self.assertEqual(s["champ_qb2_war_sum"], 500)
        self.assertEqual(s["champ_slot_n"], 1)

    def test_the_three_tiers_are_counted_separately(self):
        # 4 starter-grade RBs, of whom 1 was elite, and 2 are career franchise
        row = mkrow(1, 1, srb=4, erb=1, frb=2)
        s = sc.summarize_outcomes([self.row(1, [row])], 0, 1)["counts"]
        self.assertEqual(s[f"rb_start{sc.ELITE_CAP}_rosters"], 1)   # 4 capped to 3
        self.assertEqual(s["rb_elite1_rosters"], 1)
        self.assertEqual(s["rb_fran2_rosters"], 1)

    def test_counts_are_capped_so_thin_buckets_dont_fragment(self):
        s = sc.summarize_outcomes([self.row(1, [mkrow(1, 1, eqb=7)])], 0, 1)["counts"]
        self.assertEqual(s[f"qb_elite{sc.ELITE_CAP}_rosters"], 1)

    def test_every_roster_lands_in_exactly_one_bucket_per_position_and_tier(self):
        rows = [self.row(1, [mkrow(1, 1, eqb=0), mkrow(2, 2, eqb=1),
                             mkrow(3, 3, eqb=5)])]
        s = sc.summarize_outcomes(rows, 0, 1)["counts"]
        for tier in ("start", "elite", "fran"):
            total = sum(v for k, v in s.items()
                        if k.startswith(f"qb_{tier}") and k.endswith("_rosters"))
            self.assertEqual(total, 3, tier)

    def test_a_season_with_no_champion_contributes_no_champ_counts(self):
        s = sc.summarize_outcomes([self.row(None, [mkrow(1, 1)])], 0, 1)["counts"]
        self.assertEqual(s.get("champs", 0), 0)
        self.assertEqual(s.get("champ_roster_n", 0), 0)


class TurnaroundTest(unittest.TestCase):
    """Bottom-third finishes, and how long they take to come back."""

    def league(self, lid, per_season):
        """per_season: {season: {rid: place}} -> outcome rows.

        Each season gets a DIFFERENT `lid`, as Sleeper does — a league_id is one
        season — while sharing one `chain`. Fixtures that reused a single lid
        hid the grouping bug that made every real turnaround invisible.
        """
        out = []
        for season, places in per_season.items():
            rs = [mkrow(rid, pl) for rid, pl in places.items()]
            champ = next((rid for rid, pl in places.items() if pl == 1), None)
            out.append({"lid": f"{lid}-{season}", "chain": lid, "season": season,
                        "teams": len(rs), "champ": champ, "runner": None,
                        "rosters": rs})
        return out

    def test_seasons_are_grouped_by_chain_not_league_id(self):
        rows = self.league("L", {
            2023: {r: (12 if r == 5 else r if r < 5 else r - 1) for r in range(1, 13)},
            2024: {r: (1 if r == 5 else r + 1 if r < 5 else r) for r in range(1, 13)},
        })
        self.assertEqual(len({r["lid"] for r in rows}), 2)   # distinct per season
        self.assertEqual(len({r["chain"] for r in rows}), 1)
        self.assertEqual(sc.summarize_outcomes(rows, 0, 1)["counts"]["last_to_first"], 1)

    def test_rows_without_a_chain_fall_back_to_lid(self):
        # corpus written before `chain` existed must still summarize
        rows = self.league("L", {2023: {1: 1, 2: 2}, 2024: {1: 2, 2: 1}})
        for r in rows:
            r["lid"] = "same"
            del r["chain"]
        # 2 rosters across 1 season transition = 2 moves
        self.assertEqual(sc.summarize_outcomes(rows, 0, 1)["counts"]["move_n"], 2)

    def twelve(self, season, worst_rid, worst_place=12):
        places = {}
        nxt = 1
        for rid in range(1, 13):
            if rid == worst_rid:
                continue
            places[rid] = nxt if nxt != worst_place else nxt + 1
            nxt = places[rid] + 1
        places[worst_rid] = worst_place
        return {season: places}

    def test_last_to_first_in_one_year_is_counted(self):
        rows = self.league("L", {
            2023: {r: (12 if r == 5 else r if r < 5 else r - 1) for r in range(1, 13)},
            2024: {r: (1 if r == 5 else r + 1 if r < 5 else r) for r in range(1, 13)},
        })
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertGreaterEqual(c["bottom_finishes"], 1)
        self.assertEqual(c["last_to_first"], 1)
        self.assertEqual(c["bottom_to_title"], 1)
        self.assertEqual(c["bottom_to_title_years"], 1)

    def test_a_finish_with_no_future_seasons_cannot_be_a_failure(self):
        """The newest season of a league has nowhere to recover TO. Counting
        those in the denominator reported 6% on real data when the honest
        answer was 'unknown for 136 of 348'."""
        rows = self.league("L", {2025: {r: r for r in range(1, 13)}})
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertEqual(c["bottom_finishes"], c["bottom_no_room"])
        self.assertEqual(c.get("room_1", 0), 0)      # nothing enters any denominator

    def test_room_denominators_only_count_finishes_that_had_the_years(self):
        # 3 seasons: 2023 finishes have 2 years of room, 2024 have 1, 2025 none
        rows = self.league("L", {y: {r: r for r in range(1, 13)}
                                 for y in (2023, 2024, 2025)})
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        bottom = 4                                    # places 9-12 of 12
        self.assertEqual(c["room_1"], bottom * 2)     # 2023 and 2024 finishes
        self.assertEqual(c["room_2"], bottom * 1)     # only 2023 has 2 ahead
        self.assertEqual(c.get("room_3", 0), 0)
        self.assertEqual(c["bottom_no_room"], bottom)

    def test_within_k_is_cumulative(self):
        # roster 12 finishes last in 2021, wins in 2023 — 2 years later
        def yr(p12):
            places, slot = {12: p12}, 1
            for r in range(1, 12):
                while slot == p12:
                    slot += 1
                places[r] = slot
                slot += 1
            return places
        rows = self.league("L", {2021: yr(12), 2022: yr(6), 2023: yr(1),
                                 2024: yr(6), 2025: yr(6)})
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertEqual(c.get("to_title_within_1", 0), 0)
        self.assertEqual(c["to_title_within_2"], 1)
        self.assertEqual(c["to_title_within_3"], 1)   # stays counted, not re-counted
        self.assertEqual(c["to_title_within_4"], 1)

    def test_a_bottom_team_that_never_recovers_is_censored_not_zero(self):
        rows = self.league("L", {
            2023: {r: r for r in range(1, 13)},
            2024: {r: r for r in range(1, 13)},
        })
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertEqual(c.get("bottom_to_title", 0), 0)
        self.assertEqual(c.get("bottom_to_title_years", 0), 0)
        # censored now means "had the chance and didn't take it" — the final
        # season's finishes had no chance at all and sit in bottom_no_room
        self.assertEqual(c["bottom_to_title_censored"] + c["bottom_no_room"],
                         c["bottom_finishes"])
        self.assertEqual(c["bottom_to_title_censored"], c["room_1"])

    def test_horizon_is_respected(self):
        # roster 12 finishes last ONCE (2020), sits mid-table for five seasons,
        # then wins in 2026 — six years later, outside TURN_HORIZON. Keeping it
        # out of the bottom in between matters: a second bottom finish would
        # start a fresh, shorter clock and the title would land inside it.
        def year(place12):
            others = [r for r in range(1, 13) if r != 12]
            places, slot = {12: place12}, 1
            for r in others:
                while slot == place12:
                    slot += 1
                places[r] = slot
                slot += 1
            return places
        seasons = {2020: year(12)}
        for y in range(2021, 2026):
            seasons[y] = year(6)
        seasons[2026] = year(1)
        c = sc.summarize_outcomes(self.league("L", seasons), 0, 1)["counts"]
        self.assertEqual(c.get("bottom_to_title", 0), 0)
        self.assertGreaterEqual(c["bottom_to_title_censored"], 1)

    def test_one_year_moves_are_measured_both_ways(self):
        rows = self.league("L", {
            2023: {1: 1, 2: 2, 3: 3, 4: 4},
            2024: {1: 4, 2: 2, 3: 3, 4: 1},
        })
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertEqual(c["move_n"], 4)
        self.assertEqual(c["move_abs_sum"], 6)   # 3 down + 0 + 0 + 3 up
        self.assertEqual(c["move_up_sum"], 3)    # only the gain counts here

    # Big Dog Dynasty 2022-2026, oldest first. Real Sleeper ids, so the
    # hashing below is the hashing production does.
    CHAIN = ["814608002207334400", "916360462835634176", "1048300464669937664",
             "1180090288907112448", "1312221243742621696"]

    def chain_rows(self):
        """What the crawler writes for one franchise: a row per season, each
        under THAT season's league_id, every one of them tagged with the
        founding id. Roster 5 finishes 12th and then wins."""
        places = {2024: {r: (12 if r == 5 else r if r < 5 else r - 1)
                         for r in range(1, 13)},
                  2025: {r: (1 if r == 5 else r + 1 if r < 5 else r)
                         for r in range(1, 13)}}
        lids = {2024: self.CHAIN[2], 2025: self.CHAIN[3]}
        return [{"lid": lids[season], "chain": self.CHAIN[0], "season": season,
                 "teams": 12, "runner": None,
                 "champ": next(r for r, p in pl.items() if p == 1),
                 "rosters": [mkrow(rid, p) for rid, p in pl.items()]}
                for season, pl in places.items()]

    def test_a_league_never_splits_across_shards(self):
        """The turnaround sums are only correct because every season of a
        franchise is summarized together — and that is NOT free. A Sleeper
        league_id is one season, and the ids of one chain are unrelated
        numbers. The crawler shards on the ENTRY league_id, walks back to the
        founding one, and tags every row it emits with that founding id, so
        the whole chain is crawled once by one shard and lands in one file.
        (The walk itself needs the network; what is exercised here is the
        grouping key it produces.)
        """
        rows = self.chain_rows()
        self.assertEqual({r["chain"] for r in rows}, {self.CHAIN[0]})
        self.assertEqual(len({r["lid"] for r in rows}), len(rows))
        entry = self.CHAIN[-1]
        c = sc.summarize_outcomes(rows, sc.shard_of(entry, 4), 4)["counts"]
        self.assertEqual(c["last_to_first"], 1)

    def test_the_seasons_of_a_chain_do_not_share_a_shard_by_luck(self):
        """Sharding on each season's own id instead would scatter this
        franchise across three of the four shard files."""
        self.assertGreater(len({sc.shard_of(lid, 4) for lid in self.CHAIN}), 1)

    def test_a_chain_split_across_shards_loses_the_sequence(self):
        """The failure the design prevents: with the seasons in separate files
        nothing ever sees the transition — which is how the first trial
        reported zero turnarounds in a league that had a 12th-to-1st."""
        split = [sc.summarize_outcomes([r], i, 4)["counts"]
                 for i, r in enumerate(self.chain_rows())]
        self.assertEqual(sum(s.get("last_to_first", 0) for s in split), 0)
        self.assertEqual(sum(s.get("move_n", 0) for s in split), 0)


def signals_doc(leagues):
    return {"generated": "2026-08-09", "season": "2026", "leagues": leagues, "players": {}}


def shard_doc(league_seasons):
    counts = {"league_seasons": league_seasons} if league_seasons else {}
    return {"generated": "2026-08-10", "shard": 0, "nshards": 4, "counts": counts}


class CrawlGuardTest(unittest.TestCase):
    """A cold Actions cache writes a healthy-looking file with a tenth of the data."""

    def test_the_august_cold_cache_is_refused(self):
        # the real numbers: first mid-run push, end of that run, outcome shard 0
        for new, old in ((signals_doc(1000), signals_doc(78019)),
                         (signals_doc(7257), signals_doc(78019)),
                         (shard_doc(4625), shard_doc(42306))):
            self.assertFalse(crawl_guard.verdict(new, old)[0])

    def test_ordinary_movement_is_allowed(self):
        self.assertTrue(crawl_guard.verdict(signals_doc(78019), signals_doc(78453))[0])
        self.assertTrue(crawl_guard.verdict(signals_doc(90000), signals_doc(78019))[0])

    def test_the_floor_itself_passes_and_one_below_does_not(self):
        self.assertTrue(crawl_guard.verdict(signals_doc(800), signals_doc(1000))[0])
        self.assertFalse(crawl_guard.verdict(signals_doc(799), signals_doc(1000))[0])

    def test_a_shard_with_no_rows_yet_counts_as_zero_not_unknown(self):
        # the counters are a defaultdict: a coldest-possible shard has no key at all
        self.assertEqual(crawl_guard.sample_size(shard_doc(0)), 0)
        self.assertFalse(crawl_guard.verdict(shard_doc(0), shard_doc(42306))[0])

    def test_first_publish_has_nothing_to_protect(self):
        self.assertTrue(crawl_guard.verdict(signals_doc(10), None)[0])
        self.assertTrue(crawl_guard.verdict(signals_doc(10), signals_doc(0))[0])
        self.assertTrue(crawl_guard.verdict(signals_doc(10), {"old": "shape"})[0])

    def test_an_unreadable_new_file_waits(self):
        for bad in (None, [], {"old": "shape"}, {"leagues": ["1", "2"]}):
            self.assertFalse(crawl_guard.verdict(bad, signals_doc(10))[0], bad)

    def test_the_real_summarizer_output_is_what_gets_counted(self):
        row = {"lid": "x", "season": 2025, "teams": 1, "champ": 1, "runner": None,
               "rosters": [mkrow(1, 1)], "playoff_teams": 1}
        doc = sc.summarize_outcomes([row], 0, 1)
        self.assertEqual(crawl_guard.sample_size(doc), 1)
        self.assertEqual(crawl_guard.sample_size(sc.summarize_outcomes([], 0, 1)), 0)


class GitRepoCase(unittest.TestCase):
    """A real throwaway repo, so the comparison runs against an actual git ref."""

    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.git("init", "-q")
        self.git("config", "user.name", "t")
        self.git("config", "user.email", "t@example.invalid")
        (self.repo / "data").mkdir()

    def git(self, *a):
        return subprocess.run(["git", *a], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout

    def write(self, path, doc):
        (self.repo / path).write_text(json.dumps(doc), encoding="utf-8")

    def commit(self, path, doc):
        self.write(path, doc)
        self.git("add", path)
        self.git("commit", "-qm", "x")


class CrawlGuardAgainstGitTest(GitRepoCase):
    def quiet_allow(self, *a, **k):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ok = crawl_guard.allow(*a, ref="HEAD", cwd=self.repo, **k)
        return ok, out.getvalue()

    def test_a_refusal_warns_and_a_pass_does_not(self):
        self.commit("data/s.json", signals_doc(78019))
        self.write("data/s.json", signals_doc(1000))
        ok, out = self.quiet_allow("data/s.json")
        self.assertFalse(ok)
        self.assertIn("::warning", out)
        self.write("data/s.json", signals_doc(78000))
        ok, out = self.quiet_allow("data/s.json")
        self.assertTrue(ok)
        self.assertNotIn("::warning", out)

    def test_a_file_aside_is_compared_under_its_committed_path(self):
        self.commit("data/s.json", shard_doc(42306))
        aside = self.repo / "saved.json"
        aside.write_text(json.dumps(shard_doc(4625)), encoding="utf-8")
        self.assertFalse(self.quiet_allow("data/s.json", file=aside)[0])

    def test_a_path_not_at_origin_passes(self):
        self.write("data/new.json", signals_doc(5))
        self.assertTrue(self.quiet_allow("data/new.json")[0])

    def test_truncated_json_is_refused(self):
        self.commit("data/s.json", signals_doc(10))
        (self.repo / "data/s.json").write_text('{"leagues": 1', encoding="utf-8")
        self.assertFalse(self.quiet_allow("data/s.json")[0])


class GitPushGuardTest(GitRepoCase):
    """--commit-every is what really published the cold cache on 2026-08-09."""

    def push(self, paths, guarded):
        """git_push against a bare origin. Everything goes to temp: ROOT is patched."""
        bare = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, bare, ignore_errors=True)
        subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
        self.git("remote", "add", "origin", str(bare))
        self.git("push", "-q", "origin", "HEAD:refs/heads/main")
        with mock.patch.object(sc, "ROOT", self.repo), \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            sc.git_push(paths, "partial", guarded=guarded)
        return subprocess.run(["git", "--git-dir", str(bare), "show", "main:data/s.json"],
                              check=True, capture_output=True, text=True).stdout, bare

    def setUp(self):
        super().setUp()
        self.commit("data/s.json", signals_doc(78019))
        self.commit("data/l.json", {"count": 1, "leagues": ["1"]})
        self.write("data/s.json", signals_doc(1000))
        self.write("data/l.json", {"count": 2, "leagues": ["1", "2"]})

    def test_a_cold_signals_file_stays_home_while_the_league_list_still_goes(self):
        pushed, bare = self.push(["data/s.json", "data/l.json"], ("data/s.json",))
        self.assertEqual(json.loads(pushed)["leagues"], 78019)
        leagues = subprocess.run(["git", "--git-dir", str(bare), "show", "main:data/l.json"],
                                 check=True, capture_output=True, text=True).stdout
        self.assertEqual(json.loads(leagues)["count"], 2)

    def test_an_unguarded_path_is_unaffected(self):
        pushed, _ = self.push(["data/s.json"], ())
        self.assertEqual(json.loads(pushed)["leagues"], 1000)


class RecoverStartAccTest(unittest.TestCase):
    PLAYERS = {"a": {"start_rate": 0.25, "start_obs": 400},
               "b": {"start_rate": 0.0, "start_obs": 0}}

    def test_both_halves_of_the_fraction_come_back(self):
        acc = sc.recover_start_acc({"season": "2026", "players": self.PLAYERS}, "2026")
        self.assertEqual(acc, {"a": [100, 400]})     # no observations, nothing to recover

    def test_another_season_is_not_recovered(self):
        self.assertEqual(
            sc.recover_start_acc({"season": "2025", "players": self.PLAYERS}, "2026"), {})

    def test_no_committed_file(self):
        self.assertEqual(sc.recover_start_acc({}, "2026"), {})
        self.assertEqual(sc.recover_start_acc(None, "2026"), {})


class Clock:
    """time.time() that the fake Sleeper advances; sleep never really sleeps."""

    def __init__(self, now):
        self.now = now

    def time(self):
        return self.now

    def sleep(self, _s):
        pass


class SignalsDeadlineTest(unittest.TestCase):
    """The deadline, offline: `get` is a stub and every path is a temp dir."""

    OWNERS = ["u1", "u2", "u3"]

    def run_signals(self, get, clock, max_minutes=10, frontier=None):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        state = tmp / "state"
        state.mkdir()
        (tmp / "data").mkdir()
        (state / "frontier.json").write_text(json.dumps(frontier or ["L1"]), encoding="utf-8")
        args = argparse.Namespace(
            state=str(state), league_type="dynasty", seeds=[], season="2026",
            season_type="pre", week=0, cooldown_days=7.0, max_leagues=1000000,
            max_minutes=max_minutes, teams=12, any_qb=False, commit_every=0,
            log_every=1e9, signals_out="data/league_signals.json",
            leagues_out="data/crawl_leagues.json")
        out = io.StringIO()
        with mock.patch.object(sc, "ROOT", tmp), mock.patch.object(sc, "get", get), \
                mock.patch.object(sc, "time", clock), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            sc.mode_signals(args, clock.now)
        return tmp, state, out.getvalue()

    def sleeper(self, clock, slow_user=None, seconds=0):
        league = {"settings": {"type": 2}, "total_rosters": 12,
                  "roster_positions": ["SUPER_FLEX"], "last_message_time": 0}
        rosters = [{"owner_id": u, "players": ["p"], "starters": ["p"]} for u in self.OWNERS]
        def get(path):
            if path.startswith("/user/"):
                if slow_user and path.startswith(f"/user/{slow_user}/"):
                    clock.now += seconds
                return []
            return rosters if path.endswith("/rosters") else league
        return get

    def test_a_league_that_sleeps_past_the_deadline_stops_inside_the_owner_loop(self):
        clock = Clock(1_000_000.0)
        seen = []
        inner = self.sleeper(clock, slow_user="u1", seconds=3600)
        def get(path):
            seen.append(path)
            return inner(path)
        tmp, state, out = self.run_signals(get, clock)
        # u1 ate the budget, so u2 and u3 were never asked
        self.assertEqual([p for p in seen if p.startswith("/user/")],
                         ["/user/u1/leagues/nfl/2026"])
        # spending the budget is how most runs end: reported, not annotated
        self.assertNotIn("::warning", out)
        self.assertIn("inside league L1", out)
        # ...and the existing flush path still ran
        self.assertTrue((tmp / "data" / "league_signals.json").exists())
        self.assertTrue((state / "registry.json").exists())

    def test_the_interrupted_league_is_put_back_not_marked_visited(self):
        clock = Clock(1_000_000.0)
        _, state, _ = self.run_signals(self.sleeper(clock, "u1", 3600), clock)
        self.assertNotIn("L1", json.loads((state / "registry.json").read_text("utf-8")))
        self.assertEqual(json.loads((state / "frontier.json").read_text("utf-8"))[0], "L1")
        self.assertEqual(json.loads((state / "snapshots.json").read_text("utf-8")), {})

    def test_a_rate_limit_stop_warns(self):
        clock = Clock(1_000_000.0)
        def get(path):
            raise RuntimeError("rate-limited 10x, giving up")
        _, state, out = self.run_signals(get, clock)
        self.assertIn("::warning", out)
        self.assertIn("rate-limited", out)
        self.assertIn("L1", json.loads((state / "frontier.json").read_text("utf-8")))

    def test_running_out_of_budget_between_leagues_reports_without_annotating(self):
        clock = Clock(1_000_000.0)
        def get(path):
            clock.now += 3600
            return None                  # not on-type: just moves to the next league
        _, _, out = self.run_signals(get, clock, frontier=["L1", "L2"])
        self.assertNotIn("::warning", out)
        self.assertIn("--max-minutes 10", out)

    def test_an_exhausted_frontier_is_not_an_early_stop(self):
        clock = Clock(1_000_000.0)
        _, state, out = self.run_signals(self.sleeper(clock), clock)
        self.assertNotIn("::warning", out)
        self.assertIn("L1", json.loads((state / "snapshots.json").read_text("utf-8")))


class DraftContribTest(unittest.TestCase):
    def test_a_revisit_with_no_new_draft_keeps_the_picks(self):
        prev = {"ts": 1.0, "startup": {"a": [5]}, "rookie": {"b": [2]}}
        got = sc.merged_contrib(prev, {}, {}, 9.0)
        self.assertEqual(got, {"ts": 9.0, "startup": {"a": [5]}, "rookie": {"b": [2]}})

    def test_a_new_draft_adds_to_what_was_there(self):
        prev = {"ts": 1.0, "startup": {"a": [5]}, "rookie": {}}
        got = sc.merged_contrib(prev, {"a": [7], "c": [1]}, {"b": [2]}, 9.0)
        self.assertEqual(got["startup"], {"a": [5, 7], "c": [1]})
        self.assertEqual(got["rookie"], {"b": [2]})

    def test_a_first_visit(self):
        self.assertEqual(sc.merged_contrib(None, {"a": [1]}, {}, 9.0),
                         {"ts": 9.0, "startup": {"a": [1]}, "rookie": {}})

    def test_a_league_just_due_for_its_revisit_is_still_there_to_keep(self):
        day = 86400
        now = 100 * day
        contrib = {"due": {"ts": now - 8 * day}, "gone": {"ts": now - 15 * day}}
        self.assertEqual(sorted(sc.live_contrib(contrib, now, 7.0)), ["due"])


class DraftWalkTest(unittest.TestCase):
    """mode_drafts offline: a stub `get` and temp paths only."""

    DRAFT = {"draft_id": "D1", "status": "complete", "season": "2026",
             "settings": {"rounds": 4}}
    PICK = {"player_id": "p1", "pick_no": 3}

    def run_drafts(self, get, tmp=None, clock=None):
        clock = clock or Clock(1_000_000.0)
        tmp = tmp or Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        state = tmp / "state"
        state.mkdir(exist_ok=True)
        (tmp / "data").mkdir(exist_ok=True)
        (tmp / "data" / "crawl_leagues.json").write_text(
            json.dumps({"leagues": ["L1"]}), encoding="utf-8")
        args = argparse.Namespace(
            state=str(state), season="2026", cooldown_days=7.0, max_minutes=0,
            commit_every=0, log_every=1e9, leagues_out="data/crawl_leagues.json",
            drafts_out="data/draft_signals.json", rookie_out="data/rookie.json",
            draft_index_out="data/draft_index.json")
        pmeta = {"p1": {"exp": 0, "name": "P", "pos": "WR"}}
        with mock.patch.object(sc, "ROOT", tmp), mock.patch.object(sc, "get", get), \
                mock.patch.object(sc, "time", clock), \
                mock.patch.object(sc, "load_player_meta", lambda _sd: pmeta), \
                contextlib.redirect_stderr(io.StringIO()):
            sc.mode_drafts(args, clock.now)
        read = lambda name: json.loads((state / name).read_text(encoding="utf-8"))
        return tmp, read

    def sleeper(self, picks):
        def get(path):
            if path == "/league/L1":
                return {"season": "2026", "previous_league_id": None}
            if path == "/league/L1/drafts":
                return [self.DRAFT]
            if path == "/draft/D1/picks":
                return picks()
            raise AssertionError(path)
        return get

    def test_a_read_draft_is_marked_seen_and_counted(self):
        _, read = self.run_drafts(self.sleeper(lambda: [self.PICK]))
        self.assertIn("D1", read("seen_drafts.json"))
        self.assertEqual(read("rookie_corpus.json"), {"2026|3|p1": 1})

    def test_a_failed_fetch_leaves_the_draft_to_be_read_next_time(self):
        def boom():
            raise OSError("connection reset")
        _, read = self.run_drafts(self.sleeper(boom))
        self.assertNotIn("D1", read("seen_drafts.json"))
        self.assertEqual(read("seen_leagues.json"), [])

    def test_a_404_leaves_the_chain_unwalked_so_the_draft_stays_reachable(self):
        _, read = self.run_drafts(self.sleeper(lambda: None))
        self.assertNotIn("D1", read("seen_drafts.json"))
        self.assertEqual(read("seen_leagues.json"), [])

    def test_the_second_visit_keeps_the_first_visits_adp(self):
        clock = Clock(1_000_000.0)
        tmp, _ = self.run_drafts(self.sleeper(lambda: [self.PICK]), clock=clock)
        clock.now += 8 * 86400                 # due again: one cooldown has passed
        tmp, read = self.run_drafts(self.sleeper(lambda: [self.PICK]), tmp, clock)
        self.assertEqual(read("progress.json")["L1"], clock.now)
        self.assertEqual(read("contrib.json")["L1"]["rookie"], {"p1": [3]})
        self.assertEqual(read("rookie_corpus.json"), {"2026|3|p1": 1})   # and no double count


class MergeShardCountTest(unittest.TestCase):
    def test_a_missing_shard_warns(self):
        self.assertIn("::warning", merge_trade_corpus.shard_warning(3))
        self.assertIn("3 of 4", merge_trade_corpus.shard_warning(3))

    def test_a_full_set_is_silent(self):
        self.assertIsNone(merge_trade_corpus.shard_warning(4))


if __name__ == "__main__":
    unittest.main()
