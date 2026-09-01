#!/usr/bin/env python3
"""
Invariants of the analog (k-nearest-comparable) projection.

What these lock down is ONE rule, applied in three places: a season that does
not exist is not a season of zero.

feature() already encodes that — a missing season is a 0.0 in `rates` with a
false flag in `has`, and distance() skips those slots. The estimate did not
honour it. project() built the local-linear regression's x-axis from
`rates[0]` with no mask, and read the fit at the QUERY's `rates[0]` with no
mask, so a player whose most recent season does not exist was evaluated at
x = 0.0 — "did not play" priced as "produced nothing" — and cohort members with
the same gap were pulling the slope toward the origin. On the committed
2026-08 file that was 277 of 895 players, Brandon Aiyuk (no 2025 season) among
them, published at a negative year-one analog.

The third is `pairs = [(0.0, 1.0)]`: a horizon year no comparable could score
used to publish an invented 0.0 over n_scored 1, which is indistinguishable in
the file from a real cohort that genuinely returned nothing.

  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import project_war_knn as K                                        # noqa: E402


# Unit spreads, so a distance in these tests is the raw feature difference and
# the fixtures stay readable.
SCALER = {"rates": [1.0, 1.0, 1.0], "gps": [1.0, 1.0, 1.0],
          "age": 1.0, "exp": 1.0}


def member(pid, r0, fut, has0=True, yr=2020, fut_gp=K.FULL_GP):
    """One corpus row: a (player, season) with its features and its future.

    `has0=False` is the case under test — his most recent season does not
    exist, so `rates[0]` carries the phantom 0.0 feature() writes there.
    """
    return {"pos": "RB", "age": 26, "exp": 5,
            "rates": [r0 if has0 else 0.0, 1.0, 1.0],
            "gps": [1.0 if has0 else 0.0, 1.0, 1.0],
            "has": [has0, True, True],
            "future": [fut], "future_gp": [fut_gp],
            "pid": pid, "yr": yr}


def query(r0, has0=True):
    return {"pos": "RB", "age": 26, "exp": 5,
            "rates": [r0 if has0 else 0.0, 1.0, 1.0],
            "gps": [1.0 if has0 else 0.0, 1.0, 1.0],
            "has": [has0, True, True], "pid": "QUERY"}


def run(q, corpus, horizon=1, max_dist=100.0):
    return K.project(q, corpus, max_dist, horizon, SCALER)


class TestLocalLinear(unittest.TestCase):
    """The boundary-bias correction itself, before any masking question."""

    LINE = [(x / 10, x / 10, 1.0) for x in range(0, 22, 2)]   # y = x on 0..2.0

    def test_too_few_points_declines_to_fit(self):
        self.assertIsNone(K.local_linear(self.LINE[:5], 1.0))

    def test_a_degenerate_x_spread_declines_to_fit(self):
        """Every backup's cohort scored ~0, so there is no gradient to read."""
        flat = [(1.0, y / 10, 1.0) for y in range(10)]
        self.assertIsNone(K.local_linear(flat, 1.0))

    def test_it_reads_the_cohort_gradient_at_the_query(self):
        self.assertAlmostEqual(K.local_linear(self.LINE, 2.0), 2.0, places=6)
        self.assertAlmostEqual(K.local_linear(self.LINE, 0.0), 0.0, places=6)

    def test_it_never_extrapolates_past_the_cohorts_own_outcomes(self):
        hi = max(y for _, y, _ in self.LINE)
        self.assertLessEqual(K.local_linear(self.LINE, 50.0), hi)
        self.assertGreaterEqual(K.local_linear(self.LINE, -50.0), 0.0)

    def test_a_phantom_zero_on_the_axis_is_not_harmless(self):
        """Why the mask matters at all. Eight comparables whose most recent
        season does not exist enter the axis at x = 0.0 carrying real outcomes,
        and the slope the cohort 'reveals' inverts."""
        phantoms = [(0.0, 2.0, 1.0)] * 8
        clean = K.local_linear(self.LINE, 2.0)
        dirty = K.local_linear(self.LINE + phantoms, 2.0)
        self.assertGreater(clean, dirty)


class TestQueryMask(unittest.TestCase):
    """A player whose seed season does not exist must not be read at x = 0.0."""

    # a cohort with a clean positive gradient: more last year -> more next year
    CORPUS = [member(f"c{i}", i * 0.2, i * 0.2) for i in range(12)]

    def test_a_missing_seed_season_falls_back_to_the_weighted_median(self):
        r = run(query(0.0, has0=False), self.CORPUS)
        self.assertFalse(r["fitted"][0])
        self.assertEqual(r["median"][0], r["median_flat"][0])
        # and it is a real neighbourhood median, not a boundary-regressed zero
        self.assertGreater(r["median"][0], 0.5)

    def test_local_linear_is_not_consulted_at_all(self):
        seen = []
        orig = K.local_linear
        K.local_linear = lambda pts, xq: seen.append((pts, xq))
        try:
            run(query(0.0, has0=False), self.CORPUS)
        finally:
            K.local_linear = orig
        self.assertEqual(seen, [])

    def test_the_same_player_with_a_real_zero_season_does_take_the_fit(self):
        """Control. A player who DID play and produced nothing is a different
        fact, and the boundary correction is supposed to bite on him — if this
        stops passing, the fixture has stopped exercising the fitted path."""
        r = run(query(0.0, has0=True), self.CORPUS)
        self.assertTrue(r["fitted"][0])
        self.assertLess(r["median"][0], r["median_flat"][0])


