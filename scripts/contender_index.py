#!/usr/bin/env python3
"""
contender_index.py — CVI, the Contender Value Index: what a player is worth
over ONE season. DVI's sibling, and deliberately its opposite number.

DVI = market (KTC+FC) + production + roster% + start%. CVI keeps the non-market
half at 50% and gives the other 50% to FantasyPros ECR, which is a REDRAFT
consensus and therefore already scoped to this year.

The consequence that matters: no age channel. DVI inherits a youth premium
through KTC/FC; CVI has no way to see a birthdate. A 29-year-old who is a top-5
player this season reads like a top-5 player.

Inputs:  data/leagues/<key>/projections.json  (projected WAR)
         data/ecr.json                        (global, FantasyPros consensus)
         data/league_signals.json             (global, roster% / start%)
Output:  data/leagues/<key>/cvi.json          (published: value + ranks)
         data/leagues/<key>/cvi_detail.json   (gitignored: component breakdown)

Usage: python scripts/contender_index.py [--format ppr-superflex]
"""
import argparse, json
from datetime import date
from pathlib import Path

from curves import CURVES, DEFAULT_CURVE, war_reader
from ioutil import atomic_write
from leaguepaths import DataDir
# One definition of the shared machinery. start% in particular is subtle (it
# blends a season average with the current snapshot on a week schedule) and
# must not drift between the two indices.
from blend_values import (CLAMP, INJURED, INJURY_SKIP_BEFORE_WEEK,
                          clamp, pctl, snap_weight, start_value)

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

# ---- knobs -----------------------------------------------------------------
# ECR takes the fixed half that KTC+FC hold in DVI: an outside opinion that the
# internal signals cannot outvote.
CONSENSUS_SHARE = 0.50
# start% outranks roster% here, the reverse of how a dynasty index should read
# them. roster% is contaminated for win-now purposes — managers roster rookies
# and stashes they have no intention of starting, so it partly measures FUTURE
# interest. start% is its win-now analogue. roster% survives at a low weight
# only as a liquidity check: a player nobody rosters cannot be bought.
WEIGHTS_NM = {"war": 1.0, "roster": 0.4, "start": 1.4}
DEFAULT_FORMAT = "ppr-superflex"


def ecr_to_war(ecr_rank_order, war_sorted_desc):
    """ECR rank -> a value on the PROJECTED-WAR curve.

    ECR is ordinal: rank 1 and rank 12 are one apart as integers and worlds
    apart as players, so a linear percentile would flatten exactly the top end
    a contender is shopping in. Borrowing the shape of the projected-WAR
    distribution fixes that with no free parameters and no market input — the
    #1 consensus player is worth what the #1 projected season is worth.

    Ranks are DENSE over the players present in both files, which drops the K
    and DST that inflate raw FantasyPros rank numbers.
    """
    out = {}
    for i, pid in enumerate(ecr_rank_order):
        out[pid] = war_sorted_desc[min(i, len(war_sorted_desc) - 1)]
    return out


def load_inputs(fmt=DEFAULT_FORMAT):
    """Everything CVI reads that does NOT depend on the projection curve.

    Split out for the same reason blend_values' version is: index_models.py
    prices six curves from one load, and sleeper_data/players.json is ~19 MB.
    """
    proj = {p["pid"]: p
            for p in json.load(open(DATA / "projections.json", encoding="utf-8"))["players"]}

    ecrf = DATA / "ecr.json"
    ecr_all = json.load(open(ecrf, encoding="utf-8")).get("players", {}) if ecrf.exists() else {}
    if not ecr_all:
        print("!! no data/ecr.json — run scripts/fetch_ecr.py first")
    ecr_rank = {}
    for pid, per_fmt in ecr_all.items():
        row = per_fmt.get(fmt)
        if row and row.get("ecr") and pid in proj:
            ecr_rank[pid] = row["ecr"]

    sf = DATA / "league_signals.json"
    sigf = json.load(open(sf, encoding="utf-8")) if sf.exists() else {}
    players_meta = json.load(open(ROOT / "sleeper_data" / "players.json", encoding="utf-8")) \
        if (ROOT / "sleeper_data" / "players.json").exists() else {}
    return {"proj": proj, "ecr_all": ecr_all, "ecr_rank": ecr_rank,
            "sig": sigf.get("players", {}), "week": sigf.get("week", 0),
            "players_meta": players_meta}


