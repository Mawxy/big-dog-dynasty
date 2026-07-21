#!/usr/bin/env python3
"""
sleeper_war.py — per-player WAA (wins above average) and WAR (wins above
replacement) computed from a sleeper_pull.py data dump.

How it works, per season and per week:

1. Player points come from matchups/week_NN.json players_points — these are
   already scored with YOUR league's exact ruleset (PPR, TE premium, etc.).

2. The league-wide "startable pool" is built empirically from the roster
   settings. For a 12-team QB/2RB/3WR/TE/FLEX/SF league that's 12 QB, 24 RB,
   36 WR, 12 TE dedicated slots, then the best remaining players fill the 12
   SUPER_FLEX (QB/RB/WR/TE) and 12 FLEX (RB/WR/TE) slots by actual points.
   So "is WR48 better than RB25 or TE13?" is answered by the data each week —
   whoever scores more takes the flex.

3. Baselines per position per week:
     average starter  = mean points of startable players at that position
     replacement      = best player at that position left OUT of the pool
                        (the true next-man-up once every flex is filled)

4. Points -> wins, computed WEEK BY WEEK: each week's win shift uses that
   week's own distribution of team scores in your league. Adding X points to
   an average team changes its win probability by
   phi(X / (sigma_week*sqrt(2))) - 0.5 (opponent is an independent draw from
   the same week's distribution). So a monster game in a low-scoring week
   converts to more wins than the same margin in a shootout week. Weekly win
   shifts are summed over the regular season.

   WAA = sum of weekly win shift vs the average starter at the position
   WAR = sum of weekly win shift vs replacement level

Usage:
  python sleeper_war.py --data C:\\Users\\maxwa\\sleeper_data
  python sleeper_war.py --data sleeper_data --season 2025 --top 30

Requires the dump to include players.json (run sleeper_pull.py with --players).
Outputs CSVs into <data>/analysis/.
"""
import argparse, csv, json, math, statistics
from collections import defaultdict
from pathlib import Path

CORE = {"QB", "RB", "WR", "TE"}

# Multi-position slots, mapped to the positions they accept. Sleeper uses
# distinct names per league era: this league family ran WRRB_FLEX in 2018-19
# and REC_FLEX in 2020 before settling on FLEX + SUPER_FLEX.
FLEX_SLOTS = {
    "WRRB_FLEX":  {"RB", "WR"},
    "REC_FLEX":   {"WR", "TE"},
    "FLEX":       {"RB", "WR", "TE"},
    "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
}
# Filled most-restrictive-first so a narrow slot is not stranded by a player
# who also fits a wider one. Ties broken by the order above.
FLEX_ORDER = sorted(FLEX_SLOTS, key=lambda s: len(FLEX_SLOTS[s]))

# Bench/reserve slots occupy roster_positions but never start anyone.
NON_STARTING_SLOTS = {"BN", "IR", "TAXI"}

def norm_win_shift(points, sigma):
    """Change in single-week win probability from adding `points` to an average team."""
    if sigma <= 0:
        return 0.0
    z = points / (sigma * math.sqrt(2))
    return 0.5 * (1 + math.erf(z / math.sqrt(2))) - 0.5

def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))

def player_pos(players, pid):
    p = players.get(pid)
    if not p:
        return None
    pos = p.get("position") or (p.get("fantasy_positions") or [None])[0]
    return pos if pos in CORE else None

def player_name(players, pid):
    p = players.get(pid)
    return f"{p.get('first_name','')} {p.get('last_name','')}".strip() if p else f"#{pid}"

def slot_counts(league):
    per_team = defaultdict(int)
    for s in league["roster_positions"]:
        per_team[s] += 1
    unknown = sorted(set(per_team) - CORE - set(FLEX_SLOTS) - NON_STARTING_SLOTS)
    if unknown:
        # Silently ignoring a starting slot shrinks the league-wide startable
        # pool, which lowers replacement level and inflates every WAR in the
        # season. Fail loudly instead.
        raise ValueError(
            f"unrecognized roster slot(s) {unknown} in league "
            f"{league.get('league_id')} ({league.get('season')}); add them to "
            f"FLEX_SLOTS or NON_STARTING_SLOTS in sleeper_war.py"
        )
    n = league["total_rosters"]
    return {s: c * n for s, c in per_team.items()}

