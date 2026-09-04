#!/usr/bin/env python3
"""
season_wpa.py — WIN SHARE for the regular season, week by week.

The postseason has had this figure since playoff_wpa.py: every game a team wins
hands out exactly 1.0 among the nine who started it, split half by LEVERAGE
(each starter's Shapley win-probability contribution) and half by PRODUCTION
(his points over positional replacement). A player's total then reads literally
— "he accounted for 3.2 of his team's 9 wins" — and a season's shares sum to
the games the league actually won.

This is the same figure over weeks 1..playoff_start-1. Same allocation, same
blend, same Shapley: `win_shares`, `shapley_wpa` and `shrink` are IMPORTED from
playoff_wpa rather than reimplemented, because the two halves are added together
on the site and a second implementation is how they would drift into being two
different statistics that share a name.

WHAT IT DOES NOT NEED. playoff_wpa rebuilds positional replacement from the raw
Sleeper dumps, which are gitignored. This script needs none of that: the
regular-season engine already published `par` per player per week into
weekly.json, so the production arm reads the number the WAR column is built on
rather than recomputing a baseline that would then have to be proven equal to
it. Everything here comes out of committed data — weekly.json and
matchups.json — so it runs on a fresh clone.

THREE THINGS WORTH KNOWING ABOUT THE REGULAR-SEASON CASE:

  * THE DISTRIBUTIONS ARE LEAVE-ONE-OUT. The leverage arm asks what the odds
    were before the week resolved, so a starter's (mean, sd) is built from his
    OTHER weeks. Using the full season would let the week being scored inform
    its own prior — a 40-point explosion would partly predict itself and
    collect less credit for being a surprise.

  * A STARTER MISSING FROM weekly.json TAKES THE RESIDUAL. weekly.json carries
    rostered players, and five to ten starter-weeks a season fall outside it (a
    body dropped and gone before the file was built). The team's actual score
    IS known, so the gap between it and the known starters is handed to whoever
    is missing, split evenly if there is more than one. That keeps the fully
    revealed coalition equal to the score the team actually put up, which is
    the property the Shapley allocation's exactness rests on.

  * TIES. A tie is not a win and hands out nothing. There has never been one in
    this league's regular season; the branch exists so that the first one is a
    0.0 rather than a crash or a silent half-win.

Output: data/leagues/<key>/<season>/winshare.json

  {"meta": {...},
   "players": {"<pid>": {"ws": 3.214, "gs": 14, "w": 9, "l": 5,
                         "wk": {"3": 0.21, "5": 0.44}}}}

`ws` is the season total, `gs` games started, `w`/`l` the starter's won-lost
record, and `wk` the per-week share for the weeks that carried one. A losing
week is absent rather than zero — the weeks a player was on the winning side
are the only ones with anything to hand out, and a map of zeroes would double
the file to say so.
"""
import argparse
import json
import sys
from pathlib import Path

from ioutil import write_json
from leaguepaths import DataDir
# THE ALLOCATION IS THE POSTSEASON'S, IMPORTED. See the module note: these two
# figures are added together on the Stats board, so they cannot be two
# implementations of one idea.
from playoff_wpa import (MIN_SD, PRIOR_N, PRODUCTION_BLEND,  # noqa: E402
                         shapley_wpa, shrink, win_shares)

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

# weekly.json row: [week, pts, paa, par, waa, war]
WK, PTS, PAR = 0, 1, 3


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8")) if Path(p).exists() else None


