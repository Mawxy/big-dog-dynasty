#!/usr/bin/env python3
"""
sleeper_pull.py — dump an entire Sleeper league's history to JSON files.

Walks the previous_league_id chain (dynasty history) and saves, per season:
  league.json, rosters.json, users.json, traded_picks.json,
  drafts.json, draft_<id>_picks.json, draft_<id>_traded_picks.json,
  winners_bracket.json, losers_bracket.json,
  matchups/week_NN.json, transactions/week_NN.json

Also saves nfl_state.json and (optionally) the full player-ID map.

Usage:
  python sleeper_pull.py 1312221243742621696
  python sleeper_pull.py 1312221243742621696 --out sleeper_data --players
  python sleeper_pull.py --username mawxy --season 2026 --players

No dependencies beyond the standard library. Read-only API, no auth.
"""
import argparse, json, sys, time, urllib.request, urllib.error
from pathlib import Path

BASE = "https://api.sleeper.app/v1"
DELAY = 0.15          # seconds between calls; keeps well under Sleeper's ~1000/min limit
RETRIES = 3

def get(path):
    """GET a Sleeper endpoint, return parsed JSON (None on 404/null)."""
    url = path if path.startswith("http") else BASE + path
    for attempt in range(RETRIES):
        try:
            time.sleep(DELAY)
            with urllib.request.urlopen(url, timeout=30) as r:
                body = r.read().decode("utf-8")
            return json.loads(body) if body and body != "null" else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:            # rate limited: back off hard
                time.sleep(30)
                continue
            if attempt == RETRIES - 1:
                raise
            time.sleep(2 ** attempt)
        except Exception:
            if attempt == RETRIES - 1:
                raise
            time.sleep(2 ** attempt)

