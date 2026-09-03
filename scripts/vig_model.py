"""
How sportsbooks actually juice a moneyline, measured — so the League screen
can post our matchups the way a book would (Max, 2026-09-02).

A fair line reads ±X on both sides. No book posts that: it scales both implied
probabilities up so they sum past 100% and keeps the difference (the hold),
and it does NOT spread that hold evenly — the favourite carries more of it at
some probabilities and the dog at others. Rather than assume a flat 4.5%, this
reads every NFL game's closing moneylines from nflverse (`load_schedules`:
`home_moneyline`, `away_moneyline`, closing lines) and tabulates, by the
FAIR probability of the favourite, what the book actually posted on each side.

    fair_fav  = p_fav / (p_fav + p_dog)      (vig removed, proportional)
    posted    = the implied probabilities as quoted, hold and all

Output: data/vig_model.json — one row per 1% bin of fair favourite
probability from 50% to 99%, with the median posted implied probability of the
favourite and of the dog, and the game count behind each. Thin bins (fewer
than MIN_N games) are filled by linear interpolation between their neighbours
so the table is continuous. The site (beta/screens/League.tsx `moneyline`)
interpolates in this table; when the file is absent it falls back to a flat
−110/−110 hold.

A one-time fit, committed. Re-run when a few more seasons have closed:

    pip install nflreadpy
    python scripts/vig_model.py [--start 2010] [--end 2025]
"""
import argparse
import json
import sys
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "vig_model.json"
MIN_N = 25


def implied(ml):
    """American moneyline -> implied probability (hold included)."""
    ml = float(ml)
    return (-ml) / (-ml + 100.0) if ml < 0 else 100.0 / (ml + 100.0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2010)
    ap.add_argument("--end", type=int, default=2025)
    args = ap.parse_args()

    import nflreadpy as nfl
    rows = nfl.load_schedules(list(range(args.start, args.end + 1))).to_dicts()

    bins = {k: {"fav": [], "dog": [], "hold": [], "spread": []} for k in range(50, 100)}
    games = 0
    for r in rows:
        h, a = r.get("home_moneyline"), r.get("away_moneyline")
        if h in (None, "", "NA") or a in (None, "", "NA"):
            continue
        try:
            ph, pa = implied(h), implied(a)
        except (TypeError, ValueError):
            continue
        if not (0 < ph < 1 and 0 < pa < 1):
            continue
        tot = ph + pa
        fav, dog = (ph, pa) if ph >= pa else (pa, ph)
        fair = fav / tot
        k = min(99, max(50, int(fair * 100)))
        b = bins[k]
        b["fav"].append(fav)
        b["dog"].append(dog)
        b["hold"].append(tot - 1.0)
        sp = r.get("spread_line")
        if sp not in (None, "", "NA"):
            try:
                b["spread"].append(abs(float(sp)))
            except (TypeError, ValueError):
                pass
        games += 1

    table = []
    for k in range(50, 100):
        b = bins[k]
        n = len(b["fav"])
        table.append({
            "p": k / 100.0, "n": n,
            "fav": median(b["fav"]) if n else None,
            "dog": median(b["dog"]) if n else None,
            "hold": median(b["hold"]) if n else None,
            "spread": median(b["spread"]) if b["spread"] else None,
        })

    # fill thin bins by interpolating between the nearest well-populated ones,
    # so the site never lands on a hole; the count stays honest
    def fill(field):
        good = [(i, t[field]) for i, t in enumerate(table) if t["n"] >= MIN_N and t[field] is not None]
        if len(good) < 2:
            return
        for i, t in enumerate(table):
            if t["n"] >= MIN_N and t[field] is not None:
                continue
            lo = max((g for g in good if g[0] <= i), default=None, key=lambda g: g[0])
            hi = min((g for g in good if g[0] >= i), default=None, key=lambda g: g[0])
            if lo and hi and lo[0] != hi[0]:
                w = (i - lo[0]) / (hi[0] - lo[0])
                t[field] = lo[1] + (hi[1] - lo[1]) * w
            elif lo or hi:
                t[field] = (lo or hi)[1]
            t[field + "_filled"] = True
    for f in ("fav", "dog", "hold", "spread"):
        fill(f)

    holds = [t["hold"] for t in table if t["n"] >= MIN_N and t["hold"] is not None]
    out = {
        "meta": {
            "source": "nflverse load_schedules closing moneylines",
            "seasons": [args.start, args.end], "games": games, "min_n": MIN_N,
            "hold_median": median(holds) if holds else None,
            "note": "p = fair favourite probability (vig removed proportionally); "
                    "fav/dog = median POSTED implied probability, hold included; "
                    "spread = median |closing spread| in NFL points, for reference only",
        },
        "bins": table,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{games} games -> {OUT.relative_to(ROOT)}; median hold "
          f"{(out['meta']['hold_median'] or 0) * 100:.2f}%")
    for t in table[::7]:
        print(f"  fair {t['p']:.2f}  n={t['n']:4d}  fav {t['fav']:.3f}  dog {t['dog']:.3f}"
              f"  hold {t['hold'] * 100:.2f}%" if t["fav"] else f"  fair {t['p']:.2f}  —")
    return 0


if __name__ == "__main__":
    sys.exit(main())