class TestCohortMask(unittest.TestCase):
    """Comparables with a missing seed season must stay off the regression's
    x-axis — they still vote in the median, they just cannot be plotted at
    zero."""

    REAL = [member(f"r{i}", 1.0 + i * 0.2, 2.0 + i * 0.4) for i in range(6)]
    PHANTOM = [member(f"p{i}", 0.0, 4.0, has0=False) for i in range(8)]

    def _axis(self, corpus, q):
        got = []
        orig = K.local_linear

        def spy(pts, xq):
            got.append((list(pts), xq))
            return orig(pts, xq)
        K.local_linear = spy
        try:
            run(q, corpus)
        finally:
            K.local_linear = orig
        return got

    def test_only_comparables_with_a_real_seed_season_are_plotted(self):
        calls = self._axis(self.REAL + self.PHANTOM, query(2.0))
        self.assertEqual(len(calls), 1)
        pts, xq = calls[0]
        self.assertEqual(xq, 2.0)
        self.assertEqual(len(pts), len(self.REAL))
        self.assertTrue(all(x >= 1.0 for x, _, _ in pts),
                        "a phantom 0.0 reached the regression's x-axis")

    def test_the_phantoms_still_count_toward_the_cohort_and_its_median(self):
        """Masking is about the AXIS, not about membership. They are real
        players with real outcomes; only their unknown season is unknown."""
        r = run(query(2.0), self.REAL + self.PHANTOM)
        self.assertEqual(r["n"], len(self.REAL) + len(self.PHANTOM))
        self.assertEqual(r["n_scored"][0], len(self.REAL) + len(self.PHANTOM))


class TestUnscorableHorizon(unittest.TestCase):
    """No observation is not an observation of zero."""

    # everyone in the neighbourhood was hurt or inactive that year: skipped,
    # never zeroed (METHODOLOGY on absence)
    HURT = [member(f"h{i}", i * 0.2, None, fut_gp=0) for i in range(12)]

    def test_a_year_nobody_could_score_publishes_null(self):
        r = run(query(1.0), self.HURT)
        self.assertIsNone(r["median"][0])
        self.assertIsNone(r["median_flat"][0])
        self.assertIsNone(r["mean"][0])
        self.assertIsNone(r["p20"][0])
        self.assertIsNone(r["p80"][0])
        self.assertIsNone(r["share_useful"][0])

    def test_it_does_not_claim_a_comparable_it_did_not_have(self):
        r = run(query(1.0), self.HURT)
        self.assertEqual(r["n_scored"][0], 0)
        self.assertFalse(r["fitted"][0])

    def test_availability_is_still_reported(self):
        """`avail` is measured over the whole cohort, not over the scorable
        part — nobody played, and that is a fact worth publishing."""
        r = run(query(1.0), self.HURT)
        self.assertEqual(r["avail"][0], 0.0)

    def test_a_scorable_year_is_unaffected(self):
        good = [member(f"g{i}", i * 0.2, 1.0) for i in range(12)]
        r = run(query(1.0), good)
        self.assertIsNotNone(r["median"][0])
        self.assertEqual(r["n_scored"][0], 12)


class TestFeatureMask(unittest.TestCase):
    """The source of the phantom zeros: what `seen` must be read through."""

    META = {"P": {"name": "Test Player", "common": "Test Player", "pos": "RB",
                  "born": 1998, "draft": 2020}}

    def seasons(self, years):
        return {y: {"P": {"pos": "RB", "gp": 13, "war": 1.0, "pts": 200.0,
                          "rate": 1.0}} for y in years}

    def test_a_gap_is_flagged_rather_than_scored(self):
        f = K.feature("P", 2025, self.seasons([2023, 2025]), self.META, "hybrid")
        self.assertEqual(f["has"], [True, False, True])
        # the phantom is there — which is exactly why every reader of `rates`
        # has to go through `has`
        self.assertEqual(f["rates"][1], 0.0)
        self.assertEqual(f["gps"][1], 0.0)

    def test_a_full_three_year_window_masks_nothing(self):
        f = K.feature("P", 2025, self.seasons([2023, 2024, 2025]),
                      self.META, "hybrid")
        self.assertEqual(f["has"], [True, True, True])


if __name__ == "__main__":
    unittest.main()
