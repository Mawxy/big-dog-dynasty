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

THE CURVES ARE FULL-SEASON FIGURES, AND THE FILE NOW SAYS WHAT SEASON IS LEFT
(Max, 2026-09-21). Year 1 of every curve is a whole-season projection for the
roster season — a per-13 rate across expected games — which is the right input
to a model and the wrong thing to show a reader in week 4, when four of those
weeks are a settled fact. So this file additionally publishes the two facts an
in-season view needs, and computes nothing from them:

    meta.inseason   {season, weeks_played, reg_weeks, remaining_frac}, or absent
    row.banked      his realized regular-season WAR to date (summary.json)
    row.gp          the games behind that figure

    outlook = banked + year1 * remaining_frac      (scripts/inseason.py)

Every published curve VALUE is untouched, because everything that consumes
year 1 as a model input — index_models.py, value_bridge.py, trade_analysis.py,
the pick tiers — must keep seeing the full season. Banked WAR has no trade
value, and an index shrinking to it by week 14 would price every asset at
nothing in December. The block is absent in the offseason, and `banked`/`gp`
ride with it: present exactly when the block is.

Usage: python scripts/project_matrix.py
Output: data/<league>/projections_matrix.json
"""
import argparse
import datetime
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import inseason as insn
from ioutil import atomic_write
from leaguepaths import DataDir
from project_war import BLEND_W, composite_path
from seasons import last_completed_season

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
# shipped behavior of project_war.py and, after measuring it, the right one.
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
# The remaining gate is arithmetic, not judgment: a forecast cannot be negative
# points, so pts13 <= 0 is not a forecast.
#
# `hard` and `taper` are kept because the measurement that rejected them is
# worth being able to re-run, not because either should ship.
SLEEPER_GATE = "none"
PTS13_FLOOR = 25.0   # `hard` cutoff / `taper` lower end
PTS13_FULL = 128.0   # `taper` upper end: the pts->WAR zero crossing

# THE TWO ARMS REFRESH TOGETHER NOW, BUT SEED FROM DIFFERENT PLACES.
#
# Both projections.json and projections_knn_hybrid.json are rebuilt every night
# by data-refresh.yml (the analog arm joined it 2026-08-12; before that nothing
# ran project_war_knn.py on a schedule and the arm was as fresh as the last time
# someone remembered). A date lag should now be zero, which is what makes it
# worth checking: a nonzero one means the step failed or was dropped, not that
# somebody forgot.
#
# THE SEED CHECK HAS TWO OUTCOMES, AND TELLING THEM APART IS THE POINT.
#
# A seed mismatch looks identical from the outside — scalar ahead of analog —
# but it has two causes, one benign and one that must not ship:
#
#   LEGITIMATE (warn). The analog corpus is nfl_history/*.csv, rebuilt only by
#   the manual war-history.yml workflow. When a season finishes, the scalar arm
#   advances to it on the next nightly and the analog arm cannot until someone
#   dispatches that job. Both arms are then seeded on seasons that really
#   happened; one is simply a year behind. Dispatching war-history fixes it.
#
#   BROKEN (fatal). The scalar arm seeded from a season nobody has finished —
#   which is what happened on 2026-09-15, when meta.latest flipped to 2026 on
#   the freeze of week 1 and project_war.py started projecting 2027-2029 off a
#   single game. The arms disagree, and the arm that moved is the wrong one.
#   No amount of rebuilding the corpus fixes that; blending the two produces a
#   default curve whose year 1 is 2027 on one side and 2026 on the other.
#
# So the discriminator is not the gap, it is whether the SCALAR seed is a
# completed season (seasons.py). Below that bar the run dies rather than
# publishing eight curves that do not share a year; above it, the old loud
# warning stands, because a stale analog arm is still an arm and taking the
# nightly down over it would remove eight curves to complain that two are old.
STALE_DAYS = 7


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


# BOTH ARMS OF THE POINTS-FIRST MODEL COUNT. project_points.py prices veterans
# from their own history (`src: points`) and incoming rookies from draft
# capital (`src: rookie`); only rows it could not price at all are left on the
# scalar (`src: scalar`). Reading the first arm alone silently handed all 56
# rookies the SCALAR pair under a points_* heading with has_points false —
# Jeremiyah Love read [0.735, ...] here against [0.835, ...] in
# projections.json, one player priced two ways in two files.
POINTS_SRC = ("points", "rookie")


def points_streams(players):
    """pid -> (natural, composite) for every row the points-first model priced.

    `has_points` is a claim about the MODEL, not about the arm: a rookie the
    rookie arm priced was priced by the points-first model.
    """
    return {r["pid"]: (r["proj"], r["composite"]) for r in players
            if r.get("src") in POINTS_SRC}


def trust_of(k, d_ref):
    """How much this player's analog cohort is worth, in [0, 1]."""
    ref = d_ref.get(k["pos"]) or 1.0
    t = 1.0 / (1.0 + (k["d_med"] / ref) ** TRUST_P)
    return t * PAD_PENALTY if k.get("padded") else t


