#!/usr/bin/env python3
"""
Invariants of the six-curve projection matrix.

The matrix exists to publish a DISAGREEMENT between two models. Most of what can
go wrong with it is not an exception — it is the six curves quietly collapsing
into one number, or a composite landing somewhere none of its inputs support.
These lock down the decisions that keep it six curves.

  python -m unittest discover -s tests
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import inseason                                                  # noqa: E402
from leaguepaths import DataDir                                  # noqa: E402
from project_matrix import (points_streams, seed_mismatch,       # noqa: E402
                            sleeper_scale, trust_of,
                            PAD_PENALTY, PTS13_FLOOR, PTS13_FULL,
                            W_MAX, W_MIN)
# THE composite formula lives in project_war.py and is imported by the matrix,
# not duplicated in it. It used to exist in both, and the copies drifted by the
# corpus->league ratio — the same player read 1.502 on his page and 1.547 on the
# value board. These tests follow it to its one home.
from project_war import BLEND_W, composite_path                   # noqa: E402


def composite(natural, ext, w1, decay):
    """Argument order the older tests were written against."""
    return composite_path(natural, ext, decay, w1)


class TestTrust(unittest.TestCase):
    """`trust` is how much the analog's cohort is worth. It drives both the
    blend of the two naturals and the analog composite's Sleeper weight, so its
    direction is the whole design: tighter cohort -> more analog."""

    D_REF = {"RB": 0.94}

    def t(self, d_med, padded=False):
        return trust_of({"pos": "RB", "d_med": d_med, "padded": padded}, self.D_REF)

    def test_tight_cohort_is_trusted_more_than_a_loose_one(self):
        self.assertGreater(self.t(0.60), self.t(0.94))
        self.assertGreater(self.t(0.94), self.t(1.40))

    def test_at_the_reference_distance_trust_is_one_half(self):
        self.assertAlmostEqual(self.t(0.94), 0.5, places=6)

    def test_bounded_to_the_unit_interval(self):
        for d in (0.01, 0.5, 1.0, 3.76, 50.0):
            self.assertGreaterEqual(self.t(d), 0.0)
            self.assertLessEqual(self.t(d), 1.0)

    def test_an_uncomparable_player_collapses_to_nearly_zero(self):
        # McCaffrey: d_med 3.76 against an RB reference of 0.94, and padded.
        # He has no comparables, and the weight has to say so rather than
        # merely leaning.
        self.assertLess(self.t(3.76, padded=True), 0.01)

    def test_padding_costs_exactly_the_penalty(self):
        self.assertAlmostEqual(self.t(0.94, padded=True),
                               self.t(0.94) * PAD_PENALTY, places=9)

    def test_sleeper_weight_moves_opposite_to_trust(self):
        w = lambda t: W_MIN + (W_MAX - W_MIN) * (1 - t)
        self.assertAlmostEqual(w(1.0), W_MIN, places=9)
        self.assertAlmostEqual(w(0.0), W_MAX, places=9)
        self.assertGreater(w(self.t(3.76, True)), w(self.t(0.60)))


class TestComposite(unittest.TestCase):
    """A composite blends a natural with Sleeper's year-1 read, aged forward
    along the SCALAR path's decay."""

    SCALAR = [1.00, 0.80, 0.60]

    def test_year_one_is_exactly_the_stated_mix(self):
        out = composite([0.40, 0.40, 0.40], 1.40, 0.50, self.SCALAR)
        self.assertAlmostEqual(out[0], 0.5 * 1.40 + 0.5 * 0.40, places=3)

    def test_sleeper_weight_decays_across_the_horizon(self):
        """Sleeper knows this year's depth chart and nothing about year 3, so
        its pull has to shrink. Measured as distance moved off the natural."""
        nat = [0.0, 0.0, 0.0]
        out = composite(nat, 1.0, 0.9, [0.0, 0.0, 0.0])
        self.assertGreater(out[0], out[1])
        self.assertGreater(out[1], out[2])

    def test_zero_weight_returns_the_natural_untouched(self):
        nat = [0.30, 0.20, 0.10]
        self.assertEqual(composite(nat, 9.9, 0.0, self.SCALAR), nat)

    def test_aging_uses_the_scalar_shape_not_the_blended_curve(self):
        """THE McCAFFREY CASE. A curve we distrust enough to down-weight cannot
        also be the curve we borrow a decay shape from. His analog natural fell
        1.752 -> 1.001, and aging Sleeper along that step produced a year-2
        composite of 0.638 — below the natural, below the scalar and below
        Sleeper, supported by nothing."""
        analog = [1.752, 1.001, 0.937]
        scalar = [0.974, 0.979, 0.861]
        out = composite(analog, 1.025, 0.899, scalar)
        self.assertGreater(out[1], 0.95)
        # and it must sit between the two things it is actually mixing
        self.assertGreaterEqual(out[1], min(analog[1], 1.025) - 0.05)
        self.assertLessEqual(out[1], max(analog[1], 1.025) + 0.05)

    def test_a_signed_natural_does_not_flip_the_path(self):
        """The additive-vs-ratio bug project_war.py already hit: a near-zero or
        negative first year makes a ratio decay sign-flip and amplify."""
        out = composite([-0.90, -0.60, -0.30], 0.80, 0.90, [0.01, 0.00, -0.01])
        self.assertTrue(all(abs(v) < 2.0 for v in out), out)
        # year 1 leans on Sleeper, so it must land above the natural
        self.assertGreater(out[0], -0.90)


