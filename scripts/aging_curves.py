#!/usr/bin/env python3
"""
aging_curves.py — fit the WAR projection model on historical data
(nfl_history/*.csv). Redesigned 2026-07-17 with Max after walking the data.

Everything is per-13-game rate (a "full healthy season" is 13 games in this
league — 14 weeks minus a bye). Working in rate separates talent from
availability: a hurt star (few games, low cumulative WAR) keeps his high rate.

Three fitted pieces, all emitted to <data>/aging_curves.json:

1. curves[pos][age-bucket]:  next_rate = a + b * LEVEL
     LEVEL = recency- and games-weighted per-13 rate over the last 3 seasons
     (RECENCY weights 0.5/0.4/0.1 x games). Fit ONLY on transitions where the
     player actually played the next season (gp >= MIN_GP), so the curve is pure
     talent aging; falling out of the league is handled by (3). Age buckets
     capture progression (young hold, old decline). p20/p80 = residual bands.

     WEIGHTED BY HOW MUCH OF A SEASON ACTUALLY HAPPENED (--fit-weight, default
     `production`). MIN_GP used to be the gate keeping non-contributors out of
     this fit, but it filters on `gp`, and the played rule redefined `gp` from
     "games he produced in" to "games he dressed for". Tyrod Taylor's 2024 went
     gp 1 -> 13, and 51-59% of every QB bucket became players at a mean LEVEL
     near -1.0 — each counting as one full observation of what a quarterback
     does next year. Least squares has no locality, so they set where the line
     sits for starters too.
     A weight of min(pts / the position's median full season, 1) drops a
     zero-point season out of the fit without leaving a hole in the support the
     way a hard gate would. Validated on four rolling holdout seasons, de-biased
     per season: starters (LEVEL >= 0.8) mae 0.385 -> 0.373 and bias -0.018 ->
     -0.010; QB mae 0.543 -> 0.534. Wins 3 of 4 seasons on both cuts.

2. capital_priors[pos][tier]:  expected early-career rate by draft slot
     Mean per-13 rate of a position's players in their first two seasons,
     split by coarse draft tier. The data only supports COARSE tiers — picks
     1-16 are flat (top-5 == top-10), and within round 2 there's no gradient
     (early R2 == late R2) — so tiers are 1-16 / 17-64 / 65+ / UDFA, and the
     effect is strong for RB, medium for QB, weak for WR. Used in projection
     as a prior for thin resumes (shrinkage), fading as real seasons accrue.

3. availability[pos][age-bucket]:  expected games / 13 next season
     Mean of next-season games/13 (0 if absent) — bakes in injury AND exit
     risk. Lets projection report both an "if healthy" rate and an expected
     (rate x availability) number. RBs and older players sit lower.

Age = age on Sep 1 of the "from" season (players_meta.csv birth dates).

Usage:  python scripts/aging_curves.py [--data nfl_history] [--start 2012]
Output: <data>/aging_curves.json  + diagnostics on stdout.
"""
import argparse, csv, datetime, json, math, statistics
from collections import defaultdict
from pathlib import Path

AGE_GROUPS = {
    "QB": [("le24", 0, 24), ("25_29", 25, 29), ("30_33", 30, 33), ("ge34", 34, 99)],
    "RB": [("le23", 0, 23), ("24_26", 24, 26), ("ge27", 27, 99)],
    "WR": [("le24", 0, 24), ("25_28", 25, 28), ("ge29", 29, 99)],
    "TE": [("le25", 0, 25), ("ge26", 26, 99)],
}
UDFA_PICK = 260         # treat undrafted as just past the last pick for the ln-pick prior
RECENCY = [0.5, 0.4, 0.1]   # recency weights for seasons t, t-1, t-2 (rate over volume)
FULL_GP = 13            # a full healthy season
MIN_GP = 4             # a season needs this many games for its rate to count
MIN_N = 20             # minimum sample to fit a cell
AVAIL_MIN_LEVEL = 0.5  # availability is measured over contributor-level seasons only
                       # (the pool-wide mean is dragged down by scrubs who vanish)


def age_on_sep1(birth, season):
    return season - birth.year - (1 if (birth.month, birth.day) > (9, 1) else 0)


def quantile(v, p):
    v = sorted(v)
    i = (len(v) - 1) * p
    lo = int(i)
    return v[lo] + (v[lo + 1] - v[lo]) * (i - lo) if lo + 1 < len(v) else v[lo]


