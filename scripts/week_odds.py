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
honestly. Only while season_type is "regular" — see snapshot_week(). Seasons
before this existed have no snapshots and fall back to the positional prior,
which is what they were always built on.

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
import argparse, json, math, random, statistics, sys
from collections import defaultdict
from pathlib import Path

from ioutil import atomic_write
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


def snapshot_projections(season, ld, sproj, week):
    """Archive THE WEEK'S OWN LINES under `week`, for every player who has one.

    Sleeper only serves today's projections, so pricing a past week off them
    later requires having kept them.

    EVERY PLAYER WITH A LINE, NOT EVERY ROSTERED PLAYER (2026-09-21). This
    used to trim to the players rostered on snapshot day, on the grounds that
    nobody else can be a starter. Two things are wrong with that. A player
    added off waivers on Wednesday IS a starter that Sunday and is missing
    from Tuesday's snapshot; and a snapshot with a hole in it is read by
    `projected()` below as "no line", which used to mean the positional mean —
    eight to twelve phantom points, appearing only once the week flipped from
    upcoming to played, so the PREGAME line of record changed after the fact.
    proj_sleeper.json carries ~600 rows with weekly lines; keeping them all
    costs a few kilobytes a week and makes the snapshot a complete record of
    what was quoted, which is the only thing that can be read back honestly.

    A SEASON ROW IS NOT A WEEK'S LINE. `src:"season"` players have no `wk` map
    — the field this used to fall back to, `ppg`, is that player's season total
    over 17, which never drops to zero on a bye and is not a projection for any
    particular week. It is not archived: absent means "no line for this week",
    which is what `projected()` now prices at 0.0, matching the live path's one
    rule (Max, 2026-09-15)."""
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
    snap = {}
    for p, v in sproj.items():
        val = (v.get("wk") or {}).get(str(week))
        if val is not None:
            snap[p] = round(val, 2)
    if not snap:
        return False
    hist[str(week)] = snap
    atomic_write(f, json.dumps(hist, separators=(",", ":")))
    return True


def snapshot_week(state, seasons):
    """The (season, week) today's projections may be archived under, or None.

    REGULAR SEASON ONLY. Through August Sleeper's /state/nfl reports
    season_type "pre" with `week` counting PREseason weeks, so an August daily
    run would archive preseason projections under regular-season week keys —
    and snapshot_projections is first-write-wins, so the honest pregame
    snapshot is then refused when that week actually arrives. sleeper_pull's
    effective_week() distrusts state.week outside the regular season for the
    same reason.
    """
    state = state or {}
    if state.get("season_type") != "regular":
        return None
    wk, sn = state.get("week"), str(state.get("season") or "")
    return (sn, wk) if wk and sn in seasons else None


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
    # The earliest week ANY player has form in. The "is there prior form?" test
    # below is exactly `first_form < wk`, and hoisting it out of the week loop
    # replaces a full rescan of every player's every week — per priced week —
    # with one scan per season.
    first_form = min((w for wks in form.values() for w in wks), default=None)

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
        if not is_proj and not phist.get(str(wk)) and not (
                first_form is not None and first_form in prior):
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
                # ONE RULE IN BOTH PATHS (2026-09-21). The snapshot is a
                # complete record of the lines quoted for this week (see
                # snapshot_projections), so a player who isn't in it had no
                # line — a bye, an absence, or a waiver add the snapshot
                # predates — and that is zero, exactly as the live branch
                # below reads it. Returning None here instead sent him to the
                # positional mean, so the same player was priced 0 while the
                # week was upcoming and ~10 once it flipped to played: the
                # pregame line of record changed after the fact.
                return wproj.get(pid, 0.0)
            if not is_proj:
                return None
            # THE WEEK'S OWN LINE, AND ONLY IT (Max, 2026-09-15). rotowire
            # varies lines by matchup, so the week is the unit; a player with
            # no line for this week is not playing it, whether that is a bye,
            # a roster Sleeper publishes no weekly projection for, or someone
            # missing from the file entirely. All three are zero for the week.
            #
            # This used to fall back to `ppg`. For a src:season row that field
            # is the season total divided by 17 — neither a week's projection
            # nor a per-game average, and it never drops to zero on a bye, so
            # a season number stood in for the one thing this function exists
            # to report and a benched player kept scoring through his bye.
            return ((sproj.get(pid) or {}).get("wk") or {}).get(str(wk), 0.0)

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
                # Sleeper writes "0" for an empty lineup slot. It is not a
                # player, and dist("0") returns the fallback mean — roughly ten
                # phantom points added to that team's line (2023 week 7 has one).
                for pid in e[4]:
                    if pid == "0":
                        continue
                    m, sd = dist(pid)
                    mus.append(m); vs.append(sd * sd)
                sides[int(rid)] = (sum(mus), sum(vs), e[2])
        else:
            pairs = (mw.get("schedule") or {}).get(str(wk)) or []
            opp = {}
            for a, b in pairs:
                opp[a], opp[b] = b, a
            # the LIVE week prices the lineup managers actually set; future
            # weeks stay best-projected (settled with Max, 2026-08-31)
            set_lineups = ((mw.get("set") or {}).get("starters")
                           if (mw.get("set") or {}).get("week") == wk else None)

            def week_val(pid):
                # the same one rule as `projected` above: this week's line, or
                # zero. The zero is what lets best_lineup bench a player on
                # bye, as a manager would, and it is now also what a player
                # with no weekly coverage gets, rather than a season average.
                return ((sproj.get(pid) or {}).get("wk") or {}).get(str(wk), 0.0)

            for t in teams:
                rid = t["roster_id"]
                mus, vs = [], []
                set_l = (set_lineups or {}).get(str(rid))
                if set_l:
                    for pid in set_l:
                        if not pid or pid == "0":   # empty lineup slot
                            continue
                        # no positional-prior fallback here either: that was
                        # ten phantom points for a player nobody projected
                        mus.append(week_val(pid))
                        vs.append(dist(pid)[1] ** 2)
                else:
                    cands = []
                    for pid in t.get("players") or []:
                        po = pos_of(pid)
                        if not po:
                            continue
                        cands.append((pid, po, week_val(pid)))
                    for pid, _po, val in best_lineup(cands, slots):
                        mus.append(val)
                        vs.append(dist(pid)[1] ** 2)
                sides[rid] = (sum(mus), sum(vs), opp.get(rid))

        # A WEEK WITH NO LINES IS NOT A FORECAST. With every starter at zero
        # both sides price at zero and win_prob returns a flat 50%, which
        # reads as a prediction rather than as the absence of one — the same
        # call made above for a week with neither form nor projection. Skip
        # it and let the week arrive when Sleeper publishes it.
        if is_proj and not any(mu > 0 for mu, _v, _o in sides.values()):
            continue
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


