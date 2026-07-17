#!/usr/bin/env python3
"""
fetch_projections.py — pull Sleeper preseason projections for the upcoming
season and write each player's projected WAR-basis points, scaled to the
league's 13-game fantasy season.

Used by project_war.py to build the COMPOSITE stream (year 1 = half math,
half this external projection). Runs where there is network to Sleeper
(GitHub Actions data-refresh, or an on-computer session) — the cloud sandbox
cannot reach api.sleeper.app.

Pipeline:
  1. league scoring_settings  (GET /v1/league/<id>)   -> exact league scoring
  2. season projections       (projections/nfl/<season>?...position[]=...)
  3. league points = scoring . projected_stats  (+ TE reception premium)
  4. scale to 13 games: pts13 = league_pts / proj_gp * 13   (Sleeper totals
     are ~17 games; we want a full healthy 13-game fantasy season)
  5. write data/proj_sleeper.json  {pid: {pos, pts13}}  (+ meta)

NOTE: Sleeper's projections endpoint is undocumented and lives OFF the /v1
base (host api.sleeper.app, path /projections/nfl/...). If the shape changes,
adjust PROJ_URL / item parsing below — everything else is stable.

Usage: python scripts/fetch_projections.py [--season 2026] [--league-id ...]
"""
import argparse, json, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEAGUE_ID = "1312221243742621696"          # Big Dog Dynasty
V1 = "https://api.sleeper.app/v1"
PROJ_HOST = "https://api.sleeper.app"       # projections live off /v1
POSITIONS = ["QB", "RB", "WR", "TE"]
LEAGUE_GAMES = 13                           # 14-week fantasy season minus a bye
SLEEPER_GAMES_DEFAULT = 17                  # full NFL season (fallback if gp absent)


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))
    return None


def season_proj_url(season, pos):
    # e.g. https://api.sleeper.app/projections/nfl/2026?season_type=regular&position[]=RB&order_by=pts_ppr
    return (f"{PROJ_HOST}/projections/nfl/{season}"
            f"?season_type=regular&position[]={pos}&order_by=pts_ppr")


def score_line(stats, scoring, pos):
    """League points for a projected stat line: scoring . stats, plus the
    TE reception premium (bonus_rec_te applies only to tight ends)."""
    pts = 0.0
    for k, v in scoring.items():
        if k == "bonus_rec_te":
            continue                         # handled below (TE only)
        s = stats.get(k)
        if isinstance(s, (int, float)):
            pts += v * s
    if pos == "TE" and "bonus_rec_te" in scoring:
        pts += scoring["bonus_rec_te"] * stats.get("rec", 0) or 0.0
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=None, help="default: current from /state/nfl")
    ap.add_argument("--league-id", default=LEAGUE_ID)
    args = ap.parse_args()

    season = args.season
    if season is None:
        season = int(get(f"{V1}/state/nfl")["season"])

    league = get(f"{V1}/league/{args.league_id}")
    scoring = league.get("scoring_settings") or {}
    if not scoring:
        sys.exit("no scoring_settings on league; cannot score projections")

    out = {}
    for pos in POSITIONS:
        data = get(season_proj_url(season, pos))
        if not data:
            print(f"  WARN: no projection data for {pos} (check PROJ_URL/season)")
            continue
        for item in data:
            pid = str(item.get("player_id") or "")
            stats = item.get("stats") or {}
            if not pid or not stats:
                continue
            pts = score_line(stats, scoring, pos)
            gp = stats.get("gp") or SLEEPER_GAMES_DEFAULT
            pts13 = pts / gp * LEAGUE_GAMES if gp else pts
            out[pid] = {"pos": pos, "pts13": round(pts13, 2),
                        "proj_gp": round(float(gp), 1), "raw_pts": round(pts, 1)}
        print(f"  {pos}: {sum(1 for v in out.values() if v['pos'] == pos)} players")
        time.sleep(0.3)

    result = {"meta": {"season": season, "league_id": args.league_id,
                       "league_games": LEAGUE_GAMES, "players": len(out),
                       "note": "pts13 = league-scored projected points scaled to 13 games"},
              "players": out}
    dest = ROOT / "data" / "proj_sleeper.json"
    dest.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"wrote {dest}  ({len(out)} players, season {season})")


if __name__ == "__main__":
    main()
