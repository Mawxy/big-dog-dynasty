#!/usr/bin/env python3
"""
nfl_history.py — shape nflverse data (2014+) into a sleeper_pull.py-style
dump so sleeper_war.py runs UNCHANGED on historical NFL seasons.

Why: aging curves and pick-value bridges (WAR valuation model) need more
seasons of WAR than the league's own 2022+ history. This adapter imposes the
league's exact shape on raw NFL data:

  * league scoring recomputed weekly from raw components (PPR + 0.5 TE
    premium, superflex) — scoring dict pulled from the live league and frozen
    below;
  * the settled 2026-08-07 played rule, position-INDEPENDENT: dressed =
    played, and a dressed 0.00 accrues negative value. Weekly roster status
    supplies "dressed" where snaps and stats are both absent, which is what
    lets a QB2 who never entered be scored rather than skipped. Replaces the
    2026-07-17 QB carve-out; see row_played_hist for why.
  * the league's startable-pool shape (12 QB / 24 RB / 36 WR / 12 TE + 12 SF
    + 12 FLEX weekly, greedy by points — reuses sleeper_war.build_week);
  * 12 synthetic team scores per week for the sigma step: the 108 startable
    slots are dealt into 12 legal lineups (slot-wise, seeded shuffle, so runs
    are reproducible), then the 12 scores are rescaled around their weekly
    mean so their sample stdev hits SIGMA_COEF * mean. The raw slot-wise
    deal makes 12 near-equal rosters whose scores cluster far tighter than a
    real league's (measured 2026-07-17: historical WAR ran 1.4-1.55x the
    real league's for identical player-seasons), so sigma is calibrated to
    the real league: SIGMA_COEF fitted so matched player-season WAR ratios
    (league/hist, 2022-2025) center on 1.0 per season. Notes from the fit:
    real CV (sigma/mean of the 12 weekly team scores) was 0.195/0.217/
    0.208/0.242 over 2022-2025 (sample stdev, weeks 1-14, pooled 0.216),
    uncorrelated with weekly scoring level (R^2 = 0.02); real team means run
    ~0.79 of the optimal-pool synthetic mean; residual season ratios
    (~0.90-1.10) reflect the league's own CV drift — accepted, one constant
    across all eras keeps seasons comparable. Player points are untouched —
    only team `points` (the engine's sigma input) is rescaled, so team
    points no longer equal the sum of players_points (true in the real
    league too, where `points` covers starters only).

Weeks 1-14 only (the league's regular season), season_type REG.

Output layout (mirrors sleeper_pull.py):
  <out>/players.json                      gsis_id -> {position, first/last name}
  <out>/players_meta.csv                  + common name, birth_date, draft slot
  <out>/<season>/league.json              synthetic league shell
  <out>/<season>/matchups/week_NN.json    12 teams: points + players_points
  <out>/<season>/played/week_NN.json      pid -> NFL team (settled played rule)
  <out>/<season>/status/week_NN.json      pid -> {st, tm, snaps, played} for
                                          EVERY rostered QB/RB/WR/TE, played or
                                          not. Not read by the WAR path — it
                                          exists so "active, zero snaps" stops
                                          being indistinguishable from "not in
                                          the NFL". See pull_season.

Then:  python scripts/sleeper_war.py --data <out>

Requires: pip install nflreadpy   (Python port of nflreadr; no R needed)
Run on GitHub Actions (war-history.yml) — nflverse downloads are blocked in
some sandboxes.
"""
import argparse, csv, json, random, statistics, sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sleeper_war import (  # reuse the engine's pool logic
    build_week, slot_counts, FLEX_SLOTS, FLEX_ORDER,
)

