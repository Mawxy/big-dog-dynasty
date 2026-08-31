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
import argparse, json, sys, time
from collections import Counter, defaultdict
from pathlib import Path
from ioutil import atomic_write
from leaguepaths import DataDir
# The shared Sleeper client, which is a BUG FIX here rather than a tidy-up. The
# local one this replaces sent no User-Agent, had no 429 handling, and — because
# HTTPError subclasses URLError — retried a 404 and a rate-limit four times over
# and then raised either way. It now identifies itself, treats a 404 as None,
# and backs off properly when Sleeper says slow down.
from sleeper_http import get


ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")
LEAGUE_ID = "1312221243742621696"          # Big Dog Dynasty (registry fallback)
V1 = "https://api.sleeper.app/v1"
PROJ_HOST = "https://api.sleeper.app"       # projections live off /v1
POSITIONS = ["QB", "RB", "WR", "TE"]
LEAGUE_GAMES = 13                           # our fantasy season: 14 weeks minus a bye
NFL_SEASON_GAMES = 17                       # a full NFL season is 17 GAMES (Sleeper's
                                            # gp=18 is weeks incl. the bye = a zero week)


def week_proj_url(season, week, pos):
    """The WEEKLY projection endpoint. Season-long rotowire covers only ~22% of
    QBs (77 of 355 for 2026) — starters and near-starters — and lists everyone
    else at ADP only. Weekly membership differs slightly, so a player can have
    a weekly line and no season line (Garrett Nussmeier, 2026)."""
    return (f"{PROJ_HOST}/projections/nfl/{season}/{week}"
            f"?season_type=regular&position[]={pos}&order_by=pts_ppr")


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
        # guard the STAT, not the product: `... * stats.get("rec") or 0.0` binds
        # `or` to the product and still raises if rec is present-but-null
        pts += scoring["bonus_rec_te"] * (stats.get("rec") or 0)
    return pts


