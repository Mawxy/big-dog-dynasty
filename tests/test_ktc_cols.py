#!/usr/bin/env python3
"""Locks the league KTC column (scripts/ktc_cols.py) to the site's
(src/lib/values.ts LADDER). Two copies of one rule is how a tight end got one
price on his page and another in the pipeline until 2026-10-07."""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from ktc_cols import TEP_FIELDS, ktc_of, tep_ratio  # noqa: E402


class LockstepWithValuesTs(unittest.TestCase):
    def test_ladders_match(self):
        ts = (ROOT / "src" / "lib" / "values.ts").read_text(encoding="utf-8")
        block = ts.split("const LADDER", 1)[1].split("};", 1)[0]
        got = {m.group(1): tuple(re.findall(r'"(\w+)"', m.group(2)))
               for m in re.finditer(r'(\w+):\s*\[([^\]]*)\]', block)}
        want = {k: v for k, v in TEP_FIELDS.items() if k}
        self.assertEqual(got, want)


class Behaviour(unittest.TestCase):
    ROW = {"ktc": 7451, "ktcTep": 8252, "ktcTepp": 9000}

    def test_premium_league_reads_its_column(self):
        self.assertEqual(ktc_of(self.ROW, "tep"), 8252)
        self.assertEqual(ktc_of(self.ROW, ""), 7451)

    def test_missing_column_walks_down(self):
        self.assertEqual(ktc_of({"ktc": 100, "ktcTep": 120}, "teppp"), 120)
        self.assertEqual(ktc_of({"ktc": 100}, "tep"), 100)
        self.assertIsNone(ktc_of(None, "tep"))

    def test_ratio(self):
        self.assertAlmostEqual(tep_ratio(self.ROW, "tep"), 8252 / 7451)
        self.assertEqual(tep_ratio({"ktc": 500}, "tep"), 1.0)
        self.assertEqual(tep_ratio({}, "tep"), 1.0)


if __name__ == "__main__":
    unittest.main()
