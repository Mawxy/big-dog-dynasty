#!/usr/bin/env python3
"""
nfl_history.py — shape nflverse data (2014+) into a sleeper_pull.py-style
dump so sleeper_war.py runs UNCHANGED on historical NFL seasons.

Why: aging curves and pick-value bridges (WAR valuation model) need more
seasons of WAR than the league's own 2022+ history. This adapter imposes the
league's exact shape on raw NFL data:

  * league scoring recomputed weekly from raw components (PPR + 0.5 TE
    premium, superflex) — scoring dict pulled from the live league and frozen
    below;
  * the settled 2026-07-17 played rule, position-dependent:
      QB       — offensive participation only (off snaps or offensive stats);
      RB/WR/TE — dressed = played (any snaps in any phase, or any stats).
      Historical caveat: a dressed player with zero snaps in EVERY phase is
      invisible in nflverse; treated as DNP. Negligible.
  * the league's startable-pool shape (12 QB / 24 RB / 36 WR / 12 TE + 12 SF
    + 12 FLEX weekly, greedy by points — reuses sleeper_war.build_week);
  * 12 synthetic team scores per week for the sigma step: the 108 startable
    slots are dealt into 12 legal lineups (slot-wise, seeded shuffle, so runs
    are reproducible), then the 12 scores are rescaled around their weekly
    mean so their sample stdev hits CV_TARGET * mean. The raw slot-wise deal
    makes 12 near-equal rosters whose scores cluster far tighter than a real
    league's (measured 2026-07-17: historical WAR ran 1.4-1.55x the real
    league's for identical player-seasons), so sigma is calibrated to the
    real league instead: CV (sigma/mean of the 12 weekly team scores) was
    0.195/0.217/0.208/0.242 over 2022-2025 (sample stdev, weeks 1-14),
    pooled mean 0.216, uncorrelated with weekly scoring level (R^2 = 0.02).
    One constant across all eras keeps seasons comparable. Player points are
    untouched — only team `points` (the engine's sigma input) is rescaled,
    so team points no longer equal the sum of players_points (true in the
    real league too, where `points` covers starters only).

Weeks 1-14 only (the league's regular season), season_type REG.

Output layout (mirrors sleeper_pull.py):
  <out>/players.json                      gsis_id -> {position, first/last name}
  <out>/players_meta.csv                  + birth_date, draft season/round/pick
  <out>/<season>/league.json              synthetic league shell
  <out>/<season>/matchups/week_NN.json    12 teams: points + players_points
  <out>/<season>/played/week_NN.json      pid -> NFL team (settled played rule)

Then:  python scripts/sleeper_war.py --data <out>

Requires: pip install nflreadpy   (Python port of nflreadr; no R needed)
Run on GitHub Actions (war-history.yml) — nflverse downloads are blocked in
some sandboxes.
"""
import argparse, csv, json, random, statistics, sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sleeper_war import build_week, slot_counts  # reuse the engine's pool logic

# ---------------------------------------------------------------- scoring ---
# Frozen from the live league (league_id 1312221243742621696, fetched
# 2026-07-17). Offensive components only — no K/DEF in the WAR pool.
# Not implementable from nflverse and skipped (all rare/small):
#   pass_int_td (-2 extra for pick-six thrown), fum_rec_td.
SCORING = {
    "pass_yd": 0.04, "pass_td": 4.0, "pass_int": -2.0, "pass_2pt": 2.0,
    "rush_yd": 0.1, "rush_td": 6.0, "rush_2pt": 2.0,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0, "rec_2pt": 2.0,
    "bonus_rec_te": 0.5,            # TE premium, per reception
    "fum": -1.0, "fum_lost": -1.0,  # fum = any fumble; fum_lost stacks on top
    "st_td": 6.0,                   # kick/punt-return TDs credit the player
}
ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "SUPER_FLEX"]
CORE = {"QB", "RB", "WR", "TE"}
N_TEAMS = 12
LAST_WEEK = 14          # league regular season = weeks 1-14 (playoffs wk 15+)
CV_TARGET = 0.216       # weekly sigma/mean of team scores; pooled real-league
                        # 2022-2025 (sample stdev, n=12) — see module docstring


def g(row, *names, default=0.0):
    """First present, non-None field among alternate nflverse column names
    (the 2024 nflverse stats rebuild renamed several columns)."""
    for n in names:
        v = row.get(n)
        if v is not None:
            return v
    return default


