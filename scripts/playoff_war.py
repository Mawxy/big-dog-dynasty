#!/usr/bin/env python3
"""
playoff_war.py — wins above replacement, for the postseason.

  python scripts/playoff_war.py                  # every season with a bracket
  python scripts/playoff_war.py --season 2025
  python scripts/playoff_war.py --probe          # report, write nothing

THE QUESTION THIS ANSWERS, and why it needs its own figure. The site carries
three other playoff numbers, all of them conditioned on the result:

  * WPA (playoff_wpa.py) — how much win probability a start swung. A game that
    was never in doubt has almost none to swing.
  * Win share — how much of a WIN was his. A loss pays exactly nothing.
  * MVP — the award, built from win share.

None of them credits production in a loss. Davante Adams put up the single
biggest contribution in the 2023 final and scores zero win share, because
Still Tae lost it. Playoff WAR is the figure that says he played well anyway:
points above what a replacement-level player at his position would have
scored, converted to wins. Win or lose, it counts.

That makes it the direct analogue of basketball's Win Shares — production
measured against a replacement baseline and converted to wins by a
points-per-win exchange rate — where the OTHER figures are closer to WPA.

METHOD. The engine is sleeper_war.py's, unchanged: build the league-wide
optimal lineup for the week from the whole player pool, take replacement as
the best player who did NOT make it at each position, and convert points over
that baseline into wins through the weekly score spread. Two deliberate
departures:

  1. SIGMA IS IMPORTED FROM THE REGULAR SEASON. The points-per-win exchange
     rate comes from the spread of team scores, and in playoff weeks half the
     league is in a consolation bracket with lineups it has stopped setting.
     Those unset lineups score low, which inflates the spread, which quietly
     makes every marginal point worth FEWER wins. Measured on this league it
     is not subtle: 2025 week 15 reads sigma 41.4 against a regular-season
     29.3, so a playoff-week conversion would have discounted every quarter-
     final performance by a third. Weeks 1-14, when all twelve teams are
     trying, are the honest yardstick.

     The replacement baseline itself needs no such correction — build_week
     reads the PLAYER POOL, never anyone's lineup, so a benched star is still
     in the pool at his real score and a consolation team's apathy cannot move
     it. (An earlier version of this note claimed otherwise; it was wrong.)

  2. ELIMINATION GAMES ONLY. Same scope as everything else on the page: a
     player accrues WAR for a start in a quarterfinal, semifinal or final, not
     for a placement game, and not for the consolation bracket.

Output: merged into each season's bracket.json as "war":

  {"<pid>": {"rid": 4, "war": 0.41, "pts": 61.2, "par": 24.8, "gp": 2,
             "wk": {"16": 0.22, "17": 0.19}}, ...}

`par` is points above replacement, `war` those points converted to wins.
"""
import argparse, json, statistics, sys
from collections import defaultdict
from pathlib import Path

from ioutil import write_json
from leaguepaths import DataDir
from sleeper_war import (build_week, load_json, norm_win_shift,   # noqa: E402
                         player_pos, score_stats, slot_counts)

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")


def regular_season_sigma(sdir, playoff_start):
    """Spread of team scores over the REGULAR season only.

    This is the points-per-win exchange rate. Computing it from playoff weeks
    would read the consolation bracket's unset lineups as real variance and
    discount every playoff performance — see the module docstring.
    """
    scores = []
    for wf in sorted((sdir / "matchups").glob("week_*.json")):
        if int(wf.stem.split("_")[1]) >= playoff_start:
            continue
        scores += [t["points"] for t in load_json(wf) if t.get("points")]
    return statistics.stdev(scores) if len(scores) >= 2 else 0.0