# ---------------------------------------------------------------------------
# SEASON SIMULATION — playoff and title odds per franchise (Max, 2026-09-02)
# ---------------------------------------------------------------------------

SIMS = 10000


def first_round_byes(n_po):
    """How many top seeds sit out round one of an `n_po`-team bracket.

    A bracket is a power of two; a field that isn't one fills the gap with
    byes for the best seeds. Six teams in an eight-slot bracket is two byes,
    which is what this league runs. Every other size falls out of the same
    arithmetic rather than needing its own branch — 3 -> 1 bye, 5 -> 3,
    10 -> 6 — and only 4, 8, 16 have none."""
    size = 1
    while size < n_po:
        size *= 2
    return size - n_po


def run_bracket(field, seed_of, game):
    """Play a Sleeper bracket down to its two finalists. `field` is in seed
    order, best first.

    RESEEDING EVERY ROUND, which is what this league's brackets have actually
    done: the survivors are re-sorted by seed, so the 1 seed always draws the
    lowest one left. Generalized from the hand-written 4 / 6 / 8 branches this
    replaces (2026-09-21) — those dropped a survivor at 10, raised a
    ValueError at 12, and quietly put the 3 seed out of a 3-team bracket
    without a game. Nothing about the six-team path moves: two byes, then
    1-v-lowest and 2-v-higher, the same games in the same order."""
    alive = list(field)
    byes = first_round_byes(len(alive))
    while len(alive) > 2:
        resting, playing = alive[:byes], alive[byes:]
        winners = [game(playing[i], playing[len(playing) - 1 - i])
                   for i in range(len(playing) // 2)]
        alive = sorted(resting + winners, key=lambda r: seed_of[r])
        byes = 0                                  # byes are a round-one thing
    return alive[0], alive[1]


def season_sim(mw, odds_weeks, league, seed=1):
    """Monte-Carlo the rest of the season off the same per-week lines.

    The standings as played so far are taken as given; every remaining
    regular-season matchup is drawn from the two sides' (mu, sd) in the odds
    table — the projected lineups, priced with no lookahead — and the final
    table is seeded the way the league seeds (wins, then points). The top
    `playoff_teams` play a Sleeper bracket (`run_bracket`): the best seeds
    rest through round one until the field fills a power of two, and every
    round RESEEDS, so the 1 seed always draws the lowest survivor. With six —
    this league — that is byes for seeds 1-2, then 3v6 and 4v5, then 1 against
    the lower winner. Playoff strength is a team's mean projected week over
    the remaining schedule, since no lineup exists for a week that far out.

    Returns {rid: {"playoff": p, "bye": p, "title": p, "final": p}}, or None
    when the regular season is over (the bracket page owns that story).
    """
    ps = mw.get("playoff_start", 15)
    n_po = int((league.get("settings") or {}).get("playoff_teams") or 6)
    # every franchise: the scored table before the season has no rows, so the
    # schedule's pairings name the field until week 1 is in
    rids = sorted({int(r) for r in mw["teams"]}
                  | {r for pairs in (mw.get("schedule") or {}).values() for pr in pairs for r in pr})
    if not rids:
        return None
    # a bracket needs two teams and cannot hold more than the league has
    n_po = max(2, min(n_po, len(rids)))
    n_bye = first_round_byes(n_po)
    wins = {r: 0.0 for r in rids}
    pts = {r: 0.0 for r in rids}
    played = set()
    for r, lst in mw["teams"].items():
        for e in lst:
            if e[0] >= ps:
                continue
            played.add(e[0])
            pts[int(r)] += e[1]
            if e[3] is not None:
                wins[int(r)] += 1.0 if e[1] > e[3] else 0.5 if e[1] == e[3] else 0.0
    remaining = []
    for wk_s, pairs in (mw.get("schedule") or {}).items():
        wk = int(wk_s)
        if wk >= ps or wk in played:
            continue
        line = odds_weeks.get(str(wk)) or {}
        for a, b in pairs:
            la, lb = line.get(str(a)), line.get(str(b))
            if la and lb:
                remaining.append((a, b, la["mu"], la["sd"], lb["mu"], lb["sd"]))
    if not remaining and len(played) >= ps - 1:
        return None                                  # season over; bracket owns it
    # playoff-week strength: the mean of each team's remaining projected weeks,
    # falling back to its played average, then to the league mean
    strength = {}
    for r in rids:
        mus = [l[str(r)]["mu"] for l in odds_weeks.values() if str(r) in l and l[str(r)].get("proj")]
        sds = [l[str(r)]["sd"] for l in odds_weeks.values() if str(r) in l and l[str(r)].get("proj")]
        if mus:
            strength[r] = (statistics.mean(mus), statistics.mean(sds))
        elif played:
            strength[r] = (pts[r] / len(played), 24.0)
    if not strength:
        return None
    lm = statistics.mean(m for m, _ in strength.values())
    for r in rids:
        strength.setdefault(r, (lm, 24.0))

    rng = random.Random(seed)
    made = {r: 0 for r in rids}; bye = {r: 0 for r in rids}
    final = {r: 0 for r in rids}; title = {r: 0 for r in rids}

    def game(a, b):
        sa, sb = strength[a], strength[b]
        return a if rng.gauss(*sa) >= rng.gauss(*sb) else b

    for _ in range(SIMS):
        w = dict(wins); p = dict(pts)
        for a, b, ma, sa, mb, sb in remaining:
            xa, xb = rng.gauss(ma, sa), rng.gauss(mb, sb)
            p[a] += xa; p[b] += xb
            if xa > xb: w[a] += 1
            elif xb > xa: w[b] += 1
            else: w[a] += 0.5; w[b] += 0.5
        order = sorted(rids, key=lambda r: (w[r], p[r]), reverse=True)
        field = order[:n_po]
        for r in field:
            made[r] += 1
        seed_of = {r: i + 1 for i, r in enumerate(field)}
        for r in field[:n_bye]:
            bye[r] += 1
        f1, f2 = run_bracket(field, seed_of, game)
        final[f1] += 1; final[f2] += 1
        title[game(f1, f2)] += 1
    return {str(r): {"playoff": round(made[r] / SIMS, 4), "bye": round(bye[r] / SIMS, 4),
                     "final": round(final[r] / SIMS, 4), "title": round(title[r] / SIMS, 4)}
            for r in rids}


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
        got = snapshot_week(state, seasons)
        if got:
            sn, wk = got
            if snapshot_projections(sn, ld, sproj, wk):
                print(f"  archived {sn} week {wk} projections")
        else:
            wk, sn = state.get("week"), str(state.get("season") or "")
            st = state.get("season_type")
            why = ("not the regular season" if st != "regular"
                   else "offseason" if not wk else "season not built")
            print(f"  no snapshot: NFL week {wk!r}, season {sn!r}, "
                  f"type {st!r} ({why})")
    n = 0
    for s in seasons:
        got = season_odds(s, ld, raw_root, sproj)
        if not got:
            print(f"  {s}: no matchups — skipped")
            continue
        wks = got["weeks"]
        npro = sum(1 for v in wks.values() if any(r.get("proj") for r in v.values()))
        print(f"  {s}: {len(wks)} weeks ({len(wks) - npro} played, {npro} projected)")
        # the season simulation rides the same lines; only while the regular
        # season is still open — a finished one is the bracket's to tell
        sim = season_sim(load(ld / s / "matchups.json"), wks,
                         load(raw_root / s / "league.json") or {})
        if sim:
            got["season"] = {"sims": SIMS, "teams": sim,
                             "model": "Monte Carlo over the remaining schedule on the same "
                                      "per-week lines; seeded wins then points; Sleeper "
                                      "bracket with reseeding"}
            top = max(sim.items(), key=lambda kv: kv[1]["title"])
            print(f"      season sim: {SIMS} runs, title favorite rid {top[0]} at "
                  f"{top[1]['title'] * 100:.1f}%")
        if args.probe:
            continue
        atomic_write(ld / s / "odds.json", json.dumps(got, separators=(",", ":")))
        n += 1
    print(f"\n{'probe: nothing written' if args.probe else f'wrote {n} odds.json'}")


if __name__ == "__main__":
    main()
