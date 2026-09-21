#!/usr/bin/env python3
"""
usage_stats.py — the nflverse usage and efficiency figures, on the site.

nfl_features.py has shipped per-player-season SKILL features since 2026-09-11
(nfl_history/features_<season>.csv: target share, air-yard share, EPA per
dropback, CPOE, expected fantasy points from ffopportunity, and so on), but
only the projection models read them. Max, 2026-09-16: the player pages need
more stats and the leaderboard needs more to sort by. This puts a per-position
slice of that file where the site can reach it.

THE LEAGUE'S WINDOWS, NOT NFLVERSE'S (Max, 2026-09-16). nflverse's season is
weeks 1-18; the league's regular season stops at 14 and its playoffs run to
17. A receiver whose only catches came in weeks 15-18 read 0.00 league PPG
beside a +5 "vs expected", which is two windows pretending to be one. So this
reads the per-player-WEEK table nfl_features.py writes
(nfl_history/features_weekly_<season>.csv) and sums it over the league's own
phases, read off that season's matchups.json:

    reg    weeks 1 .. playoff_start-1     the regular season
    post   weeks playoff_start .. last    the bracket weeks
    both   weeks 1 .. last

Per league season on the site (2022 onward for Big Dog), one file:

    data/leagues/<key>/<season>/usage.json
        { "<sleeper pid>": { "reg":  { "g": games, "fp_exp_pg": …, … },
                             "post": { … }, "both": { … } } }

A window he never touched the ball in is absent, never a row of zeros. Every
key is nfl_features.py's own column name, so the Key on the leaderboard and
the script that computes the figure agree by construction. Each position
ships its own five (POS_COLS), plus two every position carries: `fp_diff_pg`,
actual minus expected fantasy points per game — finishing plus touchdown luck,
the regression candidate — and `snap_pct`, his offensive snaps over his team's
across the window's touched weeks (Max, 2026-09-17; the site shows it on the
box score, not the Maxalytics lens). The rates are computed the way the season file computes
them: season totals divided (attempt-weighted CPOE, EPA over dropbacks), with
the two shares nflverse ships weekly averaged over touched weeks.

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


def load_weekly(season):
    p = ROOT / "nfl_history" / f"features_weekly_{season}.csv"
    if not p.exists():
        return None
    with open(p, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def windows(mw):
    """the league's phases for a season, as (name, first_week, last_week).

    BOUNDED BY WHAT THE LEAGUE HAS PLAYED, not by its schedule (2026-09-21).
    `reg` used to end at playoff_start-1 whatever the date, so in September a
    player's league "regular season" ran to week 14 while the league had played
    one — and nflverse, which plays on its own calendar, handed back every NFL
    week up to today. 2026's usage.json said g:2 for 236 players against a
    league that had played [1]: the exact mismatched-window problem this file's
    docstring says it exists to prevent, arrived from the other end.

    build_site_data only writes a week into matchups.json once it has points,
    so its weeks ARE the played weeks. A phase with nothing in it yet is
    dropped rather than emitted backwards (post as "15-14"), and `aggregate`
    then leaves that key off the player, which the site reads as the em dash."""
    ps = int(mw.get("playoff_start") or 15)
    played = {e[0] for rows in (mw.get("teams") or {}).values() for e in rows}
    last_reg = max((w for w in played if w < ps), default=0)
    last_post = max((w for w in played if w >= ps), default=0)
    last = max(last_reg, last_post)
    out = [("reg", 1, last_reg), ("post", ps, last_post), ("both", 1, last)]
    # `both` is identical to `reg` for as long as the bracket hasn't started,
    # and is emitted anyway. Dropping the duplicate would halve the in-season
    # file, but the site's three phase chips read a missing window as the em
    # dash (src/lib/usage.ts `usageOf` returns null, src/views/Player.tsx dashes
    # the row), so "Both" would go blank for the whole regular season. A
    # duplicated window is cheaper than a blank chip.
    return [(n, lo, hi) for n, lo, hi in out if hi >= lo]


def aggregate(pos, weeks):
    """one window's figures from its touched weeks, or None when there are none"""
    if not weeks:
        return None
    n = len(weeks)
    tot = lambda k: sum(num(w.get(k)) or 0.0 for w in weeks)                # noqa: E731
    att, car, tgt, rec = tot("att"), tot("car"), tot("tgt"), tot("rec")
    db = att + tot("sacks")

    def mean_of(k):
        vals = [num(w.get(k)) for w in weeks]
        vals = [v for v in vals if v is not None]
        return sum(vals) / len(vals) if vals else None
    cp = [(num(w.get("cpoe")), num(w.get("att")) or 0.0) for w in weeks]
    cp = [(c, a) for c, a in cp if c is not None and a > 0]
    exp_w = [num(w.get("fp_exp")) for w in weeks]
    act_w = [num(w.get("fp_act")) for w in weeks]
    have_opp = any(v is not None for v in exp_w)
    fp_exp = sum(v or 0.0 for v in exp_w)
    fp_act = sum(v or 0.0 for v in act_w)
    ts, ays = mean_of("tgt_share"), mean_of("ay_share")
    every = {
        "fp_exp_pg": round(fp_exp / n, 2) if have_opp else None,
        "att_pg": round(att / n, 2), "car_pg": round(car / n, 2), "tgt_pg": round(tgt / n, 2),
        "epa_db": round(tot("pass_epa") / db, 4) if db else None,
        "cpoe": round(sum(c * a for c, a in cp) / sum(a for _, a in cp), 3) if cp else None,
        "tgt_share": round(ts, 4) if ts is not None else None,
        "ay_share": round(ays, 4) if ays is not None else None,
        "adot": round(tot("rec_ay") / tgt, 2) if tgt else None,
        "car_share": round(car / tot("team_car"), 4) if tot("team_car") else None,
        "rb_touch_share": (round((car + rec) / tot("team_rb_touch"), 4)
                           if pos == "RB" and tot("team_rb_touch") else None),
    }
    out = {"g": n}
    for c in POS_COLS[pos]:
        if every.get(c) is not None:
            out[c] = every[c]
    if have_opp:
        out["fp_diff_pg"] = round((fp_act - fp_exp) / n, 2)
    # snap share over the window: both sums over the weeks that have a snap
    # line, so a week the crosswalk missed drops out of numerator and
    # denominator together rather than reading as zero snaps
    sn = [(num(w.get("snaps")), num(w.get("team_snaps"))) for w in weeks]
    sn = [(a, b) for a, b in sn if a is not None and b]
    if sn:
        out["snap_pct"] = round(sum(a for a, _ in sn) / sum(b for _, b in sn), 4)
    return out


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
        rows = load_weekly(int(season))
        if rows is None:
            print(f"{season}: no nfl_history/features_weekly_{season}.csv — skipped "
                  "(run war-history.yml with the weekly table)")
            continue
        # SNAP SHARE ONLY EXISTS WHERE THE CSV CARRIES IT (Max, 2026-09-17).
        # The columns were added to nfl_features.py after the history corpus
        # was last rebuilt, so every season but the one data-refresh.yml
        # refreshes nightly is missing them and its snap_pct silently never
        # appears. Say so rather than shipping a quietly emptier season: the
        # remedy is re-dispatching war-history.yml over 2012..last.
        if rows and not ("snaps" in rows[0] and "team_snaps" in rows[0]):
            print(f"{season}: WARN features_weekly_{season}.csv has no snaps/"
                  "team_snaps columns — snap_pct will be absent for this season "
                  "(re-run war-history.yml to rebuild the weekly table)")
        try:
            mw = json.load(open(out / season / "matchups.json", encoding="utf-8"))
        except FileNotFoundError:
            print(f"{season}: no matchups.json — skipped")
            continue
        wins = windows(mw)
        by_player = {}          # gsis -> (pos, [touched weeks])
        for r in rows:
            if r.get("pos") not in CORE:
                continue
            by_player.setdefault(r["player_id"], (r["pos"], []))[1].append(r)
        usage, unmatched = {}, 0
        for gsis, (pos, wk_rows) in by_player.items():
            pid = by_gsis.get(gsis)
            if not pid:
                unmatched += 1
                continue
            rec = {}
            for name, lo, hi in wins:
                agg = aggregate(pos, [w for w in wk_rows if lo <= int(w["week"]) <= hi])
                if agg:
                    rec[name] = agg
            if rec:
                usage[pid] = rec
        atomic_write(out / season / "usage.json", json.dumps(usage, separators=(",", ":")))
        print(f"{season}: {len(usage)} players matched, {unmatched} nflverse rows without a "
              f"Sleeper match · {', '.join(f'{n} wk {lo}-{hi}' for n, lo, hi in wins)} "
              f"→ {out / season / 'usage.json'}")


if __name__ == "__main__":
    sys.exit(main())
