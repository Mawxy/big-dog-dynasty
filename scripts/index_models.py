#!/usr/bin/env python3
"""
index_models.py — DVI and CVI under every projection curve, in one pass.

WHAT IT WRITES

  data/<league>/dvi.json          the DEFAULT curve, unchanged shape
  data/<league>/cvi.json          the DEFAULT curve, unchanged shape
  data/<league>/index_models.json all six curves, both indices, one file

The first two are what every existing screen already reads, so nothing on the
site has to change for this script to be correct — it replaces the separate
blend_values / contender_index steps and produces byte-comparable output for
the default curve. The third is the new file: it is what lets a reader switch
model and see the whole site reprice.

WHY ONE PASS AND NOT TWELVE INVOCATIONS

Both indices read sleeper_data/players.json for injury flags — ~19 MB, and
already a known cost at twice per daily run. Shelling out six times each would
have made that fourteen. Both scripts were split into load_inputs() /
compute(war_of) / to_*() so the loads happen once here and only the WAR lookup
changes per curve.

WHY ONE COMBINED FILE RATHER THAN TWELVE

dvi.json is ~37 KB, so twelve of them is ~440 KB and twelve more requests. The
combined file shares each player's name and position across all six curves and
carries only the figures that actually move, which is most of the saving. It
also makes the atomic unit right: a reader switching model wants all six
available at once, not one fetch per flip.

WHAT has_analog / has_sleeper MEAN, AND WHAT THEY DO NOT

Per player, from projections_matrix.json: whether the analog arm and Sleeper's
read exist for him at all. When has_analog is false his analog and blend
PROJECTIONS are the scalar projection; when has_sleeper is false every
composite projection is its own natural.

They are claims about the projection, NOT about the published index. Measured
2026-08-13: of the 65 players with no analog cohort, all 65 had identical WAR
across the curves and only 4 had an identical DVI. Both indices clamp on
percentiles of the whole field, so changing the model reprices everyone and a
player whose own projection never moved still drifts a tenth or two around the
field. The site must read these as "no second opinion was measured for him" and
never as "this figure is model-independent" — the second is false, and a reader
told it once would stop trusting the selector the first time the number moved.
"""
import argparse
import datetime
import json
from pathlib import Path

import blend_values
import contender_index
from curves import CURVES, DEFAULT_CURVE, fallback_flags, war_reader
from ioutil import atomic_write
from leaguepaths import DataDir

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--default-curve", default=DEFAULT_CURVE, choices=CURVES,
                    help="which curve dvi.json / cvi.json publish")
    ap.add_argument("--format", default=contender_index.DEFAULT_FORMAT)
    args = ap.parse_args()

    dvi_in = blend_values.load_inputs()
    cvi_in = contender_index.load_inputs(args.format)
    print(f"loaded once: {len(dvi_in['proj'])} players, week={dvi_in['week']}, "
          f"{len(cvi_in['ecr_rank'])} with an ECR rank")

    dvi_by, cvi_by = {}, {}
    for curve in CURVES:
        war_of = war_reader(DATA, curve)
        dvi_by[curve] = blend_values.to_dvi(blend_values.compute(dvi_in, war_of))
        cvi_by[curve] = contender_index.to_cvi(contender_index.compute(cvi_in, war_of))
        print(f"  {curve:18} DVI {len(dvi_by[curve]):>4}  CVI {len(cvi_by[curve]):>4}")

    today = datetime.date.today().isoformat()

    # the two files the site already reads, on the default curve
    atomic_write(DATA / "dvi.json", json.dumps(
        {"generated": today, "curve": args.default_curve,
         "players": dvi_by[args.default_curve]}, separators=(",", ":")))
    atomic_write(DATA / "cvi.json", json.dumps(
        {"generated": today, "format": args.format, "curve": args.default_curve,
         "ecrRanked": len(cvi_in["ecr_rank"]), "players": cvi_by[args.default_curve]},
        separators=(",", ":")))

    # the combined file. Identity is stored ONCE per player and the six curves
    # carry only the figures, which is what keeps this near one dvi.json rather
    # than twelve.
    flags = fallback_flags(DATA)
    players = {}
    for pid in dvi_by[args.default_curve]:
        base = dvi_by[args.default_curve][pid]
        has_analog, has_sleeper = flags.get(pid, (False, False))
        players[pid] = {
            "name": base["name"], "pos": base["pos"],
            "has_analog": has_analog, "has_sleeper": has_sleeper,
            "dvi": {c: [dvi_by[c][pid]["dvi"], dvi_by[c][pid]["rank"],
                        dvi_by[c][pid]["pos_rank"]]
                    for c in CURVES if pid in dvi_by[c]},
            "cvi": {c: [cvi_by[c][pid]["cvi"], cvi_by[c][pid]["rank"],
                        cvi_by[c][pid]["pos_rank"]]
                    for c in CURVES if pid in cvi_by[c]},
        }
    atomic_write(DATA / "index_models.json", json.dumps(
        {"generated": today, "curves": list(CURVES), "default": args.default_curve,
         "format": args.format,
         "note": "[value, rank, pos_rank] per curve. has_analog false means his "
                 "PROJECTION under the analog and blend curves is the scalar one; "
                 "has_sleeper false means every composite projection is its own "
                 "natural. It does NOT mean his index figure is identical across "
                 "curves: DVI and CVI clamp on percentiles of the whole field, so "
                 "repricing everyone else moves him too. Measured on 2026-08-13, "
                 "65 players had no analog cohort; their WAR was identical across "
                 "curves in all 65 cases and their published DVI in only 4. Read "
                 "the flags as 'no second opinion was measured for him', never as "
                 "'this number will not move'.",
         "players": players}, separators=(",", ":")))

    n_af = sum(1 for p in players.values() if not p["has_analog"])
    n_sf = sum(1 for p in players.values() if not p["has_sleeper"])
    size = (DATA / "index_models.json").stat().st_size
    print(f"wrote index_models.json: {len(players)} players x {len(CURVES)} curves "
          f"· {size // 1024} KB · default {args.default_curve}")
    print(f"  no analog cohort: {n_af} · no Sleeper read: {n_sf} "
          f"(their curves repeat by construction)")


if __name__ == "__main__":
    main()
