"""Start rate from FINISHED weeks (Max, 2026-11-14).

The signals crawl used to take a start observation off the live /rosters call
on every visit. It now reads /league/<lid>/matchups/<week> for weeks that are
over, joins them to who actually played, and drops a roster's week when nobody
was plainly setting that lineup. These tests are offline: `get` is a stub and
every path is a temp dir.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

_spec = importlib.util.spec_from_file_location(
    "sleeper_crawl_start", Path(__file__).resolve().parent.parent / "scripts" / "sleeper_crawl.py")
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)

TEAM = {"qb": "BUF", "rb": "DAL", "wr": "KC", "te": "BAL", "hurt": "JAX", "k": "BUF"}
POS = {"qb": "QB", "rb": "RB", "wr": "WR", "te": "TE", "hurt": "RB", "k": "K"}
BYES = {"KC": 5, "BAL": 9}


def dead(starters, week, played):
    return sc.roster_week_dead(starters, week, played, TEAM, BYES, POS)


class PlayedSet(unittest.TestCase):
    """The played-set join: snaps OR a stat line, never gms_active alone."""

    ROWS = [
        {"player_id": "snaps", "stats": {"off_snp": 4}},                 # no gp
        {"player_id": "line", "stats": {"rec": 1, "off_snp": 0}},        # a catch, 0 snaps
        {"player_id": "dressed", "stats": {"gms_active": 1, "tm_off_snp": 61}},
        {"player_id": "ir", "stats": {"gms_active": 1, "pos_rank_ppr": 999}},
        {"player_id": "empty", "stats": {}},
        {"player_id": 4034, "stats": {"gp": 1}},                         # an int id
    ]

    def test_snaps_or_a_stat_line_is_played(self):
        self.assertEqual(sc.played_set(self.ROWS), {"snaps", "line", "dressed", "4034"})

    def test_gms_active_alone_is_never_played(self):
        self.assertFalse(sc.stat_played(self.ROWS[3]))

    def test_no_feed_is_nobody(self):
        self.assertEqual(sc.played_set(None), set())
        self.assertEqual(sc.played_set([]), set())

    def test_the_rule_matches_the_pipelines_own(self):
        """stat_played restates sleeper_pull.row_played; they must not drift."""
        try:
            import sleeper_pull
        except Exception as e:                       # the WAR engine's imports
            self.skipTest(f"sleeper_pull not importable here: {e}")
        for row in self.ROWS:
            self.assertEqual(sc.stat_played(row), sleeper_pull.row_played(row), row)


class FinishedThrough(unittest.TestCase):
    def test_everything_before_the_week_being_played_is_finished(self):
        self.assertEqual(sc.finished_through("regular", 10), 9)
        self.assertEqual(sc.finished_through("regular", 1), 0)

    def test_only_the_regular_season_feeds_start_rate(self):
        self.assertEqual(sc.finished_through("pre", 3), 0)
        self.assertEqual(sc.finished_through("post", 2), 0)
        self.assertEqual(sc.finished_through("regular", 0), 0)

    def test_it_stops_at_the_last_regular_week(self):
        self.assertEqual(sc.finished_through("regular", 25), sc.REG_WEEKS)


class DeadRosterWeek(unittest.TestCase):
    """A roster's finished week votes only if somebody was setting the lineup."""

    PLAYED = {2: {"qb", "rb", "wr", "te"}, 3: {"qb", "rb", "wr", "te"},
              4: {"qb", "rb", "wr", "te"}}

    def test_a_set_lineup_votes(self):
        self.assertIsNone(dead(["qb", "rb", "wr", "te"], 3, self.PLAYED))

    def test_starting_a_player_on_bye_is_dead(self):
        played = {5: {"qb", "rb", "te"}, 4: {"qb", "rb", "wr", "te"}}
        self.assertEqual(dead(["qb", "rb", "wr", "te"], 5, played), "bye")

    def test_an_empty_slot_is_dead(self):
        self.assertEqual(dead(["qb", "0", "wr", "te"], 3, self.PLAYED), "empty")
        self.assertEqual(dead([], 3, self.PLAYED), "empty")
        self.assertEqual(dead(None, 3, self.PLAYED), "empty")

    def test_out_two_weeks_running_is_dead(self):
        self.assertEqual(dead(["qb", "hurt", "wr", "te"], 3, self.PLAYED), "out")

    def test_a_surprise_scratch_is_not_held_against_a_live_manager(self):
        played = {3: {"qb", "rb", "wr", "te"}, 2: {"qb", "rb", "wr", "te", "hurt"}}
        self.assertIsNone(dead(["qb", "hurt", "wr", "te"], 3, played))

    def test_a_bye_is_not_an_absence(self):
        """KC is off in week 5: a week-6 scratch looks back to week 4."""
        played = {6: {"qb"}, 5: {"qb"}, 4: {"qb", "wr"}}
        self.assertIsNone(dead(["qb", "wr"], 6, played))
        played[4] = {"qb"}
        self.assertEqual(dead(["qb", "wr"], 6, played), "out")

    def test_week_one_has_nothing_to_look_back_on(self):
        self.assertIsNone(dead(["qb", "hurt"], 1, {1: {"qb"}}))

    def test_a_kicker_is_never_evidence(self):
        self.assertIsNone(dead(["qb", "k"], 3, {3: {"qb"}, 2: {"qb"}}))

    def test_a_week_with_no_played_set_convicts_nobody(self):
        self.assertIsNone(dead(["qb", "hurt"], 3, {}))
        # ...and neither does a missing week to look back on
        self.assertIsNone(dead(["qb", "hurt"], 3, {3: {"qb"}}))

    def test_the_verdict_is_for_that_week_alone(self):
        """No strikes: dead in week 3 says nothing about week 4."""
        played = dict(self.PLAYED)
        played[4] = {"qb", "rb", "wr", "te", "hurt"}
        self.assertEqual(dead(["qb", "hurt"], 3, played), "out")
        self.assertIsNone(dead(["qb", "hurt"], 4, played))