def build_week(points, positions, slots):
    """Greedy league-wide optimal lineup. Returns (startable ids, avg baseline, repl baseline)."""
    pool = sorted((pid for pid in points if positions.get(pid)),
                  key=lambda x: -points[x])
    open_slots = dict(slots)  # e.g. {"QB":12,"RB":24,"WR":36,"TE":12,"FLEX":12,"SUPER_FLEX":12}
    startable, leftovers = set(), []
    for pid in pool:                              # dedicated positional slots first
        pos = positions[pid]
        if open_slots.get(pos, 0) > 0:
            open_slots[pos] -= 1
            startable.add(pid)
        else:
            leftovers.append(pid)
    rest = []
    for pid in leftovers:                         # then flex slots by points
        pos = positions[pid]
        for slot in FLEX_ORDER:                   # narrowest slot this player fits
            if pos in FLEX_SLOTS[slot] and open_slots.get(slot, 0) > 0:
                open_slots[slot] -= 1
                startable.add(pid)
                break
        else:
            rest.append(pid)
    avg, repl = {}, {}
    for pos in CORE:
        started = [points[p] for p in startable if positions[p] == pos]
        if started:
            avg[pos] = statistics.mean(started)
        nxt = next((p for p in rest if positions[p] == pos), None)  # rest is points-sorted
        repl[pos] = points[nxt] if nxt else 0.0
    return startable, avg, repl

def run_season(season_dir: Path, players, args):
    league = load_json(season_dir / "league.json")
    slots = slot_counts(league)
    playoff_start = league.get("settings", {}).get("playoff_week_start", 15)
    weeks = sorted((season_dir / "matchups").glob("week_*.json"))
    if not weeks:
        return None

    team_scores = []
    acc = defaultdict(lambda: {"pts": 0.0, "gp": 0, "paa": 0.0, "par": 0.0,
                               "waa": 0.0, "war": 0.0})
    weekly_rows = []

    # first pass: team score distribution PER WEEK (a big game in a
    # low-scoring week is worth more wins than in a shootout week)
    week_scores = defaultdict(list)
    for wf in weeks:
        wk = int(wf.stem.split("_")[1])
        if wk >= playoff_start and not args.include_playoffs:
            continue
        for team in load_json(wf):
            if team.get("points"):
                team_scores.append(team["points"])
                week_scores[wk].append(team["points"])
    if len(team_scores) < 4:
        return None
    sigma = statistics.stdev(team_scores)          # season-wide, fallback only
    sigmas = {wk: (statistics.stdev(v) if len(v) >= 2 else sigma)
              for wk, v in week_scores.items()}

    for wf in weeks:
        wk = int(wf.stem.split("_")[1])
        if wk >= playoff_start and not args.include_playoffs:
            continue
        # who actually played (from Sleeper's stats feed, saved by sleeper_pull).
        # With it, a true 0.00-point game counts (and accrues negative value)
        # while byes/inactives are excluded. Without it (older dumps), fall
        # back to treating 0.00 as did-not-play.
        pfile = season_dir / "played" / f"week_{wk:02d}.json"
        played = set(load_json(pfile)) if pfile.exists() else None
        points, positions = {}, {}
        for team in load_json(wf):
            for pid, pts in (team.get("players_points") or {}).items():
                pos = player_pos(players, pid)
                if not pos or pts is None:
                    continue
                if played is not None:
                    if pid not in played:
                        continue
                elif not pts:
                    continue
                points[pid], positions[pid] = pts, pos
        if not points:
            continue
        startable, avg, repl = build_week(points, positions, slots)
        sig = sigmas.get(wk, sigma)                # pure weekly sigma
        for pid, pts in points.items():
            pos = positions[pid]
            paa, par = pts - avg[pos], pts - repl[pos]
            waa_w, war_w = norm_win_shift(paa, sig), norm_win_shift(par, sig)
            a = acc[pid]
            a["pts"] += pts; a["gp"] += 1
            a["paa"] += paa; a["par"] += par
            a["waa"] += waa_w
            a["war"] += war_w
            weekly_rows.append([league["season"], wk, pid, player_name(players, pid),
                                pos, round(pts, 2), round(paa, 2), round(par, 2),
                                round(waa_w, 4), round(war_w, 4), round(sig, 1),
                                int(pid in startable)])
    return league["season"], sigma, acc, weekly_rows, players

