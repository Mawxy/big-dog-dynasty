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
     (weights 0.5/0.3/0.2 x games). Fit ONLY on transitions where the player
     actually played the next season (gp >= MIN_GP), so the curve is pure
     talent aging; falling out of the league is handled by (3). Age buckets
     capture progression (young hold, old decline). p20/p80 = residual bands.

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
    xs = [r[0] for r in rows]; ys = [r[1] for r in rows]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    a = my - b * mx
    resid = [y - (a + b * x) for x, y in zip(xs, ys)]
    return {"n": len(rows), "a": round(a, 4), "b": round(b, 4),
            "p20": round(quantile(resid, 0.2), 4), "p80": round(quantile(resid, 0.8), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="nfl_history")
    ap.add_argument("--start", type=int, default=2012)
    ap.add_argument("--end", type=int, default=2025)
    args = ap.parse_args()
    data = Path(args.data)
    meta, war, gp, pos, pts = load(data, args.start, args.end)

    # gather transitions: (pos, age, exp, tier, level, next_rate_or_None, next_gp)
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
        trans.append((pos[(yr, pid)], age, exp, m["pick"], lvl, nrt, ngp))

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
            played = [(t[4], t[5]) for t in cell if t[5] is not None]
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

    dest = data / "aging_curves.json"
    dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nwrote {dest}")


if __name__ == "__main__":
    main()
