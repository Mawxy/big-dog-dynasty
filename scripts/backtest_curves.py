#!/usr/bin/env python3
"""
backtest_curves.py — grade the four NATURAL projection curves out of sample.

WHAT THIS ANSWERS

projections_matrix.json publishes eight curves: scalar, analog, blend and
points, each natural and composite. Nothing in the repo says which of them is
actually right, because the matrix is a single as-of-today snapshot — there is
no stored record of what any curve said in 2019 to grade against 2020-2022.
This rebuilds them walk-forward and scores them.

WHY ONLY THE FOUR NATURALS (Max, 2026-09-18)

A composite is its natural curve blended with Sleeper's CURRENT-SEASON
projection (proj_sleeper.json, at BLEND_W 0.9/0.5/0.1). The repo keeps exactly
one vintage of that file, this season's, and Sleeper's API serves whatever it
stores for an old season today rather than the number that was live that
August. So a composite cannot be graded historically without either leaking the
outcome or comparing the model against a projection nobody ever saw. The four
naturals are pure functions of the history and have no such problem.

The fix is forward-looking, not retrospective: archive proj_sleeper.json each
preseason (see --archive-note) and the composites become gradeable in 2029.

WHAT A NATURAL CURVE IS, AND THEREFORE WHAT IT IS SCORED AGAINST

All four naturals are PER-13 RATES: what the player is worth over a full
healthy 13-game season. None of them is trying to predict games missed — that
is what the `expected` stream exists for. So the outcome is the realized per-13
rate, WAR / gp * 13, over players who actually played MIN_GP+ games in the
outcome season. Scoring a rate against a raw season total would mark every
curve down for injuries it never claimed to forecast, and would reward
whichever curve happened to be most pessimistic.

`--outcome raw` scores against realized season WAR instead, counting an absent
season as the replacement-level 0.0. That is the harsher, more trade-relevant
question and it is reported as a secondary, not the headline.

WHO IS IN THE COHORT (Max, 2026-09-18)

Every run reports THREE nested cohorts, because the widest one flatters
everybody. `all`
is every player the four curves price, which is 500-odd a seed and mostly deep
bench: men who sat near replacement level last year and will sit near it again.
They are trivially easy to project and there are hundreds of them, so they pull
every MAE down and, worse, they do most of the RANKING work — telling a starter
from a scrub is not the judgement a dynasty manager needs.

`starters` keeps each season's top 32 QB / 36 RB / 48 WR / 24 TE by fantasy
points, roughly the startable pool with bench depth behind it. `true` tightens
to 24 / 24 / 36 / 12, roughly the nine men actually in a lineup. The
finish is taken in the SEED season, never the outcome season: ranking on the
outcome would be the same lookahead this whole file exists to avoid, and would
also silently drop anyone who got hurt.

The three do not agree, so read them in order. See TIER_SETS to change the caps.

REANALYSIS WITHOUT RE-RUNNING

Every scored row is kept in the output, so `--reanalyze <file>` rebuilds the
reports from a finished run in a second. Changing the cohort caps or adding a
breakdown does not mean re-fitting eight vintages of three models.

WALK-FORWARD, WITH THE CURVES REFIT EACH TIME

For seed season S, everything is refit on seasons <= S:

  aging_curves.py --end S      the scalar arm's age/level lines, capital
                               priors, availability, durability, pedigree
  project_war_knn.py --as-of S the analog arm's comparables corpus
  project_points.py  --as-of S the points-first trees

then each curve projects S+1, S+2, S+3 and is scored against what happened.
The aging curves are refit BEFORE the analog arm runs, because the analog arm
reads pts_to_war out of the same file.

THE SCALAR ARM IS RUN HERE RATHER THAN SHELLED OUT

project_war.py takes its population and its per-13 levels from the LEAGUE's
data/<league>/<year>/summary.json, which only goes back to 2022 — one scoreable
vintage, useless. So the scalar arm is driven off nfl_history instead, using
project_war's own wlevel / prior_weight / curve_at, imported rather than
retyped. Two differences from the shipped script, both forced and both
recorded in the output's meta:

  * no fantasy rookie-draft slot prior (that is league data, and the NFL pick
    prior covers the same ground)
  * no Sleeper leg at all, which is the point — this is the natural curve

Usage:
  python scripts/backtest_curves.py --first-seed 2015 --last-seed 2022
  python scripts/backtest_curves.py --seeds 2019 --keep        (one vintage)
  python scripts/backtest_curves.py --reanalyze bt/backtest_rate.json
Output: bt/backtest_curves.json  + a printed table per cohort
"""
import argparse
import csv
import json
import math
import shutil
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "nfl_history"
HIST_EARLY = HIST / "early"
sys.path.insert(0, str(ROOT / "scripts"))

