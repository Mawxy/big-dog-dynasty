#!/usr/bin/env python3
"""
project_matrix.py — the six projection curves, in one file, on one Sleeper gate.

Two models disagree about the same players, and neither is reliably right. This
script does not pick a winner; it publishes both, their blend, and each with and
without the market/depth-chart read, so the disagreement is visible instead of
averaged away.

    model \\ stream   natural (no Sleeper)      composite (with Sleeper)
    ---------------  -----------------------  --------------------------
    scalar           projections.json:proj    flat BLEND_W
    analog           projections_knn:proj     TRUST-SCALED weight
    blend            trust-weighted mix       flat BLEND_W on blend/natural

NATURAL vs COMPOSITE. Natural is what the model believes from a player's own
record. Composite folds in Sleeper's projection, which is the only input here
that knows about 2026 — a trade, a depth-chart move, a rookie ahead of him.
Neither model can know any of that; they only see what he has already done.

WHY THE ANALOG COMPOSITE IS WEIGHTED DIFFERENTLY. The scalar model hands year 1
to Sleeper at a flat 0.9. Applying that same 0.9 to the analog would produce a
duplicate curve, not a sixth one: measured on the 257 players with a usable
Sleeper number, scalar-natural and analog-natural disagree by a mean of 0.199
WAR (max 1.02), and at a flat 0.9 only a tenth of that survives — the two
composites then differ by a mean of 0.020, max 0.10. Three of the six curves
would be the same number.

So the analog's Sleeper weight is a function of how good its cohort actually is.
That is not a trick to force separation; it is the honest reading of what the
analog knows. When a player has a dense neighbourhood of real comparables the
analog is saying something, and Sleeper should not override it. When the cohort
is twelve strangers the analog is guessing, and Sleeper's depth-chart read is
strictly better information.

  trust = 1 / (1 + (d_med / d_ref[pos]) ** TRUST_P),  halved when `padded`
  w_sleeper(yr1) = W_MIN + (W_MAX - W_MIN) * (1 - trust)

d_ref is the POSITION'S OWN median cohort tightness, not an absolute constant.
Rostered d_med runs p10 0.72 / p50 0.91 / p90 1.06 — a narrow band with one
genuine outlier — so a fixed denominator leaves trust flat across almost
everyone and the weight stops discriminating. Scaling by the position's median
also means the knob survives the corpus growing.

The same `trust` weights the blend of the two naturals, deliberately: there is
one question here — how much is this player's analog cohort worth — and one
answer to it, used in both places, rather than two constants tuned apart.

Sleeper's weight decays across the horizon on the scalar model's existing shape
(BLEND_W, 0.9/0.5/0.1 -> ratios 1.0/0.556/0.111). It knows this year's role and
nothing about 2028.

EVERY POSITIVE SLEEPER PROJECTION COUNTS. There is no points floor — see
SLEEPER_GATE below for the measurement that removed the one I had put here. The
only rejection is pts13 <= 0, which is arithmetic residue rather than a forecast.
This matches project_war.py, so projections.json's own `composite` and the
scalar_composite here agree player for player.

Usage: python scripts/project_matrix.py
Output: data/<league>/projections_matrix.json
"""
import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

from leaguepaths import DataDir
from project_war import BLEND_W

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")
HIST = ROOT / "nfl_history"

TRUST_P = 4.0        # sharpness. At 2 the middle 80% of players span only
                     # trust 0.42-0.62 and the weight barely moves; at 4 they
                     # span 0.30-0.70 and the tail (McCaffrey, d_med 3.76 on a
                     # 0.94 reference) collapses to ~0, which is correct — he
                     # has no comparables at all.
PAD_PENALTY = 0.5    # `padded` means the cohort had to reach past MAX_DIST to
                     # fill twelve. d_med already reflects that, but the flag is
                     # a categorical statement the distance alone understates.
W_MIN = 0.25         # Sleeper's floor even for a perfect cohort. It is never
                     # zero: however good the comparables, they cannot know he
                     # was traded in March.
