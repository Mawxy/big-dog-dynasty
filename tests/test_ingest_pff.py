#!/usr/bin/env python3
"""
Invariants of the PFF export ingest (scripts/ingest_pff.py).

What is locked down: an export is identified by its header, not its file name;
a filtered or truncated export is refused before it is stored; an export older
than the stored one is refused unless forced; and the only thing published is
the roles file, which may carry labels and nothing else (PFF's terms bar
publishing their figures, and the repo is public).

  python -m unittest discover -s tests
"""
import csv
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import ingest_pff as P                                            # noqa: E402

TEAMS = [f"T{i:02d}" for i in range(32)]


def rows(kind, n=192, games=3):
    spec = P.KINDS[kind]
    pos = sorted(spec["positions"])
    out = []
    for i in range(n):
        r = {c: "10" for c in spec["required"]}
        r.update(player=f"P{i}", player_id=str(i), position=pos[i % len(pos)],
                 team_name=TEAMS[i % 32], player_game_count=str(games))
        for c in spec["rates"]:
            r[c] = "42.5"
        if "routes" in r:
            r["routes"] = "40"
        out.append(r)
    return out


def write(path, rs):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rs[0]))
        w.writeheader()
        w.writerows(rs)


class TestClassify(unittest.TestCase):
    def test_header_decides_kind(self):
        for kind in P.KINDS:
            self.assertEqual(P.classify(list(rows(kind, 1)[0])), kind)

    def test_unrelated_csv_is_ignored(self):
        self.assertIsNone(P.classify(["player", "player_id", "sacks"]))


class TestValidate(unittest.TestCase):
    def test_full_export_passes(self):
        facts = P.validate("receiving_summary", rows("receiving_summary"))
        self.assertEqual(facts, {"rows": 192, "max_games": 3})

    def test_team_filter_is_refused(self):
        rs = [r for r in rows("receiving_summary") if r["team_name"] != "T00"]
        with self.assertRaises(P.IngestError):
            P.validate("receiving_summary", rs)

    def test_position_filter_is_refused(self):
        rs = rows("receiving_summary")
        for r in rs:
            if r["position"] == "HB":
                r["position"] = "WR"
        with self.assertRaises(P.IngestError):
            P.validate("receiving_summary", rs)

    def test_rushing_needs_qbs_not_receivers(self):
        rs = rows("rushing_summary")
        self.assertEqual(P.validate("rushing_summary", rs)["rows"], 192)
        for r in rs:
            if r["position"] == "QB":
                r["position"] = "HB"
        with self.assertRaises(P.IngestError):
            P.validate("rushing_summary", rs)

    def test_real_headers_classify_to_one_kind(self):
        """Every kind's real PFF header (its required columns plus the other
        kinds' shared ones) must not also satisfy a different kind."""
        for kind, spec in P.KINDS.items():
            others = [k for k, o in P.KINDS.items()
                      if k != kind and o["marker"] in spec["required"]]
            self.assertEqual(others, [], f"{kind} carries another kind's marker")

    def test_passing_needs_a_qb_per_club(self):
        for kind in ("passing_summary", "passing_pressure"):
            rs = rows(kind, n=53)
            self.assertEqual(P.validate(kind, rs)["rows"], 53)
            with self.assertRaises(P.IngestError):
                P.validate(kind, rs[:31])

    def test_elusive_rating_over_100_is_allowed(self):
        rs = rows("rushing_summary")
        rs[0]["elusive_rating"] = "960.0"
        P.validate("rushing_summary", rs)

    def test_rate_out_of_range_is_refused(self):
        rs = rows("receiving_summary")
        rs[5]["slot_rate"] = "140"
        with self.assertRaises(P.IngestError):
            P.validate("receiving_summary", rs)


class TestRoles(unittest.TestCase):
    def row(self, pos, slot, inline=0.0, routes=40):
        return {"position": pos, "routes": str(routes), "slot_rate": str(slot),
                "inline_rate": str(inline), "player_id": "1", "player": "X",
                "team_name": "DET"}

    def test_wr_thresholds(self):
        self.assertEqual(P.role_for(self.row("WR", 75)), "slot")
        self.assertEqual(P.role_for(self.row("WR", 60)), "slot")
        self.assertEqual(P.role_for(self.row("WR", 45)), "mixed")
        self.assertEqual(P.role_for(self.row("WR", 30)), "perimeter")

    def test_te_thresholds(self):
        self.assertEqual(P.role_for(self.row("TE", 20, inline=70)), "inline")
        self.assertEqual(P.role_for(self.row("TE", 40, inline=30)), "move")

    def test_small_samples_and_rbs_get_no_label(self):
        self.assertIsNone(P.role_for(self.row("WR", 90, routes=5)))
        self.assertIsNone(P.role_for(self.row("HB", 90)))

    def test_published_file_carries_labels_only(self):
        doc = P.build_roles("2026", [self.row("WR", 75)], 3)
        self.assertEqual(P.validate_roles(doc), 1)
        self.assertEqual(set(doc["players"][0]), P.ROLE_FIELDS)
        doc["players"][0]["slot_rate"] = 75.0
        with self.assertRaises(P.IngestError):
            P.validate_roles(doc)


class TestIngest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.src = base / "Downloads"
        self.src.mkdir()
        self._pff, self._cp = P.PFF_DIR, P.commit_and_push
        P.PFF_DIR = base / "pff"
        P.commit_and_push = lambda *a, **k: None      # never touch git in tests

    def tearDown(self):
        P.PFF_DIR, P.commit_and_push = self._pff, self._cp
        self.tmp.cleanup()

    def drop(self, games, name="receiving_summary (1).csv"):
        p = self.src / name
        write(p, rows("receiving_summary", games=games))
        t = time.time()
        os.utime(p, (t, t))
        return p

    def ingest(self, **kw):
        P.ingest(self.src, "2026", days=7, force=kw.get("force", False),
                 dry_run=False, push=False)

    def test_older_export_is_refused(self):
        self.drop(3)
        self.ingest()
        man = json.loads((P.PFF_DIR / "2026" / "manifest.json").read_text())
        self.assertEqual(man["receiving_summary"]["max_games"], 3)
        self.drop(2)
        with self.assertRaises(P.IngestError):
            self.ingest()
        self.ingest(force=True)

    def test_roles_are_written_beside_not_inside_the_raw_exports(self):
        self.drop(3)
        self.ingest()
        roles = json.loads(P.roles_path("2026").read_text())
        self.assertEqual(roles["through_games"], 3)
        self.assertTrue(roles["players"])
        self.assertEqual(P.roles_path("2026").parent, P.PFF_DIR)
        self.assertTrue((P.PFF_DIR / "2026" / "receiving_summary.csv").exists())


if __name__ == "__main__":
    unittest.main()
