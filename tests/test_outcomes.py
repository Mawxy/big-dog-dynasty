"""Locks the outcomes crawl's pure logic against Big Dog's own 2024 season.

These are the three functions that decide what every benchmark means, so a
change here is a change in what "champion", "held a first" and "homegrown"
report — not a broken build. The fixtures are the real Sleeper payloads the
crawler would fetch, so a Sleeper shape change fails here first.
"""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "sleeper_data" / "2024"

_spec = importlib.util.spec_from_file_location(
    "sleeper_crawl", ROOT / "scripts" / "sleeper_crawl.py")
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)


def load(name):
    return json.loads((RAW / f"{name}.json").read_text(encoding="utf-8"))


@unittest.skipUnless(RAW.exists(), "sleeper_data/2024 not present (gitignored)")
class ChampionTest(unittest.TestCase):
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
        rank = sorted(st, key=lambda i: (-(st[i].get("wins") or 0),
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
          hg=5, n=20, qb=3, rb=6, wr=8, te=3, exp_sum=60, exp_n=20):
    return [rid, w, l, fpts, *picks, kept, hg, n, place, qb, rb, wr, te,
            exp_sum, exp_n]


class SummarizeTest(unittest.TestCase):
    """Counts must be additive so the four shards merge by summing."""

    def row(self, champ, rosters, lid="x", season=2025):
        return {"lid": lid, "season": season, "teams": len(rosters),
                "champ": champ, "runner": None, "rosters": rosters}

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
        # champion: 5 of 20 homegrown; field: 20 of 40 across both rosters
        self.assertEqual((s["champ_homegrown_sum"], s["champ_roster_sum"]), (5, 20))
        self.assertEqual((s["field_homegrown_sum"], s["field_roster_sum"]), (20, 40))
        self.assertEqual(s["champ_roster_n"], 1)
        self.assertEqual(s["field_roster_n"], 2)
        self.assertEqual(s["champ_rb_sum"], 6)
        self.assertEqual(s["field_rb_sum"], 12)

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
        # corpus written before `chain` existed must still summarise
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

    def test_a_bottom_team_that_never_recovers_is_censored_not_zero(self):
        rows = self.league("L", {
            2023: {r: r for r in range(1, 13)},
            2024: {r: r for r in range(1, 13)},
        })
        c = sc.summarize_outcomes(rows, 0, 1)["counts"]
        self.assertEqual(c.get("bottom_to_title", 0), 0)
        self.assertEqual(c["bottom_to_title_censored"], c["bottom_finishes"])
        self.assertEqual(c.get("bottom_to_title_years", 0), 0)

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

    def test_a_league_never_splits_across_shards(self):
        # shard_of keys on league_id, so every season of a league is together —
        # the turnaround sums are only correct because of that.
        lid = "1048300464669937664"
        self.assertEqual(len({sc.shard_of(lid, 4) for _ in range(3)}), 1)


if __name__ == "__main__":
    unittest.main()