class TestGates(unittest.TestCase):
    def test_there_is_no_points_floor_on_the_shipped_path(self):
        """This test used to assert the opposite. I had gated Sleeper at 25
        points believing a low projection was an artifact being extrapolated;
        the corpus says it is a real forecast sitting inside the line's support,
        and a backup projected for 32 points IS projected below replacement.
        Projected WAR is production, not worth — the optionality that makes such
        a player valuable is DVI and CVI's job."""
        from project_matrix import SLEEPER_GATE
        self.assertEqual(SLEEPER_GATE, "none")
        self.assertEqual(sleeper_scale(4.28), 1.0)

    def test_the_analog_composite_is_not_the_scalar_composite(self):
        """At the scalar model's flat 0.9 the two composites agree to a mean of
        0.020 WAR — one curve published twice. The trust scaling is what makes
        the analog composite a sixth curve rather than a duplicate."""
        scalar = [1.00, 0.80, 0.60]
        analog = [0.40, 0.40, 0.40]
        sl = 1.30
        flat = composite(analog, sl, BLEND_W[0], scalar)
        trusted = composite(analog, sl, W_MIN + (W_MAX - W_MIN) * (1 - 0.80), scalar)
        self.assertGreater(abs(flat[0] - trusted[0]), 0.15)


class TestSleeperGate(unittest.TestCase):
    """What counts as a Sleeper projection.

    The shipped gate is `none`: every positive projection counts at full
    weight. A floor was tried at 25 points and removed after measuring it — the
    pts->WAR line is fit ON sub-replacement seasons (620 of 1041 QB seasons sit
    below its zero crossing), so a backup's low projection is in-support, not an
    extrapolation. `hard` and `taper` survive only so that measurement can be
    re-run.
    """

    def test_a_forecast_cannot_be_negative_points(self):
        for gate in ("none", "hard", "taper"):
            self.assertEqual(sleeper_scale(-0.31, gate), 0.0, gate)
            self.assertEqual(sleeper_scale(0.0, gate), 0.0, gate)
            self.assertEqual(sleeper_scale(None, gate), 0.0, gate)

    def test_none_admits_every_positive_projection(self):
        for pts in (0.5, 4.28, 24.9, 25.1, 127.0, 271.0):
            self.assertEqual(sleeper_scale(pts, "none"), 1.0, pts)

    def test_hard_is_a_cliff_and_that_is_why_it_lost(self):
        self.assertEqual(sleeper_scale(24.93, "hard"), 0.0)
        self.assertEqual(sleeper_scale(25.10, "hard"), 1.0)

    def test_taper_ramps_between_the_two_anchors(self):
        self.assertEqual(sleeper_scale(PTS13_FLOOR, "taper"), 0.0)
        self.assertEqual(sleeper_scale(PTS13_FULL, "taper"), 1.0)
        mid = sleeper_scale((PTS13_FLOOR + PTS13_FULL) / 2, "taper")
        self.assertAlmostEqual(mid, 0.5, places=6)

    def test_taper_is_monotone(self):
        xs = [26, 40, 60, 90, 120, 128, 200]
        ss = [sleeper_scale(x, "taper") for x in xs]
        self.assertEqual(ss, sorted(ss))


