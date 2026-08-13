#!/usr/bin/env python3
"""
validate_data.py — sanity gate between the pipeline and `git add data`.

Catches the silent-empty failure class: a script that exited 0 but produced
gutted output (missing inputs, empty API responses) must not be committed and
deployed. Floors sit far below current values — they fire on catastrophic
emptiness, never on normal drift (2026-07: players_min 812, projections 390,
values 550, trades 144, shards 812; 2026-08: proj_sleeper 573, pick slots 48,
pick bands 12, priced odds weeks 66 across five seasons).

A floor read off a current value is only valid while the file means the same
thing. proj_sleeper went 3103 -> 573 not because anything broke but because
fetch_projections.py stopped writing an entry for every player Sleeper has ever
heard of; the floor fired on the fix. When a producer changes what it emits,
its floor is part of that change.

  python scripts/validate_data.py                # full check (data-refresh)
  python scripts/validate_data.py --values-only  # market-values workflow
"""
import argparse, json, sys
from pathlib import Path
from leaguepaths import DataDir
# the eight lineup slots, from the crawler's own schema — a validator that
# restated them would pass a file whose slots had been renamed underneath it
from crawl_schema import LEAGUE_YEAR_CAP, SLOT_NAMES


ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

FLOORS = {
    "players_min": 400,
    "ownership": 400,
    "shards": 400,
    "projections": 200,
    # Cut from 1000 on 2026-08-11, when the file legitimately shrank by 82%.
    # The old floor was read off a file that carried an entry for every NFL
    # player Sleeper knows about (3103), the overwhelming majority of them
    # ADP-only records written as `pts13: 0`. fetch_projections.py now omits
    # those instead of writing a zero, so the file is 573 entries — one per
    # player Sleeper actually projects — and the old floor fired on the fix.
    # 300 sits below that and still catches a gutted API response.
    "proj_sleeper": 300,
    # rostered players with a usable projection; currently 302 of 390. This is
    # the one that matters — see the note at the call site.
    "proj_sleeper_rostered": 200,
    "trades": 100,
    "values": 300,
    "franchises": 10,
    "dvi": 150,      # currently ~391
    "cvi": 150,      # currently ~391
    "index_models": 150,   # same population as dvi/cvi, six curves each
    "pick_slots": 40,    # every rookie slot 1.01-4.12; currently 48
    "pick_bands": 12,    # 4 rounds x Early/Mid/Late, so exactly 12
    # priced weeks summed over EVERY season, not per season: an in-progress
    # season legitimately prices only a handful, and a floor per season would
    # fire on week 1 rather than on a gutted run. Currently 66.
    "odds_weeks": 40,
    # Cross-league crawl outputs. These are merged COUNTERS, so the denominators
    # only ever grow as the crawl reaches more leagues — a floor here is not
    # tracking a moving target, it is catching a merge that read no shards.
    # 2026-08: benchmarks league_seasons 61431, champions 61431, rosters 311383.
    # Floors sit two orders of magnitude below that: one shard's worth of a bad
    # run still clears them, a merge over zero parseable shards does not.
    "benchmark_seasons": 500,
    "benchmark_rosters": 2000,
    # slot_values.json is hand-run (no workflow writes it), so it is validated
    # only when present. Its own corpus is the same one benchmarks merges.
    "slot_value_seasons": 500,
}

# Sane bounds for a published WAR figure. A lineup slot's median WAR runs 0.46
# (WR3, field) to 1.41 (QB1, champion) today; nothing legitimate lands outside
# this, and a gutted or mis-indexed corpus lands far outside it.
WAR_RANGE = (-5.0, 10.0)


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