def score_row(row, pos):
    """League fantasy points from a raw nflverse weekly-stats row."""
    fum = (g(row, "rushing_fumbles") + g(row, "receiving_fumbles")
           + g(row, "sack_fumbles"))
    fum_lost = (g(row, "rushing_fumbles_lost") + g(row, "receiving_fumbles_lost")
                + g(row, "sack_fumbles_lost"))
    rec = g(row, "receptions")
    pts = (
        SCORING["pass_yd"] * g(row, "passing_yards")
        + SCORING["pass_td"] * g(row, "passing_tds")
        + SCORING["pass_int"] * g(row, "passing_interceptions", "interceptions")
        + SCORING["pass_2pt"] * g(row, "passing_2pt_conversions")
        + SCORING["rush_yd"] * g(row, "rushing_yards")
        + SCORING["rush_td"] * g(row, "rushing_tds")
        + SCORING["rush_2pt"] * g(row, "rushing_2pt_conversions")
        + SCORING["rec"] * rec
        + SCORING["rec_yd"] * g(row, "receiving_yards")
        + SCORING["rec_td"] * g(row, "receiving_tds")
        + SCORING["rec_2pt"] * g(row, "receiving_2pt_conversions")
        + SCORING["fum"] * fum
        + SCORING["fum_lost"] * fum_lost
        + SCORING["st_td"] * g(row, "special_teams_tds")
    )
    if pos == "TE":
        pts += SCORING["bonus_rec_te"] * rec
    return round(pts, 2)


def has_off_stats(row):
    """Any offensive box-score involvement (the stat-line side of the rule)."""
    return any(g(row, k) for k in (
        "attempts", "completions", "passing_yards", "carries", "rushing_att",
        "rushing_yards", "targets", "receptions", "receiving_yards",
        "sacks_suffered", "sacks", "passing_2pt_conversions",
        "rushing_2pt_conversions", "receiving_2pt_conversions"))


def row_played_hist(pos, off_snp, def_snp, st_snp, stat_row):
    """Settled 2026-07-17 played rule on nflverse inputs (mirrors
    sleeper_pull.row_played)."""
    if pos == "QB":
        return bool(off_snp) or (stat_row is not None and has_off_stats(stat_row))
    return bool(off_snp or def_snp or st_snp) or (
        stat_row is not None and has_off_stats(stat_row))


# ------------------------------------------------------- team synthesis -----
def assign_slots(points, positions, slots):
    """Mirror build_week's greedy fill but keep WHICH slot each startable
    player took, so lineups can be dealt to synthetic teams."""
    pool = sorted(points, key=lambda p: -points[p])
    open_slots = dict(slots)
    groups = defaultdict(list)      # slot label -> [pid] (points-sorted)
    leftovers = []
    for pid in pool:
        pos = positions[pid]
        if open_slots.get(pos, 0) > 0:
            open_slots[pos] -= 1
            groups[pos].append(pid)
        else:
            leftovers.append(pid)
    rest = []
    for pid in leftovers:
        pos = positions[pid]
        if pos in {"RB", "WR", "TE"} and open_slots.get("FLEX", 0) > 0:
            open_slots["FLEX"] -= 1
            groups["FLEX"].append(pid)
        elif pos in CORE and open_slots.get("SUPER_FLEX", 0) > 0:
            open_slots["SUPER_FLEX"] -= 1
            groups["SUPER_FLEX"].append(pid)
        else:
            rest.append(pid)
    return groups, rest


def calibrate_scores(scores, cv=CV_TARGET):
    """Rescale the 12 team scores around their mean so their sample stdev
    equals cv * mean (the real league's measured spread). Preserves the mean
    and each team's relative position; only the spread changes."""
    m = statistics.mean(scores)
    s = statistics.stdev(scores)
    if s <= 0 or m <= 0:
        return scores
    f = (cv * m) / s
    return [round(m + (x - m) * f, 2) for x in scores]


def synth_teams(points, positions, slots, seed):
    """Deal the startable slots into 12 legal lineups (seeded, reproducible)
    and spread the rest of the player universe across teams. Team 'points'
    drive the engine's weekly sigma and are calibrated to the real league's
    spread (calibrate_scores); players_points carry the full pool so
    replacement baselines see every played player."""
    groups, rest = assign_slots(points, positions, slots)
    rng = random.Random(seed)
    team_players = [[] for _ in range(N_TEAMS)]
    for slot, pids in sorted(groups.items()):
        pids = pids[:]
        rng.shuffle(pids)
        for i, pid in enumerate(pids):
            team_players[i % N_TEAMS].append(pid)
    raw = [sum(points[p] for p in pids) for pids in team_players]
    cal = calibrate_scores(raw)
    teams = []
    for i, pids in enumerate(team_players):
        teams.append({
            "roster_id": i + 1,
            "points": cal[i],
            "players_points": {p: points[p] for p in pids},
        })
    for j, pid in enumerate(rest):   # non-startable universe, round-robin
        teams[j % N_TEAMS]["players_points"][pid] = points[pid]
    return teams