class TestSeedMismatch(unittest.TestCase):
    """The two arms must project from the same season, and there are two ways
    for them not to. Only one of them is survivable.

    LEGITIMATE: the analog corpus (nfl_history/*.csv) is rebuilt only by the
    manual war-history.yml workflow, so between a season finishing and someone
    dispatching that job the scalar arm is a year ahead. Both arms are seeded on
    seasons that really happened; a warning is the right response, because
    taking the nightly down would remove eight curves to complain that two are
    old.

    BROKEN: the scalar arm seeded past the last completed season — 2026-09-15,
    when meta.latest flipped on the freeze of week 1 and the scalar arm started
    projecting 2027-2029 off a single game. Its year 1 is then a DIFFERENT
    SEASON from the analog arm's, and no rebuild fixes that.
    """

    def test_arms_in_step_say_nothing(self):
        self.assertIsNone(seed_mismatch(2025, 2025, 2025))

    def test_a_corpus_a_year_behind_is_only_stale(self):
        """January 2027: the 2026 title game is played, the scalar arm has
        advanced to it, nobody has rebuilt nfl_history yet."""
        self.assertEqual(seed_mismatch(2026, 2025, 2026), "stale")

    def test_seeding_past_the_last_completed_season_is_fatal(self):
        """THE 2026-09-15 CASE."""
        self.assertEqual(seed_mismatch(2026, 2025, 2025), "broken")

    def test_both_arms_rolling_onto_an_unplayed_season_is_still_fatal(self):
        """Agreeing on the wrong year is not agreement."""
        self.assertEqual(seed_mismatch(2026, 2026, 2025), "broken")

    def test_a_corpus_ahead_of_the_league_is_fatal(self):
        """Impossible by construction, which is exactly why it should stop the
        run rather than print a warning about a stale analog arm."""
        self.assertEqual(seed_mismatch(2025, 2026, 2025), "broken")

    def test_an_unstamped_file_is_not_a_mismatch(self):
        self.assertIsNone(seed_mismatch(None, 2025, 2025))
        self.assertIsNone(seed_mismatch(2025, None, 2025))

    def test_a_league_with_no_finished_season_is_not_judged(self):
        """Nothing to measure against, so nothing is fatal."""
        self.assertIsNone(seed_mismatch(2026, 2026, None))
        self.assertEqual(seed_mismatch(2026, 2025, None), "stale")


class TestPointsArms(unittest.TestCase):
    """BOTH arms of the points-first model fill the points_* curves.

    project_points.py prices veterans from their own history (`src: points`)
    and incoming rookies from draft capital (`src: rookie`). Reading only the
    first handed all 56 rookies the SCALAR pair under a points heading, with
    has_points false — Jeremiyah Love read [0.735, ...] in the matrix against
    [0.835, ...] in projections.json, and nothing in the file said the two
    disagreed.
    """

    ROWS = [
        {"pid": "1", "src": "points", "proj": [1.0, 0.9, 0.8],
         "composite": [1.1, 0.95, 0.85]},
        {"pid": "2", "src": "rookie", "proj": [0.5, 0.6, 0.7],
         "composite": [0.8, 0.7, 0.75]},
        {"pid": "3", "src": "scalar", "proj": [0.2, 0.2, 0.2],
         "composite": [0.3, 0.3, 0.3]},
    ]

    def test_a_rookie_the_rookie_arm_priced_is_a_points_row(self):
        got = points_streams(self.ROWS)
        self.assertEqual(got["2"], ([0.5, 0.6, 0.7], [0.8, 0.7, 0.75]))

    def test_a_veteran_the_points_arm_priced_is_a_points_row(self):
        self.assertIn("1", points_streams(self.ROWS))

    def test_a_row_the_model_could_not_price_is_not(self):
        """src:scalar is an unjoined name. It keeps the scalar pair and
        has_points says so — that fallback is the honest one."""
        self.assertNotIn("3", points_streams(self.ROWS))

    def test_an_unmarked_row_is_not_a_points_row(self):
        """A projections.json written by project_war.py alone carries no
        `src`, and none of its rows belong to this model."""
        self.assertEqual(points_streams([{"pid": "9", "proj": [1], "composite": [1]}]), {})


