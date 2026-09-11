#!/usr/bin/env python3
"""
project_points.py — project POINTS first; WAR comes later, from the points.

WHY POINTS FIRST (Max, 2026-09-10)

WAR is points over the position's replacement level that season. Projecting
WAR directly therefore projects two things at once: what the player produces,
and where the replacement line happens to sit — which moves when a dozen
other players at his position have a good year and has nothing to do with
him. A model in WAR can mark a man as regressing when he did not regress.
So: project each player's points per game and games, then hand every
projected season to the WAR engine's own pool logic, which sets that
season's replacement level from the projections themselves.

WHAT IT LEARNS FROM

  history   his last three seasons' points per game (league scoring, weeks
            1-14, from nfl_history/waa_war_<season>.csv) and games — each
            season era-normalized (see era() below) so 2014 and 2024 pool
  skill     nfl_history/features_<season>.csv for his last THREE seasons,
            plus the three-year mean of each column (Max, 2026-09-10: a
            track record has to be visible to be learned) —
            usage (target share, WOPR, carries and targets a game),
            efficiency (EPA per opportunity, CPOE, RACR, YAC, yards per
            target / carry / attempt, TD and first-down rates) and
            ffopportunity's expected points (what an average player would
            have scored on the same opportunities, and how far above or
            below that he finished)
  who       age, draft round and pick, years of experience

MODEL

Gradient-boosted trees (sklearn HistGradientBoostingRegressor), one per
position per horizon year per target. Missing values are left missing — the
trees route them — so a rookie with no history and a veteran with no
features row both fit the same model. Not explainable, and not meant to be
(Max, 2026-09-10: "I don't care if the projection can't be explained").

TWO TARGETS PER HORIZON YEAR

  ppg     points per game IF he plays — fitted on seasons of MIN_GP+ games
  games   games played, with an absent season a real 0: out of the league,
          hurt all year, or never made it are all zero games received

Expected season points = ppg × games. Bands come from the residual
distribution of the holdout fits per position (p20 / p80 of actual − fitted).

BACKTEST   --backtest fits on seasons before each holdout year (2021-2024)
           and reports MAE on ppg and games against a naive "last season"
           baseline, so a feature change has to earn its place in a number.

THE SITE MODEL (Max, 2026-09-11: "implement this as a model")

`--site` makes this THE projection the site runs on. It reads the scalar
model's projections.json (project_war.py, run just before), keeps a copy as
projections_scalar.json for the comparison lens, and rewrites projections.json
in the same schema with this model's streams, so every consumer — the player
ladder, Team and Teams, the trade builder, value_bridge, index_models, the
shards — switches at once:

  natural    (proj)       WAR over a full 13 games at the projected ppg
  expected   (expected)   WAR over the projected games
  composite  (composite)  the projected ppg blended with Sleeper's preseason
                          line in POINTS space — year one at BLEND_W[0]
                          Sleeper, later years scaled by BLEND_W as
                          project_war.composite_path does, Sleeper's read aged
                          along this model's own path — then WAR from the
                          composite pool. Natural and composite are both on
                          the page; the composite is what the site prices on.

THE ROOKIE ARM (Max, 2026-09-11: "build a rookie arm based on draft capital")

A rookie has no NFL season, so the main model has nothing to read. His arm
is the same construction on the one thing that is known the day he is
drafted: draft capital. Per position, trees fit on every draft class since
2014 — overall pick, round, age at the draft — to the class's year one,
two and three ppg and games. Same two targets, same era normalization,
same WAR from the pool. An undrafted rookie is priced as pick UDFA_PICK.
Rows it prices are flagged `src: "rookie"`; a player neither arm can read
(an unjoined name) keeps his scalar row, `src: "scalar"`.

Usage:  python scripts/project_points.py [--backtest] [--as-of 2025] [--site]
Output: nfl_history/projections_points.json  (gsis_id -> {ppg, games, pts, …})
        data/<league>/projections_points.json — the same rows keyed by Sleeper
        pid (project_war.py's name matcher does the join, as the analog arm's
        does), with the WAR bands the player page draws
        --site: data/<league>/projections.json rewritten, projections_scalar.json
"""
import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "nfl_history"

CORE = ("QB", "RB", "WR", "TE")
FULL_GP = 13
MIN_GP = 4            # a ppg is only a rate once he has played this many
HORIZON = 3
# seasons of skill features the trees see (was 2 — a guess about staleness
# that hid a three-year track record; Max, 2026-09-10)
FEAT_YEARS = 3
# the startable pool the league's lineups draw from, all positions: 12 QB +
# 24 RB + 36 WR + 12 TE + 12 FLEX + 12 SF = 108 player-seasons
POOL = 108