def default_league_id():
    """The registry default's CURRENT-season league_id — scoring settings must
    come from the live season, and Sleeper mints a new id every year. Falls
    back to the hardcoded id when the registry or field is absent."""
    try:
        reg = json.loads((ROOT / "data" / "leagues.json").read_text(encoding="utf-8"))
        entry = next(l for l in reg["leagues"] if l["key"] == reg.get("default"))
        return entry.get("currentLeagueId") or LEAGUE_ID
    except (OSError, ValueError, KeyError, StopIteration):
        return LEAGUE_ID


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=None, help="default: current from /state/nfl")
    ap.add_argument("--debug-pid", default=None,
                    help="dump Sleeper's raw item for this player_id and exit "
                         "without writing — for diagnosing a player the app "
                         "shows points for but this file scores at 0")
    ap.add_argument("--survey", action="store_true",
                    help="report which projection SOURCES the endpoint returns "
                         "and how many carry real stat lines, then exit")
    ap.add_argument("--weeks", type=int, default=0, metavar="N",
                    help="probe the WEEKLY endpoint for weeks 1..N and report "
                         "coverage, then exit. Combine with --debug-pid.")
    ap.add_argument("--weekly-fallback", type=int, default=18, metavar="N",
                    help="for players the SEASON endpoint lists at ADP only, "
                         "sum weeks 1..N from the weekly endpoint instead. "
                         "0 disables.")
    ap.add_argument("--league-id", default=None,
                    help="default: the registry's current-season league id")
    args = ap.parse_args()
    league_id = args.league_id or default_league_id()

    season = args.season
    if season is None:
        state = get(f"{V1}/state/nfl")
        if not state:
            sys.exit("/state/nfl returned nothing; pass --season")
        season = int(state["season"])

    league = get(f"{V1}/league/{league_id}")
    # a 404 is now None rather than an HTTPError, so say which it was
    if not league:
        sys.exit(f"league {league_id} not found; cannot score projections")
    scoring = league.get("scoring_settings") or {}
    if not scoring:
        sys.exit("no scoring_settings on league; cannot score projections")

    def scored(stats):
        """A real projection touches at least one key the league scores. ADP
        plus gp is a LISTING, not a forecast."""
        return any(isinstance(stats.get(k), (int, float)) and stats[k]
                   for k in scoring)

    if args.weeks:
        print(f"WEEKLY coverage, {season} weeks 1-{args.weeks}")
        for pos in POSITIONS:
            seen, has = set(), set()
            for wk in range(1, args.weeks + 1):
                for item in get(week_proj_url(season, wk, pos)) or []:
                    pid = str(item.get("player_id") or "")
                    if not pid:
                        continue
                    seen.add(pid)
                    if scored(item.get("stats") or {}):
                        has.add(pid)
                time.sleep(0.2)
            print(f"  {pos}: {len(seen)} players seen · {len(has)} with a scored line")
            if args.debug_pid and str(args.debug_pid) in seen:
                print(f"    -> {args.debug_pid} IS in weekly "
                      f"({'scored' if str(args.debug_pid) in has else 'ADP-only'})")
        return

    if args.survey:
        for pos in POSITIONS:
            data = get(season_proj_url(season, pos)) or []
            comp, real, adp = Counter(), Counter(), Counter()
            for item in data:
                c = item.get("company") or "?"
                comp[c] += 1
                st = item.get("stats") or {}
                if scored(st):
                    real[c] += 1
                elif st:
                    adp[c] += 1
            print(f"\n  {pos}: {len(data)} items")
            for c, n in comp.most_common():
                print(f"    {c:14} {n:>5} items · {real[c]:>5} scored · {adp[c]:>5} ADP-only")
            time.sleep(0.3)
        return

    out = {}
    for pos in POSITIONS:
        data = get(season_proj_url(season, pos))
        if not data:
            print(f"  WARN: no projection data for {pos} (check PROJ_URL/season)")
            continue
        for item in data:
            pid = str(item.get("player_id") or "")
            stats = item.get("stats") or {}
            if args.debug_pid and pid == str(args.debug_pid):
                print(f"\n=== raw Sleeper item for {pid} ({pos}) ===")
                print(json.dumps(item, indent=1, sort_keys=True)[:2500])
                print("\nstat keys returned:", sorted(stats))
                print("keys that CONTRIBUTE under league scoring:",
                      {k: (scoring[k], stats[k]) for k in scoring
                       if isinstance(stats.get(k), (int, float)) and stats[k]}
                      or "NONE  <- this is why he scores 0")
                print("computed league points:", score_line(stats, scoring, pos))
                return
            if not pid or not stats:
                continue
            # An ADP-only record is a listing, not a forecast. Writing it as
            # pts13:0 made "no opinion" indistinguishable from "projected to
            # score nothing", and project_war.py reads a 0 as absent and falls
            # back to the pure-math stream — the optimistic path, handed to
            # exactly the unproven players who least deserve it.
            if not scored(stats):
                continue
            pts = score_line(stats, scoring, pos)
            # Sleeper totals are a full 17-game season; scale to our 13-game slate.
            pts13 = pts / NFL_SEASON_GAMES * LEAGUE_GAMES
            out[pid] = {"pos": pos, "pts13": round(pts13, 2),
                        "ppg": round(pts / NFL_SEASON_GAMES, 2),
                        "raw_pts": round(pts, 1)}

        # The weekly pass serves two consumers from one set of calls:
        #
        # 1. FALLBACK rows for anyone the season endpoint listed at ADP only.
        #    Aggregate coverage is nearly identical (76 scored QBs weekly vs 77
        #    season-long for 2026) but MEMBERSHIP differs, so this rescues a
        #    handful of real players rather than lifting coverage wholesale.
        # 2. A PER-ACTIVE-GAME ppg for everyone with weekly lines. Rotowire's
        #    season total bakes in an availability discount (Jayden Reed 2026:
        #    ~13.2 PPR every projected week but a 197.6 season total ≈ 15
        #    games), so season/17 published 11.7 while the Sleeper app showed
        #    13 — the site read as disagreeing with Sleeper when it was only
        #    dividing by scheduled games instead of played ones. ppg is now the
        #    mean of his projected weeks (what the app shows); pts13 stays the
        #    season-total expectation, availability discount included.
        if args.weekly_fallback:
            wk_pts, wk_n = defaultdict(float), defaultdict(int)
            for wk in range(1, args.weekly_fallback + 1):
                for item in get(week_proj_url(season, wk, pos)) or []:
                    pid = str(item.get("player_id") or "")
                    st = item.get("stats") or {}
                    if pid and st and scored(st):
                        wk_pts[pid] += score_line(st, scoring, pos)
                        wk_n[pid] += 1
                time.sleep(0.2)
            rescued = 0
            for pid, pts in wk_pts.items():
                if pid in out or pts <= 0:
                    continue
                out[pid] = {"pos": pos,
                            "pts13": round(pts / NFL_SEASON_GAMES * LEAGUE_GAMES, 2),
                            "ppg": round(pts / NFL_SEASON_GAMES, 2),
                            "raw_pts": round(pts, 1), "src": "weekly"}
                rescued += 1
            for pid, n in wk_n.items():
                if n and pid in out and out[pid]["pos"] == pos:
                    out[pid]["ppg"] = round(wk_pts[pid] / n, 2)
            if rescued:
                print(f"  {pos}: +{rescued} from the weekly endpoint")

        print(f"  {pos}: {sum(1 for v in out.values() if v['pos'] == pos)} players")
        time.sleep(0.3)

    dest = DATA / "proj_sleeper.json"
    # Every spring /state/nfl rolls to the new season before Sleeper publishes
    # projections for it — the endpoint then returns [] with HTTP 200. Writing
    # that would gut the committed file; exit non-zero and keep the old one
    # (data-refresh.yml treats this step as best-effort, so the pipeline
    # continues on last week's projections instead).
    empty = [p for p in POSITIONS if not any(v["pos"] == p for v in out.values())]
    if empty:
        sys.exit(f"no projections returned for {', '.join(empty)} "
                 f"(season {season}) — not yet published? refusing to overwrite {dest}")
    result = {"meta": {"season": season, "league_id": league_id,
                       "league_games": LEAGUE_GAMES, "players": len(out),
                       "note": "pts13 = league-scored projected points scaled to 13 games "
                               "(availability discount included); ppg = mean of the player's "
                               "projected WEEKS where weekly lines exist (per-active-game, "
                               "matches the Sleeper app), else season/17"},
              "players": out}
    atomic_write(dest, json.dumps(result, separators=(",", ":")))
    print(f"wrote {dest}  ({len(out)} players, season {season})")


if __name__ == "__main__":
    main()