def positional_priors(weekly, pos_of, ps):
    """Mean and sd of a weekly score, per position, over the whole league.

    The prior a thin sample is pulled toward. Built from every rostered
    player's regular-season weeks rather than from starters only: a bench body
    is exactly the kind of player the prior exists to describe, and taking it
    from lineups would make the prior a description of good players.
    """
    by_pos = {}
    for pid, rows in weekly.items():
        p = pos_of.get(pid)
        if not p:
            continue
        for r in rows:
            if r[WK] < ps:
                by_pos.setdefault(p, []).append(r[PTS])
    out = {}
    for p, xs in by_pos.items():
        n = len(xs)
        m = sum(xs) / n
        var = sum((x - m) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
        out[p] = (m, max(var ** 0.5, MIN_SD))
    return out


def season_shares(season, ld):
    """Win share for one regular season. Returns (players, stats) or None."""
    sdir = ld / season
    mu_file = load(sdir / "matchups.json")
    weekly = load(sdir / "weekly.json")
    summary = load(sdir / "summary.json")
    if not mu_file or not weekly:
        return None
    ps = mu_file.get("playoff_start") or 15

    # position per pid — summary.json first (it is this season's own answer),
    # players_min as the fallback for a body that never scored
    pos_of = {r[0]: r[1] for r in (summary or [])}
    pmin = load(ld / "players_min.json") or {}
    for pid, v in pmin.items():
        pos_of.setdefault(pid, v[1] if len(v) > 1 else None)

    priors = positional_priors(weekly, pos_of, ps)

    # per player: week -> (pts, par), for the reveal and the production arm
    box = {}
    for pid, rows in weekly.items():
        box[pid] = {r[WK]: (r[PTS], r[PAR]) for r in rows if r[WK] < ps}

    def dist(pid, skip_wk):
        """(mean, sd) from his OTHER weeks, shrunk toward his position."""
        pm, psd = priors.get(pos_of.get(pid), (0.0, MIN_SD))
        xs = [v[0] for w, v in box.get(pid, {}).items() if w != skip_wk]
        return shrink(xs, pm, psd)

    players = {}

    def rec(pid):
        return players.setdefault(pid, {"ws": 0.0, "gs": 0, "w": 0, "l": 0, "wk": {}})

    wins = 0
    ties = 0
    for rid, rows in mu_file["teams"].items():
        for e in rows:
            wk, pts, opp, opp_pts = e[WK], e[1], e[2], e[3]
            if wk >= ps or opp is None or opp_pts is None:
                continue
            starters = [p for p in (e[4] or []) if p and p != "0"]
            if not starters:
                continue
            won = pts > opp_pts
            tied = pts == opp_pts
            if won:
                wins += 1
            if tied:
                ties += 1

            for pid in starters:
                r = rec(pid)
                r["gs"] += 1
                if won:
                    r["w"] += 1
                elif not tied:
                    r["l"] += 1

            # A LOSS AND A TIE HAND OUT NOTHING, so neither needs the Shapley —
            # win_shares would return zeros and the expensive part would have
            # been spent producing them.
            if not won:
                continue

            actuals = [box.get(p, {}).get(wk, (None, None))[0] for p in starters]
            par = [box.get(p, {}).get(wk, (None, 0.0))[1] or 0.0 for p in starters]
            # the residual: the team's score is known, so whatever the known
            # starters don't account for belongs to the ones weekly.json has
            # no row for. See the module note.
            missing = [i for i, a in enumerate(actuals) if a is None]
            if missing:
                gap = pts - sum(a for a in actuals if a is not None)
                each = gap / len(missing)
                for i in missing:
                    actuals[i] = each
            mus, sds = [], []
            for p in starters:
                m, sd = dist(p, wk)
                mus.append(m)
                sds.append(sd)
            vals, _base = shapley_wpa(mus, [sd * sd for sd in sds], actuals, opp_pts)
            shares = win_shares(vals, par, True, PRODUCTION_BLEND)
            for p, sh in zip(starters, shares):
                if sh <= 0:
                    continue
                r = rec(p)
                r["ws"] += sh
                r["wk"][str(wk)] = round(r["wk"].get(str(wk), 0.0) + sh, 4)

    # THE PROPERTY THAT MAKES THE FIGURE READABLE: the shares hand out exactly
    # one win per game won. Asserted, not assumed — a silent drift here would
    # turn "3.2 of his team's 9 wins" into a number with no units.
    got = sum(r["ws"] for r in players.values())
    if abs(got - wins) > 1e-6:
        sys.exit(f"{season}: win shares sum to {got:.4f}, expected {wins} wins")

    for r in players.values():
        r["ws"] = round(r["ws"], 4)

    return players, {"wins": wins, "ties": ties, "weeks": ps - 1}


def main():
    ap = argparse.ArgumentParser(description="regular-season win share")
    ap.add_argument("--season", help="one season; default every season with weekly.json")
    ap.add_argument("--probe", action="store_true", help="compute and print, write nothing")
    # The registry's default league is the usual target; this is how the second
    # one gets built without editing leagues.json to point at it.
    ap.add_argument("--league", help="founding league_id; default the registry's")
    args = ap.parse_args()

    ld = Path(str(DataDir(ROOT / "data", args.league) if args.league else DATA))
    seasons = sorted(d.name for d in ld.iterdir()
                     if d.is_dir() and d.name.isdigit()
                     and (d / "weekly.json").exists()
                     and (d / "matchups.json").exists())
    if args.season:
        seasons = [s for s in seasons if s == args.season]
    if not seasons:
        sys.exit("no season has weekly.json + matchups.json — run build_site_data.py first")

    pmin = load(ld / "players_min.json") or {}
    print(f"regular-season win share · production blend {PRODUCTION_BLEND}")
    n = 0
    for s in seasons:
        got = season_shares(s, ld)
        if not got:
            print(f"  {s}: no weekly/matchups — skipped")
            continue
        players, stats = got
        top = sorted(players.items(), key=lambda kv: -kv[1]["ws"])[:3]
        line = " · ".join(f"{(pmin.get(p) or ['?'])[0]} {v['ws']:.2f}" for p, v in top)
        print(f"  {s}: {stats['wins']} wins over {stats['weeks']} weeks · {line}")
        if args.probe:
            continue
        write_json(ld / s / "winshare.json", {
            "meta": {
                "scope": f"regular season, weeks 1..{stats['weeks']}",
                "blend": PRODUCTION_BLEND, "prior_n": PRIOR_N, "min_sd": MIN_SD,
                "wins": stats["wins"], "ties": stats["ties"],
                "note": "each won game hands out exactly 1.0 among its nine "
                        "starters, half by Shapley win-probability contribution "
                        "and half by points over positional replacement; "
                        "positive parts only",
            },
            "players": players,
        }, separators=(",", ":"))
        n += 1
    print(f"\n{'probe: nothing written' if args.probe else f'wrote {n} winshare.json'}")


if __name__ == "__main__":
    main()