# skill columns carried from features_<season>.csv (rates, not totals, so a
# 12-game and a 17-game season compare)
FEAT_COLS = [
    "games", "att_pg", "car_pg", "tgt_pg", "tgt_share", "ay_share", "wopr",
    "cmp_pct", "ypa", "pass_td_rate", "int_rate", "sack_rate", "epa_db", "cpoe",
    "pacr", "pass_fd_rate", "pass_expl_rate",
    "ypc", "rush_td_rate", "epa_car", "rush_fd_rate", "rush_expl_rate",
    "catch_rate", "ypt", "ypr", "adot", "racr", "yac_rec", "epa_tgt",
    "rec_td_rate", "rec_fd_rate", "rec_expl_rate",
    "fp_exp_pg", "exp_share", "fp_diff", "td_diff",
]
# opportunity counts, gating the rates above: a 9.0 ypc on three carries is
# not a skill, and the trees can only know that if the count is a feature
COUNT_COLS = ["att", "car", "tgt"]
ALL_COLS = FEAT_COLS + COUNT_COLS
# WHAT EACH POSITION IS ALLOWED TO SEE — MAX'S SETS (2026-09-11).
#
# Chosen from the per-metric correlation table (scratch/feature_correlations.md):
# for each position, the columns that still correlate with future ppg after
# this season's ppg is taken out. Usage and expected opportunity, nothing
# else — every efficiency rate (yards per target, EPA per target, explosive
# rate, catch rate, YAC, ADOT, RACR) partials to zero once scoring is known,
# and the first fit's 60-column WR set was splitting on them anyway.
#
# Holdout against history-only (ppg MAE, starters, N+1 / N+2 / N+3):
#   QB  3.24 / 4.16 / 4.40  ->  3.27 / 4.17 / 4.22   games better at N+2
#   RB  3.30 / 4.03 / 4.62  ->  3.29 / 3.89 / 4.58
#   WR  2.91 / 3.39 / 3.57  ->  2.89 / 3.47 / 3.71   a small cost, taken on
#                                                    purpose so the model can
#                                                    see usage (Max)
#   TE  3.29 / 3.63 / 3.58  ->  3.19 / 3.63 / 3.57
# Three seasons of ppg and games already carry most of what these know; the
# gains are at the longer horizons and on the games model.
POS_COLS = {
    "QB": ["fp_exp_pg", "epa_db"],
    "RB": ["fp_exp_pg", "car_pg", "tgt_share"],
    "WR": ["fp_exp_pg", "tgt_pg", "tgt_share", "ay_share"],
    "TE": ["fp_exp_pg", "tgt_share", "ay_share"],
}