# ---------------------------------------------------------------- scoring ---
# Frozen from the live league (league_id 1312221243742621696, fetched
# 2026-07-17). Offensive components only — no K/DEF in the WAR pool.
# Not implementable from nflverse and skipped (all rare/small):
#   pass_int_td (-2 extra for pick-six thrown), fum_rec_td.
SCORING = {
    "pass_yd": 0.04, "pass_td": 4.0, "pass_int": -2.0, "pass_2pt": 2.0,
    "rush_yd": 0.1, "rush_td": 6.0, "rush_2pt": 2.0,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0, "rec_2pt": 2.0,
    "bonus_rec_te": 0.5,            # TE premium, per reception
    "fum": -1.0, "fum_lost": -1.0,  # fum = any fumble; fum_lost stacks on top
    "st_td": 6.0,                   # kick/punt-return TDs credit the player
}
ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "SUPER_FLEX"]
CORE = {"QB", "RB", "WR", "TE"}

# ---------------------------------------------------------------------------
# Position is CURRENT-STATE and applied to every season.
#
# nflverse's players table carries one position per player — whatever he is
# listed as now — and this file used it for all seasons. The consequence is
# invisible in the output (no player in the corpus ever changes position) but
# real in two places: score_row() applies the TE premium off `pos`, and
# assign_slots()/the replacement baseline rank a player inside that position's
# pool. A player who changed eligibility is therefore scored and pooled under
# his LAST role for his whole career.
#
# Measured blast radius: 9 of 914 players disagree between nflverse and Sleeper
# (1.0%), and only one of those ever cleared 0.5 WAR. The temporal problem is
# rarer still. Removing the one contaminating case below moves TE6 by -0.015
# and TE12 by -0.009 across 2012-2025, and moves TE1/TE3 not at all — so this
# is a correctness fix, not a numbers fix.
#
# Overrides are (gsis_id -> [(first_season, last_season, position), ...]),
# earliest first; a season outside every range falls back to nflverse. Pinning
# a player whose sources already agree is deliberate: it stops a future
# nflverse reclassification from silently rewriting his history.
POS_OVERRIDE = {
    # WR for Philadelphia through 2016 — his only productive years, and the
    # ones that put him in TE tables he never belonged in. Listed TE later,
    # which is where nflverse and Sleeper both leave him.
    "00-0031299": [(2012, 2016, "WR")],                  # Jordan Matthews
    # Fantasy-eligible TE for his whole career whatever he lines up as, which
    # is the eligibility the league actually scores. Pinned, not changed.
    "00-0033357": [(2012, 2100, "TE")],                  # Taysom Hill
    # Converted QB; the 2014 QB season is noise and everything that matters is
    # at tight end. Pinned.
    "00-0031280": [(2012, 2100, "TE")],                  # Logan Thomas
    # NOT overridden, deliberately: Cordarrelle Patterson and Ty Montgomery
    # were genuinely startable at two positions for years, so neither label is
    # wrong and picking one would assert a precision the data doesn't have.
}


def pos_for(players_pos, pid, season):
    """Position for one player in ONE season, overrides first."""
    for lo, hi, pos in POS_OVERRIDE.get(pid, ()):
        if lo <= season <= hi:
            return pos
    return players_pos.get(pid)
N_TEAMS = 12
LAST_WEEK = 14          # league regular season = weeks 1-14 (playoffs wk 15+)
SIGMA_COEF = 0.160      # weekly sigma = SIGMA_COEF * mean synthetic team score.
                        # Fitted (2026-07-17) so matched player-season WAR
                        # ratios (league/hist, 2022-2025) center on 1.0.
                        # Decomposition: real-league CV of team scores = 0.216
                        # (pooled sample stdev / mean, weeks 1-14) x real teams
                        # scoring ~0.79 of the optimal-pool synthetic mean,
                        # plus Phi-nonlinearity + pool-composition residuals —
                        # the fit bundles all three. See module docstring.


def g(row, *names, default=0.0):
    """First present, non-None field among alternate nflverse column names
    (the 2024 nflverse stats rebuild renamed several columns)."""
    for n in names:
        v = row.get(n)
        if v is not None:
            return v
    return default


