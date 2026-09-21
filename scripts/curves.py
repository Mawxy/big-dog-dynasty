#!/usr/bin/env python3
"""
curves.py — the one place that knows what a projection curve is called and how
to read a player's WAR out of it.

WHY THIS EXISTS

DVI and CVI were both built on one number: `projections.json`'s
`composite[0]`, which at the time WAS the scalar model's year-1 composite (it
is the points-first model's file now — see the fallback note below). That made
the choice of projection model invisible — the site published a single dynasty
value and a single win-now value and never said which of the curves in
projections_matrix.json produced them.

Both indices now compute under EVERY curve, so the site can be read under any
of them. This module is what keeps the two scripts agreeing on the vocabulary:
the curve names, the default, and the lookup. Two copies of `matrix[curve][0]`
in two files is exactly how the scalar and analog composites drifted apart
before project_matrix.py imported composite_path instead of carrying its own.

WHY YEAR ONE

`[0]` is the seed year, not the three-year total, and that is inherited
behavior rather than a decision made here — both indices have always clamped
on year-1 WAR. It is defensible for CVI, which is a win-now index by
definition. It is arguable for DVI, whose whole subject is the years after
this one. Changing it moves every published figure on the site and belongs in
its own change, with its own before/after; this module only makes the choice
explicit and easy to find. See the note in blend_values.py.
"""
import json

# The eight curves, in the order project_matrix.py publishes them: two models
# (scalar, analog) plus their blend, then the points-first model, each read
# with and without Sleeper's depth-chart opinion folded in. Mirrors MATRIX_CURVES in src/lib/types.ts —
# keep the two lists in step.
CURVES = (
    "scalar_natural", "scalar_composite",
    "analog_natural", "analog_composite",
    "blend_natural", "blend_composite",
    # THE POINTS-FIRST MODEL (Max, 2026-09-11): ppg and games projected
    # first, WAR from the projected pool. project_matrix.py copies its two
    # streams in from projections.json so the picker and index_models see
    # one list of curves.
    "points_natural", "points_composite",
)

# The site's published DVI/CVI. Blend over scalar because the analog arm is a
# real second opinion the scalar model cannot express — shape, and "didn't
# play" as a state rather than a low number; composite over natural because
# Sleeper's read is the only input that knows about THIS season's depth charts,
# and neither model can see a trade or a rookie ahead of him.
# Points over blend from 2026-09-11 to 2026-09-16; back to BLEND · COMPOSITE
# since (Max, 2026-09-16). The points-first curve stays a comparison lens.
# Mirrors DEFAULT_CURVE in src/lib/model.ts — the two must agree, or the
# board opens on one curve while dvi.json was published on another.
DEFAULT_CURVE = "blend_composite"

MATRIX_FILE = "projections_matrix.json"
# THE FALLBACK FILE DEPENDS ON THE CURVE (2026-09-21).
#
# projections.json used to BE the scalar model, so one fallback served every
# curve and reading `composite[0]` off it genuinely reproduced the pre-matrix
# number. Since 2026-09-11 it is the POINTS-FIRST model's file — project_points
# parks the scalar arm at projections_scalar.json and rewrites this one — so the
# old single fallback quietly answered every scalar_* query with the points
# model's figure, under a heading that says scalar.
#
# So: scalar_* falls back to the scalar model's own file, points_* to the
# points model's own file, and analog_*/blend_* to the scalar file too, because
# that is exactly what the matrix itself does for a player with no cohort.
SCALAR_FILE = "projections_scalar.json"
POINTS_FILE = "projections.json"
# what to read when SCALAR_FILE is absent (a data dir the points model has never
# written, or one that predates the split): projections.json is the scalar model
# there, which is the old behaviour and still correct for such a tree.
FALLBACK_FILE = POINTS_FILE


def _fallback_file(curve):
    return POINTS_FILE if curve.startswith("points_") else SCALAR_FILE


def war_reader(data_dir, curve=DEFAULT_CURVE):
    """pid -> year-1 WAR under `curve`, as a plain dict.

    Falls back to the curve's OWN model file for any player the matrix does not
    carry — projections_scalar.json for the scalar, analog and blend curves,
    projections.json for the points-first pair (see the note above). Today that
    set is empty — the matrix is built from the same players — but the fallback
    is what keeps a curve switch from silently zeroing someone if the two files
    ever diverge, and zero is a meaningful WAR rather than an obviously missing
    one.

    A `*_natural` curve falls back to the file's `proj` stream and a
    `*_composite` one to its `composite`, so a fallback never folds Sleeper's
    read into a curve whose whole definition is that it has none.
    """
    if curve not in CURVES:
        raise ValueError(f"unknown curve {curve!r}; expected one of {', '.join(CURVES)}")

    src = _fallback_file(curve)
    if not (data_dir / src).exists():
        src = FALLBACK_FILE
    stream = "composite" if curve.endswith("_composite") else "proj"
    base = {}
    with open(data_dir / src, encoding="utf-8") as fh:
        for p in json.load(fh)["players"]:
            row = p.get(stream) or p.get("composite") or [0]
            base[p["pid"]] = row[0]

    mxf = data_dir / MATRIX_FILE
    if not mxf.exists():
        # A deploy whose data predates the matrix still builds, on the model
        # files themselves. Loud, because every curve silently collapsing to
        # one is the failure this module exists to stop.
        print(f"  ! no {MATRIX_FILE} — every curve falls back to its own model file")
        return base

    with open(mxf, encoding="utf-8") as fh:
        for r in json.load(fh)["players"]:
            row = r.get(curve)
            if row:
                base[r["pid"]] = row[0]
    return base


def fallback_flags(data_dir):
    """pid -> (has_analog, has_sleeper), for saying so on the site.

    When has_analog is false the analog and blend curves ARE the scalar curve;
    when has_sleeper is false every composite IS its own natural. Switching
    models then changes nothing for that player, and a reader who is not told
    reads the agreement as corroboration rather than as the same number twice.
    project_matrix.py publishes both for exactly this reason.
    """
    mxf = data_dir / MATRIX_FILE
    if not mxf.exists():
        return {}
    with open(mxf, encoding="utf-8") as fh:
        return {r["pid"]: (bool(r.get("has_analog")), bool(r.get("has_sleeper")))
                for r in json.load(fh)["players"]}