def save(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    print(f"  wrote {path}")

def dump_league(league_id: str, root: Path):
    """Dump one season's league and return its previous_league_id (or None)."""
    league = get(f"/league/{league_id}")
    if not league:
        print(f"  !! league {league_id} not found")
        return None
    season = league.get("season", "unknown")
    d = root / season
    print(f"Season {season} — {league.get('name')} ({league_id})")
    save(league, d / "league.json")
    save(get(f"/league/{league_id}/rosters"), d / "rosters.json")
    save(get(f"/league/{league_id}/users"), d / "users.json")
    save(get(f"/league/{league_id}/traded_picks"), d / "traded_picks.json")

    for name in ("winners_bracket", "losers_bracket"):
        b = get(f"/league/{league_id}/{name}")
        if b:
            save(b, d / f"{name}.json")

    drafts = get(f"/league/{league_id}/drafts") or []
    save(drafts, d / "drafts.json")
    for dr in drafts:
        did = dr["draft_id"]
        save(get(f"/draft/{did}/picks"), d / f"draft_{did}_picks.json")
        tp = get(f"/draft/{did}/traded_picks")
        if tp:
            save(tp, d / f"draft_{did}_traded_picks.json")

    # weeks: use last_scored_leg when the season is done, else assume 18
    last_week = league.get("settings", {}).get("last_scored_leg") or 18
    for wk in range(1, last_week + 1):
        m = get(f"/league/{league_id}/matchups/{wk}")
        week_scored = bool(m and any(t.get("points") for t in m))
        if week_scored:
            save(m, d / "matchups" / f"week_{wk:02d}.json")
        t = get(f"/league/{league_id}/transactions/{wk}")
        if t:
            save(t, d / "transactions" / f"week_{wk:02d}.json")
        if week_scored:
            played = fetch_played(season, wk)
            if played:
                save(played, d / "played" / f"week_{wk:02d}.json")

    return league.get("previous_league_id")


# Offensive box-score keys that prove a player took part in the offense even
# if snap counts are missing (e.g. Chism 2025 wk18: a catch with off_snp 0).
_OFF_STATS = ("pass_att", "pass_yd", "pass_cmp", "rush_att", "rush_yd",
              "rec", "rec_tgt", "rec_yd", "fum", "pass_sack")

def row_played(row):
    """Played test per the settled 2026-07-17 rule (position-dependent):

    QB       — offensive participation only: off_snp > 0 or a real offensive
               stat line. A dressed backup with zero snaps (Malik Willis 2025
               wk1) is DNP: QB is the one position with a clear every-snap
               starter, so merely dressing carries no signal.
    RB/WR/TE — dressed = played: any record beyond the bare 'gms_active'
               placeholder (gp / own snaps / tm_*_snp) counts, and a dressed
               0.00 accrues negative value — rotation positions have no
               guaranteed snap-taker.

    Never trust 'gms_active' alone: Sleeper emits it even for IR, NFI and
    practice-squad players (their records are gms_active + pos_rank 999 and
    nothing else). tm_*_snp presence is the dressed/not-dressed discriminator;
    scratches, byes and Sleeper's game-log '-' have no record at all."""
    st = row.get("stats") or {}
    pl = row.get("player") or {}
    pos = pl.get("position") or (pl.get("fantasy_positions") or [None])[0]
    if pos == "QB":
        return bool(st.get("off_snp") or any(st.get(k) for k in _OFF_STATS))
    # RB/WR/TE (and unknown-position fallback): dressed = played
    return bool(st.get("gp") or st.get("off_snp") or st.get("def_snp")
                or st.get("st_snp") or st.get("tm_off_snp")
                or st.get("tm_def_snp") or st.get("tm_st_snp"))

def fetch_played(season, week):
    """Player IDs (QB/RB/WR/TE) who count as PLAYED that week, per Sleeper's
    stats feed and the position-dependent rule in row_played(). Distinguishes
    a real 0.00-point game from a bye/inactive week."""
    url = (f"https://api.sleeper.app/stats/nfl/{season}/{week}"
           f"?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE")
    rows = get(url) or []
    played = {}   # player_id -> NFL team that week (lets us tell BYE from DNP)
    for row in rows:
        if row_played(row):
            pid = row.get("player_id")
            if pid:
                played[pid] = row.get("team") or ""
    return played

def main():
    ap = argparse.ArgumentParser(description="Dump a Sleeper league's full history to JSON.")
    ap.add_argument("league_id", nargs="?", help="Most recent league_id (chain is walked backward from here)")
    ap.add_argument("--username", help="Look up leagues by username instead of league_id")
    ap.add_argument("--season", help="Season to use with --username (default: current)")
    ap.add_argument("--out", default="sleeper_data", help="Output folder (default: sleeper_data)")
    ap.add_argument("--players", action="store_true", help="Also download the full player-ID map (~5MB; Sleeper asks max once/day)")
    ap.add_argument("--no-history", action="store_true", help="Only the given league, don't walk previous seasons")
    args = ap.parse_args()

    root = Path(args.out)
    state = get("/state/nfl")
    save(state, root / "nfl_state.json")

    league_id = args.league_id
    if not league_id:
        if not args.username:
            sys.exit("Provide a league_id or --username. See --help.")
        user = get(f"/user/{args.username}")
        if not user:
            sys.exit(f"User '{args.username}' not found.")
        season = args.season or state["league_season"]
        leagues = get(f"/user/{user['user_id']}/leagues/nfl/{season}") or []
        if not leagues:
            sys.exit(f"No {season} leagues for {args.username}.")
        print(f"Leagues for {args.username} ({season}):")
        for i, lg in enumerate(leagues):
            print(f"  [{i}] {lg['name']} ({lg['league_id']})")
        idx = 0 if len(leagues) == 1 else int(input("Pick a league number: "))
        league_id = leagues[idx]["league_id"]

    if args.players:
        print("Downloading full player map (~5MB)...")
        save(get("/players/nfl"), root / "players.json")

    seen = set()
    while league_id and league_id not in seen:
        seen.add(league_id)
        league_id = dump_league(league_id, root)
        if args.no_history:
            break

    print(f"\nDone. {len(seen)} season(s) saved under {root}/")

if __name__ == "__main__":
    main()