W_MAX = 0.90         # ceiling, matching the scalar model's flat year-1 weight.
# WHAT COUNTS AS A SLEEPER PROJECTION.
#
# `none` — every positive projection counts, at full weight. This is the
# shipped behaviour of project_war.py and, after measuring it, the right one.
#
# I previously gated this at 25 points, on the theory that the pts->WAR line was
# being extrapolated past its support and that a backup's low projection encoded
# missed games rather than bad production. Both were wrong, and the corpus says
# so plainly. `gp` counts DRESSED games since the played rule, so a quarterback
# who suits up all year and never plays HAS played a full season by this model's
# definition — `pts/17` and `pts/games_played` are the same number for him. And
# the line is fit ON that population, not stretched to reach it:
#
#     x (pts13)      0-15    15-30   30-60   60-128
#     QB seasons      323       48      70      104
#     observed WAR  -1.37    -1.15   -0.90    -0.35
#     fitted line   -1.28@10 -1.11@25 -0.95@40 -0.52@80
#
# 620 of 1041 QB seasons sit below the zero crossing. A backup projected for 32
# points is projected to produce below replacement, and projected WAR should say
# so. That Anthony Richardson carries a 2,019 KTC is the market pricing his
# optionality — DVI and CVI's job, not this file's. The two disagreeing is the
# two numbers doing different work.
#
# The remaining gate is arithmetic, not judgement: a forecast cannot be negative
# points, so pts13 <= 0 is not a forecast.
#
# `hard` and `taper` are kept because the measurement that rejected them is
# worth being able to re-run, not because either should ship.
SLEEPER_GATE = "none"
PTS13_FLOOR = 25.0   # `hard` cutoff / `taper` lower end
PTS13_FULL = 128.0   # `taper` upper end: the pts->WAR zero crossing


def sleeper_scale(pts13, gate=None):
    """How much of Sleeper's weight this projection earns, in [0, 1]."""
    gate = gate or SLEEPER_GATE
    if pts13 is None or pts13 <= 0:
        return 0.0                      # not a forecast; a forecast cannot be
    if gate == "none":                  # negative points
        return 1.0
    if gate == "hard":
        return 1.0 if pts13 >= PTS13_FLOOR else 0.0
    if pts13 >= PTS13_FULL:
        return 1.0
    if pts13 <= PTS13_FLOOR:
        return 0.0
    return (pts13 - PTS13_FLOOR) / (PTS13_FULL - PTS13_FLOOR)


def trust_of(k, d_ref):
    """How much this player's analog cohort is worth, in [0, 1]."""
    ref = d_ref.get(k["pos"]) or 1.0
    t = 1.0 / (1.0 + (k["d_med"] / ref) ** TRUST_P)
    return t * PAD_PENALTY if k.get("padded") else t