# ------------------------------------------------------------------ loading --
def fnum(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return math.nan
    return x if math.isfinite(x) else math.nan


def load_meta():
    meta = {}
    for r in csv.DictReader(open(HIST / "players_meta.csv", encoding="utf-8")):
        try:
            born = int(r["birth_date"][:4])
        except (ValueError, TypeError):
            born = None
        meta[r["gsis_id"]] = {
            "name": (r.get("common") or "").strip() or r["name"], "pos": r["pos"],
            "born": born,
            "draft": int(r["draft_season"]) if r.get("draft_season") else None,
            "round": fnum(r.get("draft_round")), "pick": fnum(r.get("draft_pick")),
        }
    return meta


def load_seasons():
    """season -> pid -> {pos, gp, pts, ppg}"""
    seasons = defaultdict(dict)
    for f in sorted(HIST.glob("waa_war_*.csv")):
        if "career" in f.name:
            continue
        yr = int(f.stem.split("_")[-1])
        for r in csv.DictReader(open(f, encoding="utf-8")):
            try:
                gp, pts = int(r["gp"]), float(r["pts"])
            except (ValueError, TypeError):
                continue
            if r["pos"] not in CORE:
                continue
            seasons[yr][r["player_id"]] = {"pos": r["pos"], "gp": gp, "pts": pts,
                                           "ppg": pts / gp if gp else 0.0}
    return seasons


def load_features():
    """season -> pid -> {col: float|nan}"""
    feats = defaultdict(dict)
    for f in sorted(HIST.glob("features_*.csv")):
        yr = int(f.stem.split("_")[-1])
        for r in csv.DictReader(open(f, encoding="utf-8")):
            feats[yr][r["player_id"]] = {c: fnum(r.get(c)) for c in ALL_COLS}
    return feats


def era(seasons):
    """Season scoring level: mean ppg of the top POOL player-seasons (8+ games)
    across ALL positions. Dividing by it makes 2014 and 2024 pool. Positional
    depth deliberately does not enter — that is the replacement line, and the
    whole point is to keep it out of the projection."""
    lvl = {}
    for yr, rows in seasons.items():
        ppgs = sorted((r["ppg"] for r in rows.values() if r["gp"] >= 8), reverse=True)[:POOL]
        lvl[yr] = statistics.mean(ppgs) if ppgs else 1.0
    ref = statistics.mean(lvl.values())
    return {yr: v / ref for yr, v in lvl.items()}, ref


# ------------------------------------------------------------------ features --
def build_x(pid, yr, seasons, feats, meta, lvl):
    """The feature vector for a player ENTERING yr+1, from what he did through
    yr. None if he has never been seen (no history and no features)."""
    hist = [seasons.get(yr - k, {}).get(pid) for k in range(3)]
    fx = [feats.get(yr - k, {}).get(pid) for k in range(FEAT_YEARS)]
    if not any(hist) and not any(fx):
        return None
    m = meta.get(pid, {})
    pos = next((h["pos"] for h in hist if h), None) or m.get("pos")
    if pos not in CORE:
        return None
    age = (yr + 1 - m["born"]) if m.get("born") else math.nan
    exp = (yr + 1 - m["draft"]) if m.get("draft") else math.nan
    x = [age, exp, m.get("round", math.nan), m.get("pick", math.nan)]
    for k, h in enumerate(hist):
        e = lvl.get(yr - k, 1.0)
        x += [h["ppg"] / e if h else math.nan, h["gp"] if h else 0.0,
              (h["pts"] / e) if h else 0.0]
    for f in fx:
        x += [f[c] if f else math.nan for c in POS_COLS[pos]]
    # THE TRACK RECORD, as a thing the trees can split on: the mean of each
    # skill column over the seasons he has. Three single years let the trees
    # learn "last year dipped"; the mean lets them learn "three years of
    # elite usage" as one fact rather than as a coincidence of three.
    for c in POS_COLS[pos]:
        vals = [f[c] for f in fx if f and not math.isnan(f[c])]
        x.append(sum(vals) / len(vals) if vals else math.nan)
    return pos, np.array(x, dtype=float)


def feature_names(pos):
    n = ["age", "exp", "round", "pick"]
    for k in range(3):
        n += [f"ppg_{k}", f"gp_{k}", f"pts_{k}"]
    for k in range(FEAT_YEARS):
        n += [f"{c}_{k}" for c in POS_COLS[pos]]
    n += [f"{c}_avg" for c in POS_COLS[pos]]
    return n


def targets(pid, yr, seasons, lvl, last_year):
    """(ppg list, games list) for yr+1..yr+HORIZON. ppg is None when he did
    not play MIN_GP games (not a rate) or the year is beyond the data; games
    is None only beyond the data — an absent season is 0 games."""
    ppg, games = [], []
    for k in range(1, HORIZON + 1):
        y = yr + k
        if y > last_year:
            ppg.append(None); games.append(None); continue
        row = seasons.get(y, {}).get(pid)
        if row and row["gp"] >= MIN_GP:
            ppg.append(row["ppg"] / lvl.get(y, 1.0))
        else:
            ppg.append(None)
        games.append(row["gp"] if row else 0)
    return ppg, games


def build_corpus(seasons, feats, meta, lvl, last_year):
    rows = []
    for yr in sorted(seasons):
        if yr >= last_year:
            break
        pids = set(seasons[yr]) | set(feats.get(yr, {}))
        for pid in pids:
            bx = build_x(pid, yr, seasons, feats, meta, lvl)
            if not bx:
                continue
            pos, x = bx
            p, g = targets(pid, yr, seasons, lvl, last_year)
            rows.append({"pid": pid, "yr": yr, "pos": pos, "x": x, "ppg": p, "games": g})
    return rows


# --------------------------------------------------------------------- model --
def make_model(target, seed=0):
    """ppg is fit to the MEDIAN (absolute error): a rate, and one outlier
    season should not drag a cohort. games is fit to the MEAN (squared
    error): it is an expectation over a lumpy outcome — most fringe
    player-seasons are followed by zero games three years out, and a median
    there is 0 for everyone, which is not what "expected games" means."""
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(
        loss="absolute_error" if target == "ppg" else "squared_error",
        max_iter=400, learning_rate=0.04,
        max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0,
        random_state=seed)


def fit_models(corpus, positions=CORE):
    """pos -> k -> {"ppg": model|None, "games": model|None}"""
    out = {}
    for pos in positions:
        rows = [r for r in corpus if r["pos"] == pos]
        out[pos] = {}
        for k in range(HORIZON):
            mods = {}
            for tgt in ("ppg", "games"):
                pairs = [(r["x"], r[tgt][k]) for r in rows if r[tgt][k] is not None]
                if len(pairs) < 60:
                    mods[tgt] = None
                    continue
                X = np.vstack([p[0] for p in pairs]); y = np.array([p[1] for p in pairs])
                mods[tgt] = make_model(tgt, seed=k).fit(X, y)
            out[pos][k] = mods
    return out


def predict(models, pos, x):
    """[(ppg_norm, games)] per horizon year; games clipped to 0..FULL_GP"""
    res = []
    for k in range(HORIZON):
        m = models[pos][k]
        ppg = float(m["ppg"].predict(x[None, :])[0]) if m["ppg"] else math.nan
        g = float(m["games"].predict(x[None, :])[0]) if m["games"] else math.nan
        res.append((max(ppg, 0.0), min(max(g, 0.0), FULL_GP)))
    return res


# ------------------------------------------------------------------ backtest --
def backtest(seasons, feats, meta, lvl, years):
    print("holdout: fit on seasons before each year, score the year after")
    print(f"{'year':>5} {'pos':>3} {'n':>4}  {'mae ppg':>8} {'naive':>6}  {'mae gp':>7} {'naive':>6}")
    agg = defaultdict(list)
    for yr in years:
        corpus = build_corpus(seasons, feats, meta, lvl, last_year=yr)
        models = fit_models(corpus)
        # scored on players WITH a history row, so the number is comparable
        # across feature sets (a features-only backup is a different test)
        test = [r for r in build_corpus(seasons, feats, meta, lvl, last_year=yr + 1)
                if r["yr"] == yr and r["pid"] in seasons[yr]]
        for pos in CORE:
            e_ppg, e_naive, e_g, e_gn = [], [], [], []
            for r in test:
                if r["pos"] != pos:
                    continue
                ppg_hat, g_hat = predict(models, pos, r["x"])[0]
                last = r["x"][4]          # ppg_0, era-normalized
                if r["ppg"][0] is not None:
                    e_ppg.append(abs(ppg_hat - r["ppg"][0]))
                    e_naive.append(abs((last if not math.isnan(last) else 0.0) - r["ppg"][0]))
                if r["games"][0] is not None:
                    e_g.append(abs(g_hat - r["games"][0]))
                    e_gn.append(abs(r["x"][5] - r["games"][0]))
            if e_ppg:
                print(f"{yr + 1:>5} {pos:>3} {len(e_ppg):>4}  {np.mean(e_ppg):8.2f} {np.mean(e_naive):6.2f}"
                      f"  {np.mean(e_g):7.2f} {np.mean(e_gn):6.2f}")
                agg[pos].append((np.mean(e_ppg), np.mean(e_naive), np.mean(e_g), np.mean(e_gn)))
    print("pooled:")
    for pos, v in agg.items():
        a = np.mean(v, axis=0)
        print(f"  {pos}: ppg {a[0]:.2f} vs naive {a[1]:.2f}  ·  games {a[2]:.2f} vs naive {a[3]:.2f}")


def residual_bands(seasons, feats, meta, lvl, years):
    """p20/p80 of (actual − fitted) ppg per position from the holdout years,
    for the bands. Pooled across the years, per horizon year 1."""
    res = defaultdict(list)
    for yr in years:
        corpus = build_corpus(seasons, feats, meta, lvl, last_year=yr)
        models = fit_models(corpus)
        test = [r for r in build_corpus(seasons, feats, meta, lvl, last_year=yr + 1) if r["yr"] == yr]
        for r in test:
            if r["ppg"][0] is None:
                continue
            ppg_hat, _ = predict(models, r["pos"], r["x"])[0]
            res[r["pos"]].append(r["ppg"][0] - ppg_hat)
    return {pos: (float(np.percentile(v, 20)), float(np.percentile(v, 80)))
            for pos, v in res.items()}


# --------------------------------------------------------------- rookie arm --
def rookie_x(pick, rnd, age):
    return np.array([pick if pick and pick < 999 else UDFA_PICK,
                     rnd if rnd and rnd == rnd else 7.0,
                     age if age is not None else math.nan], dtype=float)


def rookie_corpus(seasons, meta, lvl, last_year):
    """One row per drafted QB/RB/WR/TE, classes ROOKIE_FIRST_CLASS..last_year:
    draft capital in, his first three seasons' ppg and games out. A draftee
    with no season at all is a real zero games — that is what a seventh-round
    pick usually returns, and the arm has to know it."""
    rows = []
    for pid, m in meta.items():
        D = m.get("draft")
        if not D or D < ROOKIE_FIRST_CLASS or D > last_year or m["pos"] not in CORE:
            continue
        age = (D - m["born"]) if m.get("born") else None
        ppg, games = [], []
        for k in range(HORIZON):
            y = D + k
            if y > last_year:
                ppg.append(None); games.append(None); continue
            r = seasons.get(y, {}).get(pid)
            ppg.append(r["ppg"] / lvl.get(y, 1.0) if r and r["gp"] >= MIN_GP else None)
            games.append(r["gp"] if r else 0)
        rows.append({"pid": pid, "pos": m["pos"], "x": rookie_x(m.get("pick"), m.get("round"), age),
                     "ppg": ppg, "games": games})
    return rows


def fit_rookie_models(corpus):
    """pos -> k -> {ppg, games}: the same trees, on three inputs, with the
    leaves sized for ~250 rows a position."""
    from sklearn.ensemble import HistGradientBoostingRegressor
    out = {}
    for pos in CORE:
        rows = [r for r in corpus if r["pos"] == pos]
        out[pos] = {}
        for k in range(HORIZON):
            mods = {}
            for tgt in ("ppg", "games"):
                pairs = [(r["x"], r[tgt][k]) for r in rows if r[tgt][k] is not None]
                if len(pairs) < 40:
                    mods[tgt] = None; continue
                X = np.vstack([p[0] for p in pairs]); y = np.array([p[1] for p in pairs])
                mods[tgt] = HistGradientBoostingRegressor(
                    loss="absolute_error" if tgt == "ppg" else "squared_error",
                    max_iter=200, learning_rate=0.05, max_leaf_nodes=6,
                    min_samples_leaf=20, l2_regularization=1.0, random_state=k).fit(X, y)
            out[pos][k] = mods
    return out


def rookie_backtest(seasons, meta, lvl, last):
    """leave-one-class-out over the last four classes, year one"""
    print("rookie arm holdout (year one, by draft class):")
    for D in range(last - 3, last + 1):
        corpus = [r for r in rookie_corpus(seasons, meta, lvl, last_year=last)
                  if meta[r["pid"]]["draft"] != D and meta[r["pid"]]["draft"] + 0 < D]
        models = fit_rookie_models(corpus)
        test = [r for r in rookie_corpus(seasons, meta, lvl, last_year=last) if meta[r["pid"]]["draft"] == D]
        e_p, e_g, e_gn = [], [], []
        for r in test:
            ph, gh = predict(models, r["pos"], r["x"])[0]
            if r["ppg"][0] is not None:
                e_p.append(abs(ph - r["ppg"][0]))
            if r["games"][0] is not None:
                e_g.append(abs(gh - r["games"][0])); e_gn.append(abs(FULL_GP / 2 - r["games"][0]))
        print(f"  class {D}: n={len(test)} · ppg mae {np.mean(e_p):.2f} (played) · "
              f"games mae {np.mean(e_g):.2f} vs {np.mean(e_gn):.2f} for a flat 6.5")


# ------------------------------------------------------------ WAR from points --
# The league's starting slots, league-wide (12 teams). Mirrors nfl_history.py
# ROSTER_POSITIONS × N_TEAMS, the pool the WAR engine ranks inside.
SLOTS = {"QB": 12, "RB": 24, "WR": 36, "TE": 12, "FLEX": 12, "SUPER_FLEX": 12}
# Team-score sigma for the win-shift curve. sleeper_war.py measures it
# weekly from real team scores; the corpus (calibrated to the real league)
# prices a marginal point over replacement at ~91 per win, 2022-2025, and
# the curve's slope at zero is 1 / (sigma * 2 * sqrt(pi)), so sigma = 91 /
# (2 sqrt(pi)) = 25.7. One constant: the projections are one season's
# worth of average weeks, not fourteen distinct ones.
PTS_PER_WIN = 91.0
SIGMA = PTS_PER_WIN / (2 * math.sqrt(math.pi))
# the composite's Sleeper weight by horizon year — project_war.BLEND_W, the
# one definition the site has used since the composite existed
BLEND_W = [0.9, 0.5, 0.1]
# an undrafted rookie's pick, for the draft-capital arm (project_war's default)
UDFA_PICK = 260
# the first draft class the arm learns from — nflverse draft picks and the
# WAR corpus both cover it
ROOKIE_FIRST_CLASS = 2014


def win_shift(x, sigma=SIGMA):
    """sleeper_war.norm_win_shift: Phi(x / (sigma sqrt 2)) - 0.5"""
    return 0.5 * math.erf(x / (sigma * math.sqrt(2)) / math.sqrt(2))


def pool_war(ppg_by_pid, pos_by_pid, games_by_pid=None):
    """pid -> (war13, war_over_games, repl) for ONE season's ppg map, the
    replacement line set by the greedy league-wide lineup on these ppg."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    from sleeper_war import build_week
    points = {pid: v for pid, v in ppg_by_pid.items() if v > 0}
    positions = {pid: pos_by_pid[pid] for pid in points}
    _, _, repl = build_week(points, positions, dict(SLOTS))
    out = {}
    for pid, v in ppg_by_pid.items():
        r = repl.get(pos_by_pid[pid], 0.0)
        sh = win_shift(v - r)
        g = games_by_pid.get(pid, FULL_GP) if games_by_pid else FULL_GP
        out[pid] = (round(sh * FULL_GP, 3), round(sh * g, 3), round(r, 2))
    return out


def war_from_points(proj, k):
    """WAR for horizon year k, from the projected points of EVERYONE.

    This is the whole point of projecting points first: the replacement
    level for a projected season is set by the projected pool — the same
    greedy league-wide lineup sleeper_war.build_week fills, run on projected
    ppg — so a player's WAR moves only when HIS points move, not when the
    twelfth-best at his position has a good year in the model's eyes.
    Returns pid -> (war, war13, repl): expected WAR over projected games,
    the full-13-game "natural" WAR, and the replacement ppg it was measured
    against."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    from sleeper_war import build_week
    # the pool: everyone projected to play at all, at his projected rate
    points = {pid: p["ppg"][k] for pid, p in proj.items() if p["games"][k] >= 1 and p["ppg"][k] > 0}
    positions = {pid: proj[pid]["pos"] for pid in points}
    _, _, repl = build_week(points, positions, dict(SLOTS))
    out = {}
    for pid, p in proj.items():
        r = repl.get(p["pos"], 0.0)
        shift = win_shift(p["ppg"][k] - r)
        out[pid] = (round(shift * p["games"][k], 3), round(shift * FULL_GP, 3), round(r, 2))
    return out


# ---------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", action="store_true")
    ap.add_argument("--as-of", type=int, default=None, help="last known season")
    ap.add_argument("--out", default=str(HIST / "projections_points.json"))
    ap.add_argument("--no-feats", action="store_true", help="ablation: history only")
    ap.add_argument("--backtest-rookies", action="store_true", help="leave-one-class-out on the rookie arm")
    ap.add_argument("--site", action="store_true",
                    help="rewrite data/<league>/projections.json from this model "
                         "(the scalar's goes to projections_scalar.json)")
    args = ap.parse_args()

    meta = load_meta()
    seasons = load_seasons()
    feats = load_features()
    if args.no_feats:
        feats = {y: {} for y in feats}
    if args.as_of:
        seasons = {y: v for y, v in seasons.items() if y <= args.as_of}
        feats = {y: v for y, v in feats.items() if y <= args.as_of}
    lvl, ref = era(seasons)
    last = max(seasons)
    print(f"seasons {min(seasons)}-{last} · features {min(feats)}-{max(feats)} · era ref {ref:.2f} ppg")

    if args.backtest:
        backtest(seasons, feats, meta, lvl, years=[last - 4, last - 3, last - 2, last - 1])
        return

    corpus = build_corpus(seasons, feats, meta, lvl, last_year=last)
    print(f"corpus {len(corpus)} player-seasons")
    models = fit_models(corpus)
    bands = residual_bands(seasons, feats, meta, lvl, years=[last - 3, last - 2, last - 1])

    # everyone seen in the last three seasons, projected forward from the
    # last: a player who missed all of it (Joe Mixon's 2025) is still a
    # player, and his row has a blank latest season and two real ones
    out = {}
    pids = set()
    for k in range(3):
        pids |= set(seasons.get(last - k, {})) | set(feats.get(last - k, {}))
    for pid in pids:
        bx = build_x(pid, last, seasons, feats, meta, lvl)
        if not bx:
            continue
        pos, x = bx
        pred = predict(models, pos, x)
        lo, hi = bands.get(pos, (0.0, 0.0))
        yrs = [last + k + 1 for k in range(HORIZON)]
        # back to this era's points: the model works in normalized ppg, and
        # the projected seasons are priced at the latest season's level
        e = lvl.get(last, 1.0)
        ppg = [round(p * e, 2) for p, _ in pred]
        games = [round(g, 1) for _, g in pred]
        out[pid] = {
            "name": meta.get(pid, {}).get("name", pid), "pos": pos,
            "years": yrs, "ppg": ppg, "games": games,
            "pts": [round(p * g, 1) for p, g in zip(ppg, games)],
            "ppg_low": [round(max(p + lo * e, 0.0), 2) for p in ppg],
            "ppg_high": [round(p + hi * e, 2) for p in ppg],
        }
    # WAR, derived: one projected pool per horizon year. The bands go through
    # the same curve against the same replacement line, so a ppg band is a
    # WAR band and the page can draw it beside the other arms'.
    repl_by_year = {}
    for k in range(HORIZON):
        w = war_from_points(out, k)
        for pid, (war, war13, r) in w.items():
            p = out[pid]
            p.setdefault("war", []).append(war)
            p.setdefault("war13", []).append(war13)
            p.setdefault("war13_low", []).append(round(win_shift(p["ppg_low"][k] - r) * FULL_GP, 3))
            p.setdefault("war13_high", []).append(round(win_shift(p["ppg_high"][k] - r) * FULL_GP, 3))
        repl_by_year[str(last + k + 1)] = {pos: next((r for pid, (_, _, r) in w.items() if out[pid]["pos"] == pos), None)
                                           for pos in CORE}
    Path(args.out).write_text(json.dumps({"meta": {"as_of": last, "era_ref": round(ref, 2),
                                                    "model": "hgb points-first (ppg, games) per pos/horizon; WAR from the projected pool",
                                                    "sigma": round(SIGMA, 2), "replacement_ppg": repl_by_year},
                                           "players": out}), encoding="utf-8")
    print(f"wrote {len(out)} players → {args.out}")

    # THE ROOKIE ARM: the incoming class (draft season last+1), priced on
    # draft capital alone. Written beside the veterans, flagged, in the same
    # shape, so the site join and the pools treat them as players.
    rk_models = fit_rookie_models(rookie_corpus(seasons, meta, lvl, last_year=last))
    rookies = {}
    e = lvl.get(last, 1.0)
    for pid, m in meta.items():
        if m.get("draft") != last + 1 or m["pos"] not in CORE or pid in out:
            continue
        age = (last + 1 - m["born"]) if m.get("born") else None
        pred = predict(rk_models, m["pos"], rookie_x(m.get("pick"), m.get("round"), age))
        lo, hi = bands.get(m["pos"], (0.0, 0.0))
        ppg = [round(p * e, 2) for p, _ in pred]
        games = [round(g, 1) for _, g in pred]
        rookies[pid] = {
            "name": m["name"], "pos": m["pos"], "rookie": True,
            "years": [last + k + 1 for k in range(HORIZON)], "ppg": ppg, "games": games,
            "pts": [round(p * g, 1) for p, g in zip(ppg, games)],
            "ppg_low": [round(max(p + lo * e, 0.0), 2) for p in ppg],
            "ppg_high": [round(p + hi * e, 2) for p in ppg],
        }
    print(f"rookie arm: {len(rookies)} in the {last + 1} class priced on draft capital")
    if args.backtest_rookies:
        rookie_backtest(seasons, meta, lvl, last)
    out.update(rookies)
    # WAR for the rookies, from the same pools (recomputed with them in it)
    for k in range(HORIZON):
        w = war_from_points(out, k)
        for pid in rookies:
            war, war13, r = w[pid]
            p = out[pid]
            p.setdefault("war", []).append(war); p.setdefault("war13", []).append(war13)
            p.setdefault("war13_low", []).append(round(win_shift(p["ppg_low"][k] - r) * FULL_GP, 3))
            p.setdefault("war13_high", []).append(round(win_shift(p["ppg_high"][k] - r) * FULL_GP, 3))
    rows = write_site(out, last)
    if args.site and rows:
        write_projections(rows, last)


def write_site(out, last):
    """The same rows keyed by Sleeper pid, for the shards. Same join the
    analog arm uses (project_war.build_meta_index / match_meta), so a player
    the site can reach under one arm is reachable under this one."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        from leaguepaths import DataDir
        from project_war import build_meta_index, match_meta
    except ImportError as e:
        print(f"  ! site join skipped: {e}")
        return
    data = DataDir(ROOT / "data")
    try:
        pmin = json.loads((data / "players_min.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"  ! site join skipped: {e}")
        return
    idx = build_meta_index()
    rows = {}
    for pid, v in pmin.items():
        if v[1] not in CORE:
            continue
        m = match_meta(v[0], v[1], idx)
        gsis = m[3] if m else None
        if gsis and gsis in out and pid not in rows:
            rows[pid] = dict(out[gsis], gsis=gsis, name=v[0])
    path = data / "projections_points.json"
    path.write_text(json.dumps({"meta": {"as_of": last, "horizon": HORIZON,
                                          "years": [last + k + 1 for k in range(HORIZON)],
                                          "note": "points first: ppg and games from gradient-boosted trees on "
                                                  "history + nflverse skill features; WAR from the projected pool"},
                                 "players": rows}, separators=(",", ":")), encoding="utf-8")
    print(f"site: {len(rows)} of {len(out)} joined to Sleeper ids → {path}")
    return rows


def write_projections(rows, last):
    """projections.json in the scalar model's schema, from this model.

    Every scalar row is kept as the frame — its `career` line, `age`, `team`,
    `bye`, `pick`, `exp` are the site's metadata and are right whichever model
    prices him. Where this model has a read, the streams are replaced; where
    it does not, the scalar streams stay and the row says so."""
    import datetime
    import shutil
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    from leaguepaths import DataDir
    data = DataDir(ROOT / "data")
    pfile = data / "projections.json"
    if not pfile.exists():
        print("  ! no projections.json to rewrite (run project_war.py first)")
        return
    scalar = json.loads(pfile.read_text(encoding="utf-8"))
    sfile = data / "projections_scalar.json"
    # keep the scalar's own output for the comparison lens — but only from a
    # scalar run, never from a previous rewrite of ours
    if (scalar.get("meta") or {}).get("model", "").startswith("per-13 rate"):
        shutil.copyfile(pfile, sfile)
    elif sfile.exists():
        scalar = json.loads(sfile.read_text(encoding="utf-8"))
    else:
        print("  ! projections.json is not the scalar model's and no projections_scalar.json exists")
        return
    try:
        sproj = json.loads((data / "proj_sleeper.json").read_text(encoding="utf-8"))["players"]
    except (OSError, ValueError, KeyError):
        sproj = {}
    H = HORIZON
    years = [last + k + 1 for k in range(H)]

    # ---- the composite in points space, per player -------------------------
    # Sleeper's line is a full-participation per-13 (pts13 / 13); a positive
    # projection counts, anything else is absent (project_war's rule)
    nat, comp, games, pos_of = {}, {}, {}, {}
    for pid, r in rows.items():
        nat[pid] = list(r["ppg"]); games[pid] = list(r["games"]); pos_of[pid] = r["pos"]
        sp = sproj.get(pid)
        s13 = (sp or {}).get("pts13") or 0
        if s13 > 0:
            s_ppg = s13 / FULL_GP
            comp[pid] = [round(w * (s_ppg + (nat[pid][i] - nat[pid][0])) + (1 - w) * nat[pid][i], 2)
                         for i, w in enumerate(BLEND_W[:H])]
        else:
            comp[pid] = list(nat[pid])

    # ---- WAR from the two pools, one per horizon year ----------------------
    nat_w = [pool_war({p: nat[p][k] for p in rows}, pos_of, {p: games[p][k] for p in rows}) for k in range(H)]
    comp_w = [pool_war({p: comp[p][k] for p in rows}, pos_of, {p: games[p][k] for p in rows}) for k in range(H)]

    out_rows, replaced = [], 0
    for row in scalar["players"]:
        pid = row["pid"]
        r = rows.get(pid)
        if not r or r["pos"] != row["pos"]:
            row = dict(row, src="scalar")
            out_rows.append(row)
            continue
        replaced += 1
        src = "rookie" if r.get("rookie") else "points"
        e = 1.0
        proj = [nat_w[k][pid][0] for k in range(H)]
        expv = [nat_w[k][pid][1] for k in range(H)]
        cmp_ = [comp_w[k][pid][0] for k in range(H)]
        # the band is this model's holdout residual, in WAR, around each stream
        lo = [r["war13_low"][k] - r["war13"][k] for k in range(H)]
        hi = [r["war13_high"][k] - r["war13"][k] for k in range(H)]
        gfrac = [g / FULL_GP for g in games[pid]]
        new = dict(row)
        new.update({
            "src": src,
            "proj": proj,
            "nat_low": [round(proj[k] + lo[k], 3) for k in range(H)],
            "nat_high": [round(proj[k] + hi[k], 3) for k in range(H)],
            "expected": expv,
            "adj_low": [round((proj[k] + lo[k]) * gfrac[k], 3) for k in range(H)],
            "adj_high": [round((proj[k] + hi[k]) * gfrac[k], 3) for k in range(H)],
            "composite": cmp_,
            "comp_low": [round(cmp_[k] + lo[k], 3) for k in range(H)],
            "comp_high": [round(cmp_[k] + hi[k], 3) for k in range(H)],
            # ppg is the composite's year one, in league points — the model's
            # own unit, no pts_to_war inversion
            "ppg": round(comp[pid][0] * e, 2),
            "ppg_nat": [round(v, 2) for v in nat[pid]],
            "ppg_comp": comp[pid],
            "games": games[pid],
            "total": round(sum(proj), 3), "total_exp": round(sum(expv), 3),
            "total_comp": round(sum(cmp_), 3),
        })
        out_rows.append(new)

    # positional finish per year, on the composite, across everyone
    for y in range(H):
        for ps in {r["pos"] for r in out_rows}:
            grp = sorted((r for r in out_rows if r["pos"] == ps),
                         key=lambda r: -(r["composite"][y] if y < len(r["composite"]) else -9))
            for i, r in enumerate(grp):
                r.setdefault("posFin", [0] * H)[y] = i + 1
    out_rows.sort(key=lambda r: r["total"], reverse=True)
    meta = dict(scalar["meta"])
    meta.update({
        "generated": datetime.date.today().isoformat(),
        "model": "points-first: ppg and games from gradient-boosted trees on league history + "
                 "nflverse usage (project_points.py); rookies from draft capital; WAR from the "
                 "projected pool's replacement level; composite = ppg blended with Sleeper in "
                 "points (90/50/10) then priced the same way. Rows src:scalar keep the per-13 "
                 "rate model (unjoined names).",
        "points_players": sum(1 for r in out_rows if r.get("src") == "points"),
        "rookie_players": sum(1 for r in out_rows if r.get("src") == "rookie"),
        "scalar_players": len(out_rows) - replaced,
    })
    pfile.write_text(json.dumps({"meta": meta, "players": out_rows}, separators=(",", ":")),
                     encoding="utf-8")
    print(f"projections.json: {replaced} priced by the points model, "
          f"{len(out_rows) - replaced} kept on the scalar → {pfile}; scalar copy at {sfile.name}")


if __name__ == "__main__":
    main()
