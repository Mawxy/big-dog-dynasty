#!/usr/bin/env python3
"""
nfl_features.py — per-player-season SKILL features from nflverse, for the
WAR projection models.

Why: project_war.py and project_war_knn.py see a career as WAR rates, games,
age and draft slot — outcomes, and nothing about HOW the points happened.
nflverse carries the how, and most of it sits in the same weekly stats table
nfl_history.py already downloads and then throws away after scoring it:

  usage       target share, air-yards share, WOPR — stickier year to year
              than the points they produce, and the best public predictor of
              next year's receiving points
  efficiency  EPA per target / carry / dropback, CPOE, RACR, yards after
              catch per catch, ADOT, first-down and explosive rates —
              what the player did with each opportunity
  opportunity ffopportunity's expected fantasy points (load_ff_opportunity):
              what an average player would have scored from the same
              targets, carries and air yards. Actual minus expected is
              finishing skill plus touchdown luck, and regression toward
              expected is the best-documented effect in fantasy projection.

Every rate is a SEASON rate (season totals divided), not a mean of weekly
rates, so a two-target game does not count as much as a twelve-target one.
The exceptions are target_share / air_yards_share / WOPR, which nflverse only
ships per game; those are the mean over the weeks he had a stat line.
car_share is ours (nflverse has no carry share): his season carries over his
team's carries in the weeks he had a stat line, all positions in the
denominator. rb_touch_share (RBs only) is his carries + receptions over the
carries + receptions of every RB on his team in those same weeks.

AVAILABILITY (Max, 2026-09-11): the history files cannot tell a quarterback
who lost his job from one who tore a ligament — both show five games. The
weekly roster status can: RES / PUP is injured reserve, INA is a game-day
inactive (hurt or a healthy scratch), ACT with no touch is a healthy backup.
So each row carries wk_act / wk_res / wk_ina / wk_hurt (RES+PUP+INA) /
wk_bench (active, never touched the ball). INA is only recorded from 2019;
before that a game-day inactive reads ACT, so wk_ina, wk_hurt and wk_bench
are blank for 2014-2018 rather than wrong, and the trees route the blank.

Whole regular season, not weeks 1-14: these describe the player, not the
league's schedule, and four more games are four more games of evidence.
`gp14` is carried so a caller can still tell which seasons align with the
WAR corpus's window.

Output: <out>/features_<season>.csv, one row per (gsis_id, season), keyed
like nfl_history/waa_war_<season>.csv so the two join on player_id.

A SEASON IS WRITTEN WHOLE OR NOT AT ALL (2026-09-21). Every sub-fetch here —
weekly rosters, ffopportunity, snap counts — used to be caught, printed and
shrugged off, and the CSV was written anyway. The workflow's `[ -s … ]` check
then passed on a file with every `fp_exp` blank, and it was copied over
yesterday's good one: a night when ffopportunity is down silently deletes the
expected-points column for that season. So a failed sub-fetch, or a season
that comes back with no expected points where the committed file had them,
SKIPS THE WRITE and exits non-zero. data-refresh.yml already treats that as a
warning and keeps the committed CSV; war-history.yml fails before its collect
step, which is what a manual rebuild should do. The one exception is a source
that does not reach back to the season being built (`SOURCE_FROM`): snap counts
begin in 2012 and ffopportunity in 2006, and a full 1999-onward rebuild must
not fail on a column that never existed.

Requires: pip install nflreadpy. Run on GitHub Actions (war-history.yml) —
nflverse downloads are blocked in some sandboxes.
"""
import argparse
import csv
import io
import sys
from pathlib import Path

from ioutil import atomic_write

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "nfl_history"

# the stat columns summed over the season, in the order they are written
SUMS = [
    # passing
    "attempts", "completions", "passing_yards", "passing_tds",
    "passing_interceptions", "sacks_suffered", "passing_air_yards",
    "passing_yards_after_catch", "passing_first_downs", "passing_epa",
    "passing_20",
    # rushing
    "carries", "rushing_yards", "rushing_tds", "rushing_first_downs",
    "rushing_epa", "rushing_10", "rushing_fumbles_lost",
    # receiving
    "targets", "receptions", "receiving_yards", "receiving_tds",
    "receiving_air_yards", "receiving_yards_after_catch",
    "receiving_first_downs", "receiving_epa", "receiving_16",
    "receiving_fumbles_lost",
    "fantasy_points_ppr",
]
# per-game shares nflverse ships only weekly — averaged over stat-line weeks
MEANS = ["target_share", "air_yards_share", "wopr"]