def check_index_models():
    """index_models.json against the two files it is supposed to agree with.

    The failure this catches is the quiet one: a curve loop that runs but reads
    the same projection every time, publishing six identical sets that look like
    six models agreeing. So the checks are (1) every curve is present for every
    player, (2) the default curve reproduces dvi.json and cvi.json exactly — if
    those two ever disagree the site shows one number on a player page and
    another in the trade machine — and (3) the curves actually SEPARATE for the
    players who have a second opinion. Nothing here asserts a direction; the
    point is only that the six are six.
    """
    im = jload(DATA / "index_models.json")
    players = im.get("players") or {}
    floor("index_models", len(players))
    curves = im.get("curves") or []
    if len(curves) != 6:
        fail(f"index_models.json lists {len(curves)} curves, expected 6")
    default = im.get("default")
    if default not in curves:
        fail(f"index_models.json default {default!r} is not one of its own curves")

    missing = [pid for pid, r in players.items()
               if len(r.get("dvi") or {}) != 6 or len(r.get("cvi") or {}) != 6]
    if missing:
        fail(f"{len(missing)} players missing a curve in index_models.json "
             f"(e.g. {missing[0]})")

    for name, key in (("dvi.json", "dvi"), ("cvi.json", "cvi")):
        pub = (jload(DATA / name).get("players") or {})
        bad = [pid for pid, r in pub.items()
               if pid in players and players[pid][key][default][0] != r[key]]
        if bad:
            fail(f"{name} disagrees with index_models.json on its own default "
                 f"curve for {len(bad)} players (e.g. {bad[0]})")

    measured = [r for r in players.values() if r.get("has_analog") and r.get("has_sleeper")]
    if measured:
        moved = sum(1 for r in measured
                    if len({tuple(v) for v in r["dvi"].values()}) > 1)
        if moved < 0.5 * len(measured):
            fail(f"only {moved}/{len(measured)} fully-measured players have two "
                 f"distinct DVI curves — the curve loop is probably reading one "
                 f"projection six times")


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


def _num(v, lo, hi, what):
    """A published number must BE a number and sit in range. None is allowed —
    every figure in these files publishes null rather than a thin estimate."""
    if v is None:
        return
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        fail(f"{what} is {v!r}, not a number")
    if not lo <= v <= hi:
        fail(f"{what} is {v} (outside {lo}..{hi})")


def check_benchmarks():
    """data/benchmarks.json — the cross-league Insights tab.

    Committed by the outcomes crawl, whose commit step only checks that the file
    PARSES. An empty merge parses perfectly: benchmarks.py reads no shards, every
    counter defaults to 0, and it writes a full-shaped document in which every
    rate is null. That is the failure this catches, so the checks are structural
    (the keys and slots the site indexes) plus denominators that a real merge
    cannot be without.
    """
    b = jload(DATA / "benchmarks.json")
    for k in ("meta", "slots", "construction", "picks", "by_league_year", "playoffs"):
        if not b.get(k):
            fail(f"benchmarks.json has no {k}")
    meta = b["meta"]
    floor("benchmark_seasons", meta.get("league_seasons") or 0)
    floor("benchmark_seasons", meta.get("champions") or 0)
    floor("benchmark_rosters", meta.get("rosters") or 0)

    got = [s.get("slot") for s in b["slots"]]
    if got != SLOT_NAMES:
        fail(f"benchmarks.json slots are {got}, expected {SLOT_NAMES}")
    for s in b["slots"]:
        for scope in ("champ", "field"):
            cell = s.get(scope) or {}
            if "v" not in cell:
                fail(f"benchmarks.json slot {s['slot']} has no {scope} value")
            _num(cell["v"], *WAR_RANGE, what=f"benchmarks.json {s['slot']}.{scope}")

    # roster construction: every position counted, on both sides of the split
    for pos in ("qb", "rb", "wr", "te"):
        for scope in ("champ", "field"):
            cell = (b["construction"].get(pos) or {}).get(scope) or {}
            _num(cell.get("v"), 0, 40, f"benchmarks.json construction.{pos}.{scope}")
    for scope in ("champ", "field"):
        cell = (b["construction"].get("homegrown") or {}).get(scope) or {}
        _num(cell.get("v"), 0, 1, f"benchmarks.json construction.homegrown.{scope}")

    # league years 1..CAP, contiguous — the site reads them as a series, and a
    # gap or a short tail is exactly what a cap drifting out of step looks like
    years = [y.get("year") for y in b["by_league_year"]]
    if years != list(range(1, LEAGUE_YEAR_CAP + 1)):
        fail(f"benchmarks.json by_league_year years {years}, expected "
             f"1..{LEAGUE_YEAR_CAP} — did LEAGUE_YEAR_CAP drift?")
    for row in b["by_league_year"]:
        for scope in ("champ", "field"):
            _num((row.get(scope) or {}).get("v"), 0, 1,
                 f"benchmarks.json y{row['year']}.{scope} homegrown share")


