#!/usr/bin/env python3
"""The kickoff lock in scripts/proj_snapshot.py — pure, no network."""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from proj_snapshot import update   # noqa: E402

UTC = dt.timezone.utc
T = lambda h: dt.datetime(2026, 9, 27, h, 0, tzinfo=UTC)   # noqa: E731


class TestKickoffLock(unittest.TestCase):
    KICK = {"KC": T(17), "SF": T(20)}

    def test_overwrites_until_kickoff_then_freezes(self):
        hist, meta = {}, {}
        update(hist, meta, 3, {"a": (10.0, "KC")}, self.KICK, T(12))
        update(hist, meta, 3, {"a": (11.5, "KC")}, self.KICK, T(16))
        self.assertEqual(hist["3"]["a"], 11.5)          # the read closest to kickoff
        update(hist, meta, 3, {"a": (30.0, "KC")}, self.KICK, T(18))
        self.assertEqual(hist["3"]["a"], 11.5)          # after kickoff: frozen
        self.assertEqual(meta["3"]["at"]["a"], "2026-09-27T16:00:00Z")

    def test_each_player_locks_at_his_own_kickoff(self):
        hist, meta = {}, {}
        update(hist, meta, 3, {"a": (10.0, "KC"), "b": (8.0, "SF")}, self.KICK, T(16))
        update(hist, meta, 3, {"a": (12.0, "KC"), "b": (9.0, "SF")}, self.KICK, T(18))
        self.assertEqual(hist["3"], {"a": 10.0, "b": 9.0})

    def test_no_entry_is_added_after_kickoff(self):
        hist, meta = {}, {}
        update(hist, meta, 3, {"a": (10.0, "KC")}, self.KICK, T(18))
        self.assertNotIn("3", hist)

    def test_bye_gets_no_line(self):
        hist, meta = {}, {}
        update(hist, meta, 3, {"a": (10.0, "BUF")}, self.KICK, T(12))
        self.assertNotIn("3", hist)

    def test_no_scoreboard_is_first_write_only(self):
        hist, meta = {"3": {"a": 10.0}}, {}
        update(hist, meta, 3, {"a": (99.0, "KC"), "b": (7.0, "SF")}, None, T(12))
        self.assertEqual(hist["3"], {"a": 10.0, "b": 7.0})


if __name__ == "__main__":
    unittest.main()