def load(data, start, end):
    meta = {}
    for r in csv.DictReader(open(data / "players_meta.csv", encoding="utf-8")):
        meta[r["gsis_id"]] = {
            "birth": datetime.date.fromisoformat(r["birth_date"]) if r["birth_date"] else None,
            "draft_season": int(r["draft_season"]) if r["draft_season"] else None,
            "pick": int(r["draft_pick"]) if r["draft_pick"] else 999,
        }
    war, gp, pos, pts = {}, {}, {}, {}
    for yr in range(start, end + 1):
        f = data / f"waa_war_{yr}.csv"
        if not f.exists():
            continue
        for r in csv.DictReader(open(f, encoding="utf-8")):
            k = (yr, r["player_id"])
            war[k] = float(r["WAR"]); gp[k] = int(r["gp"]); pos[k] = r["pos"]
            pts[k] = float(r["pts"])
    return meta, war, gp, pos, pts


def rate(war, gp, yr, pid):
    g = gp.get((yr, pid), 0)
    return war[(yr, pid)] / g * FULL_GP if g >= MIN_GP else None


def level(war, gp, yr, pid):
    # recency-weighted per-13 rate, softened by sqrt(games): a short season
    # counts less than a full one, but far less than games-proportional — so
    # rate dominates while a 4-game sample still doesn't carry a full season.
    num = den = 0.0
    for k, rw in enumerate(RECENCY):
        rt = rate(war, gp, yr - k, pid)
        if rt is None:
            continue
        w = rw * min(gp.get((yr - k, pid), 0), FULL_GP) ** 0.5
        num += w * rt; den += w
    return num / den if den else None


def fit_curve(rows):
    """rows = [(level, next_rate)] or [(level, next_rate, weight)]."""
    xs = [r[0] for r in rows]; ys = [r[1] for r in rows]
    ws = [r[2] if len(r) > 2 else 1.0 for r in rows]
    sw = sum(ws)
    if sw <= 0:
        ws = [1.0] * len(rows); sw = float(len(rows))
    mx = sum(x * w for x, w in zip(xs, ws)) / sw
    my = sum(y * w for y, w in zip(ys, ws)) / sw
    sxx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws))
    b = (sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws)) / sxx
         if sxx else 0.0)
    a = my - b * mx
    resid = [y - (a + b * x) for x, y in zip(xs, ys)]
    return {"n": len(rows), "eff_n": round(sw ** 2 / sum(w * w for w in ws), 1),
            "a": round(a, 4), "b": round(b, 4),
            "p20": round(quantile(resid, 0.2), 4), "p80": round(quantile(resid, 0.8), 4)}


# median full season of points per position, filled in main() once the data is
# loaded — the denominator that turns points into "how much of a season is this"
PROD_REF = {}
FIT_WEIGHT = "none"


def prod_w(t):
    """How much of a season this transition is worth as evidence."""
    if FIT_WEIGHT != "production":
        return 1.0
    ref = PROD_REF.get(t[0]) or 1.0
    return min(max(t[7], 0.0) / ref, 1.0)


# ---------------------------------------------------------------------------
# LEVEL-LOCAL CURVE GRID
#
# `curves[pos][age-bucket]` conditions on the wrong variable. Age, which matters
# least, is bucketed exactly; LEVEL, which matters most, is assumed linear across
# the whole bucket. Least squares has no locality, so a sub-replacement backup at
# LEVEL -1.0 sets where the line sits at 1.77 as well — and the relationship is
# convex, so the line under-predicts the top.
#
# That went from a quiet approximation to a live problem when the played rule
# redefined `gp` from "games he produced in" to "games he dressed for". MIN_GP
# was the gate keeping non-contributors out of this fit; it filters on `gp`, so
# when `gp` changed meaning the gate stopped catching anything. Tyrod Taylor's
# 2024 went gp 1 -> 13, WAR -0.04 -> -1.35, and 51-59% of every QB bucket is now
# players at a mean LEVEL near -1.0.
#
# So: condition on COMPARABLE LEVEL and let age be a soft weight. Measured on six
# rolling holdout seasons, for starters (LEVEL >= 0.8, n=268):
#
#     age bucket + global OLS    bias -0.132   mae 0.446
#     comparable LEVEL, local    bias -0.051   mae 0.441
#
# Sixty-one percent of the bias gone and mae slightly better, so this is not a
# bias/variance trade. Across all levels it is a wash (mae 0.397 -> 0.399), which
# is the point: it moves the players the old shape was getting wrong.
#
# A local fit cannot ship as four numbers per bucket, so it ships as a GRID over
# age x LEVEL that project_war.py interpolates. Still a fitted artifact, still
# inspectable, and projection stays stateless.
GRID_LEVEL_H = 0.35     # kernel bandwidth in LEVEL units. Swept 0.20-1.00; every
                        # value lands within 0.005 mae, which is itself the
                        # finding — once the backups are out of the neighbourhood
                        # the window stops mattering.