from project_war import (                                    # noqa: E402
    DEFAULT_AGE, ELITE_WAR, DUR_MAX, DUR_STEP, DECAY_DAMP, FULL_GP, MIN_GP,
    ROOKIE_AGE, age_on_sep1, curve_at, group_for, prior_weight, wlevel,
)
from project_war import composite_path                       # noqa: E402
from project_war import build_meta_index, match_meta          # noqa: E402
from project_matrix import trust_of, W_MIN, W_MAX             # noqa: E402
from leaguepaths import DataDir                               # noqa: E402

CORE = ("QB", "RB", "WR", "TE")
CURVES = ("scalar_natural", "analog_natural", "blend_natural", "points_natural")
# THE COMPOSITES (Max, 2026-09-18). Built, then found ungradeable on any vintage
# pulled back from Sleeper after the fact. The machinery stays because it is
# correct and will work the moment there are LIVE captures to feed it.
#
# THE MEASUREMENT THAT SETTLED IT. Regress next season's rate on the prior
# season's, do the same to the projection, and correlate the residuals: that is
# what the projection adds beyond last year. Within position, on true starters,
# five seeds:
#
#     partial r          scalar  blend  points   SLEEPER(backfilled)
#     QB  (n=102)         0.338  0.329   0.333          0.819
#     RB  (n= 96)         0.331  0.294   0.284          0.661
#     WR  (n=153)         0.368  0.415   0.377          0.577
#     TE  (n= 54)         0.040  0.110   0.123          0.705
#
# Among the top 24 quarterbacks from the prior season roles are settled, and
# nothing an August projection knows is worth 0.82 there. Our own models read
# three seasons plus age, draft capital, usage and efficiency and add 0.27.
#
# THE SURFACE TESTS ALL PASSED and were all wrong: full games for every player,
# ADP tracked more tightly than the outcome, men who played four games still
# carrying a full year's points. Mahomes 2021 reads 395 against an actual 260.
# Individual rows look like genuine forecasts; the aggregate cannot be one. Best
# guess is mixed provenance, some rows preseason and some refreshed, which is
# also what 2018 looks like. The mechanism was never pinned down, and it does
# not need to be — a source that fails the partial test is out regardless.
#
# So: BACKFILLED VINTAGES ARE REFUSED (--allow-backfilled to experiment). Only
# a vintage captured live in its own August counts, which fetch_projections.py
# now takes nightly. 2026 was first captured in-season, so the first clean one
# is August 2027 and the composite becomes gradeable at N+1 after that season.
#
# points_composite is deliberately ABSENT. The other three blend in WAR space
# through composite_path, which is exactly what project_matrix.py publishes and
# is reproducible here. The points model blends in POINTS space and then
# re-derives WAR from the projected pool, so reproducing it means running
# project_points.py --site against each archived vintage. That is a bigger job
# and it is not what the N+1 question needs — three composites against their
# own naturals answers whether Sleeper's read helps.
COMPOSITES = ("scalar_composite", "analog_composite", "blend_composite")
ARCHIVE_DIR = "proj_sleeper_history"
DATA = DataDir(ROOT / "data")
# the two reference points a model has to beat before it has said anything:
# last season's rate carried flat, and the player's position/age cohort mean.
BASELINES = ("last_season", "cohort_mean")
# Three nested cohorts, because where you draw the line changes the answer and
# there is no single right place to draw it.
#
#   all       every player the four curves price. Mostly deep bench.
#   starters  roughly the startable pool with bench depth behind it.
#   true      roughly the nine men actually in a lineup each week: 24 QB in a
#             superflex league, 24 RB and 36 WR for two and three a side, 12 TE.
#
# Each is a strict subset of the one above it, so reading them in order shows
# what the easy players were contributing.
TIER_SETS = {
    "starters": {"QB": 32, "RB": 36, "WR": 48, "TE": 24},
    "true":     {"QB": 24, "RB": 24, "WR": 36, "TE": 12},
}
TIERS = TIER_SETS["starters"]           # the default cohort's caps
COHORTS = ("all", "starters", "true")


# ------------------------------------------------------------------ corpus --
def war_files():
    """waa_war_*.csv from the main corpus and the early one, oldest first."""
    files = list(HIST.glob("waa_war_[0-9][0-9][0-9][0-9].csv"))
    if HIST_EARLY.exists():
        files += list(HIST_EARLY.glob("waa_war_[0-9][0-9][0-9][0-9].csv"))
    return sorted(files, key=lambda f: int(f.stem.split("_")[-1]))


