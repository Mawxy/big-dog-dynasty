#!/usr/bin/env python3
"""
validate_data.py — sanity gate between the pipeline and `git add data`.

Catches the silent-empty failure class: a script that exited 0 but produced
gutted output (missing inputs, empty API responses) must not be committed and
deployed. Floors sit far below current values — they fire on catastrophic
emptiness, never on normal drift (2026-07: players_min 812, projections 390,
proj_sleeper 3103, values 550, trades 144, shards 812; 2026-08: pick slots 48,
pick bands 12, priced odds weeks 66 across five seasons).

  python scripts/validate_data.py                # full check (data-refresh)
  python scripts/validate_data.py --values-only  # market-values workflow
"""
import argparse, json, sys
from pathlib import Path
from leaguepaths import DataDir


ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

FLOORS = {
    "players_min": 400,
    "ownership": 400,
    "shards": 400,
    "projections": 200,
    "proj_sleeper": 1000,
    "trades": 100,
    "values": 300,
    "franchises": 10,
    "dvi": 150,      # currently ~391
    "cvi": 150,      # currently ~391
    "pick_slots": 40,    # every rookie slot 1.01-4.12; currently 48
    "pick_bands": 12,    # 4 rounds x Early/Mid/Late, so exactly 12
    # priced weeks summed over EVERY season, not per season: an in-progress
    # season legitimately prices only a handful, and a floor per season would
    # fire on week 1 rather than on a gutted run. Currently 66.
    "odds_weeks": 40,
}


