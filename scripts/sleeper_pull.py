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
import argparse, datetime as _dt, json, sys
from pathlib import Path

# One Sleeper client for the whole repo. This script's semantics ARE the shared
# ones — 0.15s pacing, broad retry, 404 -> None, a hard 429 budget that raises
# rather than returning a silent None — so it takes the defaults unchanged.
from sleeper_http import get

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

def effective_week(season, state):
    """The week whose lineups count as "being set right now".

    Sleeper's state doesn't read regular/week 1 until kickoff week, but
    managers set week-1 lineups well before that — so from SEPTEMBER 1 of the
    season year (Max's ruling, 2026-08-31) the upcoming week 1 is treated as
    current for set-lineup capture. In-season this is simply the live week.
    Post-season the guard is structural: a scored week never reaches the
    unscored branch this feeds, so a stale "off" state can't re-arm week 1.
    """
    if not state or str(state.get("season")) != str(season):
        return None
    if state.get("season_type") == "regular":
        return state.get("week") or None
    if state.get("season_type") in ("pre", "off") and str(season).isdigit():
        if _dt.date.today() >= _dt.date(int(season), 9, 1):
            return 1
    return None


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


def newest_of(league_id: str) -> str:
    """Follow the chain FORWARD to the newest season of this league.

    Sleeper hands out a new league_id every time the commissioner rolls the
    league over — whenever they choose, not on a schedule — and the new league
    points backward via `previous_league_id`. There is no `next_league_id`, so
    the only way to notice a rollover is to enumerate leagues, and the only
    endpoint that enumerates is per-user.

    Anchored on EVERY member, not the commissioner: any member's league list
    contains the new league, and using all of them means the walk survives the
    commissioner handing over, leaving, or not having joined yet. It stops at
    the first member who can see the successor, so the usual cost is one call.

    Nothing found is the normal case — it means no rollover has happened — and
    costs one request per member of the head league.
    """
    while True:
        league = get(f"/league/{league_id}")
        if not league:
            return league_id
        season = int(league.get("season") or 0)
        if not season:
            return league_id
        members = [u["user_id"] for u in (get(f"/league/{league_id}/users") or [])
                   if u.get("user_id")]
        nxt = None
        for uid in members:
            for lg in (get(f"/user/{uid}/leagues/nfl/{season + 1}") or []):
                if lg.get("previous_league_id") == league_id:
                    nxt = lg["league_id"]
                    break
            if nxt:
                break
        if not nxt:
            return league_id
        print(f"  -> rolled over: {season} ({league_id}) -> {season + 1} ({nxt})")
        league_id = nxt


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

    # WEEKS TO WALK — derived from the league's own shape, never from progress.
    #
    # This used to be `last_scored_leg or 18`. Out of season that field is null
    # and the `or 18` walked the whole calendar, which is the ONLY reason
    # schedule/week_NN.json ever got written: Sleeper publishes the season's
    # pairings up front, and the site's projected records and week-odds pricing
    # are built from them. The moment week 1 scores, last_scored_leg becomes 1
    # and range(1, 2) fetches exactly one week — so a fresh CI checkout (this
    # dump is gitignored and rebuilt every run) would stop writing schedule/
    # entirely, build_site_data would rebuild matchups.json without the
    # `schedule` key, and the site would silently lose every future-week pairing
    # for the rest of the season.
    #
    # The season's LENGTH is a league setting, not a function of how much of it
    # has been played: regular season runs to playoff_week_start - 1, then a
    # 6-team bracket takes two more (15 -> 17 here). last_scored_leg only ever
    # raises the cap, for a finished season whose bracket ran longer than that.
    settings = league.get("settings", {})
    ps = settings.get("playoff_week_start") or 0
    last_week = max(ps + 2 if ps else 18, settings.get("last_scored_leg") or 0)
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
            # The CURRENT week's SET lineups (settled with Max, 2026-08-31):
            # its projection should price the lineup as managers actually set
            # it, while future weeks stay best-projected. Only the live week is
            # kept — Sleeper returns starters for future weeks too, but those
            # are defaults nobody has looked at yet, not decisions. Rewritten
            # every pull, since the live week's lineups change daily.
            if (effective_week(season, state) == wk
                    and any(t.get("starters") for t in m)):
                save({str(t["roster_id"]): t.get("starters") or [] for t in m},
                     d / "lineups" / f"week_{wk:02d}.json")
        t = get(f"/league/{league_id}/transactions/{wk}")
        if t:
            save(t, d / "transactions" / f"week_{wk:02d}.json")
        if week_scored:
            rows = fetch_week_stats(season, wk)
            # played: bye vs DNP, per the position rule in row_played()
            played = {r["player_id"]: (r.get("team") or "")
                      for r in rows if r.get("player_id") and row_played(r)}
            if played:
                save(played, d / "played" / f"week_{wk:02d}.json")
            # allstats: the full scored universe (incl free agents) for the WAR
            # pool fix + VoWP waiver baseline. Trimmed to id + raw stats;
            # sleeper_war scores it to league rules itself.
            allstats = [{"player_id": r["player_id"], "stats": r.get("stats") or {}}
                        for r in rows if r.get("player_id") and r.get("stats")]
            if allstats:
                save(allstats, d / "allstats" / f"week_{wk:02d}.json")

    return league.get("previous_league_id")


