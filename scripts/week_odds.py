#!/usr/bin/env python3
"""
week_odds.py — pregame win probability for every matchup, played or upcoming.

  python scripts/week_odds.py                 # every season
  python scripts/week_odds.py --season 2026
  python scripts/week_odds.py --probe         # report, write nothing

The postseason already has this: playoff_wpa.py prices each elimination game
off the two lineups and reports the line it turned on. This extends the same
model to the regular season, so a week page can say what the matchup looked
like BEFORE it was played — which is what makes an upset legible — and what an
unplayed one looks like now.

STRICTLY PREGAME, NO LOOKAHEAD. Week W's numbers are built from weeks 1..W-1
only. A team that went on to win week 9 does not get to have known that in
week 9's line. Positional priors are drawn from the same prior window, so a
season's first weeks lean on projections and later weeks lean on form, which
is the honest shape of what was knowable at the time.

TWO SOURCES, one per situation:

  * PLAYED weeks use the lineups that were actually started (from the raw week
    dump) and each starter's own form to that point, shrunk toward his
    position's — the same shrink() the playoff engine uses.
  * UPCOMING weeks have no lineup yet, so each roster fields its best legal
    lineup by projected points (proj_sleeper.json) under the league's
    roster_positions, and the projection is the mean. Variance still comes
    from positional form, because a projection carries no spread of its own.

Team score is the sum of nine independent starters, so
P(A beats B) = Phi((muA - muB) / sqrt(varA + varB)) — the identical normal
model the bracket uses, so a playoff week and a regular-season week are
quoted on the same basis.

Output: data/<season>/odds.json

  {"meta": {...},
   "weeks": {"9": {"<rid>": {"mu": 112.4, "sd": 21.1, "opp": 7,
                             "wp": 0.58, "proj": false}, ...}}}

`proj` marks a line built from projections rather than from played form.
"""
import argparse, json, math, statistics, sys
from collections import defaultdict
from pathlib import Path

from leaguepaths import DataDir
from playoff_wpa import MIN_SD, PRIOR_N, shrink, win_prob

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

CORE = {"QB", "RB", "WR", "TE"}
FLEX_OK = {"FLEX": {"RB", "WR", "TE"},
           "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
           "REC_FLEX": {"WR", "TE"},
           "WRRB_FLEX": {"RB", "WR"}}
BENCH = {"BN", "IR", "TAXI"}
# Fallback spread for a player with no form anywhere — a rookie in week 1.
# Deliberately wide: an unknown should not arrive as a confident number.
DEFAULT_SD = 8.0


def load(p):
    p = Path(p)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def best_lineup(cands, slots):
    """Greedy best legal lineup: dedicated slots first, then flex by value.

    `cands` is [(pid, pos, value)], `slots` the per-team roster_positions.
    Mirrors the site's optimalLineup — most-restrictive slot first so a narrow
    slot is not stranded by a player who also fits a wider one.
    """
    open_slots = defaultdict(int)
    for s in slots:
        if s not in BENCH:
            open_slots[s] += 1
    picked, rest = [], []
    for pid, pos, val in sorted(cands, key=lambda c: -c[2]):
        if open_slots.get(pos, 0) > 0:
            open_slots[pos] -= 1
            picked.append((pid, pos, val))
        else:
            rest.append((pid, pos, val))
    for pid, pos, val in rest:
        for slot in sorted(FLEX_OK, key=lambda s: len(FLEX_OK[s])):
            if open_slots.get(slot, 0) > 0 and pos in FLEX_OK[slot]:
                open_slots[slot] -= 1
                picked.append((pid, pos, val))
                break
    return picked


def pos_stats(scores_by_pos):
    """(mean, sd) per position from whatever window was passed in."""
    out = {}
    for pos, xs in scores_by_pos.items():
        if not xs:
            continue
        m = sum(xs) / len(xs)
        sd = math.sqrt(sum((x - m) ** 2 for x in xs) / max(len(xs) - 1, 1))
        out[pos] = (m, max(sd, MIN_SD))
    return out