# ------------------------------------------------------------ data pull -----
def pull_season(season, players_pos, pfr_to_gsis, nfl):
    """Return (points, positions, teams_of, played) per week for one season."""
    import polars as pl
    stats = nfl.load_player_stats([season], summary_level="week")
    stats = stats.filter(pl.col("season_type") == "REG").to_dicts()
    snaps = nfl.load_snap_counts([season])
    snaps = snaps.filter(pl.col("game_type") == "REG").to_dicts()

    stat_by = {}          # (week, gsis) -> row
    for r in stats:
        pid = r.get("player_id")
        wk = r.get("week")
        if pid and wk and 1 <= wk <= LAST_WEEK:
            stat_by[(wk, pid)] = r

    snap_by = {}          # (week, gsis) -> (off, def, st)
    for r in snaps:
        gsis = pfr_to_gsis.get(r.get("pfr_player_id"))
        wk = r.get("week")
        if gsis and wk and 1 <= wk <= LAST_WEEK:
            snap_by[(wk, gsis)] = (g(r, "offense_snaps"), g(r, "defense_snaps"),
                                   g(r, "st_snaps"))

    weeks = {}
    for wk in range(1, LAST_WEEK + 1):
        points, positions, played = {}, {}, {}
        pids = {p for w, p in stat_by if w == wk} | {p for w, p in snap_by if w == wk}
        for pid in pids:
            pos = players_pos.get(pid)
            if pos not in CORE:
                continue
            srow = stat_by.get((wk, pid))
            osnp, dsnp, ssnp = snap_by.get((wk, pid), (0, 0, 0))
            if not row_played_hist(pos, osnp, dsnp, ssnp, srow):
                continue
            points[pid] = score_row(srow, pos) if srow else 0.0
            positions[pid] = pos
            played[pid] = (srow or {}).get("team") or (srow or {}).get("recent_team") or ""
        weeks[wk] = (points, positions, played)
    return weeks


def main():
    ap = argparse.ArgumentParser(description="nflverse -> sleeper_war-shaped dump")
    ap.add_argument("--start", type=int, default=2014)
    ap.add_argument("--end", type=int, default=2025)
    ap.add_argument("--out", default="nfl_history_data")
    args = ap.parse_args()

    import nflreadpy as nfl
    out = Path(args.out)

    print("loading player map + draft picks…")
    players_df = nfl.load_players().to_dicts()
    draft = {}
    for r in nfl.load_draft_picks().to_dicts():
        gid = r.get("gsis_id")
        if gid:
            draft[gid] = (r.get("season"), r.get("round"), r.get("pick"))

    players_pos, pfr_to_gsis, players_json, meta_rows = {}, {}, {}, []
    for p in players_df:
        gid = g(p, "gsis_id", default=None)
        if not gid:
            continue
        pos = g(p, "position", default=None)
        pfr = g(p, "pfr_id", "pfr_player_id", default=None)
        if pfr:
            pfr_to_gsis[pfr] = gid
        if pos in CORE:
            players_pos[gid] = pos
            first = g(p, "first_name", default="") or ""
            last = g(p, "last_name", default="") or ""
            if not (first or last):
                first = g(p, "display_name", "player_name", default=str(gid))
            players_json[gid] = {"position": pos, "first_name": first,
                                 "last_name": last}
            d = draft.get(gid, (None, None, None))
            meta_rows.append([gid, f"{first} {last}".strip(), pos,
                              g(p, "birth_date", "birthdate", default=""),
                              d[0] or "", d[1] or "", d[2] or ""])

    out.mkdir(parents=True, exist_ok=True)
    (out / "players.json").write_text(json.dumps(players_json), encoding="utf-8")
    with open(out / "players_meta.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["gsis_id", "name", "pos", "birth_date",
                    "draft_season", "draft_round", "draft_pick"])
        w.writerows(meta_rows)
    print(f"players.json: {len(players_json)} QB/RB/WR/TE")

    league = {"season": None, "total_rosters": N_TEAMS,
              "roster_positions": ROSTER_POSITIONS,
              "settings": {"playoff_week_start": LAST_WEEK + 1},
              "name": "NFL history (synthetic, league-shaped)"}
    slots = slot_counts(league)

    import nflreadpy  # noqa: F401  (already imported; keeps intent obvious)
    for season in range(args.start, args.end + 1):
        print(f"season {season}…")
        weeks = pull_season(season, players_pos, pfr_to_gsis, nfl)
        sdir = out / str(season)
        (sdir / "matchups").mkdir(parents=True, exist_ok=True)
        (sdir / "played").mkdir(parents=True, exist_ok=True)
        lg = dict(league, season=str(season))
        (sdir / "league.json").write_text(json.dumps(lg), encoding="utf-8")
        for wk, (points, positions, played) in weeks.items():
            if not points:
                continue
            teams = synth_teams(points, positions, slots, seed=f"{season}-{wk}")
            (sdir / "matchups" / f"week_{wk:02d}.json").write_text(
                json.dumps(teams), encoding="utf-8")
            (sdir / "played" / f"week_{wk:02d}.json").write_text(
                json.dumps(played), encoding="utf-8")
        n = sum(1 for w in weeks.values() if w[0])
        print(f"  {n} weeks written")

    print(f"done → {out}\nnow run: python scripts/sleeper_war.py --data {out}")


if __name__ == "__main__":
    main()