# ffopportunity columns summed over the season
OPP_SUMS = [
    "total_fantasy_points_exp", "total_fantasy_points",
    "pass_fantasy_points_exp", "rush_fantasy_points_exp", "rec_fantasy_points_exp",
    "total_touchdown_exp", "total_touchdown",
    "receptions_exp", "rec_yards_gained_exp", "rush_yards_gained_exp",
    "total_fantasy_points_exp_team",
]

CORE = {"QB", "RB", "WR", "TE"}

# The first season each nflverse source covers. A failure for a season BEFORE
# its source begins is that source saying "I don't have that year", not a lost
# download — war-history.yml rebuilds 1999 onward (the pre-2012 years land in
# nfl_history/early/), and treating those as data loss would fail every full
# rebuild on a column that never existed.
SOURCE_FROM = {
    "snap counts": 2012,            # PFR snap counts, per WEEKLY_COLS below
    "ff_opportunity": 2006,         # nflverse ffopportunity
    "ff_opportunity weekly": 2006,
    "weekly rosters": 2002,
}


def lost_data(season, fails):
    """The subset of `fails` that means a source this season SHOULD have
    answered did not. `fails` is [(source, why)]."""
    return [f"{src} ({why})" for src, why in fails
            if season >= SOURCE_FROM.get(src, 0)]


def safe_div(a, b, nd=4):
    return round(a / b, nd) if b else ""


def load_reg_stats(season, nfl):
    """The weekly player-stats table for one season's regular season.

    Loaded ONCE per season and handed to both feature builders. They each used
    to call load_player_stats themselves, which downloaded and parsed the same
    table twice per year — the single heaviest thing this script does."""
    import polars as pl
    stats = nfl.load_player_stats([season], summary_level="week")
    return stats.filter(pl.col("season_type") == "REG")


def write_csv(path, fieldnames, rows):
    """A features CSV, written atomically.

    The old path truncated first, so a cancelled run left a half-written CSV
    exactly where a committed one belongs — and the workflow's `[ -s … ]`
    check, which asks whether the file is non-empty rather than whether it
    parses, would have copied it."""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows)
    atomic_write(path, buf.getvalue(), newline="")


def prior_has_opportunity(season, *dirs):
    """Did a previously written features CSV for this season carry expected
    points? The committed file is the only record of what the column SHOULD
    look like, and losing it silently is the failure this guards."""
    for d in dirs:
        p = Path(d) / f"features_{season}.csv"
        if not p.exists():
            continue
        try:
            with open(p, encoding="utf-8") as f:
                rd = csv.DictReader(f)
                if "fp_exp" not in (rd.fieldnames or []):
                    continue
                if any((r.get("fp_exp") or "") != "" for r in rd):
                    return True
        except OSError:
            continue
    return False