class TestInSeasonPublication(unittest.TestCase):
    """THE IN-SEASON OUTLOOK (Max, 2026-09-21).

    Year 1 of every curve here is a FULL-SEASON figure for the roster season,
    which is what the index models need and the wrong thing to show a reader in
    week 4. So the file publishes the two FACTS an outlook needs —
    `meta.inseason` and each row's `banked` — and applies neither:

        outlook = banked + year1 * remaining_frac      (scripts/inseason.py)

    What these lock is that the curve values do NOT move (DVI, CVI, the value
    bridge and the pick tiers all read year 1 as an input, and an index that
    shrank to banked WAR by week 14 would price every asset at nothing in
    December), and that the block is absent whenever prorating would be wrong.

    main() is run for real against a synthetic data root; no network, no
    committed data.
    """

    SCALAR = [{"pid": "100", "name": "Star", "pos": "RB", "team": "SF", "age": 26,
               "proj": [1.400, 1.300, 1.100], "composite": [1.400, 1.300, 1.100]},
              {"pid": "200", "name": "Hurt", "pos": "WR", "team": "NYJ", "age": 29,
               "proj": [0.600, 0.500, 0.400], "composite": [0.600, 0.500, 0.400]}]
    SUMMARY = [["100", "RB", 1, 35.3, 35.3, 0.151, 0.249, 0.0, 0.287]]

    def tree(self, tmp, *, weeks=(1,), seed=2025, champion=False):
        d = Path(tmp)
        (d / "2026").mkdir(parents=True, exist_ok=True)
        w = lambda n, o: (d / n).write_text(json.dumps(o), encoding="utf-8")  # noqa: E731
        w("meta.json", {"seasons": ["2025", "2026"], "latest": "2026",
                        "rosterSeason": "2026"})
        (d / "2025").mkdir(parents=True, exist_ok=True)
        w("2025/bracket.json", {"winners": [{"r": 3, "p": 1, "w": 2, "l": 6}]})
        if champion:
            w("2026/bracket.json", {"winners": [{"r": 3, "p": 1, "w": 4, "l": 9}]})
        w("2026/matchups.json", {"playoff_start": 15, "teams": {
            "1": [[k, 120.0, 2, 100.0, [], []] for k in weeks]}})
        w("2026/summary.json", self.SUMMARY)
        w("projections_scalar.json", {
            "meta": {"seed_season": seed, "roster_season": 2026,
                     "years": [seed + 1, seed + 2, seed + 3],
                     "generated": "2026-09-21"},
            "players": self.SCALAR})
        w("projections_knn_hybrid.json", {"meta": {"seed_season": seed,
                                                   "generated": "2026-09-21"},
                                          "players": []})
        w("proj_sleeper.json", {"meta": {}, "players": {}})
        return d

    def run_matrix(self, d):
        import project_matrix
        saved_data, saved_argv = project_matrix.DATA, sys.argv
        project_matrix.DATA = DataDir(d)
        sys.argv = ["project_matrix.py"]
        try:
            with redirect_stdout(io.StringIO()):
                project_matrix.main()
        finally:
            project_matrix.DATA, sys.argv = saved_data, saved_argv
        return json.loads((d / "projections_matrix.json")
                          .read_text(encoding="utf-8"))

    def test_a_live_season_publishes_the_block(self):
        with tempfile.TemporaryDirectory() as t:
            out = self.run_matrix(self.tree(t, weeks=(1, 2, 3, 4)))
            blk = out["meta"]["inseason"]
            self.assertEqual(blk["season"], 2026)
            self.assertEqual((blk["weeks_played"], blk["reg_weeks"]), (4, 14))
            self.assertAlmostEqual(blk["remaining_frac"], 10 / 14, places=5)

    def test_every_row_carries_what_it_has_banked(self):
        with tempfile.TemporaryDirectory() as t:
            out = self.run_matrix(self.tree(t))
            rows = {r["pid"]: r for r in out["players"]}
            self.assertEqual(rows["100"]["banked"], 0.249)
            self.assertEqual(rows["100"]["gp"], 1)
            # no row in summary.json: he has dressed for nobody, which is a
            # real 0.0 rather than a missing figure the site has to guess at
            self.assertEqual(rows["200"]["banked"], 0.0)
            self.assertEqual(rows["200"]["gp"], 0)

    def test_the_curves_themselves_do_not_move(self):
        """The whole design rests on this: the published year-1 WAR stays the
        full-season figure the index models are calibrated on."""
        with tempfile.TemporaryDirectory() as t:
            out = self.run_matrix(self.tree(t, weeks=(1, 2, 3, 4)))
            row = next(r for r in out["players"] if r["pid"] == "100")
            for c in out["meta"]["curves"]:
                self.assertEqual(row[c][0], 1.400, c)

    def test_the_outlook_is_what_max_asked_for(self):
        """'In week 4 we should have 4 weeks of actual data + the proj war for
        a final projected war outlook.'"""
        with tempfile.TemporaryDirectory() as t:
            out = self.run_matrix(self.tree(t, weeks=(1, 2, 3, 4)))
            row = next(r for r in out["players"] if r["pid"] == "100")
            got = inseason.outlook(row["blend_composite"][0], row["banked"],
                                   out["meta"]["inseason"])
            self.assertAlmostEqual(got, 0.249 + 1.400 * 10 / 14, places=5)
            self.assertLess(got, row["blend_composite"][0])

    def test_before_kickoff_there_is_no_block_and_no_banked(self):
        """The offseason file is exactly what it was before this existed."""
        with tempfile.TemporaryDirectory() as t:
            out = self.run_matrix(self.tree(t, weeks=()))
            self.assertIsNone(out["meta"]["inseason"])
            for r in out["players"]:
                self.assertNotIn("banked", r)
                self.assertNotIn("gp", r)

    def test_a_finished_season_publishes_no_block(self):
        """Once the title game is decided the projection rolls forward; adding
        2026's banked WAR to a 2027 year one would be nonsense."""
        with tempfile.TemporaryDirectory() as t:
            out = self.run_matrix(self.tree(t, weeks=tuple(range(1, 15)),
                                            seed=2026, champion=True))
            self.assertIsNone(out["meta"]["inseason"])

    def test_the_matrix_does_not_define_its_own_remaining_fraction(self):
        """One definition of how much season is left, in scripts/inseason.py —
        the same rule the composite formula is held to above."""
        import project_matrix
        src = Path(project_matrix.__file__).read_text(encoding="utf-8")
        self.assertIn("import inseason", src)
        self.assertNotIn("def remaining_frac", src)
        self.assertNotIn("playoff_start", src)