def load_corpus():
    """(war, gp, pos) keyed [gsis][season], over every season on disk."""
    war, gp, pos = defaultdict(dict), defaultdict(dict), {}
    for f in war_files():
        yr = int(f.stem.split("_")[-1])
        for r in csv.DictReader(open(f, encoding="utf-8")):
            if r["pos"] not in CORE:
                continue
            pid = r["player_id"]
            if not pid:
                continue
            war[pid][yr] = float(r["WAR"])
            gp[pid][yr] = int(r["gp"])
            pos[pid] = r["pos"]
    return war, gp, pos


def load_meta():
    """gsis -> (birth, draft_season, draft_pick). The corpus is already keyed
    by gsis, so none of project_war's name matching is needed or wanted here:
    a name match that fails is a silent population difference between arms."""
    import datetime
    out = {}
    for r in csv.DictReader(open(HIST / "players_meta.csv", encoding="utf-8")):
        if not r["gsis_id"]:
            continue
        out[r["gsis_id"]] = (
            datetime.date.fromisoformat(r["birth_date"]) if r["birth_date"] else None,
            int(r["draft_season"]) if r["draft_season"] else None,
            int(r["draft_pick"]) if r["draft_pick"] else 999,
        )
    return out


def load_finish():
    """[season][gsis] -> positional finish by fantasy points that season.

    Points, not WAR, because "the top 36 RBs" is a finish a manager reads off a
    leaderboard, and because ranking on WAR would rank the cohort by the same
    quantity the models are being scored on.
    """
    finish = defaultdict(dict)
    for f in war_files():
        yr = int(f.stem.split("_")[-1])
        by_pos = defaultdict(list)
        for r in csv.DictReader(open(f, encoding="utf-8")):
            if r["pos"] in TIERS and r["player_id"]:
                by_pos[r["pos"]].append((float(r["pts"]), r["player_id"]))
        for v in by_pos.values():
            for i, (_pts, pid) in enumerate(sorted(v, reverse=True), 1):
                finish[yr][pid] = i
    return finish


# ------------------------------------------------------------ scalar arm ----
def scalar_curves(seed, horizon, war, gp, pos, meta, model):
    """gsis -> the per-13 natural path, project_war.py's math on the corpus."""
    curves, avail, priors = model["curves"], model["availability"], model["capital_priors"]
    udfa = model["meta"].get("udfa_pick", 260)

    def avail_for(p, age):
        g = group_for(avail[p], age)
        return g["avail"] if g else 1.0

    out = {}
    for pid, years in war.items():
        if seed not in years:
            continue                       # not in the league as of the seed
        p = pos.get(pid)
        if p not in curves or not curves[p]:
            continue
        birth, draft_season, pick = meta.get(pid, (None, None, 999))
        if birth is not None:
            base_age = age_on_sep1(birth, seed)
        elif draft_season is not None:
            base_age = ROOKIE_AGE + (seed - draft_season)
        else:
            base_age = DEFAULT_AGE.get(p, 26)

        cf = priors[p]
        prior = cf["a"] + cf["b"] * math.log(pick if pick < 999 else udfa)

        # rates/gps only from seasons at or before the seed. Everything in this
        # loop has to be blind to seed+1 or the whole exercise is theatre.
        rates = {y: war[pid][y] / gp[pid][y] * FULL_GP
                 for y in years if y <= seed and gp[pid].get(y, 0) >= MIN_GP}
        gps = {y: gp[pid][y] for y in years if y <= seed}

        elite = sum(1 for y, w in years.items() if y <= seed and w >= ELITE_WAR)
        dur = min(DUR_MAX, max(0.0, (elite - 3) * DUR_STEP))

        dcfg = (model.get("durability") or {}).get(p)
        av_delta = 0.0
        if dcfg:
            h = [min(gps[y], FULL_GP) / FULL_GP
                 for y in (seed - 2, seed - 1, seed) if gps.get(y)]
            if len(h) >= 2:
                fname = dcfg["feature"]
                if len(h) == 3:
                    f = (statistics.mean(sorted(h)[1:]) if fname == "best2"
                         else statistics.mean(h) if fname == "mean3"
                         else 0.5 * h[2] + 0.3 * h[1] + 0.2 * h[0])
                else:
                    f = statistics.mean(h)
                av_delta = dcfg["b"] * (f - dcfg["feat_mean"])
                if fname == "recency_sd" and len(h) == 3:
                    av_delta += dcfg["b_sd"] * (statistics.pstdev(h) - dcfg["sd_mean"])
                av_delta *= 1.0 if len(h) == 3 else 0.5

        rates, gps = dict(rates), dict(gps)
        path, anchor = [], None
        for k in range(horizon):
            frm = seed + k
            L_real, _ = wlevel(rates, gps, frm)
            if L_real is None:
                L_real = prior
            pw = prior_weight((frm - draft_season + 1) if draft_season else None, L_real)
            L = (1 - pw) * L_real + pw * prior
            if anchor is None:
                anchor = L
            age = base_age + k
            r, _p20, _p80 = curve_at(model, p, age, L, use_grid=False)
            ped = model.get("pedigree_hold", {})
            pm, pc = ped.get("meta", {}), ped.get(p)
            if pc and age <= pm.get("max_age", 24) and pick <= pm.get("max_pick", 40) \
                    and L >= pm.get("min_level", 0.8):
                r += pc["bump"]
            r = (1 - dur) * r + dur * L
            path.append(round(r, 3))
            rates[frm + 1] = r + DECAY_DAMP * (anchor - r)
            gps[frm + 1] = FULL_GP
            _ = avail_for(p, age) + av_delta     # natural carries no availability
        out[pid] = path
    return out


