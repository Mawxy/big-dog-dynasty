#!/usr/bin/env python3
"""
project_war_knn.py — EXPERIMENTAL analog projection. Does not replace
project_war.py; writes its own file so the two can be compared.

WHY THIS EXISTS

The shipped model collapses a career into one number: LEVEL is a recency- and
games-weighted mean of the last three per-13 rates, and everything downstream
reads only that scalar. Two consequences, both real:

  * SHAPE IS LOST. A player who went 1.21 then 0.01 and one who sat flat at
    0.47 for three years produce the same LEVEL and therefore the same
    projection. One spike three seasons back keeps paying rent forever.

  * "DIDN'T PLAY" IS NOT A STATE. aging_curves.py fits next_rate = a + b*LEVEL
    on seasons of 4+ games ("conditional on playing"), then that line is
    applied to players who did not play. A QB aged <=24 with LEVEL 0 collects
    the intercept a = 0.3976 — a number earned by 130 QBs who *were* starting.
    Empirically, of 317 QB seasons of <=4 games since 2012, 94% never took a
    real role in the following three years and their mean WAR was -0.04.

METHOD

For a player entering season N, build a feature vector from what he has
actually done, then find the k most similar (player, season) pairs in
2012-2025 and report what THOSE players did in N+1..N+3.

  features   three per-13 rates, most recent first, each paired with the games
             that produced it; age; experience. Games are carried explicitly so
             "0.0 in 2 games" and "0.0 in 13 games" are different players.
  distance   weighted euclidean, recent seasons weighted hardest
  outcome    an analog absent from season N+k counts as ZERO, not as missing.
             That is the whole point: the players who vanish are the answer to
             "what usually happens", and dropping them is what makes every
             backup look like a lottery ticket with no losing tickets.
  estimate   MEDIAN of the cohort, not the mean, so one Malik Willis in the
             neighbourhood cannot carry the projection on its own.
  bands      p20/p80 OF THIS PLAYER'S COHORT, so confidence is a property of
             the player's situation rather than a constant pasted onto
             everyone in an age bucket.

Scale: fit on nfl_history WAR, which uses an NFL-wide replacement level and
runs ~15% above this league's. A single fitted ratio converts at the end;
the two are otherwise near-perfectly correlated.

Usage: python scripts/project_war_knn.py [--k 40] [--horizon 3]
Output: data/<league>/projections_knn.json
"""
import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

from leaguepaths import DataDir
# The corpus is keyed by nflverse gsis_id; the SITE joins on Sleeper player ids.
# Reuse project_war.py's matcher rather than writing a second one — it carries a
# manual alias map for players nflverse indexes under a legal first name (Geno
# Smith is Eugene Smith, Andy Dalton is Andrew Dalton) plus tiered nickname and
# prefix fallbacks. A naive name join silently drops those, and an earlier
# backtest here matched only 214 of ~594 players because of it.
from project_war import build_meta_index, match_meta

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")
HIST = ROOT / "nfl_history"