GRID_AGE_H = 3.0        # in years. Age still carries signal beyond LEVEL:
                        # dropping it entirely costs 0.009 mae. It just does not
                        # want to be a cliff at 30.
GRID_MIN_EFF = 12.0     # widen the window rather than answer from fewer
GRID_LEVEL = (-2.0, 2.6, 0.1)
GRID_AGE = (20, 42)


def _wls(rows, wts):
    """Weighted least squares of next_rate on LEVEL, returned as (mean, slope,
    mean_x) so the caller can evaluate at its own query point."""
    sw = sum(wts)
    if sw <= 0:
        return None
    mx = sum(r[0] * w for r, w in zip(rows, wts)) / sw
    my = sum(r[1] * w for r, w in zip(rows, wts)) / sw
    sxx = sum(w * (r[0] - mx) ** 2 for r, w in zip(rows, wts))
    if sxx / sw < 1e-6:
        return (my, 0.0, mx)
    b = sum(w * (r[0] - mx) * (r[1] - my) for r, w in zip(rows, wts)) / sxx
    return (my, b, mx)


def local_at(cell, age, lvl):
    """Local linear fit at (age, lvl), with p20/p80 of the weighted residuals.

    cell = [(age, level, next_rate)] for one position. Returns None when even
    the widest window cannot find anybody."""
    for h in (GRID_LEVEL_H, GRID_LEVEL_H * 2, GRID_LEVEL_H * 4, GRID_LEVEL_H * 12):
        rows, wts = [], []
        for a, l, n in cell:
            w = (math.exp(-((l - lvl) ** 2) / (2 * h * h))
                 * math.exp(-((a - age) ** 2) / (2 * GRID_AGE_H * GRID_AGE_H)))
            if w > 1e-4:
                rows.append((l, n)); wts.append(w)
        if not wts:
            continue
        eff = sum(wts) ** 2 / sum(w * w for w in wts)
        if eff < GRID_MIN_EFF and h < GRID_LEVEL_H * 12:
            continue
        f = _wls(rows, wts)
        if not f:
            continue
        my, b, mx = f
        pred = my + b * (lvl - mx)
        # Bands are the residual spread of the NEIGHBOURHOOD, not of the whole
        # bucket — the same reason the point estimate is local. A starter's
        # uncertainty is not a backup's.
        resid = sorted((n - (my + b * (l - mx)), w) for (l, n), w in zip(rows, wts))
        tot = sum(w for _, w in resid)

        def wq(q):
            acc = 0.0
            for v, w in resid:
                acc += w
                if acc >= q * tot:
                    return v
            return resid[-1][0]
        return {"pred": round(pred, 4), "p20": round(wq(0.2), 4),
                "p80": round(wq(0.8), 4), "eff_n": round(eff, 1)}
    return None


