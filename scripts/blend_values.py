#!/usr/bin/env python3
"""
blend_values.py — an ENSEMBLE trade value: combine production (projected WAR),
both markets (KTC, FantasyCalc), and league behavior from the crawl (roster%,
start% when available) into one number, so no single flawed signal dominates.

Each signal is percentile-ranked across the tradeable universe (robust to the
wildly different raw scales), blended under several weight presets, and the
blended percentile is mapped back onto the KTC value scale so the output reads
in familiar units. Emits data/blended_values.json and prints a comparison.

Inputs (all committed): data/projections.json, data/values.json,
data/league_signals.json.  Usage: python scripts/blend_values.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# weight presets over [war, ktc, fc, roster, start]; missing signals drop out
# and the remaining weights renormalize per player.
PRESETS = {
    "balanced":   {"war": 1, "ktc": 1, "fc": 1, "roster": 1, "start": 1},
    "market":     {"war": 0.5, "ktc": 2, "fc": 2, "roster": 1, "start": 1},
    "production": {"war": 3, "ktc": 1, "fc": 1, "roster": 0.5, "start": 1},
    "behavior":   {"war": 1, "ktc": 1, "fc": 1, "roster": 2.5, "start": 2.5},
}


def pct_ranks(values):
    """map {key: number} -> {key: percentile in [0,1]} (ties share mid-rank)."""
    items = sorted(values.items(), key=lambda kv: kv[1])
    n = len(items)
    out = {}
    i = 0
    while i < n:
        j = i
        while j + 1 < n and items[j + 1][1] == items[i][1]:
            j += 1
        p = ((i + j) / 2) / (n - 1) if n > 1 else 0.5
        for k, _ in items[i:j + 1]:
            out[k] = p
        i = j + 1
    return out


def main():
    proj = json.load(open(DATA / "projections.json", encoding="utf-8"))["players"]
    vals = json.load(open(DATA / "values.json", encoding="utf-8")).get("players", {})
    sig = json.load(open(DATA / "league_signals.json", encoding="utf-8")).get("players", {})

    # raw signal per player (only players we actually project = tradeable universe)
    raw = {}
    for p in proj:
        pid = p["pid"]
        v = vals.get(pid, {})
        s = sig.get(pid, {})
        comp = p.get("composite") or [0]
        raw[pid] = {
            "name": p.get("name"), "pos": p.get("pos"),
            "war": comp[0],
            "ktc": v.get("ktc"),
            "fc": v.get("fc"),
            "roster": s.get("roster_rate", 0.0),      # absent from crawl => ~0
            "start": s.get("start_rate"),             # None until the crawl collects starters
        }

    # percentile-rank each signal across players that HAVE it
    SIGNALS = ["war", "ktc", "fc", "roster", "start"]
    ranks = {}
    for sg in SIGNALS:
        present = {pid: r[sg] for pid, r in raw.items() if r[sg] is not None}
        ranks[sg] = pct_ranks(present) if present else {}

    # KTC scale for mapping blended percentile back to familiar units
    ktc_sorted = sorted(v.get("ktc") for v in vals.values() if v.get("ktc") is not None)

    def to_ktc(pctile):
        if not ktc_sorted:
            return None
        idx = min(len(ktc_sorted) - 1, int(round(pctile * (len(ktc_sorted) - 1))))
        return ktc_sorted[idx]

    out = {}
    for pid, r in raw.items():
        prow = {sg: ranks[sg].get(pid) for sg in SIGNALS}
        blends = {}
        for name, w in PRESETS.items():
            num = den = 0.0
            for sg in SIGNALS:
                if prow[sg] is not None and w.get(sg):
                    num += w[sg] * prow[sg]
                    den += w[sg]
            pct = num / den if den else None
            blends[name] = {"pct": round(pct, 4) if pct is not None else None,
                            "ktc": to_ktc(pct) if pct is not None else None}
        out[pid] = {"name": r["name"], "pos": r["pos"],
                    "signals": {sg: (round(prow[sg], 3) if prow[sg] is not None else None)
                                for sg in SIGNALS},
                    "blends": blends}

    (DATA / "blended_values.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"wrote {DATA/'blended_values.json'}: {len(out)} players, presets {list(PRESETS)}")

    # comparison: how each preset ranks a few reference players (KTC-scale)
    refs = ["Malik Nabers", "Marvin Harrison", "Ricky Pearsall", "Keon Coleman",
            "Xavier Legette", "Mack Hollins", "Kenny Pickett"]
    byname = {r["name"]: pid for pid, r in out.items()}
    hdr = f"{'player':20}{'pos':4}{'KTC':>6}" + "".join(f"{p[:9]:>10}" for p in PRESETS)
    print("\n=== blended trade value (KTC-scale) by preset ===")
    print(hdr)
    for nm in refs:
        pid = byname.get(nm)
        if not pid:
            continue
        row = out[pid]
        ktc = vals.get(pid, {}).get("ktc", "-")
        cells = "".join(f"{row['blends'][p]['ktc'] if row['blends'][p]['ktc'] is not None else '-':>10}"
                        for p in PRESETS)
        print(f"{nm[:19]:20}{row['pos']:4}{ktc:>6}{cells}")


if __name__ == "__main__":
    main()