class FinishedWeekObs(unittest.TestCase):
    PLAYED = {3: {"qb", "rb", "wr", "te"}, 2: {"qb", "rb", "wr", "te"}}

    def obs(self, matchups, week=3, played=None):
        return sc.finished_week_obs(matchups, week, played or self.PLAYED, TEAM, BYES, POS)

    def test_a_live_roster_votes_for_everyone_it_holds(self):
        obs, live, dead_n = self.obs([
            {"roster_id": 1, "players": ["qb", "rb", "te"], "starters": ["qb", "rb"]}])
        self.assertEqual((live, dead_n), (1, 0))
        self.assertEqual(sorted(obs), [("qb", True), ("rb", True), ("te", False)])

    def test_a_dead_roster_does_not_vote_at_all(self):
        """The whole roster-week goes, benched breakouts included: that bench
        is exactly the opinion a dead roster does not have."""
        obs, live, dead_n = self.obs([
            {"roster_id": 1, "players": ["qb", "hurt", "te"], "starters": ["qb", "hurt"]},
            {"roster_id": 2, "players": ["rb", "wr"], "starters": ["rb", "wr"]}])
        self.assertEqual((live, dead_n), (1, 1))
        self.assertEqual(sorted(obs), [("rb", True), ("wr", True)])

    def test_a_player_on_his_own_bye_is_not_an_observation(self):
        played = {5: {"qb", "rb"}, 4: {"qb", "rb", "wr"}}
        obs, live, _ = self.obs([
            {"roster_id": 1, "players": ["qb", "wr"], "starters": ["qb"]}], 5, played)
        self.assertEqual(live, 1)
        self.assertEqual(obs, [("qb", True)])

    def test_a_roster_with_nobody_on_it_is_neither(self):
        self.assertEqual(self.obs([{"roster_id": 1, "players": None, "starters": None}]),
                         ([], 0, 0))
        self.assertEqual(self.obs(None), ([], 0, 0))


class NowWeek(unittest.TestCase):
    def test_the_latest_week_once_enough_leagues_have_read_it(self):
        self.assertEqual(sc.now_week({"8": 900, "9": 600}, 1000), 9)

    def test_the_week_before_while_the_new_one_is_still_thin(self):
        self.assertEqual(sc.now_week({"8": 900, "9": 40}, 1000), 8)

    def test_nothing_until_some_week_has_a_sample(self):
        self.assertIsNone(sc.now_week({}, 1000))
        self.assertIsNone(sc.now_week({"9": 3}, 1000))


class Clock:
    def __init__(self, now):
        self.now = now

    def time(self):
        return self.now

    def sleep(self, _s):
        pass


