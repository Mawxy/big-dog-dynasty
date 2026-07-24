#!/usr/bin/env python3
"""
blend_values.py — an ensemble "trade rating" in the spirit of NFL passer rating:
each signal is clamped into a meaningful range (below a floor = no credit, above
a ceiling = no extra), then weighted and summed, so no single flawed signal
dominates and separation comes from excelling across ALL of them.

Signals: projected WAR (production), KTC + FantasyCalc (two markets), roster%
(crowd demand, capped since it saturates), and start% (real starter usage).

start% is the subtle one — it blends the crawl's SEASON AVERAGE with the current
SNAPSHOT on a schedule that trusts the snapshot early (thin data) and shifts to
the season average by week 8, so one injured week never tanks a value. Injured-
flagged players skip the start component while the snapshot still dominates.

Inputs (committed): data/projections.json, data/values.json,
data/league_signals.json, sleeper_data/players.json (injury flags).
Output: data/blended_values.json.  Usage: python scripts/blend_values.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# ---- knobs -----------------------------------------------------------------
# KTC and FC are the SAME market, so they're merged into one "market" opinion
# that gets a fixed share; WAR/roster/start split the rest (weighted among
# themselves). MARKET_SHARE=0.5 => a true second opinion, not a KTC echo.
MARKET_SHARE = 0.50
WEIGHTS_NM = {"war": 1.0, "roster": 1.0, "start": 1.2}   # non-market, relative
# clamp ranges: below lo -> 0, above hi -> 1. markets keep a high ceiling to
# preserve top-end spread; roster% caps early because it saturates ~0.9.
CLAMP = {"war": ("p10", "p95"), "ktc": ("p10", "p99"), "fc": ("p10", "p99"),
         "roster": (0.30, 0.90), "start": (0.05, 0.85)}
# snapshot weight by regular-season week (season-average weight = 1 - this):
# 100% snapshot wk<=1 -> 0% (fully season avg) by wk>=8.
SNAP_SCHEDULE = {2: 0.85, 3: 0.75, 4: 0.65, 5: 0.50, 6: 0.30, 7: 0.10}
INJURED = {"Out", "Doubtful", "IR", "PUP", "Sus", "NA"}
INJURY_SKIP_BEFORE_WEEK = 8      # while the snapshot still drives start%


def snap_weight(week):
    if not week or week <= 1:
        return 1.0                # offseason / wk1: snapshot only
    return SNAP_SCHEDULE.get(week, 0.0)   # wk>=8 -> season average only


def start_value(s, week):
    """Blend season-average and current-snapshot start% per the week schedule."""
    season, now, obs = s.get("start_rate"), s.get("start_rate_now"), s.get("start_obs", 0)
    if now is None and season is None:
        return None
    if not obs or season is None:
        return now                # no season data yet -> snapshot
    w = snap_weight(week)
    return w * (now if now is not None else season) + (1 - w) * season


def pctl(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1)))] if xs else 0.0


def clamp(x, lo, hi):
    return None if x is None else max(0.0, min(1.0, (x - lo) / (hi - lo)))


def main():
    proj = {p["pid"]: p for p in json.load(open(DATA / "projections.json"))["players"]}
    vals = json.load(open(DATA / "values.json")).get("players", {})
    # crawl signals are optional — before the first crawl DVI still computes from
    # market + production, just without roster%/start%
    sf = DATA / "league_signals.json"
    sigf = json.load(open(sf)) if sf.exists() else {}
    sig = sigf.get("players", {})
    week = sigf.get("week", 0)
    players_meta = json.load(open(ROOT / "sleeper_data" / "players.json")) \
        if (ROOT / "sleeper_data" / "players.json").exists() else {}

    # resolve percentile-based clamp bounds from the data
    dist = {"war": [(p.get("composite") or [0])[0] for p in proj.values()],
            "ktc": [v["ktc"] for v in vals.values() if v.get("ktc")],
            "fc": [v["fc"] for v in vals.values() if v.get("fc")]}
    rng = {}
    for k, (lo, hi) in CLAMP.items():
        rng[k] = (pctl(dist[k], float(lo[1:]) / 100) if isinstance(lo, str) else lo,
                  pctl(dist[k], float(hi[1:]) / 100) if isinstance(hi, str) else hi)
    ktc_sorted = sorted(v["ktc"] for v in vals.values() if v.get("ktc"))

    def to_ktc(p01):
        return ktc_sorted[min(len(ktc_sorted) - 1, int(p01 * (len(ktc_sorted) - 1)))] if ktc_sorted else None

    out = {}
    for pid, p in proj.items():
        v = vals.get(pid, {})
        s = sig.get(pid, {}) or {}
        inj = (players_meta.get(pid, {}) or {}).get("injury_status")
        sv = start_value(s, week)
        start_c = clamp(sv, *rng["start"])
        if inj in INJURED and (not week or week < INJURY_SKIP_BEFORE_WEEK):
            start_c = None            # hurt + snapshot-driven -> don't penalize
        comps = {
            "war": clamp((p.get("composite") or [0])[0], *rng["war"]),
            "ktc": clamp(v.get("ktc"), *rng["ktc"]),
            "fc": clamp(v.get("fc"), *rng["fc"]),
            "roster": clamp(s.get("roster_rate", 0.0), *rng["roster"]),
            "start": start_c,
        }
        # market = one opinion (average the two market clamps that exist)
        mparts = [c for c in (comps["ktc"], comps["fc"]) if c is not None]
        market = sum(mparts) / len(mparts) if mparts else None
        # non-market signals weighted among themselves
        nnum = nden = 0.0
        for k in ("war", "roster", "start"):
            if comps[k] is not None:
                nnum += WEIGHTS_NM[k] * comps[k]
                nden += WEIGHTS_NM[k]
        nonmarket = nnum / nden if nden else None
        if market is not None and nonmarket is not None:
            score = MARKET_SHARE * market + (1 - MARKET_SHARE) * nonmarket
        else:
            score = market if market is not None else nonmarket
        rating = round(100 * score, 1) if score is not None else None
        out[pid] = {"name": p.get("name"), "pos": p.get("pos"), "rating": rating,
                    "trade_ktc": to_ktc(score) if score is not None else None,
                    "components": {k: (round(c, 3) if c is not None else None) for k, c in comps.items()},
                    "start_used": round(sv, 3) if sv is not None else None}

    # full detail (components etc.) stays local for tuning — gitignored, NOT
    # published, so the formula isn't inspectable on the site.
    (DATA / "blended_values.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    # site-facing DVI: value + rank only, no component breakdown.
    ranked = sorted((pid for pid in out if out[pid]["rating"] is not None),
                    key=lambda pid: -out[pid]["rating"])
    dvi = {}
    for i, pid in enumerate(ranked, 1):
        r = out[pid]
        dvi[pid] = {"name": r["name"], "pos": r["pos"], "dvi": r["rating"], "rank": i}
    (DATA / "dvi.json").write_text(json.dumps(
        {"generated": __import__("datetime").date.today().isoformat(),
         "players": dvi}, separators=(",", ":")), encoding="utf-8")
    print(f"wrote data/dvi.json: {len(dvi)} players, week={week}, "
          f"start snap-weight={snap_weight(week)}")
    ranked = [out[pid] for pid in ranked]
    print("\n=== top 10 ===")
    for r in ranked[:10]:
        print(f"  {r['name'][:22]:23}{r['pos']:4}{r['rating']:>6}  (trade-KTC {r['trade_ktc']})")
    print("\n=== reference / dart-throws ===")
    byname = {r["name"]: r for r in out.values()}
    for nm in ["Malik Nabers", "Ricky Pearsall", "Keon Coleman", "Xavier Legette",
               "Jonathon Brooks", "Mack Hollins"]:
        r = byname.get(nm)
        if r:
            print(f"  {nm:20} rating={r['rating']} start_used={r['start_used']} "
                  f"(KTC-scale {r['trade_ktc']})")


if __name__ == "__main__":
    main()