def _as_date(s):
    try:
        return datetime.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _shout(title, lines):
    """One stderr banner, in the shape the nightly log is read in."""
    bar = "!" * 78
    print(f"\n{bar}", file=sys.stderr)
    print(f"!! {title}", file=sys.stderr)
    for ln in lines:
        print(f"!! {ln}", file=sys.stderr)
    print(f"{bar}\n", file=sys.stderr)


def seed_mismatch(scalar_seed, knn_seed, last_done):
    """Classify a scalar/analog seed pair: None, "stale" or "broken".

    Split out from the reporting so the decision itself is testable — see the
    two-outcome note above STALE_DAYS for why there is a decision at all.
    `last_done` is seasons.last_completed_season(); None (a league with nothing
    finished) means we cannot judge, so nothing is fatal.
    """
    if not scalar_seed or not knn_seed:
        return None                       # a file with no stamp; nothing to compare
    if last_done is not None and scalar_seed > last_done:
        return "broken"                   # seeded from a season nobody has finished
    if knn_seed == scalar_seed:
        return None
    if knn_seed < scalar_seed:
        # both seeds are seasons that really happened; the corpus is a year
        # behind the league and only war-history.yml can move it
        return "stale"
    return "broken"                       # corpus AHEAD of the league — impossible


def check_arm_freshness(scalar_meta, knn_meta, knn_path, last_done=None):
    """Report how far the analog arm trails the scalar one, and refuse to
    publish a matrix whose two arms do not share a clock. See STALE_DAYS.

    The two files do not carry the same stamps, so this compares what is
    comparable: `seed_season` is on both, and is the honest one — it says which
    season each arm projected FORWARD from. Dates are messier. projections.json
    stamps `generated`; the knn writer stamps none at all, so its file mtime
    stands in. That is imperfect (a fresh clone rewrites every mtime) which is
    exactly why a mtime lag stays a warning at any size.

    Returns "stale" when the analog corpus is merely a year behind (loud, not
    fatal). Raises SystemExit when the scalar arm seeded off an unfinished
    season — publishing eight curves that disagree about what year 1 IS is
    worse than publishing none.
    """
    scalar_seed, knn_seed = scalar_meta.get("seed_season"), knn_meta.get("seed_season")
    scalar_gen = _as_date(scalar_meta.get("generated"))
    knn_gen, knn_src = _as_date(knn_meta.get("generated")), "generated"
    if knn_gen is None:
        knn_src = "mtime"           # the analog file stamps no generation date
        try:
            knn_gen = datetime.date.fromtimestamp(Path(knn_path).stat().st_mtime)
        except OSError:
            knn_gen = None
    print(f"  arms: scalar seed {scalar_seed}, generated {scalar_gen} · "
          f"analog seed {knn_seed}, {knn_src} {knn_gen} · "
          f"last completed season {last_done}")

    verdict = seed_mismatch(scalar_seed, knn_seed, last_done)
    if verdict == "broken":
        _shout("ARMS DISAGREE ABOUT WHAT YEAR IT IS — refusing to publish.", [
            f"scalar arm projects from {scalar_seed}, analog arm from {knn_seed},",
            f"and the last season with a decided champion is {last_done}.",
            "",
            "A scalar seed PAST the last completed season means project_war.py",
            "seeded off a season still being played — meta.latest flips as soon",
            "as week 1 freezes. An analog seed past it means the corpus is ahead",
            "of the league, which cannot happen. Either way year 1 is a DIFFERENT",
            "SEASON on each arm, and blend_composite would average the two under",
            "one column heading.",
            "",
            "This is not fixed by rebuilding nfl_history/ — check the seed in",
            "scripts/seasons.py:last_completed_season and rerun project_war.py.",
        ])
        raise SystemExit(1)

    why = []
    if verdict == "stale":
        why.append(f"SEED SEASON: scalar projects from {scalar_seed}, analog from "
                   f"{knn_seed} — the analog corpus is a year behind the league")
    lag = (scalar_gen - knn_gen).days if scalar_gen and knn_gen else None
    if lag is not None and lag >= STALE_DAYS:
        why.append(f"AGE: analog arm is {lag} days behind the scalar arm "
                   f"({knn_gen} by {knn_src} vs {scalar_gen})")
    if not why:
        return None
    _shout("STALE ANALOG ARM — data/projections_knn_hybrid.json is out of date.",
           why + [
               "data-refresh.yml rebuilds it nightly, so a DATE lag means that step",
               "failed or was removed. A SEED lag means nfl_history/ is behind the",
               "league — dispatch war-history.yml, which is the only thing that",
               "rebuilds the analog corpus.",
               "Every analog_* and blend_* curve below is built on the old numbers,",
               "blended against a scalar arm rebuilt last night.",
           ])
    return "stale"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="projections_matrix.json")
    ap.add_argument("--sleeper-gate", choices=("hard", "taper", "none"), default=None)
    args = ap.parse_args()
    global SLEEPER_GATE
    if args.sleeper_gate:
        SLEEPER_GATE = args.sleeper_gate

    # THE SCALAR ARM IS ITS OWN FILE NOW (Max, 2026-09-11): projections.json
    # is the points-first model's, and project_points.py --site parks the
    # per-13 rate model's output at projections_scalar.json so this lens keeps
    # reading the scalar it was built to compare. Falls back to projections.json
    # for a data directory the points model has not written.
    scalar_path = DATA / "projections_scalar.json"
    if not scalar_path.exists():
        scalar_path = DATA / "projections.json"
    scalar = json.loads(scalar_path.read_text())
    # the points-first model's streams, keyed by pid, for the two curves it
    # adds; a row it did not price (src:scalar) falls back to the scalar pair
    points = {}
    ppath = DATA / "projections.json"
    if scalar_path != ppath and ppath.exists():
        points = points_streams(json.loads(ppath.read_text())["players"])
    knn_path = DATA / "projections_knn_hybrid.json"
    knnf = json.loads(knn_path.read_text())
    sproj = json.loads((DATA / "proj_sleeper.json").read_text())["players"]
    # before anything else: is the arm this file blends in actually current?
    # Fatal when the scalar arm seeded off an unfinished season; see above.
    scalar_meta = scalar.get("meta") or {}
    check_arm_freshness(scalar_meta, knnf.get("meta") or {}, knn_path,
                        last_completed_season(DATA))
    # NOTE: pts_to_war is deliberately not read here. Converting Sleeper's
    # points to WAR is project_war.py's job and its output is taken as given.
    # The corpus->league rescale this file briefly applied is gone everywhere —
    # it was never distinguishable from 1.0; see project_war_knn.py.

    analog = {p["pid"]: p for p in knnf["players"] if p.get("pid")}

    # --- how much of the roster season is already in the books --------------
    # Two facts, published rather than applied: the league's week count (or
    # nothing, out of season) and each player's realized WAR so far. The site
    # combines them (src/lib/outlook.ts); every curve below stays full-season.
    years = scalar_meta.get("years") or []
    roster_season = scalar_meta.get("roster_season")
    inblock = insn.block(DATA, roster_season, years[0] if years else None)
    banked = {}
    if inblock:
        sfile = DATA / str(inblock["season"]) / "summary.json"
        if sfile.exists():
            banked = insn.banked_war(json.loads(sfile.read_text(encoding="utf-8")))

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
        scale = sleeper_scale(pts13)
        # THE SLEEPER LEG IS READ, NOT RECOMPUTED. project_war.py already
        # publishes it as `proj_ext`; deriving it a second time from pts_to_war
        # is what let the two files disagree by the corpus->league ratio.
        sl_war = p.get("proj_ext") if scale > 0 else None
        if sl_war is not None:
            n_sl += 1

        # --- naturals -------------------------------------------------------
        if k:
            n_an += 1
            # A horizon year whose cohort had no scorable outcome publishes
            # null rather than a fabricated 0.0 (project_war_knn). The analog
            # arm has nothing to say about that year, so it falls back to the
            # scalar curve for it — the same thing `has_analog: False` already
            # does for a player with no cohort at all, one year at a time.
            an_nat = [s if a is None else a for a, s in zip(k["proj"], sc_nat)]
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
            # The scalar composite is project_war.py's, verbatim, whenever the
            # gate is not modifying it — this file must not be a second opinion
            # about a number that already has an owner. `hard` and `taper` are
            # experiments, so they recompute; the shipped path reads.
            sc_cmp = (p["composite"] if scale >= 1.0
                      else composite_path(sc_nat, sl_war, sc_nat, BLEND_W[0] * scale))
            # these two exist nowhere else, so the matrix does own them. The
            # taper multiplies whatever weight the model would otherwise give
            # Sleeper, so trust and the gate compose rather than compete.
            an_cmp = composite_path(an_nat, sl_war, sc_nat, w_an * scale)
            bl_cmp = composite_path(bl_nat, sl_war, sc_nat, BLEND_W[0] * scale)

        pt_nat, pt_cmp = points.get(pid, (sc_nat, sc_cmp))
        row = {
            "pid": pid, "name": p["name"], "pos": pos, "team": p.get("team"),
            "age": p.get("age"),
            "scalar_natural": sc_nat, "scalar_composite": sc_cmp,
            "analog_natural": an_nat, "analog_composite": an_cmp,
            "blend_natural": bl_nat, "blend_composite": bl_cmp,
            "points_natural": pt_nat, "points_composite": pt_cmp,
            "has_points": pid in points,
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
                ("blend_natural", bl_nat), ("blend_composite", bl_cmp),
                ("points_natural", pt_nat), ("points_composite", pt_cmp))},
        }
        if inblock:
            # A rostered player the summary has no row for has not dressed for
            # anybody: 0.0 banked off 0 games, not a missing figure. Written on
            # every row so the site never has to tell the two apart.
            b, g = banked.get(pid, (0.0, 0))
            row["banked"], row["gp"] = round(b, 3), g
        rows.append(row)

    rows.sort(key=lambda r: -r["totals"]["blend_composite"])
    out = {
        "meta": {
            "curves": ["scalar_natural", "scalar_composite",
                       "analog_natural", "analog_composite",
                       "blend_natural", "blend_composite",
                       "points_natural", "points_composite"],
            "horizon": len(BLEND_W),
            # WHICH SEASON THESE CURVES PROJECT FROM. Copied off the scalar
            # arm, which is the frame every row is built on. Carried so the
            # file can be checked against the other projection files instead
            # of being the one member of the chain that never says — see
            # validate_data.check_projection_coherence.
            "seed_season": scalar_meta.get("seed_season"),
            "roster_season": scalar_meta.get("roster_season"),
            "years": scalar_meta.get("years"),
            # HOW MUCH OF YEAR 1 HAS ALREADY BEEN PLAYED (2026-09-21), or null
            # out of season. Never consumed here — see the docstring and
            # scripts/inseason.py / src/lib/outlook.ts.
            "inseason": inblock,
            "blend_w": BLEND_W,
            "trust_p": TRUST_P, "pad_penalty": PAD_PENALTY,
            "w_min": W_MIN, "w_max": W_MAX,
            # which gate produced this file, so a reader never has to infer it
            # from the numbers — an earlier edit failed to land this key and I
            # misread its absence as evidence of a stale build
            "sleeper_gate": SLEEPER_GATE,
            "pts13_floor": PTS13_FLOOR, "pts13_full": PTS13_FULL,
            "d_ref": {k: round(v, 3) for k, v in d_ref.items()},
            "players": len(rows), "with_analog": n_an, "with_sleeper": n_sl,
            "note": "analog composite uses a trust-scaled Sleeper weight; "
                    "scalar and blend composites use the flat BLEND_W",
        },
        "players": rows,
    }
    dest = DATA / args.out
    atomic_write(dest, json.dumps(out, separators=(",", ":")) + "\n")

    tv = [r["trust"] for r in rows if r["trust"] is not None]
    print(f"wrote {dest} · {len(rows)} players")
    if inblock:
        print(f"  {insn.label(inblock)}: weeks {inblock['weeks_played']}/"
              f"{inblock['reg_weeks']} played · year-1 projections prorate to "
              f"{inblock['remaining_frac']:.3f} on the site · "
              f"{sum(1 for r in rows if r['banked'])} of {len(rows)} players "
              f"have banked a nonzero WAR")
    else:
        print("  offseason (or year 1 is not the roster season): no inseason "
              "block — the outlook is the projection")
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
