#!/usr/bin/env python3
"""
aging_curves.py — fit per-position aging curves on historical WAR
(nfl_history/*.csv from war-history.yml) for the valuation model.

Model (settled 2026-07-17 with Max):
  next_WAR = a + b * current_WAR, fit per (position, age group) over all
  transitions with current_WAR >= 0 (assets only; negative-WAR players are
  not assets). Players absent the following season count as next_WAR = 0 —
  exit risk is priced in, not dropped (survivorship guard).

  Scenario bands: p20 / p80 of the residual (next - fit) per group give the
  "worst case" / "best case" offsets around the expectation. The bands are
  wide (~+-0.5 WAR) because year-over-year fantasy outcomes are wide — loose
  expectations are intentional.

Age groups (breakpoints located empirically, 2012-2025 transitions):
  QB: one group — flat aging in superflex; a 34yo QB1 ~ a 26yo QB1.
  RB: <=23 / 24-26 / 27+ — hard cliff at 27-28.
  WR: <=24 / 25-28 / 29+ — gentle decline from 29.
  TE: <=25 / 26+ — small sample, two groups only.

Findings baked into the shape (see chat 2026-07-17): elite seasons regress
in ratio terms (peak-outlier reversion) but stay far above starters in
absolute terms — the linear-in-current-WAR form captures both. Elite RBs
retain only ~53% of value year-over-year even before the age cliff.

Age = age on Sep 1 of the season year, from players_meta.csv birth dates.

Usage:  python scripts/aging_curves.py [--data nfl_history] [--start 2012]
Output: <data>/aging_curves.json  + a diagnostics table on stdout.
"""
import argparse, csv, datetime, json, statistics
from pathlib import Path

AGE_GROUPS = {          # pos -> list of (label, min_age, max_age)
    "QB": [("all", 0, 99)],
    "RB": [("le23", 0, 23), ("24_26", 24, 26), ("ge27", 27, 99)],
    "WR": [("le24", 0, 24), ("25_28", 25, 28), ("ge29", 29, 99)],
    "TE": [("le25", 0, 25), ("ge26", 26, 99)],
}
MIN_CUR_WAR = 0.0       # transitions below this are not assets; excluded


def age_on_sep1(birth_date, season):
    return season - birth_date.year - (
        1 if (birth_date.month, birth_date.day) > (9, 1) else 0)


def quantile(v, p):
    v = sorted(v)
    i = (len(v) - 1) * p
    lo = int(i)
    return v[lo] + (v[lo + 1] - v[lo]) * (i - lo) if lo + 1 < len(v) else v[lo]


def load_transitions(data, start, end):
    meta = {}
    for r in csv.DictReader(open(data / "players_meta.csv", encoding="utf-8")):
        if r["birth_date"]:
            meta[r["gsis_id"]] = datetime.date.fromisoformat(r["birth_date"])
    war = {}
    for yr in range(start, end + 1):
        f = data / f"waa_war_{yr}.csv"
        if not f.exists():
            continue
        for r in csv.DictReader(open(f, encoding="utf-8")):
            war[(yr, r["player_id"])] = (float(r["WAR"]), r["pos"])
    trans = []
    for (yr, pid), (w, pos) in war.items():
        if yr == end or pid not in meta or w < MIN_CUR_WAR:
            continue
        nxt = war.get((yr + 1, pid))
        trans.append((pos, age_on_sep1(meta[pid], yr), w,
                      nxt[0] if nxt else 0.0, nxt is None))
    return trans


def fit_group(rows):
    """OLS next = a + b*cur, plus residual p20/p80 and exit rate."""
    xs = [r[2] for r in rows]
    ys = [r[3] for r in rows]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    a = my - b * mx
    resid = [y - (a + b * x) for x, y in zip(xs, ys)]
    return {
        "n": len(rows),
        "a": round(a, 4), "b": round(b, 4),
        "p20": round(quantile(resid, 0.2), 4),
        "p80": round(quantile(resid, 0.8), 4),
        "exit_rate": round(sum(1 for r in rows if r[4]) / len(rows), 4),
    }


def main():
    ap = argparse.ArgumentParser(description="fit aging curves on historical WAR")
    ap.add_argument("--data", default="nfl_history")
    ap.add_argument("--start", type=int, default=2012)
    ap.add_argument("--end", type=int, default=2025)
    args = ap.parse_args()
    data = Path(args.data)

    trans = load_transitions(data, args.start, args.end)
    out = {"meta": {
        "fitted": datetime.date.today().isoformat(),
        "seasons": f"{args.start}-{args.end}",
        "model": "next_WAR = a + b*cur_WAR; scenarios = fit + p20/p80 residual",
        "min_cur_war": MIN_CUR_WAR,
        "transitions": len(trans),
    }, "curves": {}}

    print(f"transitions (cur WAR >= {MIN_CUR_WAR}): {len(trans)}")
    print(f"{'pos':4s} {'group':6s} {'ages':7s} {'n':>4s} {'a':>7s} {'b':>6s} "
          f"{'p20':>6s} {'p80':>6s} {'exit%':>6s}   E[next] @ cur=0.5 / 1.5")
    for pos, groups in AGE_GROUPS.items():
        out["curves"][pos] = []
        for label, lo, hi in groups:
            rows = [t for t in trans if t[0] == pos and lo <= t[1] <= hi]
            if len(rows) < 20:
                print(f"{pos:4s} {label:6s}  SKIPPED (n={len(rows)})")
                continue
            g = fit_group(rows)
            g.update({"group": label, "min_age": lo, "max_age": hi})
            out["curves"][pos].append(g)
            e05 = g["a"] + g["b"] * 0.5
            e15 = g["a"] + g["b"] * 1.5
            print(f"{pos:4s} {label:6s} {lo:>2d}-{hi:<3d} {g['n']:>4d} "
                  f"{g['a']:>7.3f} {g['b']:>6.3f} {g['p20']:>6.2f} "
                  f"{g['p80']:>6.2f} {g['exit_rate']:>6.1%}   "
                  f"{e05:.2f} / {e15:.2f}")

    dest = data / "aging_curves.json"
    dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nwrote {dest}")


if __name__ == "__main__":
    main()
