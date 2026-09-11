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

Whole regular season, not weeks 1-14: these describe the player, not the
league's schedule, and four more games are four more games of evidence.
`gp14` is carried so a caller can still tell which seasons align with the
WAR corpus's window.

Output: <out>/features_<season>.csv, one row per (gsis_id, season), keyed
like nfl_history/waa_war_<season>.csv so the two join on player_id.

Requires: pip install nflreadpy. Run on GitHub Actions (war-history.yml) —
nflverse downloads are blocked in some sandboxes.
"""
import argparse
import csv
from pathlib import Path

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


def safe_div(a, b, nd=4):
    return round(a / b, nd) if b else ""


def season_features(season, nfl):
    """One row per QB/RB/WR/TE with a regular-season stat line."""
    import polars as pl
    stats = nfl.load_player_stats([season], summary_level="week")
    stats = stats.filter(pl.col("season_type") == "REG")
    reg_last = int(stats["week"].max()) if stats.height else 18
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
                 *[pl.col(c).sum().alias(c) for c in sums],
                 *[pl.col(c).filter(pl.col("_touched")).mean().alias(c) for c in means]]))

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


def main():
    ap = argparse.ArgumentParser(description="nflverse -> per-season skill features")
    ap.add_argument("--start", type=int, default=2014)
    ap.add_argument("--end", type=int, default=2025)
    ap.add_argument("--out", default="nfl_history_data/features")
    args = ap.parse_args()

    import nflreadpy as nfl
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for season in range(args.start, args.end + 1):
        print(f"season {season}…")
        rows = season_features(season, nfl)
        if not rows:
            print("  ! no rows")
            continue
        path = out / f"features_{season}.csv"
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        with_opp = sum(1 for r in rows if r["fp_exp"] != "")
        print(f"  {len(rows)} player-seasons · {with_opp} with expected points → {path}")
    print(f"done → {out}")


if __name__ == "__main__":
    main()