class TestOneOwnerPerNumber(unittest.TestCase):
    """The matrix must not be a second opinion about a number that already has
    an owner — see the note on the composite import above."""

    def test_the_matrix_does_not_define_its_own_composite(self):
        import project_matrix
        self.assertFalse(
            "def composite(" in Path(project_matrix.__file__).read_text(encoding="utf-8"),
            "project_matrix has re-grown its own composite formula")

    def test_scalar_composite_matches_projections_json(self):
        """The shipped gate reads project_war's number verbatim. Since
        2026-09-11 project_war's output lives at projections_scalar.json
        (projections.json is the points-first model's); read whichever the
        matrix itself read."""
        import json
        from leaguepaths import DataDir
        d = DataDir(Path(__file__).resolve().parent.parent / "data")
        f_s, f_m = d / "projections_scalar.json", d / "projections_matrix.json"
        if not f_s.exists():
            f_s = d / "projections.json"
        if not (f_s.exists() and f_m.exists()):
            self.skipTest("no built data")
        sc = {str(p["pid"]): p for p in json.loads(f_s.read_text())["players"]}
        for m in json.loads(f_m.read_text())["players"]:
            p = sc.get(m["pid"])
            if not p:
                continue
            self.assertEqual(m["scalar_natural"], p["proj"], m["name"])
            self.assertEqual(m["scalar_composite"], p["composite"], m["name"])


if __name__ == "__main__":
    unittest.main()
