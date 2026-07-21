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
RATE_LIMIT_TRIES = 10   # 429s get their own budget, separate from error retries

def get(path):
    """GET a Sleeper endpoint, return parsed JSON (None ONLY on 404/null)."""
    url = path if path.startswith("http") else BASE + path
    attempt = rate_hits = 0
    while True:
        try:
            time.sleep(DELAY)
            with urllib.request.urlopen(url, timeout=30) as r:
                body = r.read().decode("utf-8")
            return json.loads(body) if body and body != "null" else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:            # rate limited: back off hard
                rate_hits += 1
                if rate_hits >= RATE_LIMIT_TRIES:
                    # never fall through to None here — a silent None becomes a
                    # silently incomplete dump that build + commit would publish
                    raise RuntimeError(f"rate-limited {rate_hits}x, giving up: {url}")
                time.sleep(30)
                continue
            attempt += 1
            if attempt >= RETRIES:
                raise
            time.sleep(2 ** attempt)
        except Exception:
            attempt += 1
            if attempt >= RETRIES:
                raise
            time.sleep(2 ** attempt)

def save(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    print(f"  wrote {path}")

def require(obj, what):
    """Refuse to treat a null API response as data for a must-exist resource —
    json.dumps(None) is the string "null", which would clobber a good file."""
    if obj is None:
        raise RuntimeError(f"Sleeper returned null for {what} — refusing to save")
    return obj

def week_complete(season, wk, state):
    """Is (season, wk) a FULLY-played week, safe to freeze as final?

    'Any points present' is not enough: on a mid-week manual run the Thu/early
    games have points while the Sun-night/Mon players still read 0, so freezing
    then records a partial week (bad sigma, real players marked DNP). Use the
    current NFL week from /state/nfl — already fetched — as the cutoff."""
    if not state or not str(season).isdigit():
        return True                                  # no state / unknown season: old behavior
    cur_season = int(state.get("season") or 0)
    season = int(season)
    if season != cur_season:
        return season < cur_season                   # past season done; future not
    st = state.get("season_type")
    if st in ("post", "off"):
        return True                                  # regular season finished
    if st == "pre":
        return False                                 # hasn't started
    return wk < int(state.get("week") or 0)          # in-season: only weeks before the live one


def dump_league(league_id: str, root: Path, state=None):
    """Dump one season's league and return its previous_league_id (or None)."""
    league = get(f"/league/{league_id}")
    if not league:
        print(f"  !! league {league_id} not found")
        return None
    season = league.get("season", "unknown")
    d = root / season
    print(f"Season {season} — {league.get('name')} ({league_id})")
    save(league, d / "league.json")
    save(require(get(f"/league/{league_id}/rosters"), f"league {league_id} rosters"),
         d / "rosters.json")
    save(require(get(f"/league/{league_id}/users"), f"league {league_id} users"),
         d / "users.json")
    save(get(f"/league/{league_id}/traded_picks") or [], d / "traded_picks.json")

    for name in ("winners_bracket", "losers_bracket"):
        b = get(f"/league/{league_id}/{name}")
        if b:
            save(b, d / f"{name}.json")

    drafts = get(f"/league/{league_id}/drafts") or []
    save(drafts, d / "drafts.json")
    for dr in drafts:
        did = dr["draft_id"]
        save(get(f"/draft/{did}/picks") or [], d / f"draft_{did}_picks.json")
        tp = get(f"/draft/{did}/traded_picks")
        if tp:
            save(tp, d / f"draft_{did}_traded_picks.json")

    # NFL byes for this season, derived from the league-independent schedule
    # feed (published at NFL schedule release, well before Sleeper populates
    # players' bye_week). A team's bye = the week it appears in no live game.
    sched = get(f"https://api.sleeper.app/schedule/nfl/regular/{season}")
    if sched:
        by_week = {}
        for g in sched:
            if g.get("status") == "canceled":
                continue
            by_week.setdefault(g["week"], set()).update((g["home"], g["away"]))
        all_teams = set().union(*by_week.values())
        byes = {}
        for wk, playing in sorted(by_week.items()):
            for tm in all_teams - playing:
                byes.setdefault(tm, wk)
        if byes:
            save(byes, d / "byes.json")

    # weeks: use last_scored_leg when the season is done, else assume 18
    last_week = league.get("settings", {}).get("last_scored_leg") or 18
    for wk in range(1, last_week + 1):
        m = get(f"/league/{league_id}/matchups/{wk}")
        # a week is "final" only if it has points AND is fully played — never
        # freeze the live in-progress week on a mid-week manual dispatch
        week_scored = bool(m and any(t.get("points") for t in m)) \
            and week_complete(season, wk, state)
        if week_scored:
            save(m, d / "matchups" / f"week_{wk:02d}.json")
        elif m:
            # Sleeper publishes the whole season's pairings up front — keep the
            # slim schedule for unscored weeks so the site can project records
            # against the REAL schedule preseason. [[ridA, ridB], ...]
            bym = {}
            for t in m:
                if t.get("matchup_id") is not None:
                    bym.setdefault(t["matchup_id"], []).append(t["roster_id"])
            pairs = sorted(sorted(v) for v in bym.values() if len(v) == 2)
            if pairs:
                save(pairs, d / "schedule" / f"week_{wk:02d}.json")
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
    scratches, byes and Sleeper's game-log '-' have no record at all.

    Both branches test snaps OR a stat line, never one alone: either key can
    appear without the other (a TE with off_snp 4 and no gp; Chism 2025 wk18
    with a catch and off_snp 0). This keeps the test aligned with
    nfl_history.row_played_hist, which applies the same rule to nflverse
    inputs. The one asymmetry that remains is unavoidable: nflverse has no
    team-snap equivalent of tm_*_snp, so a dressed RB/WR/TE with zero snaps in
    every phase and no stat line is DNP historically but a played 0.00 here.
    Documented in nfl_history.py's header; the population is negligible."""
    st = row.get("stats") or {}
    pl = row.get("player") or {}
    pos = pl.get("position") or (pl.get("fantasy_positions") or [None])[0]
    has_stats = any(st.get(k) for k in _OFF_STATS)
    if pos == "QB":
        return bool(st.get("off_snp") or has_stats)
    # RB/WR/TE (and unknown-position fallback): dressed = played
    return bool(st.get("gp") or st.get("off_snp") or st.get("def_snp")
                or st.get("st_snp") or st.get("tm_off_snp")
                or st.get("tm_def_snp") or st.get("tm_st_snp") or has_stats)

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
        league_id = dump_league(league_id, root, state)
        if args.no_history:
            break

    print(f"\nDone. {len(seen)} season(s) saved under {root}/")

if __name__ == "__main__":
    main()