def season_odds(season, ld, raw_root, sproj):
    """Per-week pregame lines for one season, or None."""
    sdir = ld / season
    mw = load(sdir / "matchups.json")
    weekly = load(sdir / "weekly.json")
    teams = load(sdir / "teams.json")
    players = load(ld / "players_min.json") or {}
    league = load(raw_root / season / "league.json") or {}
    if not mw or teams is None:
        return None
    slots = league.get("roster_positions") or []
    ps = mw.get("playoff_start", 15)

    def pos_of(pid):
        p = players.get(pid)
        return p[1] if p and p[1] in CORE else None

    # pid -> {week: points}, regular season only (weekly.json holds no more)
    form = defaultdict(dict)
    for pid, rows in (weekly or {}).items():
        for r in rows:
            form[pid][r[0]] = r[1]

    played_weeks = sorted({e[0] for lst in mw["teams"].values() for e in lst
                           if e[0] < ps})
    sched_weeks = sorted(int(k) for k in (mw.get("schedule") or {}) if int(k) < ps)

    out = {}
    for wk in played_weeks + sched_weeks:
        prior = range(1, wk)
        # positional priors from the PRIOR window only — no lookahead
        by_pos = defaultdict(list)
        for pid, wks in form.items():
            po = pos_of(pid)
            if po:
                by_pos[po] += [v for w, v in wks.items() if w in prior]
        pstat = pos_stats(by_pos)

        def dist(pid):
            """(mean, sd) for one starter, as of before week `wk`."""
            po = pos_of(pid) or "?"
            pm, psd = pstat.get(po, (None, None))
            hist = [v for w, v in form.get(pid, {}).items() if w in prior]
            if hist and pm is not None:
                return shrink(hist, pm, psd)
            # no form yet: the projection is the best mean available
            proj = (sproj.get(pid) or {}).get("ppg")
            mean = proj if proj is not None else (pm if pm is not None else 10.0)
            return mean, (psd if psd is not None else DEFAULT_SD)

        sides, is_proj = {}, wk not in played_weeks
        if not is_proj:
            for rid, lst in mw["teams"].items():
                e = next((x for x in lst if x[0] == wk), None)
                if not e:
                    continue
                mus, vs = [], []
                for pid in e[4]:
                    m, sd = dist(pid)
                    mus.append(m); vs.append(sd * sd)
                sides[int(rid)] = (sum(mus), sum(vs), e[2])
        else:
            pairs = (mw.get("schedule") or {}).get(str(wk)) or []
            opp = {}
            for a, b in pairs:
                opp[a], opp[b] = b, a
            for t in teams:
                rid = t["roster_id"]
                cands = []
                for pid in t.get("players") or []:
                    po = pos_of(pid)
                    if not po:
                        continue
                    val = (sproj.get(pid) or {}).get("ppg")
                    if val is None:
                        val = dist(pid)[0]
                    cands.append((pid, po, val))
                mus, vs = [], []
                for pid, _po, val in best_lineup(cands, slots):
                    mus.append(val)
                    vs.append(dist(pid)[1] ** 2)
                sides[rid] = (sum(mus), sum(vs), opp.get(rid))

        wkout = {}
        for rid, (mu, var, o) in sides.items():
            rec = {"mu": round(mu, 1), "sd": round(math.sqrt(var), 1), "opp": o}
            if o is not None and o in sides:
                omu, ovar, _ = sides[o]
                rec["wp"] = round(win_prob(mu, var, omu, ovar), 4)
            if is_proj:
                rec["proj"] = True
            wkout[str(rid)] = rec
        if wkout:
            out[str(wk)] = wkout
    return {"meta": {"playoff_start": ps,
                     "model": "sum of starters ~ Normal; prior weeks only, no lookahead",
                     "played": played_weeks, "projected": sched_weeks}, "weeks": out}


def main():
    ap = argparse.ArgumentParser(description="pregame win probability per matchup")
    ap.add_argument("--season")
    ap.add_argument("--raw", default=str(ROOT / "sleeper_data"))
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()

    ld = Path(str(DATA))
    raw_root = Path(args.raw)
    sproj = (load(ld / "proj_sleeper.json") or {}).get("players") or {}
    seasons = ([args.season] if args.season
               else sorted(d.name for d in ld.iterdir()
                           if d.is_dir() and d.name.isdigit()
                           and (d / "matchups.json").exists()))
    if not seasons:
        sys.exit("no season has matchups.json — run build_site_data.py first")

    print("week odds · pregame only (weeks 1..W-1), same normal model as the bracket")
    n = 0
    for s in seasons:
        got = season_odds(s, ld, raw_root, sproj)
        if not got:
            print(f"  {s}: no matchups — skipped")
            continue
        wks = got["weeks"]
        npro = sum(1 for v in wks.values() if any(r.get("proj") for r in v.values()))
        print(f"  {s}: {len(wks)} weeks ({len(wks) - npro} played, {npro} projected)")
        if args.probe:
            continue
        (ld / s / "odds.json").write_text(json.dumps(got), encoding="utf-8")
        n += 1
    print(f"\n{'probe: nothing written' if args.probe else f'wrote {n} odds.json'}")


if __name__ == "__main__":
    main()
