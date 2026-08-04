#!/usr/bin/env python3
"""
franchise_players.py — who is a franchise player, by position.

A franchise player is one who cleared his position's bar in at least three
separate seasons. The bars are position-specific ON PURPOSE: a flat 1.0 WAR
test returns 23 QBs and 5 TEs, which measures the shape of the positions rather
than the players inside them. Each bar sits at roughly its position's 12th-rank
season value, so "franchise" means the same thing everywhere — a player who was
a genuine starter at his position, three times.

    QB 1.00   (QB12 averages 1.003)
    RB 0.70   (RB12 averages 0.693)
    WR 0.85   (WR12 averages 0.845)
    TE 0.50   (TE12 averages 0.290; see below)

Tight end is the deliberate exception. Set at its rank-12 equivalent of 0.29 the
bar admits fringe starters, and every threshold that yields a QB-comparable
count reaches into a talent pool that does not exist — the position runs out of
value by TE20 (0.034 mean) and is negative by TE22. 0.50 is a judgement: it is
the level at which the players admitted are ones a manager would actually have
wanted, and it still returns 14 against 23-25 elsewhere. That gap is the
finding, not an artefact to be tuned away.

Input:  nfl_history/waa_war_<season>.csv  (per-season WAR, one row per player)
Output: stdout tables, or --json for a machine-readable dump.

Usage:
  python scripts/franchise_players.py
  python scripts/franchise_players.py --since 2019 --min-seasons 3
  python scripts/franchise_players.py --json > out.json
"""
import argparse
import csv
import glob
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "nfl_history"

# position -> WAR a season must clear to count. See the module docstring for
# why TE is not at its rank-12 equivalent.
#
# This is a STARTER bar — roughly each position's 12th-ranked season, i.e. the
# last player you'd start in a 12-team league. It is NOT "elite", and calling it
# that overstates what it measures: at RB 0.70 it admits the 0.76-0.85 range
# where Chuba Hubbard and James Conner live. Both are useful; neither is a
# cornerstone.
FRANCHISE_BAR = {"QB": 1.00, "RB": 0.70, "WR": 0.85, "TE": 0.50}

# The tier above: roughly each position's 6th-ranked season, so a top-half-of-
# starters player. TE sits at its rank-3 equivalent instead — rank 6 is 0.67,
# barely clear of the starter bar, because the position runs out of value that
# fast. Yields ~5-6 players a year at QB/RB/WR and ~3 at TE.
ELITE_BAR = {"QB": 1.30, "RB": 1.10, "WR": 1.10, "TE": 1.00}

MIN_SEASONS = 3

# The corpus carries ONE position per player across his whole career (see
# nfl_history.POS_OVERRIDE). Players whose eligibility genuinely changed are
# corrected at the source; here we only take what the CSVs say, so this script
# inherits that limitation rather than papering over it.


def load(since=None, until=None):
    """gsis -> {"name", "pos", "war": {season: war}}"""
    out = defaultdict(lambda: {"name": None, "pos": Counter(), "war": {}})
    for f in sorted(glob.glob(str(HIST / "waa_war_*.csv"))):
        m = re.search(r"waa_war_(\d{4})\.csv$", f)
        if not m:
            continue                      # skips waa_war_career.csv
        season = int(m.group(1))
        if since and season < since:
            continue
        if until and season > until:
            continue
        with open(f, encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                p = out[r["player_id"]]
                p["name"] = r["name"]
                p["pos"][r["pos"]] += 1
                p["war"][season] = float(r["WAR"])
    return out


def qualify(players, bars=None, min_seasons=MIN_SEASONS):
    """position -> [rows], best first. A row is one franchise player."""
    bars = bars or FRANCHISE_BAR
    by_pos = defaultdict(list)
    for gsis, p in players.items():
        if not p["pos"]:
            continue
        pos = p["pos"].most_common(1)[0][0]
        bar = bars.get(pos)
        if bar is None:
            continue
        years = sorted(y for y, w in p["war"].items() if w >= bar)
        if len(years) < min_seasons:
            continue
        by_pos[pos].append({
            "gsis": gsis, "name": p["name"], "pos": pos,
            "seasons": len(years), "years": years,
            "best": round(max(p["war"].values()), 3),
            "career": round(sum(p["war"].values()), 3),
        })
    for rows in by_pos.values():
        rows.sort(key=lambda r: (-r["seasons"], -r["best"]))
    return by_pos


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", type=int, help="first season to count")
    ap.add_argument("--until", type=int, help="last season to count")
    ap.add_argument("--min-seasons", type=int, default=MIN_SEASONS)
    ap.add_argument("--json", action="store_true")
    for pos, bar in FRANCHISE_BAR.items():
        ap.add_argument(f"--{pos.lower()}-bar", type=float, default=bar,
                        help=f"{pos} threshold (default {bar})")
    args = ap.parse_args()
    bars = {p: getattr(args, f"{p.lower()}_bar") for p in FRANCHISE_BAR}
    players = load(args.since, args.until)
    if not players:
        raise SystemExit(f"no waa_war_<season>.csv under {HIST}")
    by_pos = qualify(players, bars, args.min_seasons)
    seasons = sorted({y for p in players.values() for y in p["war"]})
    if args.json:
        print(json.dumps({
            "seasons": [seasons[0], seasons[-1]], "bars": bars,
            "min_seasons": args.min_seasons,
            "counts": {p: len(r) for p, r in sorted(by_pos.items())},
            "players": by_pos,
        }, indent=1))
        return
    print(f"FRANCHISE PLAYERS · {seasons[0]}-{seasons[-1]} · "
          f"{args.min_seasons}+ qualifying seasons")
    for pos in ("QB", "RB", "WR", "TE"):
        rows = by_pos.get(pos) or []
        print(f"\n=== {pos} (bar {bars[pos]:.2f} WAR) — {len(rows)} players ===")
        print(f"{'#':>3} {'player':<24}{'ssns':>5}{'best':>7}{'career':>8}   years")
        for i, r in enumerate(rows, 1):
            print(f"{i:>3} {r['name']:<24}{r['seasons']:>5}{r['best']:>7.2f}"
                  f"{r['career']:>8.2f}   " + " ".join(map(str, r["years"])))
    print("\ncounts: " + "  ".join(f"{p} {len(by_pos.get(p) or [])}"
                                   for p in ("QB", "RB", "WR", "TE")))


if __name__ == "__main__":
    main()
