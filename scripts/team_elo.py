#!/usr/bin/env python3
"""
team_elo.py — an all-play Elo rating for every franchise, carried across seasons.

THE RULES (Max, 2026-10-12):

  * Every franchise starts at 1500 in the league's first season.
  * Ratings carry over between seasons untouched. There is no regression toward
    1500 in the offseason; the K schedule resetting each September does that
    job instead, letting early results move a rating quickly after a summer of
    roster churn.
  * K = MULT x (FLOOR + EARLY / week) = 1.5 x (40 + 40 / week): 120 in week 1,
    90 in week 2, 75 in week 4, about 64 by week 14. Week is the league week,
    so K resets to 120 every season.
  * The result is ALL-PLAY, not head-to-head. Each week a team's score is set
    against every other team's score, so a 12-team week is 11 results rather
    than one and the rating measures the roster, not the schedule.
  * One update per team per week, scaled to the WEEK rather than to each of the
    11 comparisons:

        delta = K x (actual all-play share - expected all-play share)

    actual = (wins + 0.5 x ties) / opponents; expected = the mean Elo win
    probability against those same opponents, all taken from the ratings as
    they stood BEFORE the week (so the update is order-independent and every
    week is zero-sum across the league).
  * Playoff weeks (>= playoff_start) are ignored, consolation included.

WHY THESE NUMBERS. Tuned against this league's 2022-2026 history so that a
mature season ends with the top team roughly a 90% favorite over the bottom one
(a ~380-point gap); the best all-play team out-scored the worst in 52 of 56
regular-season weeks 2022-25, so a gap much smaller than that understates how
different the rosters are. The cost is weekly moves of up to ~80 points.

Reads only committed data (<season>/matchups.json + teams.json), so it runs on
a fresh clone.

Output: data/leagues/<key>/elo.json

  {"meta": {...},
   "teams": {"<fkey>": {"elo": 1641.2, "rank": 3,
                        "seasons": {"2026": [[wk, elo, delta, ap_w, exp_w], ...]}}}}

`elo` is the rating after the last scored regular-season week. Each week row is
the rating AFTER that week, the change, the all-play wins (ties as 0.5) and the
all-play wins the ratings expected.
"""
import argparse
import json
import sys
from pathlib import Path

from ioutil import write_json
from leaguepaths import DataDir

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

START = 1500.0
MULT = 1.5
FLOOR = 40.0
EARLY = 40.0


def k_for(week):
    return MULT * (FLOOR + EARLY / week)


def expected(ra, rb):
    """Elo probability that a team rated ra beats one rated rb."""
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def run(seasons):
    """seasons: [(season, {week: {fkey: points}})] in order, playoff weeks
    already removed. Returns (ratings, history) where history is
    {fkey: {season: [[wk, elo, delta, ap_w, exp_w], ...]}}."""
    ratings, hist = {}, {}
    for season, weeks in seasons:
        for wk in sorted(weeks):
            pts = weeks[wk]
            if len(pts) < 2:
                continue
            for f in pts:
                ratings.setdefault(f, START)
            before = {f: ratings[f] for f in pts}
            k = k_for(wk)
            for f, p in pts.items():
                opps = [g for g in pts if g != f]
                w = sum(1.0 if p > pts[g] else 0.5 if p == pts[g] else 0.0 for g in opps)
                exp_w = sum(expected(before[f], before[g]) for g in opps)
                delta = k * (w - exp_w) / len(opps)
                ratings[f] = before[f] + delta
                hist.setdefault(f, {}).setdefault(season, []).append(
                    [wk, round(ratings[f], 1), round(delta, 1), w, round(exp_w, 2)])
    return ratings, hist


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8")) if Path(p).exists() else None


def season_weeks(sdir):
    """{week: {fkey: points}} for one season's scored regular-season weeks."""
    mu = load(sdir / "matchups.json")
    if not mu:
        return None
    teams = load(sdir / "teams.json") or []
    fkey = {str(t["roster_id"]): str(t.get("fkey") or t["roster_id"]) for t in teams}
    ps = mu.get("playoff_start") or 15
    weeks = {}
    for rid, rows in (mu.get("teams") or {}).items():
        for e in rows:
            wk, p = e[0], e[1]
            if wk >= ps or p is None:
                continue
            weeks.setdefault(wk, {})[fkey.get(str(rid), str(rid))] = float(p)
    # a week nobody has scored in yet is not a week of results
    return {wk: v for wk, v in weeks.items() if any(x != 0 for x in v.values())}


def main():
    ap = argparse.ArgumentParser(description="all-play team Elo")
    ap.add_argument("--probe", action="store_true", help="compute and print, write nothing")
    ap.add_argument("--league", help="founding league_id; default the registry's")
    args = ap.parse_args()

    ld = Path(str(DataDir(ROOT / "data", args.league) if args.league else DATA))
    seasons = sorted(d.name for d in ld.iterdir()
                     if d.is_dir() and d.name.isdigit() and (d / "matchups.json").exists())
    data = [(s, w) for s in seasons if (w := season_weeks(ld / s))]
    if not data:
        sys.exit("no season has scored matchups — run build_site_data.py first")

    ratings, hist = run(data)
    names = {}
    for s in seasons:
        for t in load(ld / s / "teams.json") or []:
            names[str(t.get("fkey") or t["roster_id"])] = t.get("manager") or t.get("team")
    order = sorted(ratings, key=lambda f: -ratings[f])
    last_season, last_weeks = data[-1]
    print(f"team Elo · K = {MULT:g} x ({FLOOR:g} + {EARLY:g}/week) · all-play · "
          f"through {last_season} week {max(last_weeks)}")
    for i, f in enumerate(order, 1):
        print(f"  {i:>2}. {names.get(f, f):<16} {ratings[f]:7.1f}")
    if args.probe:
        print("\nprobe: nothing written")
        return

    write_json(ld / "elo.json", {
        "meta": {
            "k": f"{MULT:g} x ({FLOOR:g} + {EARLY:g} / week)",
            "mult": MULT, "floor": FLOOR, "early": EARLY, "start": START,
            "result": "all-play",
            "scope": "regular season only; playoff weeks excluded",
            "through": {"season": last_season, "week": max(last_weeks)},
            "row": ["week", "elo_after", "delta", "allplay_w", "expected_w"],
        },
        "teams": {f: {"elo": round(ratings[f], 1), "rank": i,
                      "seasons": hist.get(f, {})}
                  for i, f in enumerate(order, 1)},
    }, separators=(",", ":"))
    print(f"\nwrote {ld / 'elo.json'}")


if __name__ == "__main__":
    main()