def score_row(row, pos):
    """League fantasy points from a raw nflverse weekly-stats row."""
    fum = (g(row, "rushing_fumbles") + g(row, "receiving_fumbles")
           + g(row, "sack_fumbles"))
    fum_lost = (g(row, "rushing_fumbles_lost") + g(row, "receiving_fumbles_lost")
                + g(row, "sack_fumbles_lost"))
    rec = g(row, "receptions")
    pts = (
        SCORING["pass_yd"] * g(row, "passing_yards")
        + SCORING["pass_td"] * g(row, "passing_tds")
        + SCORING["pass_int"] * g(row, "passing_interceptions", "interceptions")
        + SCORING["pass_2pt"] * g(row, "passing_2pt_conversions")
        + SCORING["rush_yd"] * g(row, "rushing_yards")
        + SCORING["rush_td"] * g(row, "rushing_tds")
        + SCORING["rush_2pt"] * g(row, "rushing_2pt_conversions")
        + SCORING["rec"] * rec
        + SCORING["rec_yd"] * g(row, "receiving_yards")
        + SCORING["rec_td"] * g(row, "receiving_tds")
        + SCORING["rec_2pt"] * g(row, "receiving_2pt_conversions")
        + SCORING["fum"] * fum
        + SCORING["fum_lost"] * fum_lost
        + SCORING["st_td"] * g(row, "special_teams_tds")
    )
    if pos == "TE":
        pts += SCORING["bonus_rec_te"] * rec
    return round(pts, 2)


def has_off_stats(row):
    """Any offensive box-score involvement (the stat-line side of the rule)."""
    return any(g(row, k) for k in (
        "attempts", "completions", "passing_yards", "carries", "rushing_att",
        "rushing_yards", "targets", "receptions", "receiving_yards",
        "sacks_suffered", "sacks", "passing_2pt_conversions",
        "rushing_2pt_conversions", "receiving_2pt_conversions"))


def row_played_hist(pos, off_snp, def_snp, st_snp, stat_row, active=False):
    """Played rule on nflverse inputs, settled 2026-08-07: dressed = played for
    every position, and a dressed 0.00 accrues negative value. Mirrors
    sleeper_pull.row_played.

    `active` is the piece nflverse could not supply until weekly rosters were
    pulled: True when the player carried an ACT status that week. It closes the
    two gaps the old rule left open —

      * a dressed QB who never took a snap read as DNP and kept a rate he had
        not earned. He is now a played 0.00, which is the point of the change;
      * a dressed RB/WR/TE with zero snaps in every phase was DNP here and a
        played 0.00 on the league side, because nflverse has no counterpart to
        Sleeper's tm_*_snp. ACT status is that counterpart.

    Hurt and inactive still accrue nothing: INA, RES, PUP and practice-squad
    statuses are not ACT, so they never reach the last branch."""
    if bool(off_snp or def_snp or st_snp):
        return True
    if stat_row is not None and has_off_stats(stat_row):
        return True
    return bool(active)


# ------------------------------------------------------- team synthesis -----
def assign_slots(points, positions, slots):
    """Mirror build_week's greedy fill but keep WHICH slot each startable
    player took, so lineups can be dealt to synthetic teams."""
    pool = sorted(points, key=lambda p: -points[p])
    open_slots = dict(slots)
    groups = defaultdict(list)      # slot label -> [pid] (points-sorted)
    leftovers = []
    for pid in pool:
        pos = positions[pid]
        if open_slots.get(pos, 0) > 0:
            open_slots[pos] -= 1
            groups[pos].append(pid)
        else:
            leftovers.append(pid)
    rest = []
    for pid in leftovers:
        pos = positions[pid]
        for slot in FLEX_ORDER:                   # narrowest slot this player fits
            if pos in FLEX_SLOTS[slot] and open_slots.get(slot, 0) > 0:
                open_slots[slot] -= 1
                groups[slot].append(pid)
                break
        else:
            rest.append(pid)
    return groups, rest


def calibrate_scores(scores, cv=SIGMA_COEF):
    """Rescale the 12 team scores around their mean so their sample stdev
    equals cv * mean (calibrated to the real league — see SIGMA_COEF).
    Preserves the mean and each team's relative position; only the spread
    changes."""
    m = statistics.mean(scores)
    s = statistics.stdev(scores)
    if s <= 0 or m <= 0:
        return scores
    f = (cv * m) / s
    return [round(m + (x - m) * f, 2) for x in scores]