def season_features(season, nfl, stats, fails):
    """One row per QB/RB/WR/TE with a regular-season stat line.

    `fails` collects the name of any sub-fetch that did not answer; main()
    refuses to write the season when it is non-empty."""
    import polars as pl
    reg_last = int(stats["week"].max()) if stats.height else 18
    # team carries per game, from EVERY player on the roster (fullbacks and
    # gadget WRs included) BEFORE the position filter — the denominator for
    # car_share, which nflverse does not ship the way it ships target_share
    team_car = (stats.group_by(["team", "week"])
                .agg(pl.col("carries").fill_null(0).sum().alias("_team_car")))
    stats = stats.join(team_car, on=["team", "week"], how="left")
    # RB touches per game: carries + receptions by the team's running backs
    # (position == RB; fullbacks are not RBs here) — denominator for
    # rb_touch_share, which is only meaningful for a running back
    rb_touch = (stats.filter(pl.col("position") == "RB")
                .group_by(["team", "week"])
                .agg((pl.col("carries").fill_null(0) + pl.col("receptions").fill_null(0))
                     .sum().alias("_team_rb_touch")))
    stats = stats.join(rb_touch, on=["team", "week"], how="left")
    stats = stats.filter(pl.col("position").is_in(list(CORE)))

    have = set(stats.columns)
    sums = [c for c in SUMS if c in have]
    means = [c for c in MEANS if c in have]
    # a stat line is a week he touched the ball or threw it; a row with no
    # opportunity is a dressed player, not a game of evidence
    touched = (pl.col("attempts").fill_null(0) + pl.col("carries").fill_null(0)
               + pl.col("targets").fill_null(0)) > 0
    stats = stats.with_columns(touched.alias("_touched"))

    agg = (stats.group_by("player_id")
           .agg([pl.col("player_display_name").last().alias("name"),
                 pl.col("position").last().alias("pos"),
                 pl.col("team").mode().first().alias("team"),
                 pl.col("_touched").sum().alias("games"),
                 (pl.col("_touched") & (pl.col("week") <= 14)).sum().alias("gp14"),
                 # attempt-weighted CPOE — a weekly mean would let a
                 # three-throw game count as much as a forty-throw one
                 ((pl.col("passing_cpoe") * pl.col("attempts")).sum()
                  / pl.col("attempts").sum()).alias("cpoe")
                 if "passing_cpoe" in have else pl.lit(None).alias("cpoe"),
                 # season carry share: his carries over his team's carries in
                 # the weeks he had a stat line (a season rate, unlike the
                 # weekly-mean tgt_share, because we own the denominator)
                 (pl.col("carries").fill_null(0).filter(pl.col("_touched")).sum()
                  / pl.col("_team_car").filter(pl.col("_touched")).sum()).alias("car_share"),
                 # RB touch share: his carries + receptions over his team's
                 # RB-room carries + receptions in the weeks he had a stat line
                 ((pl.col("carries").fill_null(0) + pl.col("receptions").fill_null(0))
                  .filter(pl.col("_touched")).sum()
                  / pl.col("_team_rb_touch").fill_null(0).filter(pl.col("_touched")).sum()
                  ).alias("rb_touch_share"),
                 *[pl.col(c).sum().alias(c) for c in sums],
                 *[pl.col(c).filter(pl.col("_touched")).mean().alias(c) for c in means]]))

    # ---- availability: weekly roster status, regular season ---------------
    status = {}          # pid -> {"act": n, "res": n, "ina": n}
    has_ina = season >= 2019
    try:
        ro = nfl.load_rosters_weekly([season])
        if "game_type" in ro.columns:
            ro = ro.filter(pl.col("game_type") == "REG")
        ro = ro.filter(pl.col("week") <= reg_last)
        for r in ro.select(["gsis_id", "week", "status"]).to_dicts():
            g = r.get("gsis_id")
            if not g:
                continue
            d = status.setdefault(g, {"act": 0, "res": 0, "ina": 0, "weeks": set()})
            if r["week"] in d["weeks"]:
                continue                                      # one row per week
            d["weeks"].add(r["week"])
            st = r.get("status") or ""
            if st == "ACT":
                d["act"] += 1
            elif st in ("RES", "PUP"):
                d["res"] += 1
            elif st == "INA":
                d["ina"] += 1
    except Exception as e:                                  # noqa: BLE001
        print(f"  ! weekly rosters unavailable for {season}: {e}")
        fails.append(("weekly rosters", str(e)))

    # ---- expected points: ffopportunity, regular season only ---------------
    opp = {}
    try:
        o = nfl.load_ff_opportunity([season], stat_type="weekly")
        o = o.filter(pl.col("week") <= reg_last)
        ocols = [c for c in OPP_SUMS if c in o.columns]
        oa = o.group_by("player_id").agg([pl.col(c).sum().alias(c) for c in ocols])
        for r in oa.to_dicts():
            opp[r["player_id"]] = r
    except Exception as e:                                  # noqa: BLE001
        print(f"  ! ff_opportunity unavailable for {season}: {e}")
        fails.append(("ff_opportunity", str(e)))

    rows = []
    for r in agg.to_dicts():
        pid = r["player_id"]
        if not pid or not r["games"]:
            continue
        v = lambda k: (r.get(k) or 0.0)                     # noqa: E731
        o = opp.get(pid, {})
        ov = lambda k: (o.get(k) or 0.0)                    # noqa: E731
        att, car, tgt, rec = v("attempts"), v("carries"), v("targets"), v("receptions")
        db = att + v("sacks_suffered")
        row = {
            "player_id": pid, "name": r["name"], "pos": r["pos"], "team": r["team"],
            "season": season, "games": r["games"], "gp14": r["gp14"],
            # ---- usage ----
            "att_pg": safe_div(att, r["games"], 2),
            "car_pg": safe_div(car, r["games"], 2),
            # NaN when his team never ran — polars' 0/0 — and NaN is not a figure
            "car_share": round(r["car_share"], 4) if r.get("car_share") is not None and r["car_share"] == r["car_share"] else "",
            # running backs only — a QB's share of the RB room is not a figure
            "rb_touch_share": (round(r["rb_touch_share"], 4)
                               if r["pos"] == "RB" and r.get("rb_touch_share") is not None
                               and r["rb_touch_share"] == r["rb_touch_share"] else ""),
            "tgt_pg": safe_div(tgt, r["games"], 2),
            "tgt_share": round(r["target_share"], 4) if r.get("target_share") is not None else "",
            "ay_share": round(r["air_yards_share"], 4) if r.get("air_yards_share") is not None else "",
            "wopr": round(r["wopr"], 4) if r.get("wopr") is not None else "",
            # ---- passing efficiency ----
            "att": int(att), "cmp_pct": safe_div(v("completions"), att),
            "ypa": safe_div(v("passing_yards"), att, 2),
            "pass_td_rate": safe_div(v("passing_tds"), att),
            "int_rate": safe_div(v("passing_interceptions"), att),
            "sack_rate": safe_div(v("sacks_suffered"), db),
            "epa_db": safe_div(v("passing_epa"), db),
            # NaN when he never threw — polars' 0/0 — and NaN is not a figure
            "cpoe": round(r["cpoe"], 3) if r.get("cpoe") is not None and r["cpoe"] == r["cpoe"] else "",
            "pacr": safe_div(v("passing_yards"), v("passing_air_yards"), 3),
            "pass_fd_rate": safe_div(v("passing_first_downs"), att),
            "pass_expl_rate": safe_div(v("passing_20"), att),
            # ---- rushing efficiency ----
            "car": int(car), "ypc": safe_div(v("rushing_yards"), car, 2),
            "rush_td_rate": safe_div(v("rushing_tds"), car),
            "epa_car": safe_div(v("rushing_epa"), car),
            "rush_fd_rate": safe_div(v("rushing_first_downs"), car),
            "rush_expl_rate": safe_div(v("rushing_10"), car),
            # ---- receiving efficiency ----
            "tgt": int(tgt), "rec": int(rec),
            "catch_rate": safe_div(rec, tgt),
            "ypt": safe_div(v("receiving_yards"), tgt, 2),
            "ypr": safe_div(v("receiving_yards"), rec, 2),
            "adot": safe_div(v("receiving_air_yards"), tgt, 2),
            "racr": safe_div(v("receiving_yards"), v("receiving_air_yards"), 3),
            "yac_rec": safe_div(v("receiving_yards_after_catch"), rec, 2),
            "epa_tgt": safe_div(v("receiving_epa"), tgt),
            "rec_td_rate": safe_div(v("receiving_tds"), tgt),
            "rec_fd_rate": safe_div(v("receiving_first_downs"), tgt),
            "rec_expl_rate": safe_div(v("receiving_16"), tgt),
            "fum_lost": int(v("rushing_fumbles_lost") + v("receiving_fumbles_lost")),
            # ---- availability ----
            "wk_act": status[pid]["act"] if pid in status else "",
            "wk_res": status[pid]["res"] if pid in status else "",
            "wk_ina": status[pid]["ina"] if pid in status and has_ina else "",
            "wk_hurt": (status[pid]["res"] + status[pid]["ina"]) if pid in status and has_ina else "",
            # dressed and never touched the ball: a healthy backup's week
            "wk_bench": max(status[pid]["act"] - r["games"], 0) if pid in status and has_ina else "",
            "fp_ppr": round(v("fantasy_points_ppr"), 1),
            # ---- opportunity (ffopportunity) ----
            "fp_exp": round(ov("total_fantasy_points_exp"), 1) if o else "",
            "fp_act": round(ov("total_fantasy_points"), 1) if o else "",
            "fp_diff": round(ov("total_fantasy_points") - ov("total_fantasy_points_exp"), 1) if o else "",
            "fp_exp_pg": safe_div(ov("total_fantasy_points_exp"), r["games"], 2) if o else "",
            # what share of his team's expected points ran through him
            "exp_share": safe_div(ov("total_fantasy_points_exp"),
                                  ov("total_fantasy_points_exp_team"), 4) if o else "",
            "pass_fp_exp": round(ov("pass_fantasy_points_exp"), 1) if o else "",
            "rush_fp_exp": round(ov("rush_fantasy_points_exp"), 1) if o else "",
            "rec_fp_exp": round(ov("rec_fantasy_points_exp"), 1) if o else "",
            "td_exp": round(ov("total_touchdown_exp"), 2) if o else "",
            "td_act": round(ov("total_touchdown"), 1) if o else "",
            "td_diff": round(ov("total_touchdown") - ov("total_touchdown_exp"), 2) if o else "",
        }
        rows.append(row)
    rows.sort(key=lambda x: (x["pos"], -x["fp_ppr"]))
    return rows