FULL_GP = 13
# Recent seasons dominate similarity. The third season back still matters —
# it is what distinguishes a one-year wonder from a steady producer — but at a
# fraction, which is the specific failure the shipped LEVEL has.
SEASON_W = [1.0, 0.80, 0.60]
# Flattened from [1.0, 0.55, 0.25] on 2026-08-10. The steep version discounted
# exactly the seasons that reveal CONSISTENCY, so a spike on a declining base
# matched a plateau: Russell Wilson's 2020 window [308, 273, 239] sat 0.31 from
# Josh Allen's [307, 302, 307] because the years they differ on most — 239 vs
# 307 — carried the least weight. Recency still leads, but a three-year record
# is now read as a record rather than as last season plus footnotes.
# Every feature is Z-SCORED against the position's own distribution before these
# weights apply, so a weight is a real statement of relative importance rather
# than an artefact of units. It was not, and the result was indefensible: with
# points carried as pts/100, Josh Allen's 2025 matched Kirk Cousins 2018 — 73
# points a season worse, a QB5-vs-QB20 gap — because that cost 0.96 in distance
# while being two years older cost 0.56. Age was priced at roughly 40 points a
# season. Production now dominates by construction.
AGE_W = 0.30          # per standard deviation of age
# Raised from 0.15 on 2026-08-10, together with the masked distance below. The
# two go together: masking stops a missing season being read as a zero-point
# season, and experience then has to carry the career-stage information those
# zeros were accidentally encoding. Masked alone, Marshawn Lynch's holdout year
# [208, 0, 0] and J.K. Dobbins' decline [166, 12, 52] both collapse to a single
# comparable season and become near-identical — experience is what separates a
# player who has not played yet from one who has stopped producing.
EXP_W = 0.45          # per standard deviation of experience
GP_W = 0.60           # per standard deviation of usage
# What an UNCOMPARABLE season costs, per unit of season weight. Set so that a
# season nobody can see is roughly as expensive as a one-standard-deviation
# disagreement on a season both players have — i.e. missing information is
# treated as a real difference, not as free agreement.
MISSING_PEN = 0.50
# COHORT SIZE IS NOT FIXED. Membership is a distance cutoff; k is an outcome.
#
# A hard k=40 asserts that every player has exactly forty comparables, which is
# false in both directions and measured: inside distance 0.75 Joe Milton has
# 194 analogs, Josh Allen 11, Bijan Robinson 2. Forcing 40 made Milton discard
# good matches and made Bijan reach out to players 2.5 standard deviations away
# — then reported both with the same authority.
#
# So: take everyone inside MAX_DIST. Below MIN_COHORT, fall back to the nearest
# MIN_COHORT and mark the row `padded` — the answer still exists but it is built
# from players who are not really alike, and the caller is told so. Above
# MAX_COHORT, keep the nearest; a 200-strong cohort adds nothing the nearest
# hundred did not already say.
# Recalibrated with MISSING_PEN (2026-08-10): the penalty shifted the whole
# distance scale, and the old 1.0 — tuned before it existed — excluded half the
# population. Swept jointly: 0.50/1.2 keeps a full three-season match ranked
# ahead of a one-season match (Derrick Henry 0.85 vs Doug Martin 0.94) while
# holding padded cohorts to 25 of 602. At 0.35 the ordering inverts again.
# Re-anchored from 1.2 when distance() started returning a real distance rather
# than a squared one: sqrt(1.2) = 1.0954, so cohort membership is unchanged to
# the digit. The historical notes above quote the old squared figures — Derrick
# Henry 0.85 and Doug Martin 0.94 are 0.92 and 0.97 in these units, and the
# ordering they were chosen to protect still holds.
MAX_DIST = 1.0954     # in standard deviations of the position's own features
MIN_COHORT = 12
MAX_COHORT = 100
# Neighbours are weighted by distance, not counted equally. A fixed k forces a
# cohort to fill even where the neighbourhood is empty — there are not 40 Josh
# Allens in fourteen seasons, so the tail of his cohort was Andy Dalton and
# Derek Carr carrying the same vote as Patrick Mahomes. Weighting lets a sparse
# neighbourhood stay honest: the far members are still there, they just stop
# deciding the answer. `eff_n` reports how many players the weight is really
# spread across.
# Bandwidth as a multiple of the cohort's median distance. Halved from 1.0 when
# the kernel was corrected: on true distance a bandwidth of one median is flatter
# still (effective sample 98.9% of n, against 96.7% for the old quartic), which
# defeats the point of weighting at all. At 0.5 the effective sample is 83% of n
# and a 99-match finally outvotes a 90-match by a visible margin.
#
# It is NOT tuned for accuracy, because accuracy does not move: pooled over four
# holdout seasons the mae is 0.634 at every setting from 1.0 to 0.6 and 0.635
# here, and for players who have a >=95 match it runs 0.580 / 0.578 / 0.577. The
# gain is that the weights now mean what the table says they mean.
KERNEL_H = 0.5
TOP_N = 3             # how many named comparables to publish per player


def similarity(d):
    """Distance -> a 0-100 match score, for reading rather than for maths.

    Distance is in standard deviations of the position's own features: good for
    the model, meaningless to a reader, and unbounded above so it cannot be a
    percentage directly. A gaussian maps it onto 0-100 monotonically.

    The width is NOT a free parameter. It is set so that MAX_DIST — the cohort
    membership cutoff — lands exactly on 50, which makes the score
    self-documenting: at or above 50 a comparable was inside the neighbourhood,
    below 50 he was reached for. Deliberately NOT the model's own kernel
    bandwidth, which is per-player (the cohort's median distance), so the same
    distance would score differently for different players and the number would
    stop being comparable across pages — Christian McCaffrey's uncomparable
    2.0-away analogs would score like Bijan Robinson's genuine 0.7 ones.
    """
    h = MAX_DIST / (2 * math.log(2)) ** 0.5
    return round(100 * math.exp(-(d * d) / (2 * h * h)))