# ------------------------------------------------------- the Sleeper leg ----
def sleeper_index():
    """Sleeper pid -> gsis, over every player Sleeper has ever listed.

    TWO ROUTES, because neither covers the corpus alone. sleeper_data/players.json
    carries `gsis_id` directly, but only for about a third of the file and
    weighted toward players who have been around a while — for the 2025 vintage
    it resolves 180 of 610. The rest go by name through project_war's own
    matcher, which is the same join the live pipeline uses and handles the
    legal-name cases (DK Metcalf is DeKaylin, CeeDee Lamb is Cedarian). Together
    they land 98% of every vintage.

    This is why the archive not carrying names is survivable. It should carry
    them anyway — a vintage ought to be self-sufficient rather than depending on
    a 19MB player dump that Sleeper rewrites — and fetch_projections.py has the
    change; it just has not stuck on disk yet.
    """
    f = ROOT / "sleeper_data" / "players.json"
    if not f.exists():
        return {}, {}
    doc = json.loads(f.read_text(encoding="utf-8"))
    direct, byname = {}, {}
    for pid, v in doc.items():
        if not isinstance(v, dict):
            continue
        if v.get("gsis_id"):
            direct[pid] = v["gsis_id"]
        nm = v.get("full_name") or (f"{v.get('first_name','')} "
                                    f"{v.get('last_name','')}").strip()
        if nm:
            byname[pid] = nm
    return direct, byname


def sleeper_leg(seed, model, sidx, meta_idx, allow_backfilled=False):
    """gsis -> Sleeper's year-1 WAR read for season seed+1, or {} if no vintage.

    THE TIMING IS THE POINT and it is legitimate: the vintage for season S+1 is
    published in the August of S+1, after season S is complete and before a down
    of S+1 is played. That is exactly the information set the live composite has
    when it projects forward from S.

    pts13 -> WAR through the SEED's own pts_to_war line, not today's, for the
    same reason every other arm is refit per seed.
    """
    f = DATA / ARCHIVE_DIR / f"{seed + 1}.json"
    if not f.exists():
        return {}, None
    doc = json.loads(f.read_text(encoding="utf-8"))
    backfilled = bool((doc.get("meta") or {}).get("backfilled"))
    if backfilled and not allow_backfilled:
        return {}, {"rows": len(doc["players"]), "matched": 0, "unmatched": 0,
                    "backfilled": True, "refused": True}
    ptw = model.get("pts_to_war") or {}
    direct, byname = sidx
    out, unmatched = {}, 0
    for pid, v in doc["players"].items():
        pos = v.get("pos")
        if pos not in ptw:
            continue
        g = direct.get(pid)
        if not g:
            nm = v.get("name") or byname.get(pid)
            m = match_meta(nm, pos, meta_idx) if nm else None
            g = m[3] if m else None
        if not g:
            unmatched += 1
            continue
        pts13 = v.get("pts13") or 0.0
        # `> 0`, not truthiness: a forecast cannot be negative points, so a
        # negative pts13 is arithmetic residue from a partial line rather than
        # an opinion. project_war.py makes the same call.
        if pts13 <= 0:
            continue
        out[g] = round(ptw[pos]["a"] + ptw[pos]["b"] * pts13, 3)
    return out, {"rows": len(doc["players"]), "matched": len(out),
                 "unmatched": unmatched, "backfilled": backfilled,
                 "refused": False}


