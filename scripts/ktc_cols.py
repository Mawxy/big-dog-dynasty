#!/usr/bin/env python3
"""
ktc_cols.py — which KeepTradeCut column prices a league.

KTC publishes four ladders (no premium, TE+, TE++, TE+++) and a league belongs to
exactly one, stamped on its meta.json as `tep` (crawl_schema.tep_class). The
site shows every KTC figure through `ktcOf(row, meta.tep)` in src/lib/values.ts;
until 2026-10-07 the pipeline read base `ktc` instead, so in this TE-premium
league a tight end's implied WAR, his DVI market half and the trade ledger were
priced in a market the page beside them never showed (McBride: 8252 on screen,
implied WAR fitted at 7451).

ONE DEFINITION, Python side. KEEP IN LOCKSTEP with LADDER in src/lib/values.ts
(tests/test_ktc_cols.py compares the two).
"""
import json

#: league class -> columns to try, most specific first. The fallback walks DOWN
#: the ladder so a values.json built before a premium column existed degrades
#: to the nearest milder premium rather than to nothing.
TEP_FIELDS = {"": ("ktc",),
              "tep": ("ktcTep", "ktc"),
              "tepp": ("ktcTepp", "ktcTep", "ktc"),
              "teppp": ("ktcTeppp", "ktcTepp", "ktcTep", "ktc")}


def ktc_of(row, tep=""):
    """The league's KTC value for one values.json player row, or None."""
    if not row:
        return None
    for f in TEP_FIELDS.get(tep or "", ("ktc",)):
        v = row.get(f)
        if isinstance(v, (int, float)) and v > 0:
            return v
    return row.get("ktc")


def tep_ratio(row, tep=""):
    """Today's league-column / base ratio for a player (1.0 for everyone but
    premium tight ends). Prices a BASE history row in the league's column —
    values_history.json records base KTC only — the same way trade_analysis
    scales a pre-tier pick ladder by today's tier spread."""
    base = (row or {}).get("ktc")
    lc = ktc_of(row, tep)
    return (lc / base) if base and lc else 1.0


def league_tep(data_dir):
    """The league's `tep` class off its meta.json; "" when absent."""
    try:
        with open(data_dir / "meta.json", encoding="utf-8") as fh:
            return json.load(fh).get("tep") or ""
    except (OSError, ValueError):
        return ""
