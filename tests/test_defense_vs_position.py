#!/usr/bin/env python3
"""
Invariants of the defense-vs-position matchup table (scripts/defense_vs_position.py).

What is locked down: a player's expectation never includes the game being
judged; a debut with no history counts toward points allowed but not toward
points over expectation; everything is per game played, not per week; the
shrinkage weight follows n / (n + K) toward a regressed prior; and rank 1 is
the softest defense.

  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import defense_vs_position as M                                              # noqa: E402


def row(gsis, pos, opp, week, pts, team="AAA"):
    return {"gsis": gsis, "pos": pos, "team": team, "opp": opp, "week": week, "pts": pts}


class TestExpected(unittest.TestCase):
    def test_leave_one_out(self):
        rs = M.add_expected([row("a", "WR", "X", 1, 10), row("a", "WR", "Y", 2, 20),
                             row("a", "WR", "Z", 3, 30)])
        self.assertEqual([r["exp"] for r in rs], [25.0, 20.0, 15.0])

    def test_prior_shrinks_by_k_player(self):
        rs = M.add_expected([row("a", "WR", "X", 1, 10), row("a", "WR", "Y", 2, 20)],
                            prior={"a": 14.0}, k_player=3)
        # week 1: (20 + 3*14) / (1 + 3)
        self.assertAlmostEqual(rs[0]["exp"], 15.5)

    def test_debut_has_no_expectation(self):
        rs = M.add_expected([row("rookie", "RB", "X", 1, 22)])
        self.assertIsNone(rs[0]["exp"])


class TestDefenseTable(unittest.TestCase):
    def test_per_game_and_debut_handling(self):
        rs = M.add_expected([
            row("a", "WR", "DEF", 1, 20), row("a", "WR", "OTH", 2, 10),
            row("rookie", "WR", "DEF", 2, 8),
        ])
        t = M.defense_table(rs)["DEF"]["WR"]
        self.assertEqual(t["games"], 2)
        self.assertAlmostEqual(t["pa"], (20 + 8) / 2)    # the debut counts toward PA
        self.assertAlmostEqual(t["poe"], (20 - 10) / 2)  # but not toward POE

    def test_every_position_present(self):
        t = M.defense_table(M.add_expected([row("a", "QB", "D", 1, 20)]))
        self.assertEqual(set(t["D"]), set(M.POSITIONS))


class TestBlend(unittest.TestCase):
    def test_no_games_is_the_regressed_prior(self):
        self.assertAlmostEqual(M.blend(None, {"poe": 4.0}, k=20, b=0.25), 1.0)

    def test_weight_is_n_over_n_plus_k(self):
        est = M.blend({"poe": 6.0, "games": 5}, {"poe": 4.0}, k=20, b=0.25)
        self.assertAlmostEqual(est, 1.0 + (5 / 25) * (6.0 - 1.0))

    def test_no_history_shrinks_to_zero(self):
        self.assertAlmostEqual(M.blend({"poe": 10.0, "games": 10}, None, k=10, b=0.3), 5.0)


class TestBuild(unittest.TestCase):
    def test_rank_one_is_softest(self):
        self.assertEqual(M.rank({"a": -1.0, "b": 3.0, "c": 0.5}), {"b": 1, "c": 2, "a": 3})

    def test_document_shape(self):
        cur = M.add_expected([row("a", "TE", f"D{i}", i, 10 + i) for i in range(1, 4)])
        doc = M.build(cur, [], 2026)
        self.assertEqual(doc["through_week"], 3)
        self.assertEqual(set(doc["defenses"]["D1"]), set(M.POSITIONS))
        self.assertEqual(set(doc["defenses"]["D1"]["TE"]), {"est", "rank", "poe", "pa", "games"})

    def test_validate_wants_all_32(self):
        doc = M.build(M.add_expected([row("a", "QB", "D", 1, 20)]), [], 2026)
        with self.assertRaises(ValueError):
            M.validate(doc)

    def test_constants_cover_every_position(self):
        for p in M.POSITIONS:
            self.assertGreater(M.K[p], 0)
            self.assertLess(abs(M.B_YOY[p]), 1)



class TestUnattendedGuards(unittest.TestCase):
    """The two checks that make the weekly workflow safe to run unwatched."""

    GAMES = {"1": {"AAA": ["BBB", 1, 20, 17, "t"], "BBB": ["AAA", 0, 17, 20, "t"]},
             "2": {"AAA": ["BBB", 0, 24, 10, "t"], "BBB": ["AAA", 1, 10, 24, "t"]}}

    def rows(self, wk2_teams=("AAA", "BBB")):
        r = [row("p1", "WR", "BBB", 1, 10.0), row("p2", "WR", "AAA", 1, 8.0, team="BBB")]
        r += [row(f"q{t}", "WR", "AAA" if t == "BBB" else "BBB", 2, 9.0, team=t)
              for t in wk2_teams]
        return r

    def test_a_fully_posted_week_is_kept(self):
        self.assertEqual({r["week"] for r in M.complete_rows(self.rows(), self.GAMES)}, {1, 2})

    def test_a_club_missing_from_the_stat_feed_drops_its_week(self):
        """THE MONDAY-NIGHT CASE: nflverse has 30 of 32 clubs."""
        out = M.complete_rows(self.rows(wk2_teams=("AAA",)), self.GAMES)
        self.assertEqual({r["week"] for r in out}, {1})

    def test_a_game_without_a_final_score_drops_its_week(self):
        g = json.loads(json.dumps(self.GAMES))
        g["2"]["AAA"][2] = None
        self.assertEqual({r["week"] for r in M.complete_rows(self.rows(), g)}, {1})

    def test_no_games_file_trims_nothing(self):
        self.assertEqual(len(M.complete_rows(self.rows(), {})), len(self.rows()))

    def test_a_prior_only_grid_never_replaces_a_real_one(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dvp.json"
            p.write_text(json.dumps({"season": 2026, "through_week": 4}))
            self.assertTrue(M.regresses(p, {"season": 2026, "through_week": 0}))
            self.assertFalse(M.regresses(p, {"season": 2026, "through_week": 5}))
            self.assertFalse(M.regresses(p, {"season": 2027, "through_week": 0}))
            self.assertFalse(M.regresses(Path(d) / "absent.json",
                                         {"season": 2026, "through_week": 0}))

if __name__ == "__main__":
    unittest.main()