def composites(sc, an, bl, sl, diag, d_ref):
    """The three WAR-space composites, built exactly as project_matrix.py does.

    scalar and blend take the flat BLEND_W[0]; the analog takes a trust-scaled
    weight, because applying 0.9 to both arms would publish the same number
    twice rather than a second opinion. Both facts are project_matrix's, not
    this file's, and composite_path is imported rather than reimplemented.
    """
    out = {c: {} for c in COMPOSITES}
    for g, ext in sl.items():
        if g not in sc:
            continue
        out["scalar_composite"][g] = composite_path(sc[g], ext)
        if g in bl:
            out["blend_composite"][g] = composite_path(bl[g], ext, sc[g])
        d = diag.get(g)
        if g in an and d is not None:
            t = trust_of(d, d_ref)
            w = W_MIN + (W_MAX - W_MIN) * (1 - t)
            out["analog_composite"][g] = composite_path(an[g], ext, sc[g], w)
    return out


# ------------------------------------------------------- the other arms -----
def run(cmd):
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
    return r.stdout


def analog_curves(seed, horizon, workdir):
    out = workdir / f"knn_{seed}.json"
    run([sys.executable, "scripts/project_war_knn.py", "--as-of", str(seed),
         "--space", "hybrid", "--horizon", str(horizon), "--out", str(out)])
    # project_war_knn writes through DataDir, so the file lands under the
    # league dir when a registry exists and at data/<name> when it does not.
    for cand in (out, ROOT / "data" / out.name):
        if cand.exists():
            doc = json.loads(cand.read_text())
            break
    else:
        raise FileNotFoundError(f"analog output not found for seed {seed}")
    curves, diag = {}, {}
    for r in doc["players"]:
        g = r.get("gsis")
        if not g:
            continue
        curves[g] = r["proj"]
        diag[g] = {"pos": r["pos"], "d_med": r["d_med"], "padded": r["padded"]}
    return curves, diag


def repair_analog(analog, scalar):
    """A horizon year whose cohort had no scorable outcome publishes null.

    project_war_knn emits None rather than a fabricated 0.0, and
    project_matrix.py falls back to the scalar curve for exactly that year
    (`an_nat = [s if a is None else a ...]`). The published analog_natural is
    therefore the repaired path, so that is what gets graded — leaving the
    nulls in would score a curve the site never shows, and dropping those rows
    would quietly grade the analog on an easier population than the others.
    """
    out, patched = {}, 0
    for g, path in analog.items():
        s = scalar.get(g)
        if s is None:
            continue                       # no scalar leg: out of the population
        fixed = []
        for i, a in enumerate(path):
            if a is None:
                patched += 1
                fixed.append(s[i] if i < len(s) else None)
            else:
                fixed.append(a)
        if any(v is None for v in fixed):
            continue
        out[g] = fixed
    return out, patched


def points_curves(seed, horizon, workdir):
    out = workdir / f"points_{seed}.json"
    run([sys.executable, "scripts/project_points.py", "--as-of", str(seed),
         "--out", str(out)])
    doc = json.loads(out.read_text())
    # war13 is the natural stream: WAR at the projected ppg over a full 13.
    return {g: r["war13"] for g, r in doc["players"].items() if r.get("war13")}


def blend_curves(scalar, analog, diag):
    """The trust-weighted mix project_matrix.py publishes as blend_natural.

    Same trust_of, same per-position d_ref (the median cohort tightness over
    the priced population), so this is the shipped blend and not a new one.
    """
    by_pos = defaultdict(list)
    for g, d in diag.items():
        if g in scalar:
            by_pos[d["pos"]].append(d["d_med"])
    d_ref = {p: statistics.median(v) for p, v in by_pos.items() if v}
    blend_curves.d_ref = d_ref
    out, trust = {}, {}
    for g, s in scalar.items():
        a = analog.get(g)
        if a is None:
            out[g] = list(s)               # no cohort: the blend IS the scalar
            continue
        t = trust_of(diag[g], d_ref)
        trust[g] = round(t, 3)
        out[g] = [round(t * ai + (1 - t) * si, 3) for ai, si in zip(a, s)]
    return out, trust