def synth_teams(points, positions, slots, seed):
    """Deal the startable slots into 12 legal lineups (seeded, reproducible)
    and spread the rest of the player universe across teams. Team 'points'
    drive the engine's weekly sigma and are calibrated to the real league's
    spread (calibrate_scores); players_points carry the full pool so
    replacement baselines see every played player."""
    groups, rest = assign_slots(points, positions, slots)
    rng = random.Random(seed)
    team_players = [[] for _ in range(N_TEAMS)]
    for slot, pids in sorted(groups.items()):
        pids = pids[:]
        rng.shuffle(pids)
        for i, pid in enumerate(pids):
            team_players[i % N_TEAMS].append(pid)
    raw = [sum(points[p] for p in pids) for pids in team_players]
    cal = calibrate_scores(raw)
    teams = []
    for i, pids in enumerate(team_players):
        teams.append({
            "roster_id": i + 1,
            "points": cal[i],
            "players_points": {p: points[p] for p in pids},
        })
    for j, pid in enumerate(rest):   # non-startable universe, round-robin
        teams[j % N_TEAMS]["players_points"][pid] = points[pid]
    return teams


# ------------------------------------------------------------ data pull -----
def pull_season(season, players_pos, pfr_to_gsis, nfl):
    """Return (points, positions, played, status) per week for one season.

    Status exists because absence used to mean three different things and the
    corpus recorded all of them the same way — as nothing at all:

      on a roster, active, never took a snap   a real backup, and under the
                                               2026-08-07 rule a played 0.00
      inactive / IR                            hurt; METHODOLOGY.md says skip
                                               these, not zero them
      not on an NFL roster                     a genuine 0.0

    The QB case is why this matters. The old rule admitted a QB only on
    offensive snaps or an offensive stat line, so the QB2 who dresses
    seventeen times and never enters was invisible. The module header used to
    call that gap "negligible" — true for RB/WR/TE, false for the position the
    narrow rule applied to.
    """
    import polars as pl
    stats = nfl.load_player_stats([season], summary_level="week")
    stats = stats.filter(pl.col("season_type") == "REG").to_dicts()
    snaps = nfl.load_snap_counts([season])
    snaps = snaps.filter(pl.col("game_type") == "REG").to_dicts()
    # weekly, not season-level: status changes week to week, and season-level
    # rosters would call an eight-week IR stint "active".
    try:
        rosters = nfl.load_rosters_weekly([season])
        if "game_type" in rosters.columns:
            rosters = rosters.filter(pl.col("game_type") == "REG")
        rosters = rosters.to_dicts()
    except Exception as e:                                  # noqa: BLE001
        print(f"  ! weekly rosters unavailable for {season}: {e}")
        rosters = []

    stat_by = {}          # (week, gsis) -> row
    for r in stats:
        pid = r.get("player_id")
        wk = r.get("week")
        if pid and wk and 1 <= wk <= LAST_WEEK:
            stat_by[(wk, pid)] = r

    snap_by = {}          # (week, gsis) -> (off, def, st)
    # (week, team) that snap data actually COVERS. This is the tm_*_snp
    # equivalent nflverse does not ship, and the ACT fallback below is unsafe
    # without it: snap coverage runs 69-76% of active player-weeks in 2014-18
    # against 87-88% from 2019, so `no snap row` means "we have no data" far
    # more often in the early seasons than it means "he took no snaps".
    # Treating that as a played 0.00 manufactured negative WAR out of a gap in
    # the source — 126 all-season-scoreless players in 2014 against 47 in 2025,
    # which is a coverage curve, not a football fact.
    snap_teams = set()
    for r in snaps:
        wk = r.get("week")
        if not wk or not (1 <= wk <= LAST_WEEK):
            continue
        team = r.get("team") or r.get("recent_team") or r.get("team_abbr")
        if team:
            snap_teams.add((wk, team))
        gsis = pfr_to_gsis.get(r.get("pfr_player_id"))
        if gsis:
            snap_by[(wk, gsis)] = (g(r, "offense_snaps"), g(r, "defense_snaps"),
                                   g(r, "st_snaps"))

    # bucketed by week, not keyed on (week, gsis): the per-week loop would
    # otherwise rescan every roster row in the season fourteen times over.
    status_by = defaultdict(dict)
    for r in rosters:
        gsis = r.get("gsis_id")
        wk = r.get("week")
        if gsis and wk and 1 <= wk <= LAST_WEEK:
            status_by[wk][gsis] = (r.get("status") or "", r.get("team") or "")

    weeks = {}
    for wk in range(1, LAST_WEEK + 1):
        points, positions, played = {}, {}, {}
        wk_status = status_by.get(wk, {})
        # The ACT set has to join the CANDIDATE pool, not just the played test:
        # a dressed QB who never entered has no stat row and no snap row, so
        # building `pids` from those two alone meant he was never considered at
        # all. He is exactly the player the 2026-08-07 rule exists to score.
        pids = ({p for w, p in stat_by if w == wk}
                | {p for w, p in snap_by if w == wk}
                | {p for p, (s, tm) in wk_status.items()
                   if s == "ACT" and (wk, tm) in snap_teams})
        for pid in pids:
            # season-aware: the override has to reach score_row() and the pool
            # assignment below, not just the label written to the CSV
            pos = pos_for(players_pos, pid, season)
            if pos not in CORE:
                continue
            srow = stat_by.get((wk, pid))
            osnp, dsnp, ssnp = snap_by.get((wk, pid), (0, 0, 0))
            st_code, st_team = wk_status.get(pid, ("", ""))
            # ACT only counts as "dressed and did not play" where snap data
            # covers his team that week. Without that check, missing data reads
            # as a played 0.00 — see snap_teams above.
            act = st_code == "ACT" and (wk, st_team) in snap_teams
            if not row_played_hist(pos, osnp, dsnp, ssnp, srow, act):
                continue
            points[pid] = score_row(srow, pos) if srow else 0.0
            positions[pid] = pos
            played[pid] = (srow or {}).get("team") or (srow or {}).get("recent_team") or ""

        # Everyone on an NFL roster this week at a scored position, played or
        # not. `snaps` is 0 for the dressed-but-never-entered case, the state
        # that had no representation before.
        status = {}
        for gsis, (s, team) in wk_status.items():
            if pos_for(players_pos, gsis, season) not in CORE:
                continue
            status[gsis] = {"st": s, "tm": team,
                            "snaps": snap_by.get((wk, gsis), (0, 0, 0))[0],
                            # whether snap data covers his game at all — the
                            # difference between "took no snaps" and "unknown"
                            "cov": (wk, team) in snap_teams,
                            "played": gsis in played}
        weeks[wk] = (points, positions, played, status)
    return weeks