def build_grid(trans):
    """age x LEVEL lookup per position. Emitted alongside `curves`, not instead
    of it, so a consumer that has not been updated still works."""
    lo, hi, step = GRID_LEVEL
    levels = [round(lo + i * step, 2) for i in range(int(round((hi - lo) / step)) + 1)]
    ages = list(range(GRID_AGE[0], GRID_AGE[1]))
    grid = {"meta": {"levels": levels, "ages": ages, "level_h": GRID_LEVEL_H,
                     "age_h": GRID_AGE_H, "min_eff": GRID_MIN_EFF,
                     "model": "local linear on LEVEL, gaussian in LEVEL and age; "
                              "bands are the neighbourhood's residual p20/p80"}}
    for p in AGE_GROUPS:
        cell = [(t[1], t[4], t[5]) for t in trans if t[0] == p and t[5] is not None]
        if len(cell) < MIN_N:
            continue
        pred, p20, p80, effn = [], [], [], []
        for a in ages:
            rp, r20, r80, re = [], [], [], []
            for l in levels:
                r = local_at(cell, a, l)
                rp.append(r["pred"] if r else None)
                r20.append(r["p20"] if r else None)
                r80.append(r["p80"] if r else None)
                re.append(r["eff_n"] if r else 0)
            pred.append(rp); p20.append(r20); p80.append(r80); effn.append(re)
        grid[p] = {"n": len(cell), "pred": pred, "p20": p20, "p80": p80,
                   "eff_n": effn}
    return grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="nfl_history")
    ap.add_argument("--start", type=int, default=2012)
    ap.add_argument("--end", type=int, default=2025)
    # HOW MUCH IS A SEASON WORTH AS EVIDENCE?
    #
    # `none` is what shipped: every transition counts once. Since the played
    # rule redefined gp from "games he produced in" to "games he dressed for",
    # that means a QB who dressed thirteen times and scored nothing is one full
    # observation of what a quarterback does next year — and 51-59% of every QB
    # bucket is now that player.
    #
    # `production` weights a transition by how much of a season actually
    # happened: min(pts / the position's median full season, 1). A zero-point
    # season falls out of the fit without leaving a hole in the support, which
    # is what a hard gate would do. It is the same principle the analog model
    # already uses on its outcomes.
    ap.add_argument("--fit-weight", choices=("none", "production"), default="production")
    # The grid is a MEASURED NEGATIVE and is not emitted by default: it costs
    # 220 KB in this file and loses on four rolling holdouts (de-biased mae:
    # bucket 0.476, grid 0.485, and QB 0.543 vs 0.574). Kept behind a flag so
    # the result stays reproducible rather than becoming folklore.
    ap.add_argument("--emit-grid", action="store_true")
    args = ap.parse_args()
    data = Path(args.data)
    meta, war, gp, pos, pts = load(data, args.start, args.end)

    global FIT_WEIGHT
    FIT_WEIGHT = args.fit_weight
    # the position's median points among seasons that were clearly real, so the
    # denominator is not itself set by the backups being down-weighted
    for p in AGE_GROUPS:
        v = sorted(pts[k] for k in pts if pos[k] == p and gp.get(k, 0) >= 10)
        PROD_REF[p] = v[len(v) // 2] if v else 1.0

    # gather transitions: (pos, age, exp, tier, level, next_rate_or_None, next_gp, pts)
    trans = []
    for (yr, pid), w in war.items():
        if yr == args.end:
            continue
        m = meta.get(pid)
        if not m or m["birth"] is None:
            continue
        lvl = level(war, gp, yr, pid)
        if lvl is None:
            continue
        age = age_on_sep1(m["birth"], yr)
        exp = (yr - m["draft_season"] + 1) if m["draft_season"] else None
        nrt = rate(war, gp, yr + 1, pid)                 # None if absent/too few games
        ngp = gp.get((yr + 1, pid), 0)
        trans.append((pos[(yr, pid)], age, exp, m["pick"], lvl, nrt, ngp,
                      pts.get((yr, pid), 0.0)))

    out = {"meta": {
        "fitted": datetime.date.today().isoformat(), "seasons": f"{args.start}-{args.end}",
        "full_gp": FULL_GP, "min_gp": MIN_GP, "recency_weights": RECENCY,
        "udfa_pick": UDFA_PICK,
        "model": "per-13 rate; next_rate=a+b*LEVEL conditional on playing; "
                 "capital prior = a+b*ln(pick) per position; availability separate",
    }, "curves": {}, "availability": {}, "capital_priors": {}, "pts_to_war": {}}

    # 1 + 3: curves (conditional on playing) and availability, per pos x age
    print(f"transitions: {len(trans)}")
    print(f"{'pos':4s} {'grp':6s} {'n':>4s} {'a':>7s} {'b':>6s} {'avail':>5s}   E@0.5/1.5")
    for p, groups in AGE_GROUPS.items():
        out["curves"][p] = []; out["availability"][p] = []
        for label, lo, hi in groups:
            cell = [t for t in trans if t[0] == p and lo <= t[1] <= hi]
            played = [(t[4], t[5], prod_w(t)) for t in cell if t[5] is not None]
            if len(played) >= MIN_N:
                g = fit_curve(played); g.update({"group": label, "min_age": lo, "max_age": hi})
                out["curves"][p].append(g)
            else:
                g = None
            acell = [t for t in cell if t[4] >= AVAIL_MIN_LEVEL]
            src = acell if acell else cell
            avail = statistics.mean(min(t[6], FULL_GP) / FULL_GP for t in src) if src else 1.0
            out["availability"][p].append(
                {"group": label, "min_age": lo, "max_age": hi,
                 "avail": round(avail, 3), "n": len(acell)})
            if g:
                print(f"{p:4s} {label:6s} {g['n']:>4d} {g['a']:>7.3f} {g['b']:>6.3f} "
                      f"{avail:>5.2f}   {g['a']+g['b']*0.5:.2f}/{g['a']+g['b']*1.5:.2f}")

    # 1c: pedigree hold — the Chase/Jefferson archetype. Young (<=24),
    # early-pick (<=40), productive (level >= 0.8) players regress differently
    # than their age bucket's pooled fit (backtested 2026-07-20: young elite
    # top-40 WRs hold ~flat while the bucket fit shaves them; young top-40 RBs
    # regress HARDER). Fit the mean residual vs the bucket curve per position;
    # project_war adds it back for exactly this cohort. Signed — RB's negative
    # value is information, not a bug.
    PED_YOUNG, PED_PICK, PED_LEVEL, PED_MIN_N = 24, 40, 0.8, 15
    out["pedigree_hold"] = {"meta": {"max_age": PED_YOUNG, "max_pick": PED_PICK,
                                     "min_level": PED_LEVEL}}
    print("pedigree hold (young early-pick producers vs their bucket fit):")
    for p in AGE_GROUPS:
        res = []
        # positional unpack, tolerant of the tuple growing — `pts` was appended
        # for the production weighting and a fixed-width unpack broke here
        for (pp, age, exp, pick, lvl, nrt, ngp, *_rest) in trans:
            if pp != p or nrt is None:
                continue
            if age > PED_YOUNG or pick > PED_PICK or lvl < PED_LEVEL:
                continue
            g = next((g for g in out["curves"][p]
                      if g["min_age"] <= age <= g["max_age"]), None)
            if g:
                res.append(nrt - (g["a"] + g["b"] * lvl))
        if len(res) >= PED_MIN_N:
            out["pedigree_hold"][p] = {"bump": round(statistics.mean(res), 4),
                                       "n": len(res)}
            print(f"  {p:3s} n={len(res):3d}  bump={statistics.mean(res):+.3f}/yr")
        else:
            print(f"  {p:3s} n={len(res):3d}  (below min {PED_MIN_N}, not published)")

    # 1b: durability — does a player's OWN recent GP history predict next-season
    # games beyond the pos x age baseline? Backtested with Max 2026-07-20 on
    # 2012-2025: QB rho~.43, TE ~.25, WR ~.13, RB ~.07 — real but weak, so the
    # slope b is FITTED per position (self-shrinking: RB's faint signal earns a
    # small b, QB's strong one a big b). Feature per position won a backtest
    # race of mean / median / recency-weighted / best-2-of-3 / sd:
    #   QB best-2-of-3 (one lost season is noise; the typical season is signal)
    #   RB plain mean (nothing beats it; past RB injuries barely persist)
    #   WR recency-weighted | TE recency-weighted + sd as a second term
    # project_war applies: avail = age_baseline + b*(feature - feat_mean).
    DUR_FEATURES = {"QB": "best2", "RB": "mean3", "WR": "recency", "TE": "recency_sd"}
    contrib = {}   # (yr, pid) -> gp/13, contributor-level seasons only (ppg >= 5)
    for (yr, pid), g in gp.items():
        if g > 0 and pts[(yr, pid)] / g >= 5:
            contrib[(yr, pid)] = min(g, FULL_GP) / FULL_GP
    out["durability"] = {}
    print("durability (own GP history -> next-season GP, contributor seasons):")
    for p in AGE_GROUPS:
        fname = DUR_FEATURES[p]
        xs, sds, ys = [], [], []
        for (yr, pid), nxt in contrib.items():
            if pos.get((yr, pid)) != p:
                continue
            h = [contrib.get((yr - k, pid)) for k in (3, 2, 1)]   # oldest -> newest
            if any(v is None for v in h):
                continue
            f = (statistics.mean(sorted(h)[1:]) if fname == "best2"
                 else statistics.mean(h) if fname == "mean3"
                 else 0.5 * h[2] + 0.3 * h[1] + 0.2 * h[0])
            xs.append(f); sds.append(statistics.pstdev(h)); ys.append(nxt)
        mx, ms, my = statistics.mean(xs), statistics.mean(sds), statistics.mean(ys)
        sxx = sum((x - mx) ** 2 for x in xs)
        sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        if fname == "recency_sd":
            sss = sum((s - ms) ** 2 for s in sds)
            sxs = sum((x - mx) * (s - ms) for x, s in zip(xs, sds))
            ssy = sum((s - ms) * (y - my) for s, y in zip(sds, ys))
            det = sxx * sss - sxs * sxs
            b = (sss * sxy - sxs * ssy) / det if det else 0.0
            b_sd = (sxx * ssy - sxs * sxy) / det if det else 0.0
        else:
            b, b_sd = (sxy / sxx if sxx else 0.0), 0.0
        out["durability"][p] = {
            "feature": fname, "n": len(xs), "b": round(b, 4), "b_sd": round(b_sd, 4),
            "feat_mean": round(mx, 4), "sd_mean": round(ms, 4)}
        print(f"  {p:3s} {fname:10s} n={len(xs):4d}  b={b:+.3f}  b_sd={b_sd:+.3f}  "
              f"feat_mean={mx:.3f}  (swing at ±15%: {b * 0.15 * 13:+.1f} games)")

    # 2: capital prior — smooth per-position fit, rate ~ a + b*ln(pick),
    #    on early-career seasons (exp<=2). Continuous in pick (no buckets),
    #    position-specific slope (WR weak, RB/QB steep).
    print("\ncapital prior: rate ~ a + b*ln(pick), early-career (exp<=2):")
    for p in AGE_GROUPS:
        cp = [(math.log(t[3] if t[3] < 999 else UDFA_PICK), t[4])
              for t in trans if t[0] == p and t[2] is not None and t[2] <= 2]
        if len(cp) >= 15:
            xs = [x for x, _ in cp]; ys = [y for _, y in cp]
            mx, my = statistics.mean(xs), statistics.mean(ys)
            sxx = sum((x - mx) ** 2 for x in xs)
            b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
            a = my - b * mx
            out["capital_priors"][p] = {"a": round(a, 4), "b": round(b, 4), "n": len(cp)}
            print(f"  {p}: a={a:.3f} b={b:.3f} n={len(cp)}  ->  "
                  f"pick3={a+b*math.log(3):.2f} pick20={a+b*math.log(20):.2f} "
                  f"pick60={a+b*math.log(60):.2f} pick150={a+b*math.log(150):.2f}")
        else:
            out["capital_priors"][p] = {"a": 0.0, "b": 0.0, "n": len(cp)}

    # points -> WAR bridge (per-13), to convert external projections to WAR
    print("\npoints->WAR bridge (per-13): rate ~ a + b*pts13")
    for p in AGE_GROUPS:
        pairs = []
        for (yr, pid), w in war.items():
            if pos[(yr, pid)] != p or gp[(yr, pid)] < MIN_GP:
                continue
            g = gp[(yr, pid)]
            pairs.append((pts[(yr, pid)] / g * FULL_GP, w / g * FULL_GP))
        if len(pairs) >= MIN_N:
            xs = [x for x, _ in pairs]; ys = [y for _, y in pairs]
            mx, my = statistics.mean(xs), statistics.mean(ys)
            sxx = sum((x - mx) ** 2 for x in xs)
            b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
            a = my - b * mx
            out["pts_to_war"][p] = {"a": round(a, 4), "b": round(b, 6), "n": len(pairs)}
            print(f"  {p}: a={a:.3f} b={b:.5f} n={len(pairs)}  ->  "
                  f"WAR@100pts={a+b*100:.2f} @200={a+b*200:.2f} @300={a+b*300:.2f}")

    # LEVEL-local grid — see build_grid. Emitted ALONGSIDE `curves`, so a
    # consumer that hasn't been taught about it keeps working off the buckets.
    if args.emit_grid:
        print("\nLEVEL-local curve grid (age x LEVEL, per position)")
        out["curve_grid"] = build_grid(trans)
    for p in AGE_GROUPS if args.emit_grid else []:
        g = out["curve_grid"].get(p)
        if not g:
            continue
        lv = out["curve_grid"]["meta"]["levels"]
        ag = out["curve_grid"]["meta"]["ages"]
        row = ag.index(28) if 28 in ag else 0
        pts = [(x, g["pred"][row][lv.index(x)]) for x in (-1.0, 0.0, 0.8, 1.5)
               if x in lv and g["pred"][row][lv.index(x)] is not None]
        print(f"  {p}: n={g['n']}  @age28 " +
              "  ".join(f"L{x:+.1f}->{y:+.2f}" for x, y in pts))

    dest = data / "aging_curves.json"
    dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nwrote {dest}")


if __name__ == "__main__":
    main()