# ---------------------------------------------------------------- scoring --
def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    if len(xs) < 3:
        return None
    rx, ry = rank(xs), rank(ys)
    mx, my = statistics.mean(rx), statistics.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return round(num / den, 4) if den else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-seed", type=int, default=2015)
    ap.add_argument("--last-seed", type=int, default=None,
                    help="default: the newest season with `horizon` seasons after it")
    ap.add_argument("--seeds", type=int, nargs="*", default=None,
                    help="explicit seed list, overrides the range")
    ap.add_argument("--horizon", type=int, default=3)
    ap.add_argument("--outcome", choices=("rate", "raw"), default="rate",
                    help="rate: realized WAR/gp*13 over players with MIN_GP+ games "
                         "(what a natural curve claims). raw: realized season WAR, "
                         "an absent season counting 0.0")
    ap.add_argument("--min-gp-seed", type=int, default=MIN_GP,
                    help="games in the seed season to enter the population")
    ap.add_argument("--work", default="bt")
    ap.add_argument("--out", default="bt/backtest_curves.json")
    ap.add_argument("--keep", action="store_true", help="keep the per-seed arm files")
    ap.add_argument("--allow-backfilled", action="store_true",
                    help="score composites on a Sleeper vintage that was pulled "
                         "back after the fact rather than captured live. Refused "
                         "by default — it leaks; see COMPOSITES.")
    ap.add_argument("--reanalyze", default=None, metavar="FILE",
                    help="rebuild the reports from a finished run's saved rows "
                         "and exit — no model is re-fit. Use after changing TIERS.")
    args = ap.parse_args()

    if args.reanalyze:
        reanalyze(args.reanalyze, args.out)
        return

    workdir = ROOT / args.work
    workdir.mkdir(parents=True, exist_ok=True)

    war, gp, pos = load_corpus()
    meta = load_meta()
    finish = load_finish()
    sidx = sleeper_index()
    midx = build_meta_index()
    all_years = sorted({y for v in war.values() for y in v})
    last = args.last_seed or (all_years[-1] - args.horizon)
    seeds = args.seeds or list(range(args.first_seed, last + 1))

    # the shipped curve file is an input to two arms; put it back afterwards
    live_curves = HIST / "aging_curves.json"
    backup = workdir / "aging_curves.live.json"
    if live_curves.exists() and not backup.exists():
        shutil.copy2(live_curves, backup)

    rows = []            # one per (seed, gsis, horizon year)
    per_seed = {}
    try:
        for seed in seeds:
            print(f"\n=== seed {seed} -> {seed+1}..{seed+args.horizon}", flush=True)
            run([sys.executable, "scripts/aging_curves.py", "--data", "nfl_history",
                 "--start", "2012", "--end", str(seed)])
            model = json.loads(live_curves.read_text())

            sc = scalar_curves(seed, args.horizon, war, gp, pos, meta, model)
            an_raw, diag = analog_curves(seed, args.horizon, workdir)
            an, patched = repair_analog(an_raw, sc)
            pt = points_curves(seed, args.horizon, workdir)
            bl, trust = blend_curves(sc, an, diag)
            sl, slmeta = sleeper_leg(seed, model, sidx, midx,
                                     allow_backfilled=args.allow_backfilled)
            cmp_ = composites(sc, an, bl, sl, diag, blend_curves.d_ref) if sl else \
                   {c: {} for c in COMPOSITES}
            if slmeta and slmeta.get("refused"):
                print(f"  sleeper vintage {seed+1}: REFUSED, backfilled. A vintage "
                      f"pulled back from Sleeper adds 0.69 beyond last season where "
                      f"a real forecast adds ~0.30 — see the note at COMPOSITES. "
                      f"--allow-backfilled to override.", flush=True)
            elif slmeta:
                print(f"  sleeper vintage {seed+1}: {slmeta['matched']} joined of "
                      f"{slmeta['rows']} rows ({slmeta['unmatched']} unmatched) "
                      f"[captured live]", flush=True)
            elif seed + 1 >= 2021:
                print(f"  sleeper vintage {seed+1}: MISSING — run "
                      f"fetch_projections.py --season {seed+1} --archive-only", flush=True)
            if patched:
                print(f"  analog: {patched} null horizon-years fell back to scalar",
                      flush=True)

            # ONE POPULATION FOR ALL FOUR. A curve that prices a different set
            # of players is scored on a different question; the intersection is
            # the only comparison that is about the models.
            pop = [g for g in sc
                   if g in an and g in pt and g in bl
                   and gp[g].get(seed, 0) >= args.min_gp_seed]
            print(f"  population {len(pop)}"
                  f" (scalar {len(sc)} · analog {len(an)} · points {len(pt)})", flush=True)
            per_seed[seed] = {"population": len(pop), "scalar": len(sc),
                              "analog": len(an), "points": len(pt),
                              "analog_nulls_patched": patched}

            for g in pop:
                seed_rate = (war[g][seed] / gp[g][seed] * FULL_GP
                             if gp[g].get(seed, 0) >= MIN_GP else None)
                for k in range(args.horizon):
                    y = seed + 1 + k
                    if y not in all_years:
                        continue
                    played = gp[g].get(y, 0)
                    if args.outcome == "rate":
                        if played < MIN_GP:
                            continue
                        actual = war[g][y] / played * FULL_GP
                    else:
                        actual = war[g].get(y, 0.0)
                    rows.append({
                        "seed": seed, "gsis": g, "pos": pos[g], "h": k + 1,
                        "actual": round(actual, 4),
                        "scalar_natural": sc[g][k], "analog_natural": an[g][k],
                        "blend_natural": bl[g][k], "points_natural": pt[g][k],
                        "last_season": round(seed_rate, 4) if seed_rate is not None else None,
                        "trust": trust.get(g),
                        # positional finish in the SEED season; the cohort split
                        # reads this, and it is stored rather than recomputed so
                        # --reanalyze on an old file gets the same boundary
                        "seed_rank": finish.get(seed, {}).get(g),
                        "sleeper_war": sl.get(g),
                        # None wherever a vintage is missing or the player had no
                        # Sleeper line; score() skips a None, and the composite
                        # report below restricts to the rows that have one so the
                        # naturals are never scored on a wider population than the
                        # composites they are being compared against
                        **{c: (cmp_[c][g][k] if g in cmp_[c] else None)
                           for c in COMPOSITES},
                    })
    finally:
        if backup.exists():
            shutil.copy2(backup, live_curves)
        if not args.keep:
            for f in workdir.glob("knn_*.json"):
                f.unlink()
            for f in workdir.glob("points_*.json"):
                f.unlink()

    write_report(rows, seeds, args)