# Offensive box-score keys that prove a player took part in the offense even
# if snap counts are missing (e.g. Chism 2025 wk18: a catch with off_snp 0).
_OFF_STATS = ("pass_att", "pass_yd", "pass_cmp", "rush_att", "rush_yd",
              "rec", "rec_tgt", "rec_yd", "fum", "pass_sack")

def row_played(row):
    """Played test, settled 2026-08-07 and now position-INDEPENDENT:

        dressed = played, for every position, and a dressed 0.00 accrues
        negative value.

    This supersedes the 2026-07-17 rule, which exempted QB on the grounds that
    every team dresses a QB2 every week so dressing carried no signal. That
    argument is about OPPORTUNITY, and WAR is not a measure of opportunity — it
    measures production against replacement. A backup QB is often valuable to
    OWN and reliably unproductive, and those are different facts: ownership
    value is what DVI, CVI and market price measure. Excluding his weeks let a
    backup keep a per-13 rate built from two mop-up appearances, which is the
    root of the projection model pricing unproven QBs as startable assets.

    Never trust 'gms_active' alone: Sleeper emits it even for IR, NFI and
    practice-squad players (their records are gms_active + pos_rank 999 and
    nothing else). tm_*_snp presence is the dressed/not-dressed discriminator;
    scratches, byes and Sleeper's game-log '-' have no record at all, so the
    hurt and the inactive still accrue nothing.

    Test snaps OR a stat line, never one alone: either key can appear without
    the other (a TE with off_snp 4 and no gp; Chism 2025 wk18 with a catch and
    off_snp 0). Keeps this aligned with nfl_history.row_played_hist, which now
    reads weekly roster status to make the same call on nflverse inputs."""
    st = row.get("stats") or {}
    pl = row.get("player") or {}
    pos = pl.get("position") or (pl.get("fantasy_positions") or [None])[0]
    has_stats = any(st.get(k) for k in _OFF_STATS)
    # position is still read (callers and the fallback depend on it) but no
    # longer changes the answer — see the docstring for why the QB carve-out
    # was retired.
    _ = pos
    # RB/WR/TE (and unknown-position fallback): dressed = played
    return bool(st.get("gp") or st.get("off_snp") or st.get("def_snp")
                or st.get("st_snp") or st.get("tm_off_snp")
                or st.get("tm_def_snp") or st.get("tm_st_snp") or has_stats)

def fetch_week_stats(season, week):
    """Full-NFL QB/RB/WR/TE stat lines for one week — EVERY player, rostered or
    free agent. One call feeds two consumers: the `played` set (bye vs DNP) and
    `allstats` (the full scored universe sleeper_war uses to fix the startable
    pool and measure the waiver baseline for VoWP)."""
    url = (f"https://api.sleeper.app/stats/nfl/{season}/{week}"
           f"?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE")
    return get(url) or []

def main():
    ap = argparse.ArgumentParser(description="Dump a Sleeper league's full history to JSON.")
    ap.add_argument("league_id", nargs="?", help="Most recent league_id (chain is walked backward from here)")
    ap.add_argument("--username", help="Look up leagues by username instead of league_id")
    ap.add_argument("--season", help="Season to use with --username (default: current)")
    ap.add_argument("--out", default="sleeper_data", help="Output folder (default: sleeper_data)")
    ap.add_argument("--players", action="store_true", help="Also download the full player-ID map (~19MB; Sleeper asks max once/day)")
    ap.add_argument("--players-only", action="store_true",
                    help="Download ONLY the player map and exit. The map is by "
                         "far the heaviest call Sleeper serves and changes "
                         "slowly, so it is refreshed on its own weekly cadence "
                         "while everything else runs daily against the cached copy.")
    ap.add_argument("--no-history", action="store_true", help="Only the given league, don't walk previous seasons")
    ap.add_argument("--no-forward", action="store_true", help="Don't follow the chain forward to newer seasons — pull exactly the id given")
    args = ap.parse_args()

    root = Path(args.out)
    state = get("/state/nfl")
    save(state, root / "nfl_state.json")

    # --players-only needs no league at all: the map is global to Sleeper.
    # Doing it before league selection means the weekly job can run with no
    # arguments and never touch a league endpoint.
    if args.players_only:
        print("Downloading full player map (~19MB)...")
        save(get("/players/nfl"), root / "players.json")
        print("--players-only: player map written, skipping the league pull")
        return

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
        print("Downloading full player map (~19MB)...")
        save(get("/players/nfl"), root / "players.json")

    if not args.no_forward:
        league_id = newest_of(league_id)

    seen = set()
    while league_id and league_id not in seen:
        seen.add(league_id)
        league_id = dump_league(league_id, root, state)
        if args.no_history:
            break

    print(f"\nDone. {len(seen)} season(s) saved under {root}/")

if __name__ == "__main__":
    main()