def composite(natural, sleeper_war, w1, decay):
    """Blend a natural curve with Sleeper's year-1 read, aged forward.

    The Sleeper number is aged ADDITIVELY, not by the ratio decay[i]/decay[0] —
    project_war.py learned that the hard way, because a near-zero or signed
    first year makes that ratio sign-flip and amplify instead of decay.

    `decay` is the path whose SHAPE ages Sleeper forward, and it is always the
    scalar natural — never the curve being blended. The scalar model is the only
    one here with an aging model: aging_curves.py fits the year-over-year decline
    explicitly. The analog's shape is not a decay curve at all, it is three
    independent cohort medians sitting next to each other, and its year-over-year
    step carries whatever noise separates those three cohorts.

    Aging Sleeper along the analog's own shape put Christian McCaffrey's year-2
    analog composite at 0.638 — below his analog natural (1.001), below the
    scalar (1.004) and below Sleeper itself (1.025), a number no input supported.
    His analog year 1 is an untrustworthy 1.752 (d_med 3.76, padded), so the step
    down to 1.001 read as a 0.75 collapse and dragged the Sleeper path with it.
    Distrusting a curve's level while borrowing its shape is incoherent.
    """
    out = []
    base = decay[0]
    for i, nat in enumerate(natural):
        w = w1 * (BLEND_W[i] / BLEND_W[0]) if i < len(BLEND_W) else 0.0
        path = sleeper_war + (decay[i] - base)
        out.append(round(w * path + (1 - w) * nat, 3))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="projections_matrix.json")
    ap.add_argument("--sleeper-gate", choices=("hard", "taper", "none"), default=None)
    args = ap.parse_args()
    global SLEEPER_GATE
    if args.sleeper_gate:
        SLEEPER_GATE = args.sleeper_gate

    scalar = json.loads((DATA / "projections.json").read_text())
    knnf = json.loads((DATA / "projections_knn_hybrid.json").read_text())
    sproj = json.loads((DATA / "proj_sleeper.json").read_text())["players"]
    ptw = json.loads((HIST / "aging_curves.json").read_text())["pts_to_war"]
    ratio = knnf["meta"].get("league_scale_ratio", 1.0)

    analog = {p["pid"]: p for p in knnf["players"] if p.get("pid")}

    # Reference tightness per position, over the ROSTERED players only. The
    # corpus-wide median would be set by deep bench players nobody projects.
    by_pos = defaultdict(list)
    for p in scalar["players"]:
        k = analog.get(str(p["pid"]))
        if k:
            by_pos[k["pos"]].append(k["d_med"])
    d_ref = {pos: statistics.median(v) for pos, v in by_pos.items() if v}

    rows, n_an, n_sl = [], 0, 0
    for p in scalar["players"]:
        pid = str(p["pid"])
        pos = p["pos"]
        sc_nat = p["proj"]
        k = analog.get(pid)
        sp = sproj.get(pid, {})
        pts13 = sp.get("pts13") or 0.0
        c = ptw.get(pos)
        scale = sleeper_scale(pts13)
        sl_war = (c["a"] + c["b"] * pts13) * ratio if c and scale > 0 else None
        if sl_war is not None:
            n_sl += 1

        # --- naturals -------------------------------------------------------
        if k:
            n_an += 1
            an_nat = k["proj"]
            t = trust_of(k, d_ref)
            bl_nat = [round(t * a + (1 - t) * s, 3)
                      for a, s in zip(an_nat, sc_nat)]
        else:
            # No analog cohort — he has never played an NFL down, or nflverse
            # has no row for him. There is nothing to blend, so the analog and
            # blend curves ARE the scalar curve, and `has_analog` says so.
            an_nat, bl_nat, t = sc_nat, sc_nat, None

        # --- composites -----------------------------------------------------
        if sl_war is None:
            sc_cmp, an_cmp, bl_cmp = sc_nat, an_nat, bl_nat
            w_an = None
        else:
            w_an = W_MIN + (W_MAX - W_MIN) * (1 - t) if t is not None else BLEND_W[0]
            # the taper multiplies whatever weight the model would otherwise
            # give Sleeper, so trust and the gate compose rather than compete
            sc_cmp = composite(sc_nat, sl_war, BLEND_W[0] * scale, sc_nat)
            an_cmp = composite(an_nat, sl_war, w_an * scale, sc_nat)
            bl_cmp = composite(bl_nat, sl_war, BLEND_W[0] * scale, sc_nat)

        rows.append({
            "pid": pid, "name": p["name"], "pos": pos, "team": p.get("team"),
            "age": p.get("age"),
            "scalar_natural": sc_nat, "scalar_composite": sc_cmp,
            "analog_natural": an_nat, "analog_composite": an_cmp,
            "blend_natural": bl_nat, "blend_composite": bl_cmp,
            # diagnostics — the curves are only readable next to these
            "has_analog": k is not None,
            "has_sleeper": sl_war is not None,
            "sleeper_war": round(sl_war, 3) if sl_war is not None else None,
            "pts13": round(pts13, 1),
            "trust": round(t, 3) if t is not None else None,
            "w_sleeper": round(w_an * scale, 3) if w_an is not None else None,
            "sleeper_scale": round(scale, 3),
            "d_med": k["d_med"] if k else None,
            "padded": k["padded"] if k else None,
            "totals": {n: round(sum(v), 3) for n, v in (
                ("scalar_natural", sc_nat), ("scalar_composite", sc_cmp),
                ("analog_natural", an_nat), ("analog_composite", an_cmp),
                ("blend_natural", bl_nat), ("blend_composite", bl_cmp))},
        })

    rows.sort(key=lambda r: -r["totals"]["blend_composite"])
    out = {
        "meta": {
            "curves": ["scalar_natural", "scalar_composite",
                       "analog_natural", "analog_composite",
                       "blend_natural", "blend_composite"],
            "horizon": len(BLEND_W),
            "blend_w": BLEND_W,
            "trust_p": TRUST_P, "pad_penalty": PAD_PENALTY,
            "w_min": W_MIN, "w_max": W_MAX, "pts13_floor": PTS13_FLOOR,
            "d_ref": {k: round(v, 3) for k, v in d_ref.items()},
            "league_scale_ratio": ratio,
            "players": len(rows), "with_analog": n_an, "with_sleeper": n_sl,
            "note": "analog composite uses a trust-scaled Sleeper weight; "
                    "scalar and blend composites use the flat BLEND_W",
        },
        "players": rows,
    }
    dest = DATA / args.out
    dest.write_text(json.dumps(out, separators=(",", ":")) + "\n")

    tv = [r["trust"] for r in rows if r["trust"] is not None]
    print(f"wrote {dest} · {len(rows)} players")
    print(f"  analog cohort: {n_an}/{len(rows)} · "
          f"sleeper >= {PTS13_FLOOR:.0f} pts: {n_sl}/{len(rows)}")
    print(f"  d_ref " + " ".join(f"{k} {v:.2f}" for k, v in sorted(d_ref.items())))
    if tv:
        print(f"  trust p10 {sorted(tv)[len(tv)//10]:.2f} · "
              f"median {statistics.median(tv):.2f} · "
              f"p90 {sorted(tv)[9*len(tv)//10]:.2f}")
    # spread between the six year-1 values: if this collapses, the matrix is
    # publishing one number six times and something upstream has gone flat
    sp1 = [max(r[c][0] for c in out["meta"]["curves"])
           - min(r[c][0] for c in out["meta"]["curves"]) for r in rows]
    print(f"  yr1 spread across the six curves: median {statistics.median(sp1):.3f} · "
          f"mean {statistics.mean(sp1):.3f} · max {max(sp1):.2f}")


if __name__ == "__main__":
    main()