# ---- the weekly table (Max, 2026-09-16) ------------------------------------
# The season file above pools weeks 1-18, which is right for the projection
# models and wrong beside a league PPG that stops at week 14: a receiver whose
# only catches came in weeks 15-18 read 0.00 PPG next to a +5 "vs expected".
# The site wants the SAME figures over the league's windows — regular season,
# playoffs, both — and those windows are the league's, not nflverse's, so this
# writes the per-player-week inputs and lets scripts/usage_stats.py sum them
# over whatever weeks the league says. Touched weeks only: a dressed week with
# no attempt, carry or target adds nothing to any figure here.
WEEKLY_COLS = [
    "player_id", "name", "pos", "team", "season", "week",
    "att", "cmp", "pass_epa", "sacks", "cpoe",
    "car", "tgt", "rec", "rec_ay", "tgt_share", "ay_share",
    "team_car", "team_rb_touch", "fp_ppr", "fp_exp", "fp_act",
    # SNAP SHARE (Max, 2026-09-17): his offensive snaps and his team's that
    # week, from nflverse snap counts (Pro Football Reference, 2012 on), so
    # usage_stats.py can sum both over a window and divide once. Blank when
    # the snap table has no line for him; never 0.
    "snaps", "team_snaps",
]


def pfr_crosswalk(nfl):
    """PFR player id -> gsis id, for the whole run.

    nflverse keys snap counts by PFR id, not gsis, and the players table is the
    only bridge. It is not season-scoped, so loading it inside the per-season
    snap table meant downloading the same dictionary once a year for no reason.
    Cached on the function so a caller doesn't have to thread it through."""
    if not hasattr(pfr_crosswalk, "_cache"):
        players = nfl.load_players().select(["gsis_id", "pfr_id"]).drop_nulls()
        pfr_crosswalk._cache = {r["pfr_id"]: r["gsis_id"] for r in players.to_dicts()}
    return pfr_crosswalk._cache