def write_csv(path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(header); w.writerows(rows)
    print(f"wrote {path}")

def main():
    ap = argparse.ArgumentParser(description="Compute WAA/WAR from a sleeper_pull.py dump.")
    ap.add_argument("--data", default="sleeper_data", help="Folder created by sleeper_pull.py")
    ap.add_argument("--season", help="Only this season (default: all found)")
    ap.add_argument("--top", type=int, default=25, help="Rows to print per season")
    ap.add_argument("--include-playoffs", action="store_true",
                    help="Include playoff weeks (default: regular season only)")
    args = ap.parse_args()

    root = Path(args.data)
    pfile = root / "players.json"
    if not pfile.exists():
        raise SystemExit("players.json missing — rerun sleeper_pull.py with --players")
    players = load_json(pfile)

    career = defaultdict(lambda: {"pts": 0.0, "gp": 0, "waa": 0.0, "war": 0.0, "pos": ""})
    seasons = [d for d in sorted(root.iterdir())
               if d.is_dir() and (d / "matchups").exists()
               and (not args.season or d.name == args.season)]
    for sdir in seasons:
        res = run_season(sdir, players, args)
        if not res:
            print(f"{sdir.name}: no scored weeks, skipping")
            continue
        season, sigma, acc, weekly, _ = res
        rows = []
        for pid, a in acc.items():
            pos = player_pos(players, pid)
            rows.append([pid, player_name(players, pid), pos, a["gp"],
                         round(a["pts"], 1), round(a["pts"]/a["gp"], 2),
                         round(a["paa"], 1), round(a["par"], 1),
                         round(a["waa"], 3), round(a["war"], 3)])
            c = career[pid]
            c["pts"] += a["pts"]; c["gp"] += a["gp"]
            c["waa"] += a["waa"]; c["war"] += a["war"]; c["pos"] = pos
        rows.sort(key=lambda r: -r[9])
        hdr = ["player_id", "name", "pos", "gp", "pts", "ppg",
               "pts_above_avg", "pts_above_repl", "WAA", "WAR"]
        write_csv(root / "analysis" / f"waa_war_{season}.csv", hdr, rows)
        write_csv(root / "analysis" / f"weekly_detail_{season}.csv",
                  ["season", "week", "player_id", "name", "pos", "pts",
                   "pts_above_avg", "pts_above_repl", "WAA_week", "WAR_week",
                   "week_sigma", "startable"], weekly)
        print(f"\n=== {season}  (team-score sigma {sigma:.1f}) — top {args.top} by WAR ===")
        print(f"{'name':<24}{'pos':<5}{'gp':>3}{'ppg':>7}{'WAA':>8}{'WAR':>8}")
        for r in rows[:args.top]:
            print(f"{r[1][:23]:<24}{r[2]:<5}{r[3]:>3}{r[5]:>7}{r[8]:>8}{r[9]:>8}")

    crows = sorted(([pid, player_name(players, pid), c["pos"], c["gp"],
                     round(c["pts"], 1), round(c["waa"], 3), round(c["war"], 3)]
                    for pid, c in career.items()), key=lambda r: -r[6])
    write_csv(root / "analysis" / "waa_war_career.csv",
              ["player_id", "name", "pos", "gp", "pts", "WAA", "WAR"], crows)

if __name__ == "__main__":
    main()