def main():
    ap = argparse.ArgumentParser(description="nflverse -> sleeper_war-shaped dump")
    ap.add_argument("--start", type=int, default=2014)
    ap.add_argument("--end", type=int, default=2025)
    ap.add_argument("--out", default="nfl_history_data")
    args = ap.parse_args()

    import nflreadpy as nfl
    out = Path(args.out)

    print("loading player map + draft picks…")
    players_df = nfl.load_players().to_dicts()
    draft = {}
    for r in nfl.load_draft_picks().to_dicts():
        gid = r.get("gsis_id")
        if gid:
            draft[gid] = (r.get("season"), r.get("round"), r.get("pick"))

    players_pos, pfr_to_gsis, players_json, meta_rows = {}, {}, {}, []
    for p in players_df:
        gid = g(p, "gsis_id", default=None)
        if not gid:
            continue
        pos = g(p, "position", default=None)
        pfr = g(p, "pfr_id", "pfr_player_id", default=None)
        if pfr:
            pfr_to_gsis[pfr] = gid
        if pos in CORE:
            players_pos[gid] = pos
            first = g(p, "first_name", default="") or ""
            last = g(p, "last_name", default="") or ""
            if not (first or last):
                first = g(p, "display_name", "player_name", default=str(gid))
            players_json[gid] = {"position": pos, "first_name": first,
                                 "last_name": last}
            # THE NAME PEOPLE ACTUALLY USE, carried alongside the legal one.
            # first_name is what the birth certificate says: nflverse has Julio
            # Jones as Quintorris, CeeDee Lamb as Cedarian, Dak Prescott as
            # Rayne and Johnny Manziel as Johnathan. Fine as a join key, unusable
            # in a comparables table. `football_name` is nflverse's own common
            # first name; display_name is the full common name. Prefer those and
            # fall back to the legal name so the column is never empty.
            fb = g(p, "football_name", default="") or ""
            common = (f"{fb} {last}".strip() if fb
                      else (g(p, "display_name", "player_name", default="") or "")) \
                or f"{first} {last}".strip()
            d = draft.get(gid, (None, None, None))
            meta_rows.append([gid, f"{first} {last}".strip(), common, pos,
                              g(p, "birth_date", "birthdate", default=""),
                              d[0] or "", d[1] or "", d[2] or ""])

    out.mkdir(parents=True, exist_ok=True)
    (out / "players.json").write_text(json.dumps(players_json), encoding="utf-8")
    with open(out / "players_meta.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["gsis_id", "name", "common", "pos", "birth_date",
                    "draft_season", "draft_round", "draft_pick"])
        w.writerows(meta_rows)
    print(f"players.json: {len(players_json)} QB/RB/WR/TE")

    league = {"season": None, "total_rosters": N_TEAMS,
              "roster_positions": ROSTER_POSITIONS,
              "settings": {"playoff_week_start": LAST_WEEK + 1},
              "name": "NFL history (synthetic, league-shaped)"}
    slots = slot_counts(league)

    import nflreadpy  # noqa: F401  (already imported; keeps intent obvious)
    for season in range(args.start, args.end + 1):
        print(f"season {season}…")
        weeks = pull_season(season, players_pos, pfr_to_gsis, nfl)
        sdir = out / str(season)
        (sdir / "matchups").mkdir(parents=True, exist_ok=True)
        (sdir / "played").mkdir(parents=True, exist_ok=True)
        lg = dict(league, season=str(season))
        (sdir / "league.json").write_text(json.dumps(lg), encoding="utf-8")
        (sdir / "status").mkdir(parents=True, exist_ok=True)
        for wk, (points, positions, played, status) in weeks.items():
            if not points:
                continue
            teams = synth_teams(points, positions, slots, seed=f"{season}-{wk}")
            (sdir / "matchups" / f"week_{wk:02d}.json").write_text(
                json.dumps(teams), encoding="utf-8")
            (sdir / "played" / f"week_{wk:02d}.json").write_text(
                json.dumps(played), encoding="utf-8")
            if status:
                (sdir / "status" / f"week_{wk:02d}.json").write_text(
                    json.dumps(status), encoding="utf-8")
        n = sum(1 for w in weeks.values() if w[0])
        # Count what the 2026-08-07 rule ADDED: active, zero snaps, and now
        # scored as a played 0.00. An earlier version of this counter tested
        # `not played`, which under the new rule is 0 by construction — the
        # whole point is that these players are played now. It reported 0 for
        # every season and read as a failed roster pull.
        dressed = sum(1 for w in weeks.values() for s in w[3].values()
                      if s["st"] == "ACT" and not s["snaps"] and s["played"])
        excluded = sum(1 for w in weeks.values() for s in w[3].values()
                       if s["st"] != "ACT" and not s["played"])
        print(f"  {n} weeks written · {dressed} dressed-but-scoreless player-weeks "
              f"now scored · {excluded} hurt/inactive/practice-squad still excluded")

    print(f"done → {out}\nnow run: python scripts/sleeper_war.py --data {out}")


if __name__ == "__main__":
    main()