def compute(inp, war_of):
    """The per-pid detail rows, priced with `war_of`: pid -> year-1 WAR.

    Every place the projection enters routes through `war_of` — the clamp
    bounds, the ECR-to-WAR ladder, and the per-player component. They have to
    share a curve: `ecr_to_war` maps a consensus rank onto the WAR
    distribution, so a ladder built on one model and a component clamped on
    another would put the two halves of the index on different scales.
    """
    proj, ecr_all, ecr_rank = inp["proj"], inp["ecr_all"], inp["ecr_rank"]
    sig, week, players_meta = inp["sig"], inp["week"], inp["players_meta"]

    wars = [war_of.get(pid, 0.0) for pid in proj]
    # DVI clamps war at p95 and gets its top-end spread from the markets at p99.
    # CVI has no market and rides the WAR curve on BOTH halves, so a p95 ceiling
    # collapses everyone above it into a tie at 100 — exactly the range a
    # contender is shopping in. The ceiling has to move with the missing signal.
    rng_war = (pctl(wars, 0.10), pctl(wars, 0.99))
    rng_roster = CLAMP["roster"]
    rng_start = CLAMP["start"]

    # ECR value lives on the WAR curve, so it is clamped with the WAR bounds —
    # that keeps the consensus half and the production signal commensurate.
    order = sorted(ecr_rank, key=lambda pid: ecr_rank[pid])
    ecr_war = ecr_to_war(order, sorted(wars, reverse=True))

    out = {}
    for pid, p in proj.items():
        s = sig.get(pid, {}) or {}
        inj = (players_meta.get(pid, {}) or {}).get("injury_status")
        sv = start_value(s, week)
        start_c = clamp(sv, *rng_start)
        if inj in INJURED and (not week or week < INJURY_SKIP_BEFORE_WEEK):
            start_c = None          # hurt + snapshot-driven -> don't penalize

        # Unranked is ZERO, not missing. Absence from a 534-deep consensus is
        # real information for a win-now index: no expert considers him
        # startable. Dropping the component and renormalizing would instead
        # REWARD obscurity, which is how a deep stash outranks a real WR3 on
        # the very index meant to surface starters.
        ecr_c = clamp(ecr_war[pid], *rng_war) if pid in ecr_war else (
            0.0 if ecr_all else None)

        comps = {
            "ecr": ecr_c,
            "war": clamp(war_of.get(pid, 0.0), *rng_war),
            "roster": clamp(s.get("roster_rate", 0.0), *rng_roster),
            "start": start_c,
        }
        nnum = nden = 0.0
        for k in ("war", "roster", "start"):
            if comps[k] is not None:
                nnum += WEIGHTS_NM[k] * comps[k]
                nden += WEIGHTS_NM[k]
        nonmarket = nnum / nden if nden else None
        if comps["ecr"] is not None and nonmarket is not None:
            score = CONSENSUS_SHARE * comps["ecr"] + (1 - CONSENSUS_SHARE) * nonmarket
        else:
            score = comps["ecr"] if comps["ecr"] is not None else nonmarket
        out[pid] = {
            "name": p.get("name"), "pos": p.get("pos"), "age": p.get("age"),
            "rating": round(100 * score, 1) if score is not None else None,
            "ecrRank": ecr_rank.get(pid),
            "components": {k: (round(c, 3) if c is not None else None)
                           for k, c in comps.items()},
            "start_used": round(sv, 3) if sv is not None else None,
        }
    return out


def to_cvi(out):
    """The site-facing shape: value + rank only. Ranks are within a curve —
    see to_dvi in blend_values.py for why that is the point."""
    ranked = sorted((pid for pid in out if out[pid]["rating"] is not None),
                    key=lambda pid: -out[pid]["rating"])
    cvi, pos_seen = {}, {}
    for i, pid in enumerate(ranked, 1):
        r = out[pid]
        pos_seen[r["pos"]] = pos_seen.get(r["pos"], 0) + 1   # rank within position
        # `components` = how many signals fed the figure (mirrors dvi.json) —
        # published so a confidence affordance can be designed on the figure
        # itself; the breakdown stays local in cvi_detail.json.
        cvi[pid] = {"name": r["name"], "pos": r["pos"], "cvi": r["rating"],
                    "rank": i, "pos_rank": pos_seen[r["pos"]],
                    "components": sum(1 for c in r["components"].values() if c is not None)}
        # ECR presence is the site's availability signal: a season-ending
        # injury drops a player from the redraft consensus entirely, so
        # "no ecr" ≈ "known to give you nothing this year". Home's value-plays
        # module uses it to keep DVI-vs-CVI gaps that are just news off the
        # sell-high list. Omitted (not null) when unranked, to keep the file
        # small. Curve-independent, hence stored on the row, not per curve.
        if r.get("ecrRank") is not None:
            cvi[pid]["ecr"] = r["ecrRank"]
    return cvi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", default=DEFAULT_FORMAT,
                    help="which ECR format in data/ecr.json to read")
    ap.add_argument("--curve", default=DEFAULT_CURVE, choices=CURVES,
                    help="which projection curve prices the WAR signal")
    ap.add_argument("--out", default=str(DATA / "cvi.json"))
    args = ap.parse_args()

    inp = load_inputs(args.format)
    out = compute(inp, war_reader(DATA, args.curve))
    week, ecr_rank = inp["week"], inp["ecr_rank"]

    # component breakdown stays local for tuning, same as blended_values.json
    (DATA / "cvi_detail.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    cvi = to_cvi(out)
    atomic_write(Path(args.out), json.dumps(
        {"generated": date.today().isoformat(), "format": args.format,
         "curve": args.curve, "ecrRanked": len(ecr_rank), "players": cvi},
        separators=(",", ":")))

    print(f"wrote {args.out} [{args.curve}]: {len(cvi)} players · {len(ecr_rank)} "
          f"with an ECR rank · week={week} · start snap-weight={snap_weight(week)}")
    print("\n=== top 20 ===")
    for pid in sorted(cvi, key=lambda p: cvi[p]["rank"])[:20]:
        r = out[pid]
        print(f"  {cvi[pid]['rank']:>3}. {r['name'][:22]:23}{r['pos']:4}"
              f"{r['rating']:>6}  (ECR {r['ecrRank'] or '--'})")


if __name__ == "__main__":
    main()