# ---------------------------------------------------------------- scoring --
def score(subset, key):
    pairs = [(r[key], r["actual"]) for r in subset if r.get(key) is not None]
    if len(pairs) < 3:
        return None
    pred = [p for p, _ in pairs]
    act = [a for _, a in pairs]
    n = len(pairs)
    mae = sum(abs(p - a) for p, a in pairs) / n
    rmse = math.sqrt(sum((p - a) ** 2 for p, a in pairs) / n)
    bias = sum(p - a for p, a in pairs) / n
    return {"n": n, "mae": round(mae, 4), "rmse": round(rmse, 4),
            "bias": round(bias, 4), "spearman": spearman(pred, act)}


def build_report(rows, horizon, keys=None):
    """One cohort's numbers. The cohort_mean baseline is recomputed INSIDE the
    cohort: carrying the all-players mean into the starters table would be a
    baseline for a population that is not being scored, and it would look
    absurdly bad rather than merely weak."""
    by = defaultdict(list)
    for r in rows:
        by[(r["pos"], r["h"])].append(r["actual"])
    cmean = {k: statistics.mean(v) for k, v in by.items()}
    for r in rows:
        r["cohort_mean"] = round(cmean[(r["pos"], r["h"])], 4)

    keys = keys or (CURVES + BASELINES)
    rep = {"overall": {}, "by_position": {}, "per_seed": {}, "rows": len(rows)}
    for h in range(1, horizon + 1):
        sub = [r for r in rows if r["h"] == h]
        rep["overall"][h] = {k: score(sub, k) for k in keys}
        for p in CORE:
            subp = [r for r in sub if r["pos"] == p]
            rep["by_position"].setdefault(p, {})[h] = {
                k: score(subp, k) for k in keys}
    # pooled over the horizon, per seed: is one vintage carrying the result?
    for k in keys:
        rep["per_seed"][k] = {}
        for sd in sorted({r["seed"] for r in rows}):
            v = [abs(r[k] - r["actual"]) for r in rows
                 if r["seed"] == sd and r.get(k) is not None]
            rep["per_seed"][k][sd] = round(sum(v) / len(v), 4) if v else None
    return rep


def cohort_rows(rows, cohort):
    if cohort == "all":
        return [dict(r) for r in rows]
    caps = TIER_SETS[cohort]
    return [dict(r) for r in rows
            if r.get("seed_rank") is not None and r["seed_rank"] <= caps[r["pos"]]]


