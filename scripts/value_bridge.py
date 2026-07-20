#!/usr/bin/env python3
"""
value_bridge.py — Bridge B: market value (KTC / FantasyCalc) -> WAR.

Fits a monotone curve f(value) -> WAR from players present in both
data/values.json and our WAR tables, then applies it to the market's pick
values so picks can be priced in WAR from market signal alone (to be blended
with Bridge A's empirical slot values by sample confidence + pick maturity).

Two fits per source (Option C, settled with Max 2026-07-20):
  * proj  — value -> projected 3-yr composite WAR (per-year streams y1..y3
            plus the total). THE bridge: the market prices forward-looking
            WAR (spearman ~0.87-0.91, strictly monotone by decile).
  * war25 — value -> last season's realized WAR. Sanity column only:
            independent of the projection model but backward-looking, and
            flat below ~KTC 2000 (unproven youth and washed vets produce
            alike; spearman ~0.68-0.74).

Method: isotonic regression (pool-adjacent-violators) on players sorted by
value; blocks compressed to knots (mean value, fitted WAR); prediction is
linear interpolation between knots, clamped at the ends. Position-agnostic
on purpose — picks have no position, so the bridge must not either.
Per-position spearman is reported as a diagnostic only.

Inputs (all committed): data/values.json, data/projections.json,
data/<seed>/summary.json.
Output: data/value_bridge.json
  meta:   dates, sample sizes, spearman diagnostics (overall + by pos)
  fits:   {ktc|fc: {proj: {y1,y2,y3,total: knots}, war25: knots}}
          knots = [[value, war], ...] ascending
  picks:  {ktc|fc: [[label, value, implied_war_total, [y1,y2,y3]], ...]}

Usage: python scripts/value_bridge.py [--seed-season 2025]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- fitting --
def pav(pairs):
    """Isotonic (non-decreasing) fit. pairs = [(x, y)] any order.
    Returns knots [[mean_x, fitted_y], ...] ascending in x."""
    pairs = sorted(pairs)
    # blocks: [sum_y, n, sum_x]
    blocks = []
    for x, y in pairs:
        blocks.append([y, 1, x])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] >= blocks[-1][0] / blocks[-1][1]:
            b = blocks.pop()
            blocks[-1][0] += b[0]
            blocks[-1][1] += b[1]
            blocks[-1][2] += b[2]
    return [[round(sx / n, 1), round(sy / n, 3)] for sy, n, sx in blocks]


def interp(knots, x):
    """Piecewise-linear prediction from knots, clamped at both ends."""
    if x <= knots[0][0]:
        return knots[0][1]
    if x >= knots[-1][0]:
        return knots[-1][1]
    for (x0, y0), (x1, y1) in zip(knots, knots[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return knots[-1][1]  # unreachable


def spearman(x, y):
    def rank(a):
        s = sorted(range(len(a)), key=lambda i: a[i])
        r = [0.0] * len(a)
        i = 0
        while i < len(s):
            j = i
            while j + 1 < len(s) and a[s[j + 1]] == a[s[i]]:
                j += 1
            for k in range(i, j + 1):
                r[s[k]] = (i + j) / 2
            i = j + 1
        return r
    rx, ry = rank(x), rank(y)
    n = len(x)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx) ** 0.5
    vy = sum((b - my) ** 2 for b in ry) ** 0.5
    return round(cov / (vx * vy), 3) if vx and vy else 0.0


# ------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed-season", type=int, default=2025,
                    help="season whose summary.json is the realized-WAR sanity fit")
    args = ap.parse_args()

    values = json.loads((ROOT / "data" / "values.json").read_text())
    proj = {d["pid"]: d for d in
            json.loads((ROOT / "data" / "projections.json").read_text())["players"]}
    summary = json.loads(
        (ROOT / "data" / str(args.seed_season) / "summary.json").read_text())
    war_real = {r[0]: (r[1], r[6]) for r in summary}  # pid -> (pos, war)

    out = {"meta": {"values_fetched": values.get("fetched"),
                    "seed_season": args.seed_season,
                    "sources": {}},
           "fits": {}, "picks": {}}

    for src in ("ktc", "fc"):
        # -- joins ----------------------------------------------------------
        pj = [(d[src], proj[pid]) for pid, d in values["players"].items()
              if d.get(src) and pid in proj]
        rl = [(d[src], war_real[pid]) for pid, d in values["players"].items()
              if d.get(src) and pid in war_real]

        # -- fits -----------------------------------------------------------
        proj_fit = {}
        for k, key in (("y1", 0), ("y2", 1), ("y3", 2)):
            proj_fit[k] = pav([(v, p["composite"][key]) for v, p in pj])
        proj_fit["total"] = pav([(v, p["total_comp"]) for v, p in pj])
        war25_fit = pav([(v, w) for v, (_, w) in rl])
        out["fits"][src] = {"proj": proj_fit, "war25": war25_fit}

        # -- diagnostics ----------------------------------------------------
        diag = {"n_proj": len(pj), "n_war25": len(rl),
                "spearman_proj": spearman([v for v, _ in pj],
                                          [p["total_comp"] for _, p in pj]),
                "spearman_war25": spearman([v for v, _ in rl],
                                           [w for _, (_, w) in rl]),
                "spearman_proj_by_pos": {}}
        for pos in ("QB", "RB", "WR", "TE"):
            sub = [(v, p["total_comp"]) for v, p in pj if p["pos"] == pos]
            if len(sub) >= 10:
                diag["spearman_proj_by_pos"][pos] = spearman(
                    [v for v, _ in sub], [w for _, w in sub])
        out["meta"]["sources"][src] = diag

        # -- price the market's picks --------------------------------------
        picks = []
        for label, val in values.get("picks", {}).get(src, []):
            stream = [round(interp(proj_fit[k], val), 3) for k in ("y1", "y2", "y3")]
            picks.append([label, val,
                          round(interp(proj_fit["total"], val), 3), stream])
        out["picks"][src] = picks

        # -- console report -------------------------------------------------
        print(f"[{src}] players: proj n={len(pj)} rho={diag['spearman_proj']}  "
              f"war25 n={len(rl)} rho={diag['spearman_war25']}  "
              f"knots total={len(proj_fit['total'])}")

    dest = ROOT / "data" / "value_bridge.json"
    dest.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {dest.relative_to(ROOT)}")

    # Precompute the player-page numbers into values.json itself, so the site
    # renders the implied-WAR column and model-vs-market verdict from the one
    # file it already fetches (no pop-in waiting on extra requests):
    #   impWar   = {ktc?, fc?} market-implied 3-yr WAR at the player's value
    #   modelWar = our projected 3-yr composite WAR (total_comp)
    n_imp = 0
    for pid, d in values["players"].items():
        imp = {}
        for src in ("ktc", "fc"):
            knots = out["fits"].get(src, {}).get("proj", {}).get("total")
            if knots and d.get(src) is not None:
                imp[src] = round(interp(knots, d[src]), 3)
        d.pop("impWar", None), d.pop("modelWar", None)
        if imp:
            d["impWar"] = imp
            n_imp += 1
        if pid in proj:
            d["modelWar"] = proj[pid]["total_comp"]
    vdest = ROOT / "data" / "values.json"
    vdest.write_text(json.dumps(values, separators=(",", ":")) + "\n")
    print(f"augmented {vdest.relative_to(ROOT)}: impWar for {n_imp} players")


if __name__ == "__main__":
    main()
