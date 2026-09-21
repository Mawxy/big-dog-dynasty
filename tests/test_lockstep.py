#!/usr/bin/env python3
"""
The constants two languages both own, pinned to each other.

PROJECT_NOTES §10 settles the trade machine's consolidation curve in
src/lib/tradeModel.ts and then says of scripts/dynasty_movers.py: "copies the
market curve — keep in lockstep." Nothing enforced that. The two files are in
different languages, in different halves of the repo, changed by different
kinds of work, and a drift between them is invisible: the machine would price
a package one way on the Trade screen and the movers feed would attribute the
same package another way on Home, with no error anywhere.

    s(v) = u_min + (1 - u_min) / (1 + exp(-(v - v50) / tau))

`UTIL_CURVES.market` in the TypeScript is `U_MIN, V50, TAU` in the Python. The
DVI and CVI lenses have no Python counterpart — dynasty_movers works in KTC
market value alone — so only the market row is a lockstep claim; the others are
read here only to keep the parse honest about what it found.

Text-only: the TypeScript is regexed, never executed, and the Python constants
are imported. No network, no fixtures.

  python -m unittest discover -s tests
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from dynasty_movers import TAU, U_MIN, V50, s_market            # noqa: E402

TS = ROOT / "src" / "lib" / "tradeModel.ts"
PY = ROOT / "scripts" / "dynasty_movers.py"

# market: { uMin: 0.10, v50: 3400, tau: 1200 },
CURVE_RE = re.compile(
    r"^\s*(?P<lens>market|dvi|cvi)\s*:\s*\{\s*"
    r"uMin\s*:\s*(?P<uMin>-?[\d.]+)\s*,\s*"
    r"v50\s*:\s*(?P<v50>-?[\d.]+)\s*,\s*"
    r"tau\s*:\s*(?P<tau>-?[\d.]+)\s*,?\s*\}",
    re.M)


def ts_curves():
    """{lens: {uMin, v50, tau}} out of UTIL_CURVES in tradeModel.ts."""
    src = TS.read_text(encoding="utf-8")
    block = src.split("UTIL_CURVES", 1)
    if len(block) < 2:
        return {}
    return {m.group("lens"): {k: float(m.group(k))
                              for k in ("uMin", "v50", "tau")}
            for m in CURVE_RE.finditer(block[1])}


class TestTheParseItself(unittest.TestCase):
    """A regex that silently matches nothing would make every claim below
    vacuously true, so the parse is asserted before the values are."""

    def test_both_files_exist(self):
        self.assertTrue(TS.exists(), TS)
        self.assertTrue(PY.exists(), PY)

    def test_all_three_lenses_are_found(self):
        self.assertEqual(sorted(ts_curves()), ["cvi", "dvi", "market"])

    def test_the_python_side_names_the_typescript_file(self):
        """The Python constants carry a pointer to their source of truth; a
        rename that breaks it should break here, not on the site."""
        self.assertIn("tradeModel.ts", PY.read_text(encoding="utf-8"))


class TestMarketCurveLockstep(unittest.TestCase):
    """PROJECT_NOTES §10: dynasty_movers.py copies the market curve."""

    def setUp(self):
        self.market = ts_curves().get("market")
        self.assertIsNotNone(self.market, "UTIL_CURVES.market not parsed")

    def test_u_min_matches(self):
        self.assertEqual(self.market["uMin"], U_MIN)

    def test_v50_matches(self):
        self.assertEqual(self.market["v50"], V50)

    def test_tau_matches(self):
        self.assertEqual(self.market["tau"], TAU)

    def test_the_documented_v1_values_have_not_moved_by_accident(self):
        """v2 replaces these with a measured start share per value bin. Until
        then they are asserted, and moving them is a deliberate act in both
        files at once — which is what makes this test worth failing."""
        self.assertEqual((U_MIN, V50, TAU), (0.10, 3400.0, 1200.0))

    def test_the_python_curve_evaluates_to_the_shared_formula(self):
        """Not only the constants: the shape they go into. s(v50) is the
        midpoint of the floor and 1, and the curve is bounded and monotone."""
        import math
        self.assertAlmostEqual(s_market(V50), U_MIN + (1 - U_MIN) / 2, places=9)
        prev = -1.0
        for v in (0, 500, 1500, 3400, 5000, 9000, 12000):
            got = s_market(v)
            want = U_MIN + (1 - U_MIN) / (1 + math.exp(-(v - V50) / TAU))
            self.assertAlmostEqual(got, want, places=12, msg=v)
            self.assertGreater(got, prev, v)
            self.assertGreaterEqual(got, U_MIN, v)
            self.assertLess(got, 1.0, v)
            prev = got


if __name__ == "__main__":
    unittest.main(verbosity=2)
