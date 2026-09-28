#!/usr/bin/env python3
"""
nfl_games.py — every NFL regular-season game's opponent and final score, per
week, so a finished fantasy matchup can say what each man's real game was.

WHY (Max, 2026-09-28). The live matchup card reads ESPN's scoreboard in the
browser and prints "vs TB · Q3 6:40" under every player; a finished week had
nothing, because the site keeps no NFL results. This keeps them:

    data/leagues/<key>/<season>/nfl_games.json
        {"<week>": {"<club>": [opp, home, pts, opp_pts, "<kickoff UTC>"], …}, …}

`home` is 1 or 0; the two scores are null until the game is final. A club
absent from a week had no game — a bye. Club codes are Sleeper's (ESPN's WSH
is WAS), the codes players_min.json and nfl_teams.json use.

Source: ESPN's public scoreboard, one call per week — the same feed the site
polls for the live cards and proj_snapshot.py reads for kickoffs. A season
whose file already holds all eighteen weeks final is never fetched again; the
season being played is refreshed every night. Written into every league on
the registry that has that season, since the NFL's results are everyone's.

    python scripts/nfl_games.py [--out data] [--season 2025]
"""
import argparse
import json
import sys
from pathlib import Path

from ioutil import atomic_write
from sleeper_http import get

ESPN = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        "?seasontype=2&week={week}&dates={season}")
ESPN_TO_SLEEPER = {"WSH": "WAS"}
WEEKS = 18


def week_games(season, week):
    """{club: [opp, home, pts, opp_pts, kickoff]} for one week, or None when
    the scoreboard could not be read."""
    try:
        board = get(ESPN.format(season=season, week=week), delay=0.2)
    except Exception as e:                      # noqa: BLE001
        print(f"  {season} wk {week}: scoreboard unreadable ({e})")
        return None
    if board is None:
        return None
    out = {}
    for ev in board.get("events") or []:
        for comp in ev.get("competitions") or []:
            final = ((comp.get("status") or {}).get("type") or {}).get("state") == "post"
            sides = []
            for c in comp.get("competitors") or []:
                ab = ((c.get("team") or {}).get("abbreviation") or "").upper()
                if not ab:
                    continue
                try:
                    pts = int(float(c.get("score"))) if final and c.get("score") not in (None, "") else None
                except (TypeError, ValueError):
                    pts = None
                sides.append((ESPN_TO_SLEEPER.get(ab, ab), c.get("homeAway") == "home", pts))
            if len(sides) != 2:
                continue
            when = comp.get("date") or ev.get("date") or ""
            (a, ah, ap), (b, bh, bp) = sides
            out[a] = [b, int(ah), ap, bp, when]
            out[b] = [a, int(bh), bp, ap, when]
    return out


def complete(games):
    """every week present and every game in it final"""
    return (games and len(games) >= WEEKS
            and all(v[2] is not None for wk in games.values() for v in wk.values()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--season", default=None, help="only this season")
    args = ap.parse_args()
    root = Path(args.out)
    reg = json.loads((root / "leagues.json").read_text(encoding="utf-8"))
    seasons = sorted({s for l in reg["leagues"] for s in l.get("seasons", [])})
    if args.season:
        seasons = [s for s in seasons if s == args.season]
    for season in seasons:
        dirs = [root / "leagues" / l["key"] / season for l in reg["leagues"]
                if season in l.get("seasons", []) and (root / "leagues" / l["key"] / season).is_dir()]
        if not dirs:
            continue
        have = None
        for d in dirs:
            try:
                have = json.loads((d / "nfl_games.json").read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                continue
        if complete(have):
            print(f"{season}: complete — not refetched")
            games = have
        else:
            games = dict(have or {})
            for wk in range(1, WEEKS + 1):
                got = week_games(season, wk)
                if got:
                    games[str(wk)] = got
            final = sum(1 for w in games.values() for v in w.values() if v[2] is not None) // 2
            print(f"{season}: {len(games)} weeks, {final} final games")
        body = json.dumps(games, separators=(",", ":"))
        for d in dirs:
            atomic_write(d / "nfl_games.json", body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