def season_war(season, ld, raw_root, players):
    """Playoff WAR for one season, keyed by pid. None when there's no bracket."""
    sdir = raw_root / season
    bf = ld / season / "bracket.json"
    if not bf.exists() or not (sdir / "league.json").exists():
        return None
    bracket = json.loads(bf.read_text(encoding="utf-8"))
    league = load_json(sdir / "league.json")
    slots = slot_counts(league)
    playoff_start = league.get("settings", {}).get("playoff_week_start", 15)
    scoring = league.get("scoring_settings") or {}
    sigma = regular_season_sigma(sdir, playoff_start)
    if sigma <= 0:
        return None

    # who started for whom, per elimination game — placement games excluded
    starts = defaultdict(dict)                  # week -> pid -> rid
    for g in bracket["winners"]:
        if g.get("p") and g["p"] > 1:
            continue
        wk = g["week"]
        wf = sdir / "matchups" / f"week_{wk}.json"
        if not wf.exists():
            continue
        by_rid = {t.get("roster_id"): t for t in load_json(wf)}
        for rid in (g.get("t1"), g.get("t2")):
            t = by_rid.get(rid)
            if not t:
                continue
            for pid in (t.get("starters") or []):
                if pid:
                    starts[wk][str(pid)] = rid

    out = {}
    for wk, lineup in sorted(starts.items()):
        wf = sdir / "matchups" / f"week_{wk}.json"
        # Who actually played, from Sleeper's stats feed — sleeper_pull saves
        # `played/week_NN.json` for playoff weeks too. With it a dressed 0.00
        # is a real zero and accrues NEGATIVE points above replacement, which
        # is the position-independent played rule (methodology #5) and is what
        # playoff_wpa already does. Without it (older dumps) fall back to
        # treating 0.00 as did-not-play, exactly as sleeper_war does.
        pfile = sdir / "played" / f"week_{wk:02d}.json"
        played = set(load_json(pfile)) if pfile.exists() else None
        # The pool every baseline is measured against: every rostered player's
        # actual points that week. Lineups are NOT consulted here — that is
        # what keeps the consolation bracket from moving replacement level.
        points, positions = {}, {}
        for team in load_json(wf):
            for pid, pts in (team.get("players_points") or {}).items():
                pos = player_pos(players, pid)
                if not pos or pts is None:
                    continue
                if played is not None:
                    if str(pid) not in played:
                        continue
                elif not pts:
                    continue
                points[str(pid)], positions[str(pid)] = pts, pos
        if not points:
            continue
        # widen the pool with unrostered NFL production, exactly as the
        # regular-season engine does, so replacement isn't set by a rostered
        # scrub when a free agent outscored him
        pool_pts, pool_pos = dict(points), dict(positions)
        afile = sdir / "allstats" / f"week_{wk:02d}.json"
        if afile.exists():
            for r in load_json(afile):
                pid = str(r.get("player_id") or "")
                if not pid or pid in pool_pts:
                    continue
                pos = player_pos(players, pid)
                if not pos:
                    continue
                pw = score_stats(r.get("stats") or {}, scoring, pos)
                if pw > 0:
                    pool_pts[pid], pool_pos[pid] = pw, pos
        _, _, repl = build_week(pool_pts, pool_pos, slots)

        for pid, rid in lineup.items():
            pts = points.get(pid)
            if pts is None:
                continue                        # bye/inactive (or, with no
                                                # played file, a 0.00)
            par = pts - repl[positions[pid]]
            war = norm_win_shift(par, sigma)
            rec = out.setdefault(pid, {"rid": rid, "war": 0.0, "pts": 0.0,
                                       "par": 0.0, "gp": 0, "wk": {}})
            rec["rid"] = rid
            rec["war"] += war
            rec["pts"] += pts
            rec["par"] += par
            rec["gp"] += 1
            rec["wk"][str(wk)] = round(war, 4)

    for rec in out.values():
        rec["war"] = round(rec["war"], 4)
        rec["pts"] = round(rec["pts"], 2)
        rec["par"] = round(rec["par"], 2)
    return out, round(sigma, 2)


def main():
    ap = argparse.ArgumentParser(description="playoff WAR (production vs replacement)")
    ap.add_argument("--season", help="one season (default: all with a bracket)")
    ap.add_argument("--raw", default=str(ROOT / "sleeper_data"))
    ap.add_argument("--probe", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    ld = Path(str(DATA))
    raw_root = Path(args.raw)
    pfile = raw_root / "players.json"
    if not pfile.exists():
        sys.exit("players.json missing — rerun sleeper_pull.py with --players")
    players = load_json(pfile)
    pmin = json.loads((ld / "players_min.json").read_text(encoding="utf-8"))

    seasons = ([args.season] if args.season
               else sorted(d.name for d in ld.iterdir()
                           if d.is_dir() and d.name.isdigit()
                           and (d / "bracket.json").exists()))
    if not seasons:
        sys.exit("no season has a bracket.json — run build_site_data.py first")

    print("playoff WAR · replacement baseline per week, "
          "points-per-win imported from the regular season")
    n = 0
    for s in seasons:
        got = season_war(s, ld, raw_root, players)
        if not got:
            print(f"  {s}: no bracket/league — skipped")
            continue
        war, sigma = got
        top = sorted(war.items(), key=lambda kv: -kv[1]["war"])[:3]
        line = " · ".join(f"{(pmin.get(p) or ['?'])[0]} {v['war']:+.3f}" for p, v in top)
        print(f"  {s}: sigma {sigma} · {len(war)} starters · {line}")
        if args.probe:
            continue
        f = ld / s / "bracket.json"
        b = json.loads(f.read_text(encoding="utf-8"))
        b["war"] = war
        b["war_meta"] = {
            "sigma": sigma,
            "sigma_source": "regular season (weeks 1..playoff_start-1)",
            "scope": "elimination games only; placement games excluded",
            "note": "points above positional replacement, converted to wins; "
                    "credited win or lose",
        }
        write_json(f, b, separators=(",", ":"))
        n += 1
    print(f"\n{'probe: nothing written' if args.probe else f'wrote {n} bracket.json'}")


if __name__ == "__main__":
    main()