def check_slot_values():
    """data/slot_values.json — lineup-slot pricing, the analogue of Bridge A.

    NOT required. slot_value.py is hand-run against a gitignored crawl corpus;
    no workflow produces this file, so on a clean checkout there is nothing to
    check and its absence is normal rather than a gutted run. When it IS there it
    gets the same structural floors as pick_values.json.
    """
    f = DATA / "slot_values.json"
    if not f.exists():
        return
    sv = jload(f)
    meta, slots = sv.get("meta") or {}, sv.get("slots") or []
    floor("slot_value_seasons", meta.get("league_seasons") or 0)
    got = [s.get("bucket") for s in slots]
    if got != SLOT_NAMES:
        fail(f"slot_values.json buckets are {got}, expected {SLOT_NAMES}")
    for s in slots:
        b = s["bucket"]
        if not s.get("pos"):
            fail(f"slot_values.json {b} has no position")
        _num(s.get("bar"), *WAR_RANGE, what=f"slot_values.json {b}.bar")
        for scope in ("all", "champ", "field"):
            if scope not in (s.get("n") or {}):
                fail(f"slot_values.json {b} has no {scope} count")
            _num((s.get("raw") or {}).get(scope), *WAR_RANGE,
                 what=f"slot_values.json {b}.raw.{scope}")
            _num((s.get("hit_rate") or {}).get(scope), 0, 1,
                 what=f"slot_values.json {b}.hit_rate.{scope}")
        # `all` is every roster-season, so it can never be thinner than a subset
        n = s.get("n") or {}
        if n.get("all", 0) < max(n.get("champ", 0), n.get("field", 0)):
            fail(f"slot_values.json {b}: n.all {n.get('all')} is smaller than "
                 f"champ {n.get('champ')} / field {n.get('field')}")


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
    # TWO CHECKS, because the row count alone measures the wrong thing.
    #
    # The file's length is mostly incidental: it used to carry an entry for
    # every player Sleeper has heard of, the vast majority ADP-only listings
    # written as `pts13: 0`, and the count collapsed 3103 -> 573 the day
    # fetch_projections.py stopped writing those. Nothing had broken, but a
    # floor read off the old length fired anyway and discarded a whole run.
    #
    # What the pipeline actually depends on is narrower and stable: how many
    # ROSTERED players have a projection worth using. That is what feeds the
    # composite, it cannot be moved by the size of the ADP tail, and it is the
    # number that would really be gutted by a bad API response. 25 points is
    # project_matrix.py's PTS13_FLOOR — below it Sleeper has no opinion and the
    # pts->WAR line would price the player near -1.4 WAR.
    _sp = jload(DATA / "proj_sleeper.json").get("players") or {}
    floor("proj_sleeper", len(_sp))
    _ros = {str(p.get("pid")) for p in
            (jload(DATA / "projections.json").get("players") or [])}
    floor("proj_sleeper_rostered",
          sum(1 for p in _ros if (_sp.get(p) or {}).get("pts13", 0) >= 25))
    floor("trades", len(jload(DATA / "trades.json").get("trades") or []))
    if not jload(DATA / "drafts.json"):
        fail("drafts.json is empty")
    floor("shards", len(list((DATA / "player").glob("*.json"))))
    floor("dvi", len(jload(DATA / "dvi.json").get("players") or {}))
    floor("cvi", len(jload(DATA / "cvi.json").get("players") or {}))
    check_index_models()
    floor("odds_weeks", odds_weeks)
    check_pick_values()
    check_benchmarks()
    check_slot_values()
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