def snap_table(season, nfl, fails):
    """(gsis_id, week) -> (offense snaps, team offense snaps), regular season.

    A player the crosswalk cannot place is simply absent — the weekly row then
    has no snap figure, which reads as the em dash on the site rather than as a
    0% share he never had."""
    import polars as pl
    out = {}
    try:
        sc = nfl.load_snap_counts([season])
        if "game_type" in sc.columns:
            sc = sc.filter(pl.col("game_type") == "REG")
        pfr_to_gsis = pfr_crosswalk(nfl)
        for r in sc.select(["pfr_player_id", "week", "offense_snaps", "offense_pct"]).to_dicts():
            g = pfr_to_gsis.get(r["pfr_player_id"])
            snaps, pct = r.get("offense_snaps"), r.get("offense_pct")
            if not g or snaps is None or not pct:
                continue
            # the team's snaps are not shipped; the share is, so back them out
            out[(g, int(r["week"]))] = (int(snaps), int(round(snaps / pct)))
    except Exception as e:                                  # noqa: BLE001
        print(f"  ! snap counts unavailable for {season}: {e}")
        fails.append(("snap counts", str(e)))
    return out


def weekly_features(season, nfl, stats, fails):
    """One row per QB/RB/WR/TE per regular-season week he touched the ball."""
    import polars as pl
    reg_last = int(stats["week"].max()) if stats.height else 18
    team_car = (stats.group_by(["team", "week"])
                .agg(pl.col("carries").fill_null(0).sum().alias("_team_car")))
    stats = stats.join(team_car, on=["team", "week"], how="left")
    rb_touch = (stats.filter(pl.col("position") == "RB")
                .group_by(["team", "week"])
                .agg((pl.col("carries").fill_null(0) + pl.col("receptions").fill_null(0))
                     .sum().alias("_team_rb_touch")))
    stats = stats.join(rb_touch, on=["team", "week"], how="left")
    stats = stats.filter(pl.col("position").is_in(list(CORE)))
    touched = (pl.col("attempts").fill_null(0) + pl.col("carries").fill_null(0)
               + pl.col("targets").fill_null(0)) > 0
    stats = stats.filter(touched)

    opp = {}
    try:
        o = nfl.load_ff_opportunity([season], stat_type="weekly")
        o = o.filter(pl.col("week") <= reg_last)
        for r in o.select(["player_id", "week", "total_fantasy_points_exp",
                           "total_fantasy_points"]).to_dicts():
            opp[(r["player_id"], r["week"])] = r
    except Exception as e:                                  # noqa: BLE001
        print(f"  ! ff_opportunity unavailable for {season} (weekly): {e}")
        fails.append(("ff_opportunity weekly", str(e)))

    snaps = snap_table(season, nfl, fails)

    have = set(stats.columns)
    def g(r, k):
        v = r.get(k) if k in have else None
        return v if v is not None and v == v else None
    rows = []
    for r in stats.to_dicts():
        pid = r["player_id"]
        if not pid:
            continue
        o = opp.get((pid, r["week"]))
        sn = snaps.get((pid, int(r["week"])))
        rows.append({
            "player_id": pid, "name": r["player_display_name"], "pos": r["position"],
            "team": r["team"], "season": season, "week": r["week"],
            "att": int(g(r, "attempts") or 0), "cmp": int(g(r, "completions") or 0),
            "pass_epa": round(g(r, "passing_epa") or 0.0, 3),
            "sacks": int(g(r, "sacks_suffered") or 0),
            "cpoe": "" if g(r, "passing_cpoe") is None else round(g(r, "passing_cpoe"), 3),
            "car": int(g(r, "carries") or 0), "tgt": int(g(r, "targets") or 0),
            "rec": int(g(r, "receptions") or 0),
            "rec_ay": round(g(r, "receiving_air_yards") or 0.0, 1),
            "tgt_share": "" if g(r, "target_share") is None else round(g(r, "target_share"), 4),
            "ay_share": "" if g(r, "air_yards_share") is None else round(g(r, "air_yards_share"), 4),
            "team_car": int(r.get("_team_car") or 0),
            "team_rb_touch": int(r.get("_team_rb_touch") or 0),
            "fp_ppr": round(g(r, "fantasy_points_ppr") or 0.0, 1),
            "fp_exp": round(o["total_fantasy_points_exp"] or 0.0, 2) if o else "",
            "fp_act": round(o["total_fantasy_points"] or 0.0, 2) if o else "",
            "snaps": sn[0] if sn else "", "team_snaps": sn[1] if sn else "",
        })
    rows.sort(key=lambda x: (x["player_id"], x["week"]))
    return rows


