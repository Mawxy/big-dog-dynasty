#!/usr/bin/env python3
"""
proj_snapshot.py — keep each player's weekly projection as it stood AT KICKOFF.

WHY (Max, 2026-09-28). Sleeper serves today's projections and nothing else, so
pricing a past week off what was projected for it needs a record kept at the
time. week_odds.py --snapshot kept one: the FIRST daily run of a week, which is
the Tuesday the week becomes current — five days of injury news before the
games. The line a manager actually set a lineup against is the one standing at
kickoff, so that is the one this keeps:

    Every two hours (proj-snapshots.yml, plus once in the nightly refresh), for
    the live week, every player's projection is re-read. A player whose game
    has NOT kicked off is overwritten with the fresh line; one whose game has
    kicked off is frozen. So when a week is over, each player's entry is the
    last read taken before his own kickoff — at most two hours stale, and never
    one that saw the game.

KICKOFFS come from ESPN's public scoreboard (the one the site's live cards
already poll), keyed by Sleeper's club code. When the scoreboard can't be read
nothing is overwritten — a player with no entry yet gets one (first write, the
old rule), and every existing entry stands, because without a clock there is
no way to know it is still pregame. A club with no game that week (a bye) gets
no entry, which week_odds.py reads as "no line", its one rule.

FILES (league-scoped, the default league — the only one projections run for):

    data/leagues/<key>/<season>/proj_history.json
        {"<week>": {"<pid>": points, …}, …}          unchanged shape
    data/leagues/<key>/<season>/proj_history_meta.json
        {"<week>": {"taken": "<last read, UTC>",
                    "kick": {"<club>": "<kickoff, UTC>"},
                    "at": {"<pid>": "<when this entry was read, UTC>"}}}

The meta file is what makes the record auditable: for any player it says when
his line was read, and the kickoff it was read against.

    python scripts/proj_snapshot.py [--dry-run] [--now 2026-09-27T16:00:00Z]
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from ioutil import atomic_write
from leaguepaths import DataDir
from sleeper_http import get
from fetch_projections import (POSITIONS, V1, current_regular_week, default_league_id,
                               score_line, week_proj_url)

ROOT = Path(__file__).resolve().parent.parent
ESPN = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        "?seasontype=2&week={week}&dates={season}")
# ESPN's code where it differs from Sleeper's — src/lib/liveScores.ts keeps the
# same map for the live cards
ESPN_TO_SLEEPER = {"WSH": "WAS"}


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    s = s.replace("Z", "+00:00")
    t = dt.datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def kickoffs(season, week):
    """{sleeper club: kickoff (aware UTC datetime)} for the week, or None when
    the scoreboard could not be read. A club absent from a good read has no
    game — a bye."""
    try:
        board = get(ESPN.format(season=season, week=week), delay=0)
    except Exception as e:                       # noqa: BLE001 — any failure is "no clock"
        print(f"  scoreboard unreadable ({e}); existing entries stand")
        return None
    events = (board or {}).get("events") or []
    if not events:
        return None
    out = {}
    for ev in events:
        for comp in ev.get("competitions") or []:
            when = comp.get("date") or ev.get("date")
            if not when:
                continue
            t = parse_iso(when)
            for side in comp.get("competitors") or []:
                ab = ((side.get("team") or {}).get("abbreviation") or "").upper()
                if ab:
                    out[ESPN_TO_SLEEPER.get(ab, ab)] = t
    return out or None


def week_lines(season, week, scoring):
    """{pid: (league points, club)} for every player with a scored line."""
    def scored(stats):
        return any(isinstance(stats.get(k), (int, float)) and stats[k] for k in scoring)
    out = {}
    for pos in POSITIONS:
        for item in get(week_proj_url(season, week, pos)) or []:
            pid = str(item.get("player_id") or "")
            st = item.get("stats") or {}
            if not pid or not scored(st):
                continue
            out[pid] = (round(score_line(st, scoring, pos), 2), (item.get("team") or "").upper())
    return out


def update(hist, meta, week, lines, kick, now):
    """Fold one read of the week's lines into the record. Returns how many
    entries it wrote. Pure — the whole rule lives here, and is what the tests
    pin:

      kickoff known, now before it   write (overwrite) — the freshest pregame line
      kickoff known, now at/after    frozen — never replaced, never added
      club has no game (good read)   skipped — a bye has no line
      no scoreboard at all           first write only — existing entries stand
    """
    wk = str(week)
    snap = hist.setdefault(wk, {})
    m = meta.setdefault(wk, {})
    at = m.setdefault("at", {})
    if kick is not None:
        m["kick"] = {c: iso(t) for c, t in sorted(kick.items())}
    wrote = 0
    for pid, (val, club) in lines.items():
        if kick is None:
            if pid in snap:
                continue
        else:
            t = kick.get(club)
            if t is None or now >= t:
                continue
        if snap.get(pid) != val or pid not in at:
            wrote += 1
        snap[pid] = val
        at[pid] = iso(now)
    m["taken"] = iso(now)
    if not snap:
        hist.pop(wk, None)
    return wrote


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description="kickoff-locked weekly projection snapshot")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--now", default=None, help="pretend it is this UTC time (testing)")
    args = ap.parse_args()
    now = parse_iso(args.now) if args.now else dt.datetime.now(dt.timezone.utc)

    state = get(f"{V1}/state/nfl")
    season = str((state or {}).get("season") or "")
    week = current_regular_week(state, season)
    if not week:
        print(f"no regular-season week in progress (state: {state and state.get('season_type')}) — nothing to snapshot")
        return 0

    league = get(f"{V1}/league/{default_league_id()}")
    scoring = (league or {}).get("scoring_settings") or {}
    if not scoring:
        sys.exit("no scoring_settings on the league; cannot score projections")

    lines = week_lines(season, week, scoring)
    if not lines:
        print(f"{season} week {week}: Sleeper returned no lines — nothing written")
        return 0
    kick = kickoffs(season, week)

    out = DataDir(ROOT / "data")
    f = Path(out / season / "proj_history.json")
    fm = Path(out / season / "proj_history_meta.json")
    hist, meta = load(f) or {}, load(fm) or {}
    wrote = update(hist, meta, week, lines, kick, now)
    frozen = sum(1 for _p, (_v, c) in lines.items() if kick and kick.get(c) and now >= kick[c])
    print(f"{season} week {week} @ {iso(now)}: {len(lines)} lines read · {wrote} written · "
          f"{frozen} frozen at kickoff · scoreboard {'ok' if kick else 'UNREADABLE'}")
    if args.dry_run:
        return 0
    f.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(f, json.dumps(hist, separators=(",", ":")))
    atomic_write(fm, json.dumps(meta, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
