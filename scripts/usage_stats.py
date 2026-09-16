#!/usr/bin/env python3
"""
usage_stats.py — the nflverse usage and efficiency figures, on the site.

nfl_features.py has shipped per-player-season SKILL features since 2026-09-11
(nfl_history/features_<season>.csv: target share, air-yard share, EPA per
dropback, CPOE, expected fantasy points from ffopportunity, and so on), but
only the projection models read them. Max, 2026-09-16: the player pages need
more stats and the leaderboard needs more to sort by. This puts a per-position
slice of that file where the site can reach it.

Per league season on the site (2022 onward for Big Dog), one file:

    data/leagues/<key>/<season>/usage.json
        { "<sleeper pid>": { "g": games, "fp_exp_pg": …, "fp_diff_pg": …,
                             "att_pg": …, "car_pg": …, "epa_db": …, "cpoe": …,
                             "tgt_pg": …, "tgt_share": …, "ay_share": …,
                             "adot": …, "car_share": …, "rb_touch_share": … } }

Every key is the CSV's own column name, so the Key on the leaderboard and the
script that computes the figure agree by construction. Each position ships its
own five (POS_COLS); a figure the CSV leaves blank is absent, never 0.
`fp_diff_pg` is the one derived figure: actual minus expected fantasy points
per game — finishing plus touchdown luck, the regression candidate.

THE JOIN is nflverse gsis_id -> Sleeper pid by name and position, through
project_war.py's match_meta over nfl_history/players_meta.csv — the same
matcher the projections use, so a player matched there is matched here. The
site's players_min.json is the Sleeper side: every player the site can link
to. Unmatched rows are counted and reported, never guessed.

Runs after build_site_data.py (players_min.json) and before shard_players.py,
which folds each player's seasons into his shard for the player page. Reads
only committed files; no network.

    python scripts/usage_stats.py [--out data]
"""
import argparse
import csv
import json
import sys
from pathlib import Path

from ioutil import atomic_write
from leaguepaths import DataDir
from project_war import build_meta_index, match_meta

ROOT = Path(__file__).resolve().parent.parent

# THE POSITION'S OWN FIVE (Max, 2026-09-16), in the order a reader meets them
# on the board. Expected PPG is common to all four; the other four are what
# usage means at that position. A running back's CPOE off one trick-play throw
# and a quarterback's air-yard share are in the CSV and are not figures, so
# they do not ship.
POS_COLS = {
    "QB": ["fp_exp_pg", "att_pg", "car_pg", "epa_db", "cpoe"],
    "RB": ["fp_exp_pg", "car_pg", "tgt_share", "car_share", "rb_touch_share"],
    "WR": ["fp_exp_pg", "tgt_pg", "tgt_share", "ay_share", "adot"],
    "TE": ["fp_exp_pg", "tgt_pg", "tgt_share", "ay_share", "adot"],
}
CORE = set(POS_COLS)


def num(s):
    """a CSV cell as a float, or None for blank / NaN"""
    if s is None or s == "" or s == "nan":
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return None if v != v else v


def load_features(season):
    p = ROOT / "nfl_history" / f"features_{season}.csv"
    if not p.exists():
        return None
    with open(p, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    ap = argparse.ArgumentParser(description="nflverse usage/efficiency -> per-season usage.json")
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    out = DataDir(Path(args.out))

    pmin = json.load(open(out / "players_min.json", encoding="utf-8"))
    meta = json.load(open(out / "meta.json", encoding="utf-8"))
    idx = build_meta_index()

    # Sleeper pid -> gsis, via the projections' matcher. Built once: the
    # matcher is name+position, which does not change by season.
    gsis_of = {}
    for pid, (name, pos, *_rest) in pmin.items():
        if pos not in CORE:
            continue
        m = match_meta(name, pos, idx)
        if m and m[3]:
            gsis_of[pid] = m[3]
    by_gsis = {}
    for pid, g in gsis_of.items():
        by_gsis.setdefault(g, pid)

    for season in meta["seasons"]:
        rows = load_features(int(season))
        if rows is None:
            print(f"{season}: no nfl_history/features_{season}.csv — skipped")
            continue
        usage, unmatched = {}, 0
        for r in rows:
            if r.get("pos") not in CORE:
                continue
            pid = by_gsis.get(r["player_id"])
            if not pid:
                unmatched += 1
                continue
            games = num(r.get("games"))
            rec = {"g": int(games) if games else 0}
            for c in POS_COLS[r["pos"]]:
                v = num(r.get(c))
                if v is not None:
                    rec[c] = v
            exp, act = num(r.get("fp_exp")), num(r.get("fp_act"))
            if exp is not None and act is not None and games:
                rec["fp_diff_pg"] = round((act - exp) / games, 2)
            usage[pid] = rec
        atomic_write(out / season / "usage.json", json.dumps(usage, separators=(",", ":")))
        print(f"{season}: {len(usage)} players matched, {unmatched} nflverse rows without a "
              f"Sleeper match → {out / season / 'usage.json'}")


if __name__ == "__main__":
    sys.exit(main())