def load_history():
    """(pid, season) -> dict(pos, gp, war, rate); plus meta by pid."""
    meta = {}
    for r in csv.DictReader(open(HIST / "players_meta.csv", encoding="utf-8")):
        try:
            born = int(r["birth_date"][:4])
        except (ValueError, TypeError):
            born = None
        meta[r["gsis_id"]] = {
            "name": r["name"],
            # the name people use, when nfl_history.py has been run since the
            # column was added. Falls back to the legal name so an older corpus
            # still works — it just keeps calling him Quintorris.
            "common": (r.get("common") or "").strip() or r["name"],
            "pos": r["pos"], "born": born,
            "draft": int(r["draft_season"]) if r["draft_season"] else None,
        }
    seasons = defaultdict(dict)
    for f in sorted(HIST.glob("waa_war_*.csv")):
        if "career" in f.name:
            continue
        yr = int(f.stem.split("_")[-1])
        for r in csv.DictReader(open(f, encoding="utf-8")):
            try:
                gp, war = int(r["gp"]), float(r["WAR"])
            except (ValueError, TypeError):
                continue
            if not gp:
                continue
            try:
                pts = float(r["pts"])
            except (ValueError, TypeError, KeyError):
                pts = 0.0
            seasons[yr][r["player_id"]] = {
                "pos": r["pos"], "gp": gp, "war": war, "pts": pts,
                "rate": war / gp * FULL_GP,
            }
    return meta, seasons


def feature(pid, yr, seasons, meta, space="rate"):
    """What this player looked like ENTERING yr+1, or None if never seen.

    `space` picks what the model measures a player BY:

      rate    per-13 WAR rate. Separates talent from availability, and in doing
              so throws away the thing that actually happened — two mop-up
              games get extrapolated to a full season.

      points  raw seasonal fantasy points, scaled by 100 so the magnitudes sit
              near the rate scale. Role and availability are IN the number
              rather than modelled around it: a backup scores few points
              because he is a backup, and a hurt star scores few because he was
              hurt, which are both real outcomes a manager actually received.
              WAR is retrofitted at the end via the fitted pts->WAR line.
    """
    hist = [seasons.get(yr - k, {}).get(pid) for k in range(3)]
    if not any(hist):
        return None
    m = meta.get(pid, {})
    pos = next((h["pos"] for h in hist if h), None)
    age = (yr - m["born"]) if m.get("born") else None
    exp = (yr - m["draft"] + 1) if m.get("draft") else None
    if space in ("points", "hybrid"):
        vals = [h["pts"] / 100.0 if h else 0.0 for h in hist]
    else:
        vals = [h["rate"] if h else 0.0 for h in hist]
    return {
        "pos": pos, "age": age, "exp": exp,
        "rates": vals,
        "gps": [h["gp"] / FULL_GP if h else 0.0 for h in hist],
        # WHICH SEASONS ACTUALLY EXIST. A slot with no season is not a season of
        # zero points, and treating it as one was the single largest term in the
        # distance between the two most similar backs in football: Bijan
        # Robinson's real 189-point 2023 was compared against a 2022 Jahmyr
        # Gibbs spent in college, contributing 4.65 of a 7.64 total.
        "has": [h is not None for h in hist],
    }