class SignalsFromFinishedWeeks(unittest.TestCase):
    """mode_signals end to end, in week 4 of the regular season."""

    LEAGUE = {"settings": {"type": 2}, "total_rosters": 12,
              "roster_positions": ["SUPER_FLEX"]}
    ROSTERS = [{"owner_id": "u1", "players": ["qb", "rb", "te"], "starters": ["qb", "rb"]},
               {"owner_id": "u2", "players": ["wr", "hurt"], "starters": ["wr", "hurt"]}]
    # roster 2 has started `hurt` every week; he last played in week 1
    WEEKS = {w: [{"roster_id": 1, "players": ["qb", "rb", "te"], "starters": ["qb", "rb"]},
                 {"roster_id": 2, "players": ["wr", "hurt"], "starters": ["wr", "hurt"]}]
             for w in (1, 2, 3)}
    STATS = {1: ["qb", "rb", "wr", "te", "hurt"], 2: ["qb", "rb", "wr", "te"],
             3: ["qb", "rb", "wr", "te"]}

    def setUp(self):
        self.clock = Clock(1_000_000.0)
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.state = self.tmp / "crawl" / "signals"
        self.state.mkdir(parents=True)
        (self.tmp / "data").mkdir()
        # the shared player map sits beside the state dir
        (self.state.parent / "players_nfl.json").write_text(json.dumps({
            "v": sc.PLAYERS_CACHE_V, "ts": self.clock.now,
            "players": {p: {"team": TEAM[p], "pos": POS[p]} for p in TEAM}}), encoding="utf-8")
        self.seen = []

    def get(self, path):
        self.seen.append(path)
        if path.startswith("http"):
            wk = int(path.split("?")[0].rsplit("/", 1)[1])
            return [{"player_id": p, "stats": {"gp": 1}} for p in self.STATS.get(wk, [])]
        if path.startswith("/user/"):
            return []
        if "/matchups/" in path:
            return self.WEEKS.get(int(path.rsplit("/", 1)[1]))
        if path.endswith("/rosters"):
            return self.ROSTERS
        return dict(self.LEAGUE, last_message_time=self.clock.now * 1000)

    def run_signals(self, week=4, frontier=("L1",), **extra):
        (self.state / "frontier.json").write_text(json.dumps(list(frontier)), encoding="utf-8")
        args = argparse.Namespace(
            state=str(self.state), league_type="dynasty", seeds=[], season="2026",
            season_type="regular", week=week, cooldown_days=7.0, max_leagues=1000000,
            max_minutes=0, teams=12, any_qb=False, commit_every=0, log_every=1e9,
            signals_out="data/league_signals.json", leagues_out="data/crawl_leagues.json",
            **extra)
        with mock.patch.object(sc, "ROOT", self.tmp), mock.patch.object(sc, "get", self.get), \
                mock.patch.object(sc, "time", self.clock), \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            sc.mode_signals(args, self.clock.now)
        return json.loads((self.tmp / "data" / "league_signals.json").read_text("utf-8"))

    def matchup_calls(self):
        return [p for p in self.seen if "/matchups/" in p]

    def registry(self):
        return json.loads((self.state / "registry.json").read_text("utf-8"))

    def test_a_first_visit_reads_only_the_latest_finished_week(self):
        out = self.run_signals()
        self.assertEqual(self.matchup_calls(), ["/league/L1/matchups/3"])
        self.assertEqual(self.registry()["L1"]["wk"], 3)
        self.assertEqual(out["start_basis"]["kind"], "finished-weeks")

    def test_the_dead_roster_is_dropped_and_the_live_one_counts(self):
        out = self.run_signals()
        p = out["players"]
        # roster 1 voted: started qb and rb, benched te
        self.assertEqual((p["qb"]["start_rate"], p["qb"]["start_obs"]), (1.0, 1))
        self.assertEqual((p["te"]["start_rate"], p["te"]["start_obs"]), (0.0, 1))
        # roster 2 started a man two weeks out: its week does not vote, for
        # him or for the healthy receiver beside him
        self.assertEqual(p["wr"]["start_obs"], 0)
        self.assertEqual(p["hurt"]["start_obs"], 0)
        self.assertEqual(out["start_basis"]["roster_weeks"], 1)
        self.assertEqual(out["start_basis"]["dead_roster_weeks"], 1)

    def test_start_rate_now_is_the_finished_week_not_the_live_lineup(self):
        # the live roster call says te is started; week 3 says he sat
        self.ROSTERS = [dict(self.ROSTERS[0], starters=["qb", "te"]), self.ROSTERS[1]]
        out = self.run_signals()
        self.assertEqual(out["start_basis"]["now_week"], 3)
        self.assertEqual(out["players"]["te"]["start_rate_now"], 0.0)
        self.assertEqual(out["players"]["rb"]["start_rate_now"], 1.0)

    def test_a_league_is_read_once_per_finished_week_not_once_per_visit(self):
        self.run_signals()
        self.clock.now += 8 * 86400                 # past the cooldown, same NFL week
        self.seen.clear()
        out = self.run_signals()
        self.assertEqual(self.matchup_calls(), [])
        self.assertEqual(out["players"]["qb"]["start_obs"], 1)

    def test_the_next_visit_reads_the_weeks_that_finished_since(self):
        self.run_signals(week=3)                    # reads week 2
        self.clock.now += 8 * 86400
        self.seen.clear()
        out = self.run_signals(week=4)              # reads week 3
        self.assertEqual(self.matchup_calls(), ["/league/L1/matchups/3"])
        self.assertEqual(out["players"]["qb"]["start_obs"], 2)
        self.assertEqual(self.registry()["L1"]["wk"], 3)

    def test_the_stats_feed_is_asked_once_a_week_not_once_a_league(self):
        self.run_signals(frontier=("L1", "L2", "L3"))
        stats = [p for p in self.seen if p.startswith("http")]
        self.assertEqual(len(stats), len(set(stats)))
        self.assertEqual(len(self.matchup_calls()), 3)

    def test_a_week_the_feed_has_nothing_for_is_left_for_next_time(self):
        self.STATS = {1: self.STATS[1], 2: self.STATS[2]}      # week 3 unanswered
        out = self.run_signals()
        self.assertEqual(self.matchup_calls(), [])
        self.assertIsNone(self.registry()["L1"]["wk"])
        self.assertEqual(out["players"]["qb"]["start_obs"], 0)

    def test_week_one_takes_no_start_observation_at_all(self):
        """Nothing is finished, and the live lineup is no longer an observation."""
        out = self.run_signals(week=1)
        self.assertEqual(self.matchup_calls(), [])
        self.assertEqual(out["players"]["qb"]["start_obs"], 0)
        # with no finished week, start_rate_now is still the live snapshot
        self.assertEqual(out["players"]["qb"]["start_rate_now"], 1.0)
        self.assertIsNone(out["start_basis"]["now_week"])

    def test_an_older_accumulator_is_kept_and_appended_to(self):
        """No backfill unless it is asked for: the snapshot-era counts stay."""
        (self.state / "start_acc.json").write_text(json.dumps(
            {"season": "2026", "acc": {"qb": [30, 40]}}), encoding="utf-8")
        out = self.run_signals()
        self.assertEqual(out["players"]["qb"]["start_obs"], 41)
        self.assertEqual(out["start_basis"]["from_week"], 3)

    def test_the_backfill_replaces_the_accumulator_and_rereads_every_week(self):
        (self.state / "start_acc.json").write_text(json.dumps(
            {"season": "2026", "acc": {"qb": [30, 40]}}), encoding="utf-8")
        (self.state / "registry.json").write_text(json.dumps(
            {"L1": {"counts": True, "last_signals": 0, "wk": 3}}), encoding="utf-8")
        out = self.run_signals(start_backfill=True)
        self.assertEqual(self.matchup_calls(),
                         [f"/league/L1/matchups/{w}" for w in (1, 2, 3)])
        # week 1 he played, so roster 2 votes once; weeks 2 and 3: a scratch
        # is forgiven, the second week out is not
        self.assertEqual(out["players"]["qb"]["start_obs"], 3)
        self.assertEqual(out["players"]["wr"]["start_obs"], 2)
        self.assertEqual(out["start_basis"]["from_week"], 1)
        self.assertEqual(out["start_basis"]["dead_roster_weeks"], 1)

    def test_the_backfill_flag_is_idempotent(self):
        self.run_signals(start_backfill=True)
        self.clock.now += 8 * 86400
        self.seen.clear()
        out = self.run_signals(start_backfill=True)
        self.assertEqual(self.matchup_calls(), [])
        self.assertEqual(out["players"]["qb"]["start_obs"], 1)

    def test_a_stop_between_two_weeks_counts_nothing_twice(self):
        (self.state / "registry.json").write_text(json.dumps(
            {"L1": {"counts": True, "last_signals": 0, "wk": 0}}), encoding="utf-8")
        (self.state / "start_acc.json").write_text(json.dumps(
            {"season": "2026", "acc": {}, "basis": "finished-weeks", "from_week": 1}),
            encoding="utf-8")
        real, hit = self.get, []
        def flaky(path):
            if path.endswith("/matchups/2") and not hit:
                hit.append(1)
                raise RuntimeError("rate-limited 10x, giving up")
            return real(path)
        self.get = flaky
        out = self.run_signals()
        self.assertEqual(out["players"].get("qb", {}).get("start_obs", 0), 0)
        self.assertEqual(self.registry()["L1"]["wk"], 0)
        self.get = real
        out = self.run_signals()                    # the league was put back
        self.assertEqual(out["players"]["qb"]["start_obs"], 3)
        self.assertEqual(self.registry()["L1"]["wk"], 3)


if __name__ == "__main__":
    unittest.main()