def print_table(rep, horizon, title, keys=None):
    print(f"\n{title}")
    print(f"{'':<18}" + "".join(f"{'h='+str(h):>26}" for h in range(1, horizon + 1)))
    print(f"{'curve':<18}" + "".join(f"{'mae':>8}{'rmse':>8}{'rho':>10}"
                                     for _ in range(horizon)))
    for k in (keys or (CURVES + BASELINES)):
        line = f"{k:<18}"
        for h in range(1, horizon + 1):
            sc = rep["overall"][h].get(k)
            rho = sc["spearman"] if sc and sc["spearman"] is not None else None
            line += (f"{sc['mae']:>8.3f}{sc['rmse']:>8.3f}"
                     + (f"{rho:>10.3f}" if rho is not None else f"{'-':>10}")
                     if sc else f"{'-':>26}")
        print(line)
    n1 = rep["overall"][1].get("scalar_natural")
    print(f"  n at h=1: {n1['n'] if n1 else 0} · rows {rep['rows']}")


def write_report(rows, seeds, args):
    reports = {c: build_report(cohort_rows(rows, c), args.horizon) for c in COHORTS}
    # THE COMPOSITE VIEW, on the rows that actually have a Sleeper vintage, with
    # the naturals rescored on that same subset. Comparing a composite scored on
    # five seeds against a natural scored on eight would be a comparison of
    # populations, not of models.
    # naturals and their own composites interleaved, so a reader compares down
    # the pair rather than across the table
    ckeys = ("scalar_natural", "scalar_composite",
             "analog_natural", "analog_composite",
             "blend_natural", "blend_composite", "last_season")
    creports, cseeds = {}, []
    with_sl = [r for r in rows if r.get("sleeper_war") is not None]
    if with_sl:
        cseeds = sorted({r["seed"] for r in with_sl})
        creports = {c: build_report(cohort_rows(with_sl, c), args.horizon, ckeys)
                    for c in COHORTS}
    out = {
        "meta": {
            "seeds": seeds, "horizon": args.horizon, "outcome": args.outcome,
            "min_gp_seed": args.min_gp_seed, "min_gp_outcome": MIN_GP,
            "curves": list(CURVES), "baselines": list(BASELINES),
            "cohorts": list(COHORTS), "tiers": TIERS, "tier_sets": TIER_SETS,
            "rows": len(rows),
            "composites": "not gradeable — see the module docstring",
            "scalar_arm": "project_war.py math (wlevel/prior_weight/curve_at) "
                          "driven off nfl_history rather than league summary.json; "
                          "no fantasy rookie-slot prior, no Sleeper leg",
            "cohort_note": "cohorts are capped by fantasy-points finish IN THE "
                           "SEED SEASON; ranking on the outcome season would be "
                           "lookahead. See TIER_SETS for the caps.",
            "composites": list(COMPOSITES),
            "composite_seeds": cseeds,
            "composite_note": "scored only on rows carrying an archived Sleeper "
                              "vintage for season seed+1, with the naturals "
                              "rescored on that same subset. Sleeper's usable "
                              "window starts at 2021, so the seed window starts "
                              "at 2020. points_composite is not reproduced here "
                              "(it blends in points space before the pool step).",
        },
        "report": reports["all"],          # back-compat: the old key, all players
        "reports": reports,
        "reports_composite": creports,
        "rows": rows,
    }
    dest = ROOT / args.out
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(",", ":")) + "\n")

    for c in COHORTS:
        print_table(reports[c], args.horizon,
                    f"=== {c.upper()} · outcome {args.outcome}"
                    + (f" · {TIER_SETS[c]}" if c in TIER_SETS else ""))
    for c in COHORTS:
        if creports:
            print_table(creports[c], args.horizon,
                        f"=== COMPOSITE · {c.upper()} · seeds "
                        f"{cseeds[0]}-{cseeds[-1]} · outcome {args.outcome}",
                        keys=ckeys)
    print(f"\nseeds {seeds[0]}-{seeds[-1]}")
    print(f"wrote {dest}")


def reanalyze(path, out_path):
    """Rebuild the reports from a finished run. No models re-fit."""
    doc = json.loads(Path(path).read_text())
    m = doc["meta"]
    rows = doc["rows"]
    finish = load_finish()
    for r in rows:                          # older files predate seed_rank
        r["seed_rank"] = finish.get(r["seed"], {}).get(r["gsis"])

    class A:                                # the four fields write_report reads
        horizon = m["horizon"]
        outcome = m["outcome"]
        min_gp_seed = m.get("min_gp_seed", MIN_GP)
        allow_backfilled = False
        out = out_path
    write_report(rows, m["seeds"], A)


if __name__ == "__main__":
    main()