def main():
    ap = argparse.ArgumentParser(description="nflverse -> per-season skill features")
    ap.add_argument("--start", type=int, default=2014)
    ap.add_argument("--end", type=int, default=2025)
    ap.add_argument("--out", default="nfl_history_data/features")
    args = ap.parse_args()

    import nflreadpy as nfl
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bad = []
    for season in range(args.start, args.end + 1):
        print(f"season {season}…")
        # every sub-fetch that fails names itself here; nothing is written for
        # a season that collected one (see the note at the top of the file)
        fails = []
        stats = load_reg_stats(season, nfl)
        rows = season_features(season, nfl, stats, fails)
        if not rows:
            print("  ! no rows")
            bad.append(f"{season}: no rows")
            continue
        wrows = weekly_features(season, nfl, stats, fails)
        with_opp = sum(1 for r in rows if r["fp_exp"] != "")
        lost = lost_data(season, fails)
        if lost:
            print(f"  ! NOT WRITING {season}: {'; '.join(lost)} — the committed "
                  "CSV is better than one missing those columns")
            bad.append(f"{season}: {'; '.join(lost)}")
            continue
        # ffopportunity can answer with an empty frame rather than raise. A
        # season that HAD expected points and now has none is the same loss by
        # a quieter route, so it is refused the same way.
        if with_opp == 0 and prior_has_opportunity(season, out, HIST):
            print(f"  ! NOT WRITING {season}: 0 rows with expected points, but "
                  "the existing CSV has them — ffopportunity returned nothing")
            bad.append(f"{season}: expected points vanished")
            continue
        path = out / f"features_{season}.csv"
        write_csv(path, list(rows[0].keys()), rows)
        print(f"  {len(rows)} player-seasons · {with_opp} with expected points → {path}")
        wpath = out / f"features_weekly_{season}.csv"
        write_csv(wpath, WEEKLY_COLS, wrows)
        print(f"  {len(wrows)} player-weeks → {wpath}")
    if bad:
        print(f"FAILED for {len(bad)} season(s): {'; '.join(bad)}")
        return 1
    print(f"done → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
