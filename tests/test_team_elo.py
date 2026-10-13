#!/usr/bin/env python3
"""
Invariants of the all-play team Elo (scripts/team_elo.py).

Locks the rules Max settled on 2026-10-12 (METHODOLOGY.md, "Team Elo"):

  1. K = 1.5 x (40 + 40 / week), resetting every season
  2. one update per team per WEEK, scaled to the week, not to each comparison
  3. every week is zero-sum across the league
  4. ratings carry across seasons untouched
  5. ties in all-play count half

Pure stdlib and synthetic data; runs in CI.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import team_elo as te                                       # noqa: E402


def week(scores):
    """{fkey: points} for twelve teams named 1..12, scores in fkey order."""
    return {str(i + 1): float(p) for i, p in enumerate(scores)}


LADDER = week(range(100, 220, 10))      # team 12 tops, team 1 bottoms


class KSchedule(unittest.TestCase):
    def test_curve(self):
        self.assertAlmostEqual(te.k_for(1), 120)
        self.assertAlmostEqual(te.k_for(2), 90)
        self.assertAlmostEqual(te.k_for(4), 75)
        self.assertAlmostEqual(te.k_for(14), 1.5 * (40 + 40 / 14))


class WeeklyUpdate(unittest.TestCase):
    def test_perfect_opening_week_from_even_ratings(self):
        # all at 1500: expected 5.5 of 11, so 11-0 is +K/2 and 0-11 is -K/2
        r, h = te.run([("2022", {1: LADDER})])
        self.assertAlmostEqual(r["12"], 1560)
        self.assertAlmostEqual(r["1"], 1440)
        self.assertEqual(h["12"]["2022"][0][3], 11.0)

    def test_zero_sum_every_week(self):
        weeks = {w: week([(i * 37 + w * 11) % 60 + 90 for i in range(12)])
                 for w in range(1, 15)}
        r, _ = te.run([("2022", weeks)])
        self.assertAlmostEqual(sum(r.values()), 12 * te.START, places=6)

    def test_ties_count_half(self):
        r, h = te.run([("2022", {1: week([120] * 12)})])
        self.assertTrue(all(abs(v - te.START) < 1e-9 for v in r.values()))
        self.assertEqual(h["1"]["2022"][0][3], 5.5)

    def test_updates_use_ratings_from_before_the_week(self):
        # the result for a team cannot depend on dict order
        a, _ = te.run([("2022", {1: LADDER, 2: LADDER})])
        rev = {w: dict(reversed(list(v.items()))) for w, v in {1: LADDER, 2: LADDER}.items()}
        b, _ = te.run([("2022", rev)])
        for f in a:
            self.assertAlmostEqual(a[f], b[f])


class Seasons(unittest.TestCase):
    def test_carry_over_and_k_resets(self):
        r1, _ = te.run([("2022", {1: LADDER})])
        r2, h = te.run([("2022", {1: LADDER}), ("2023", {1: LADDER})])
        # 2023 week 1 starts from 2022's rating (no reset to 1500) ...
        self.assertEqual(h["12"]["2023"][0][1] - h["12"]["2023"][0][2], round(r1["12"], 1))
        # ... and runs at week-1 K again
        exp_w = sum(te.expected(r1["12"], r1[g]) for g in r1 if g != "12")
        self.assertAlmostEqual(r2["12"] - r1["12"], te.k_for(1) * (11 - exp_w) / 11)


class Files(unittest.TestCase):
    def test_playoff_weeks_and_unscored_weeks_are_dropped(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            s = Path(d)
            rows = {str(i + 1): [[1, 100.0 + i], [14, 0.0], [15, 200.0 - i]] for i in range(12)}
            # week 14 is all zeroes (not yet played); week 15 is a playoff week
            for v in rows.values():
                v[1][1] = 0.0
            (s / "matchups.json").write_text(json.dumps({"playoff_start": 15, "teams": rows}))
            (s / "teams.json").write_text(json.dumps(
                [{"roster_id": i + 1, "fkey": f"f{i + 1}"} for i in range(12)]))
            weeks = te.season_weeks(s)
            self.assertEqual(sorted(weeks), [1])
            self.assertIn("f12", weeks[1])


if __name__ == "__main__":
    unittest.main()