def scaler(pool):
    """Per-position standard deviations for every feature, so distance is in
    standard deviations rather than in whatever units the feature happens to
    use. Guards against a zero sd on a degenerate feature."""
    def sd(vals):
        vals = [v for v in vals if v is not None]
        if len(vals) < 2:
            return 1.0
        m = sum(vals) / len(vals)
        return max((sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5, 1e-6)
    # only real seasons feed the spread — phantom zeros would deflate every sd
    # and make the whole feature space look tighter than it is
    return {
        "rates": [sd([c["rates"][i] for c in pool if c["has"][i]]) for i in range(3)],
        "gps": [sd([c["gps"][i] for c in pool if c["has"][i]]) for i in range(3)],
        "age": sd([c["age"] for c in pool]),
        "exp": sd([c["exp"] for c in pool]),
    }


def distance(a, b, sc):
    """Weighted distance over the seasons BOTH players actually have.

    Season slots present in only one of the two are skipped, and the season
    weights are renormalised over what remains — otherwise comparing on two
    seasons would automatically score closer than comparing on three, and every
    short-career player would look like everyone else's nearest neighbour.

    Career-stage information does not come from the missing slots; it comes from
    age and experience, which is why EXP_W is heavier now that the zeros are
    gone."""
    d = 0.0
    used = 0.0
    for i, w in enumerate(SEASON_W):
        if not (a["has"][i] and b["has"][i]):
            continue
        used += w
        d += w * ((a["rates"][i] - b["rates"][i]) / sc["rates"][i]) ** 2
        d += w * GP_W * ((a["gps"][i] - b["gps"][i]) / sc["gps"][i]) ** 2
    if used <= 0:
        return float("inf")            # no overlapping season: not comparable
    # A season one of them does not have is UNKNOWN, and unknown has to cost
    # something. Renormalising alone (scaling the shared part up) does not work:
    # when the one shared season happens to line up, scaling a near-zero is
    # still near-zero, so Doug Martin's rookie year [260, 0, 0] scored 0.25
    # against Bijan Robinson while Derrick Henry [263, 245, 143] — who matches
    # all three of his seasons — scored 0.85. A one-season match beat a
    # three-season match.
    #
    # So charge MISSING_PEN per unit of unshared season weight. Two players with
    # three seasons each are compared on all three and pay nothing; a rookie
    # compared on one pays for the two nobody can see.
    d += MISSING_PEN * (sum(SEASON_W) - used)
    if a["age"] is not None and b["age"] is not None:
        d += AGE_W * ((a["age"] - b["age"]) / sc["age"]) ** 2
    if a["exp"] is not None and b["exp"] is not None:
        d += EXP_W * ((a["exp"] - b["exp"]) / sc["exp"]) ** 2
    # SQUARE ROOT, so what leaves here is a distance and not a squared one.
    # Every term above is squared, so `d` is squared distance; it used to be
    # returned that way and then fed to exp(-(d*d)/(2h*h)), which squares it
    # AGAIN. The kernel was therefore exp(-distance**4 / 2h**2) — very flat near
    # the centre and a cliff further out, which is why a 99-match got only 1.6%
    # of the weight where a flat average gives 1.0%. The bandwidth had the same
    # problem: h came from the median of squared distances while a gaussian's h
    # belongs in distance units.
    return d ** 0.5


def local_linear(pts, xq):
    """Weighted least squares of outcome on the primary feature, evaluated at
    the query's own value. pts = [(x, y, w)].

    BOUNDARY BIAS is why this exists. A weighted median is a local CONSTANT
    estimator: it answers "what did players around here do". For a player at the
    edge of the feature space that is the wrong question, because there is no
    "around" on one side. Every one of Josh Allen's comparables scored fewer
    points than he did, so their median is pulled inward no matter how the
    weights are set — the estimate is biased toward the middle of the league
    exactly for the players who are furthest from it.

    A local LINEAR fit uses the slope the cohort itself reveals (more points
    last year -> more WAR next year) and reads it at the query's real position,
    which removes that bias to first order. It is the standard correction and
    costs one regression per horizon year.

    Returns None when the fit cannot be trusted, and the caller falls back to
    the median: too few points, or an x-spread so narrow the slope is noise
    (every backup's cohort scored ~0, so there is no gradient to read).
    """
    if len(pts) < 6:
        return None
    sw = sum(w for _, _, w in pts)
    if sw <= 0:
        return None
    mx = sum(x * w for x, _, w in pts) / sw
    my = sum(y * w for _, y, w in pts) / sw
    sxx = sum(w * (x - mx) ** 2 for x, _, w in pts)
    if sxx / sw < 1e-4:                     # degenerate spread — no gradient
        return None
    b = sum(w * (x - mx) * (y - my) for x, y, w in pts) / sxx
    pred = my + b * (xq - mx)
    # Never extrapolate beyond the cohort's own outcome range. The slope is a
    # local read, not a law, and a query far outside the cloud would otherwise
    # produce a number no comparable ever posted.
    lo = min(y for _, y, _ in pts)
    hi = max(y for _, y, _ in pts)
    return max(lo, min(hi, pred))


def wquantile(pairs, q):
    """Weighted quantile. pairs = [(value, weight)], any order."""
    pairs = sorted(pairs)
    tot = sum(w for _, w in pairs)
    if tot <= 0:
        return pairs[len(pairs) // 2][0]
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= q * tot:
            return v
    return pairs[-1][0]


def build_corpus(seasons, meta, horizon, space="rate"):
    """Every historical (player, season) with its features and its actual future.

    MISSING SEASONS FOLLOW METHODOLOGY.md, NOT CONVENIENCE:

        "A player-season with no source is skipped, not zeroed — but a player
         who is out of the league is a real 0.0."

    So an absence is two different facts and gets two different treatments:

      hurt / inactive   he shows up again in a LATER season, so the year is
                        skipped — excluded from that horizon entirely rather
                        than scored as a zero. Counting it would punish every
                        comparable of a good player who missed a year, which is
                        the opposite of what an injury means for an asset.

      out of the league no trace in this year or any later one. That is a real
                        0.0, and keeping it is the whole reason the model does
                        not treat every non-playing backup as a lottery ticket
                        with no losing tickets.

    `future` therefore holds None for a skipped year, and project() drops those
    from the cohort per horizon year rather than per player.
    """
    years = sorted(seasons)
    # hybrid matches on points but scores outcomes in WAR — see --space
    key = "pts" if space == "points" else "war"
    last_seen = {}
    for yr in years:
        for pid in seasons[yr]:
            last_seen[pid] = max(last_seen.get(pid, yr), yr)
    corpus = []
    for yr in years:
        # PARTIAL HORIZONS ARE KEPT. This used to `break` as soon as a window
        # could not fill all three future years, which discarded every window
        # from (last season - 2) onward — three seasons of the most recent, most
        # relevant comparables. A 2024 window cannot say what happens in 2027,
        # but it knows exactly what happened in 2025, and that is real evidence
        # for a year-one projection.
        #
        # It mattered most exactly where the corpus was thinnest: Lamar
        # Jackson's Allen-like 2023 and 2024 seasons did not exist as
        # comparables at all, nor did Allen's own, which is why his cohort fell
        # back on five Russell Wilson windows.
        if yr >= years[-1]:
            break
        for pid in seasons[yr]:
            f = feature(pid, yr, seasons, meta, space)
            if not f or not f["pos"]:
                continue
            fut, fut_gp = [], []
            for k in range(1, horizon + 1):
                if yr + k > years[-1]:
                    # beyond the data, not an absence — unknown, never zero
                    fut.append(None)
                    fut_gp.append(0)
                    continue
                row = seasons.get(yr + k, {}).get(pid)
                if row is not None:
                    fut.append(row[key])
                    fut_gp.append(row["gp"])
                elif last_seen.get(pid, 0) > yr + k:
                    fut.append(None)      # hurt / inactive — skip, do not zero
                    fut_gp.append(0)
                else:
                    fut.append(0.0)       # gone for good — a real 0.0
                    # a player out of the league was available for nothing, but
                    # his 0.0 is a real outcome and must carry full weight
                    fut_gp.append(FULL_GP)
            f["future"], f["future_gp"] = fut, fut_gp
            # carried so a cohort can be inspected — "who is in Josh Allen's
            # comparables" is the first question anyone asks of this model
            f["pid"], f["yr"] = pid, yr
            corpus.append(f)
    return corpus


def project(q, corpus, max_dist, horizon, sc):  # noqa: C901
    pool = [c for c in corpus if c["pos"] == q["pos"]]
    if len(pool) < MIN_COHORT:
        return None
    scored = sorted(((distance(q, c, sc), c) for c in pool), key=lambda t: t[0])
    near = [t for t in scored if t[0] <= max_dist][:MAX_COHORT]
    padded = len(near) < MIN_COHORT
    if padded:
        near = scored[:MIN_COHORT]
    # Gaussian kernel on distance, bandwidth set from the cohort's own median
    # so it adapts to how crowded this player's neighbourhood is. A far
    # neighbour still contributes; it just does not get an equal vote.
    dists = [d for d, _ in near]
    h = max((statistics.median(dists) or 0.0) * KERNEL_H, 1e-6)
    wts = [math.exp(-(d * d) / (2 * h * h)) for d in dists]
    # Kish effective sample size: how many equally-weighted players this cohort
    # is really worth. A big n with a tiny eff_n means the answer rests on a
    # handful of true comparables and the rest are padding.
    sw, sw2 = sum(wts), sum(w * w for w in wts)
    out = {"n": len(near), "eff_n": round(sw * sw / sw2, 1) if sw2 else 0,
           # how alike the cohort actually is. THE uncertainty signal: a median
           # distance of 0.3 is a real neighbourhood, 1.8 is a shrug. Reported
           # rather than folded into the estimate, because a wide band and a
           # cohort of strangers are different problems.
           "d_med": round(statistics.median(dists), 2),
           "d_max": round(max(dists), 2),
           "padded": padded,
           # THE NEAREST FEW, BY NAME. "Who does this model think he looks
           # like" is the first question anyone asks of an analog model, and
           # until now the answer existed only in the process memory of the run
           # that produced the number. A median with no visible cohort is not
           # inspectable — you cannot tell a real neighbourhood from a shrug.
           # Only the top TOP_N ship: past that the weights are small enough
           # that they inform the estimate without informing a reader.
           #
           # HIS OWN EARLIER WINDOWS ARE EXCLUDED FROM THIS LIST ONLY, never
           # from the estimate. A career contributes one window per season, so
           # Josh Allen's nearest two neighbours are Josh Allen 2024 and 2023 —
           # correct for the median (it is a statement about how rare the
           # pattern is) and useless as an answer to "who does he look like".
           "near": [{"pid": c["pid"], "yr": c["yr"], "d": round(d, 3),
                     "age": c["age"],
                     "rates": [round(x, 3) for x in c["rates"]],
                     "gps": [round(x * FULL_GP) for x in c["gps"]],
                     "has": c["has"],
                     "future": c["future"], "future_gp": c["future_gp"]}
                    for d, c in [t for t in near if t[1]["pid"] != q.get("pid")][:TOP_N]],
           "n_scored": [], "median": [], "mean": [], "p20": [], "p80": [],
           "share_useful": [], "avail": [], "fitted": [], "median_flat": []}
    for i in range(horizon):
        # OUTCOMES ARE WEIGHTED BY THE GAMES THAT PRODUCED THEM.
        #
        # A comparable who played six games and posted +0.55 is not evidence
        # that players like this return 0.55 — he is six games of evidence and
        # seven games of injury. Counting him whole put Cam Newton's two-game
        # 2019 (-0.04) into Josh Allen's median at near-full weight, which
        # priced a broken shoulder as a performance.
        #
        # This also makes the existing skip a special case of one rule rather
        # than a cliff: 0 games is weight 0 (what "hurt, skipped" already
        # meant), 6 games is 6/13, a full season is 1.0. The estimate becomes
        # an IF-HEALTHY number, and availability is reported separately below —
        # the same split project_war.py draws between `natural` and `expected`.
        pairs, trip, avail_n, avail_d = [], [], 0.0, 0.0
        for (_, c), w in zip(near, wts):
            v = c["future"][i]
            gp = c["future_gp"][i]
            avail_n += w * min(gp, FULL_GP) / FULL_GP
            avail_d += w
            if v is None:
                continue
            gw = w * min(gp, FULL_GP) / FULL_GP
            if gw > 0:
                pairs.append((v, gw))
                trip.append((c["rates"][0], v, gw))
        if not pairs:
            pairs = [(0.0, 1.0)]
        tw = sum(w for _, w in pairs)
        out["n_scored"].append(len(pairs))
        # Local linear where the cohort supports it, weighted median otherwise.
        # The median stays the fallback because a backup's cohort has no usable
        # gradient — everyone scored nothing — and because it is robust where
        # the outcome distribution is a spike at zero with a thin breakout tail.
        fit = local_linear(trip, q["rates"][0])
        med = wquantile(pairs, 0.5)
        out["fitted"].append(fit is not None)
        out["median"].append(round(fit if fit is not None else med, 3))
        out["median_flat"].append(round(med, 3))
        out["mean"].append(round(sum(v * w for v, w in pairs) / tw, 3))
        out["p20"].append(round(wquantile(pairs, 0.2), 3))
        out["p80"].append(round(wquantile(pairs, 0.8), 3))
        out["share_useful"].append(
            round(sum(w for v, w in pairs if v >= 0.5) / tw, 3))
        # share of a full season the cohort actually played. Multiply the
        # if-healthy median by this for an expected-value read.
        out["avail"].append(round(avail_n / avail_d, 3) if avail_d else 0.0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-dist", type=float, default=MAX_DIST,
                    help="cohort membership cutoff, in standard deviations. "
                         "Cohort SIZE is then whatever the data supports.")
    ap.add_argument("--horizon", type=int, default=3)
    ap.add_argument("--as-of", type=int, default=None,
                    help="pretend this is the last known season (for backtests)")
    ap.add_argument("--space", choices=("rate", "points", "hybrid"), default="rate",
                    help="rate: match and predict in per-13 WAR. "
                         "points: match and predict in raw seasonal points. "
                         "hybrid: match on points, predict in WAR — role and "
                         "availability shape WHO the comparables are, while a "
                         "missing season still scores as replacement level "
                         "rather than as a full season of zeroes.")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    out_name = args.out or f"projections_knn_{args.space}.json"

    meta, seasons = load_history()
    curves = json.loads((HIST / "aging_curves.json").read_text())["pts_to_war"]
    if args.as_of:
        seasons = {y: v for y, v in seasons.items() if y <= args.as_of}
    years = sorted(seasons)
    seed = years[-1]

    corpus = build_corpus(seasons, meta, args.horizon, args.space)

    # scale nfl_history WAR into this league's units, from the seasons we
    # have in both. Same shape, different replacement level.
    # gsis -> Sleeper pid. Built ONCE, up here, because two things need it: the
    # scale ratio below and the player join at the end. It used to be built only
    # at the end, so the ratio fell back to a raw-name join and came out wrong.
    gsis_to_pid, sleeper_name = {}, {}
    try:
        _pmin = json.loads((DATA / "players_min.json").read_text(encoding="utf-8"))
        _idx = build_meta_index()
        for _pid, _v in _pmin.items():
            if _v[1] not in ("QB", "RB", "WR", "TE"):
                continue
            _m = match_meta(_v[0], _v[1], _idx)
            if _m and _m[3]:
                gsis_to_pid.setdefault(_m[3], _pid)
                # Sleeper's label is the one the rest of the site shows, so it
                # wins where we have it. It only covers players the league still
                # references, which is why the corpus needs its own common name
                # for everyone who has retired.
                sleeper_name.setdefault(_m[3], _v[0])
    except (OSError, ValueError, KeyError, IndexError) as e:
        print(f"  ! could not build the Sleeper id map: {e}")

    ratio, n_r = 1.0, 0
    try:
        lmeta = json.loads((DATA / "meta.json").read_text())
        # Least squares through the origin, NOT a ratio of sums: the two WAR
        # scales both run negative for replacement-level players, and summing
        # signed values let the positives and negatives cancel into nonsense
        # (the first run of this reported a scale of -0.139).
        # Join through match_meta, NOT raw names, and require a real season on
        # both sides. Joining on normalized strings silently dropped every
        # player nflverse indexes under a legal first name and let short
        # seasons in, which dragged this slope to 0.850 — a 15% haircut on
        # every projection in the file. Done properly it is 0.969, flat across
        # every WAR band, which is what nfl_history.py's own sigma calibration
        # says it should be ("matched ratios centre on 1.0 per season").
        sxy = sxx = 0.0
        for s in lmeta["seasons"]:
            f = DATA / s / "summary.json"
            if not f.exists() or int(s) not in seasons:
                continue
            lg = {r[0]: (r[6], r[2]) for r in json.loads(f.read_text())
                  if len(r) > 6 and isinstance(r[6], (int, float))}
            for pid, row in seasons[int(s)].items():
                lp = gsis_to_pid.get(pid)
                if not lp or lp not in lg or row["gp"] < 10 or lg[lp][1] < 10:
                    continue
                sxy += row["war"] * lg[lp][0]; sxx += row["war"] ** 2; n_r += 1
        if sxx:
            ratio = sxy / sxx
    except (OSError, KeyError, json.JSONDecodeError):
        pass

    # Hand corrections, keyed by gsis_id — see the file's own note. Keyed by ID
    # and never by name, for the reason the owner splits are keyed by roster_id:
    # the name is the thing being corrected, so it cannot also be the key.
    aliases = {}
    af = HIST / "name_aliases.json"
    if af.exists():
        try:
            aliases = {k: v for k, v in json.loads(af.read_text(encoding="utf-8")).items()
                       if not k.startswith("_") and isinstance(v, str) and v.strip()}
            print(f"name aliases: {len(aliases)}")
        except (OSError, ValueError) as e:
            print(f"  ! could not read {af.name}: {e}")

    def shown(gsis):
        """The name to print for a comparable.

        Four sources, best first: Sleeper's label (matches the rest of the site,
        but only covers players the league still references), a hand alias,
        nflverse's common name, then the legal name. nflverse indexes by birth
        certificate — Julio Jones is Quintorris, CeeDee Lamb is Cedarian, Dak
        Prescott is Rayne — which is correct for a join key and unreadable in a
        comparables table.

        Sleeper outranks the alias deliberately: where the site already shows a
        name, the comparables table must not disagree with it.
        """
        m = meta.get(gsis, {})
        return (sleeper_name.get(gsis) or aliases.get(gsis)
                or m.get("common") or m.get("name"))

    def to_war(v, pos):
        """Retrofit: in points space the cohort's outcomes are seasonal points,
        so they go back through the fitted pts->WAR line before the league
        rescale. In rate and hybrid space they are already WAR.

        This conversion is exactly why pure points space fails on anyone who
        might not play: a missing season is 0 points, and the line turns 0
        points into -1.35 WAR — the value of starting a player every week who
        scores nothing. Nobody does that; they bench him, which is replacement
        level, which is 0 WAR. Hence hybrid."""
        if args.space != "points":
            return v
        c = curves.get(pos)
        return (c["a"] + c["b"] * v) if c else v

    out = {"meta": {"model": f"analog / k-nearest historical comparables ({args.space})",
                    "space": args.space,
                    "max_dist": args.max_dist, "horizon": args.horizon,
                    "corpus_seasons": [years[0], years[-1]],
                    "corpus_rows": len(corpus),
                    "seed_season": seed,
                    "league_scale_ratio": round(ratio, 4),
                    "scale_sample": n_r,
                    "absent": "hurt/inactive skipped; out of the league = 0.0"},
           "players": []}

    # Anyone seen in the last three seasons, not just the seed one. A player who
    # missed the whole seed season is still a projectable asset — Brandon Aiyuk
    # has no 2025 row and was silently absent from the output. feature() already
    # looks back three years, so the window only ever needed widening here.
    candidates = set()
    for k in range(3):
        candidates |= set(seasons.get(seed - k, {}))
    # feature spreads are per position: a QB's points distribution is nothing
    # like a TE's, and one shared scaler would import that difference as noise
    scalers = {p: scaler([c for c in corpus if c["pos"] == p])
               for p in {c["pos"] for c in corpus}}
    for pid in sorted(candidates):
        q = feature(pid, seed, seasons, meta, args.space)
        if not q or not q["pos"] or q["pos"] not in scalers:
            continue
        q["pid"] = pid
        r = project(q, corpus, args.max_dist, args.horizon, scalers[q["pos"]])
        if not r:
            continue
        pos = q["pos"]
        proj = [round(to_war(x, pos) * ratio, 3) for x in r["median"]]
        out["players"].append({
            "gsis": pid, "name": meta.get(pid, {}).get("name"),
            "pos": pos, "age": q["age"], "exp": q["exp"],
            "seen": [round(x, 3) for x in q["rates"]],
            "gps": [round(x * FULL_GP) for x in q["gps"]],
            "n": r["n"], "eff_n": r["eff_n"], "n_scored": r["n_scored"],
            "d_med": r["d_med"], "d_max": r["d_max"], "padded": r["padded"],
            # the cohort's typical match, on the same 0-100 scale as `near.sim`
            "sim_med": similarity(r["d_med"]),
            "avail": r["avail"], "fitted": r["fitted"],
            "median_flat": [round(to_war(x, pos) * ratio, 3) for x in r["median_flat"]],
            # if-healthy median x the cohort's availability
            "expected": [round(to_war(r["median"][i], pos) * ratio * r["avail"][i], 3)
                         for i in range(len(r["median"]))],
            "proj": proj,
            "proj_mean": [round(to_war(x, pos) * ratio, 3) for x in r["mean"]],
            "low": [round(to_war(x, pos) * ratio, 3) for x in r["p20"]],
            "high": [round(to_war(x, pos) * ratio, 3) for x in r["p80"]],
            "raw_median": r["median"],
            "share_useful": r["share_useful"],
            "total": round(sum(proj), 3),
            # the named comparables, in the same league WAR units as `proj` so a
            # reader can compare a cohort member's actual result against the
            # projection it helped produce without converting anything
            "near": [{
                "name": shown(m["pid"]),
                "season": m["yr"], "age": m["age"], "d": m["d"],
                "sim": similarity(m["d"]),
                # what he had done going in, most recent first — the same three
                # numbers the query was matched on
                "seen": [round(x, 3) if h else None
                         for x, h in zip(m["rates"], m["has"])],
                "gps": [g if h else None for g, h in zip(m["gps"], m["has"])],
                # what he ACTUALLY returned over the next three years. None is a
                # year he was hurt or inactive, which is skipped rather than
                # scored as a zero — a real 0.0 means he left the league, and
                # those are different facts (METHODOLOGY.md on absence).
                "then": [None if v is None else round(to_war(v, pos) * ratio, 3)
                         for v in m["future"]],
                "then_gp": m["future_gp"],
            } for m in r["near"]] if gsis_to_pid.get(pid) else [],
        })

    # gsis -> Sleeper pid, so the site can join without guessing at names.
    # Built from the LEAGUE side (Sleeper display name -> pid) through the same
    # alias map project_war.py uses, then inverted onto the corpus name.
    # Drive the join FROM the league side through match_meta, which resolves a
    # Sleeper display name to a gsis_id using the alias map AND the tiered
    # nickname/prefix fallbacks. Matching on normalized strings alone is not
    # enough: nflverse carries Joe Burrow as Joseph and Andy Dalton as Andrew,
    # and a plain-string join dropped 112 rostered players including starters.
    matched = 0
    for d in out["players"]:
        d["pid"] = gsis_to_pid.get(d["gsis"])
        if d["pid"]:
            matched += 1
    print(f"joined {matched}/{len(out['players'])} to Sleeper ids")

    out["players"].sort(key=lambda d: -d["total"])
    dest = DATA / out_name
    dest.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"[{args.space}] corpus {len(corpus)} player-seasons {years[0]}-{years[-1]} · "
          f"seed {seed} · scale x{ratio:.3f} (n={n_r})")
    print(f"wrote {dest} · {len(out['players'])} players")


if __name__ == "__main__":
    main()