def fail(msg):
    print(f"VALIDATION FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def jload(p):
    if not p.exists():
        fail(f"{p} is missing")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        fail(f"{p} is not valid JSON: {e}")


def floor(name, n):
    if n < FLOORS[name]:
        fail(f"{name}: {n} entries (< floor {FLOORS[name]})")


def check_values():
    floor("values", len(jload(DATA / "values.json").get("players") or {}))
    if not jload(DATA / "value_bridge.json").get("fits"):
        fail("value_bridge.json has no fits")
    check_ecr()


def check_ecr():
    """ecr.json's own reconciliation invariant: for every format the meta's
    `matched` must equal the players actually carrying that slug — a mismatch
    means a name collision silently overwrote someone (see HANDOFF 2026-07-29).
    The file persists across failed fetches (continue-on-error), so an old but
    internally consistent copy passes."""
    ecr = jload(DATA / "ecr.json")
    players = ecr.get("players") or {}
    for slug, m in (ecr.get("formats") or {}).items():
        n = sum(1 for by_fmt in players.values() if slug in by_fmt)
        if n != m.get("matched"):
            fail(f"ecr.json {slug}: {n} players carry the slug but meta says "
                 f"matched={m.get('matched')} — name collision overwriting someone?")


def check_pick_values():
    """Bridge A's published board (data/pick_values.json).

    The Draft page reads every slot and every band, so a run that wrote a
    header with no rows is the silent-empty failure this file exists to catch.
    `years_published` must also be contiguous from 1: draft_analysis.py sums
    years 1..n for the elapsed-window comparison, and a gap reads as a
    different window rather than as missing data.
    """
    pv = jload(DATA / "pick_values.json")
    picks, bands = pv.get("picks") or [], pv.get("bands") or []
    floor("pick_slots", len(picks))
    floor("pick_bands", len(bands))
    years = (pv.get("meta") or {}).get("years_published") or []
    if not years:
        fail("pick_values.json publishes no year-since-draft column")
    if years != list(range(1, len(years) + 1)):
        fail(f"pick_values.json years_published {years} is not contiguous from 1")
    if not (pv.get("meta") or {}).get("picks_used"):
        fail("pick_values.json was built from no picks at all")
    for row in picks + bands:
        b = row.get("bucket")
        if not b:
            fail("pick_values.json has a row with no bucket")
        # JSON keys are strings; years_published is a list of ints
        n = row.get("n") or {}
        for k in years:
            if not n.get(str(k)):
                fail(f"pick_values.json {b}: year {k} is published with "
                     f"{n.get(str(k))} observations")


def check_odds(sd, weeks_seen, scored):
    """Pregame win probability for one season (data/<season>/odds.json).

    Written for every season that has matchups, so a missing file means
    week_odds.py did not run. Regular season only by construction — a week at
    or after playoff_start would mean the postseason got priced by the
    regular-season model, which the bracket already prices differently.
    """
    of = sd / "odds.json"
    if not of.exists():
        fail(f"{of} is missing — did week_odds.py run?")
    odds = jload(of)
    meta = odds.get("meta") or {}
    weeks = odds.get("weeks") or {}
    ps = meta.get("playoff_start")
    if not ps:
        fail(f"{of} has no playoff_start")
    if scored and not weeks:
        fail(f"{of} prices no week, but the season has scored matchups")
    for wk, teams in weeks.items():
        if int(wk) >= ps:
            fail(f"{of} prices week {wk}, at or after playoff_start {ps}")
        if not teams:
            fail(f"{of} week {wk} has no teams")
        for rid, rec in teams.items():
            if rec.get("mu") is None or rec.get("sd") is None:
                fail(f"{of} week {wk} roster {rid} has no mu/sd")
            wp = rec.get("wp")
            if wp is not None and not 0.0 <= wp <= 1.0:
                fail(f"{of} week {wk} roster {rid} has win probability {wp}")
    return weeks_seen + len(weeks)


def check_full():
    meta = jload(DATA / "meta.json")
    seasons = meta.get("seasons") or []
    if not seasons:
        fail("meta.json has no seasons")
    if not meta.get("latest"):
        fail("meta.json latest is null — no season produced summary data")
    odds_weeks = 0
    for s in seasons:
        sd = DATA / s
        if len(jload(sd / "teams.json")) < 2:
            fail(f"{sd}/teams.json has fewer than 2 teams")
        # a season with scored matchups must have non-empty summary + weekly
        mf = sd / "matchups.json"
        scored = mf.exists() and bool(jload(mf).get("teams"))
        if scored:
            if not jload(sd / "summary.json"):
                fail(f"{sd}/summary.json is empty but the season has scored matchups")
            if not jload(sd / "weekly.json"):
                fail(f"{sd}/weekly.json is empty but the season has scored matchups")
        if mf.exists():
            odds_weeks = check_odds(sd, odds_weeks, scored)
        # a shipped bracket must have a decided game: Sleeper seeds a
        # placeholder bracket long before kickoff, and shipping that renders a
        # postseason for a season nobody has played
        bf = sd / "bracket.json"
        if bf.exists() and not any(g.get("w") for g in jload(bf).get("winners") or []):
            fail(f"{sd}/bracket.json has no decided game — placeholder seeding?")
    floor("players_min", len(jload(DATA / "players_min.json")))
    floor("ownership", len(jload(DATA / "ownership.json")))
    floor("franchises", len(jload(DATA / "franchises.json")))
    floor("projections", len(jload(DATA / "projections.json").get("players") or []))
    floor("proj_sleeper", len(jload(DATA / "proj_sleeper.json").get("players") or {}))
    floor("trades", len(jload(DATA / "trades.json").get("trades") or []))
    if not jload(DATA / "drafts.json"):
        fail("drafts.json is empty")
    floor("shards", len(list((DATA / "player").glob("*.json"))))
    floor("dvi", len(jload(DATA / "dvi.json").get("players") or {}))
    floor("cvi", len(jload(DATA / "cvi.json").get("players") or {}))
    floor("odds_weeks", odds_weeks)
    check_pick_values()
    check_values()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--values-only", action="store_true",
                    help="check only values.json / value_bridge.json "
                         "(the market-values workflow's outputs)")
    args = ap.parse_args()
    if args.values_only:
        check_values()
    else:
        check_full()
    print("data/ validation OK" + (" (values only)" if args.values_only else ""))


if __name__ == "__main__":
    main()
