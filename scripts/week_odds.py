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
    dump) and each starter's own form to that point.
  * UPCOMING weeks have no lineup yet, so each roster fields its best legal
    lineup by projected points under the league's roster_positions.

THE PROJECTION IS THE PRIOR. A starter's mean is his own form shrunk toward
HIS SLEEPER PROJECTION, not toward his position's average — so week 1 is pure
projection, about half and half by week 4, and mostly form by week 10, which
is the rate at which weekly scoring actually becomes informative.

That ordering was measured, not assumed. Scored against 2022-2025 with a
perfect projection standing in (each player's true season average — a ceiling
no real projection reaches), pricing off form alone versus off the projection
as prior:

    weeks 1-4    log loss 0.678 -> 0.637     accuracy 51.0% -> 58.3%
    weeks 5-9    log loss 0.629 -> 0.618     accuracy 65.0% -> 65.0%
    weeks 10-14  log loss 0.552 -> 0.536     accuracy 71.7% -> 73.3%

The entire gain is early, which is the point: four games of history is mostly
noise, and a form-only model was a coin flip through week 4. Late in a season
form has caught up and the prior barely matters — so this replaces nothing,
it only fills the gap where form is thin.

Variance still comes from positional form in every case, because a projection
is a point estimate and carries no spread of its own.

HISTORICAL SNAPSHOTS. Pricing a PAST week off projections needs the
projections as they stood THEN, and Sleeper only serves the current ones.
`--snapshot` archives the live file into <season>/proj_history.json keyed by
the NFL week, trimmed to rostered players, so future seasons can be priced
honestly. Seasons before this existed have no snapshots and fall back to the
positional prior, which is what they were always built on.

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
from playoff_wpa import MIN_SD, shrink, win_prob

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


def snapshot_projections(season, ld, sproj, week, teams):
    """Archive the CURRENT projections under `week`, trimmed to rostered players.

    Sleeper only serves today's projections, so pricing a past week off them
    later requires having kept them. Trimming to rostered players keeps the
    file small enough to live in the repo — the unrostered 2,700 are never
    starters and can't affect a line."""
    if not week or not sproj:
        return False
    f = ld / season / "proj_history.json"
    hist = load(f) or {}
    # FIRST write for a week wins. The pipeline runs daily, and Sleeper's
    # nfl_state week does not advance until after the week completes — so a
    # Monday run would otherwise overwrite the week's snapshot with numbers
    # taken AFTER its games were played, which is exactly the lookahead this
    # file exists to prevent. The first snapshot of a week is taken the day it
    # became current, which is safely pregame.
    if str(week) in hist:
        return False
    rostered = {str(p) for t in (teams or []) for p in (t.get("players") or [])}
    snap = {p: round(v["ppg"], 2) for p, v in sproj.items()
            if p in rostered and v.get("ppg") is not None}
    if not snap:
        return False
    hist[str(week)] = snap
    f.write_text(json.dumps(hist), encoding="utf-8")
    return True


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
    # projections as they stood in each week, when we have them; the live file
    # is the fallback (and is correct for an upcoming week by definition)
    phist = load(sdir / "proj_history.json") or {}

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

        is_proj = wk not in played_weeks
        # Nothing to price on: no prior form, and no projection kept for this
        # week either. Emitting a line here would print 50% for every game and
        # read as a forecast, when in fact it is the absence of one. Week 1 of
        # every season before snapshots existed lands here.
        if not is_proj and not phist.get(str(wk)) and not any(
                w in prior for wks in form.values() for w in wks):
            continue
        # What was projected FOR THIS WEEK. The archived snapshot when we kept
        # one; otherwise the live file, but ONLY for a week that hasn't been
        # played — that week is in the current season, so today's projections
        # are the right ones. Reaching for the live file on an old week would
        # price a 2022 game off 2026 numbers: Travis Kelce averaged 22.9 that
        # year and projects 11.7 now, so his 2022 lines would read as a
        # different player. A past week with no snapshot gets no projection at
        # all and falls back to the positional prior, which is what those
        # seasons were always built on.
        wproj = phist.get(str(wk))

        def projected(pid):
            if wproj is not None:
                return wproj.get(pid)
            return (sproj.get(pid) or {}).get("ppg") if is_proj else None

        def dist(pid):
            """(mean, sd) for one starter, as of before week `wk`.

            The prior is HIS PROJECTION where one exists, not his position's
            average — so a player with no games yet is his projection, and
            form takes over as it accumulates. Falls back to the positional
            mean for seasons with no archived projections."""
            po = pos_of(pid) or "?"
            pm, psd = pstat.get(po, (None, None))
            sd = psd if psd is not None else DEFAULT_SD
            base = projected(pid)
            if base is None:
                base = pm if pm is not None else 10.0
            hist = [v for w, v in form.get(pid, {}).items() if w in prior]
            return shrink(hist, base, sd) if hist else (base, sd)

        sides = {}
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
    ap.add_argument("--snapshot", action="store_true",
                    help="archive today's projections under the current NFL "
                         "week, so this week can be priced honestly later")
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

    print("week odds · pregame only (weeks 1..W-1), projection as the prior")
    if args.snapshot and not args.probe:
        state = load(raw_root / "nfl_state.json") or {}
        wk, sn = state.get("week"), str(state.get("season") or "")
        if wk and sn in seasons:
            if snapshot_projections(sn, ld, sproj, wk, load(ld / sn / "teams.json")):
                print(f"  archived {sn} week {wk} projections")
        else:
            print(f"  no snapshot: NFL week {wk!r}, season {sn!r} "
                  f"({'offseason' if not wk else 'season not built'})")
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
