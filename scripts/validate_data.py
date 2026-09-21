#!/usr/bin/env python3
"""
validate_data.py — sanity gate between the pipeline and `git add data`.

Catches the silent-empty failure class: a script that exited 0 but produced
gutted output (missing inputs, empty API responses) must not be committed and
deployed. Floors sit far below current values — they fire on catastrophic
emptiness, never on normal drift (2026-07: players_min 812, projections 390,
values 550, trades 144, shards 812; 2026-08: proj_sleeper 573, pick slots 48,
pick bands 12, priced odds weeks 66 across five seasons; 2026-09: matrix rows
365, points-model rows 300, roster-season usage 354 / winshare 108).

Not every check here is a floor. The projection chain's files have to agree
with EACH OTHER about which season they project from — see
check_projection_coherence, added after the 2026-09-15 seed rollover, when
every file still parsed and every floor still cleared while two of the arms
had quietly moved a year apart.

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
# the projection curves, from the module that defines them — this check was
# written against a hardcoded six and fired on 2026-09-11, when the
# points-first model legitimately added its two. A count restated here is a
# count that goes stale the next time a model is added.
from curves import CURVES
# and "which season actually finished", from the module every projection arm
# now seeds off — restating the rule here is how the arms drifted apart
from seasons import last_completed_season
# the in-season block's own arithmetic, from the module that writes it. Same
# rule: a validator that restated "how many weeks have been played" would agree
# with itself and not with the pipeline.
import inseason


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
    "index_models": 150,   # same population as dvi/cvi, every curve each
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
    # the eight-curve matrix, same population as projections (currently 365)
    "matrix": 200,
    # rows the points-first model actually priced from a player's own history;
    # currently 300 of 365 (the rest are 56 rookies and 9 unjoined names)
    "points_players": 200,
    # roster-season nflverse features and win shares. Both are checked only
    # once the season has a scored week — before kickoff they are legitimately
    # thin or absent. Currently usage 354, winshare 108 (9 starters x 12 teams
    # after one week; it grows as lineups change).
    "usage_players": 100,
    "winshare_players": 50,
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
    the same projection every time, publishing identical sets that look like a
    row of models agreeing. So the checks are (1) the file carries exactly the
    curves curves.py defines, and every one of them for every player, (2) the
    default curve reproduces dvi.json and cvi.json exactly — if those two ever
    disagree the site shows one number on a player page and another in the
    trade machine — and (3) the curves actually SEPARATE for the players who
    have a second opinion. Nothing here asserts a direction; the point is only
    that the curves are as many as they claim.
    """
    im = jload(DATA / "index_models.json")
    players = im.get("players") or {}
    floor("index_models", len(players))
    curves = im.get("curves") or []
    if list(curves) != list(CURVES):
        fail(f"index_models.json lists {len(curves)} curves {list(curves)}, "
             f"expected curves.py's {len(CURVES)}: {list(CURVES)}")
    default = im.get("default")
    if default not in curves:
        fail(f"index_models.json default {default!r} is not one of its own curves")

    missing = [pid for pid, r in players.items()
               if set(r.get("dvi") or {}) != set(CURVES)
               or set(r.get("cvi") or {}) != set(CURVES)]
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
                 f"projection once per curve")


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


# The projection chain, and how each file stamps the season it projects FROM.
# They are written by four different scripts at four different points in the
# nightly and agree only by construction — which is why nothing noticed when one
# of them moved on 2026-09-15 and the others did not.
PROJECTION_FILES = (
    ("projections.json", True),             # the site model (points-first)
    ("projections_scalar.json", False),     # per-13 rate model (project_war.py)
    ("projections_points.json", False),     # the points model's own file, hand-run
    ("projections_matrix.json", False),     # the eight curves
    ("projections_knn_hybrid.json", False),  # the analog arm
)


def _seed_and_first(meta):
    """(seed season, first projected year), however this file spells them.

    `seed_season` on most of them, `as_of` on projections_points.json; the knn
    writer publishes a seed and no year list, so year one is seed + 1 there.
    """
    seed = meta.get("seed_season")
    if seed is None:
        seed = meta.get("as_of")
    years = meta.get("years") or []
    first = years[0] if years else (seed + 1 if seed is not None else None)
    return seed, first


def _roster_season():
    """The default league's rosterSeason, from the registry the site reads."""
    reg = jload(DATA / "leagues.json")
    key = reg.get("default")
    for lg in reg.get("leagues") or []:
        if lg.get("key") == key and str(lg.get("rosterSeason", "")).isdigit():
            return int(lg["rosterSeason"])
    meta = jload(DATA / "meta.json")
    rs = str(meta.get("rosterSeason") or "")
    return int(rs) if rs.isdigit() else None


def check_projection_coherence():
    """Every arm of the projection chain must project from the SAME season.

    This is the check that would have caught 2026-09-15. meta.json's `latest`
    flips to the new season the moment week 1 freezes, project_war.py seeded off
    it, and the scalar arm jumped to seed 2026 / years [2027, 2028, 2029] while
    the analog and points arms (seeded off the nfl_history corpus) stayed on
    2025 / [2026, 2027, 2028]. Every file still parsed, every floor still
    cleared, and the default blend_composite curve averaged a 2027 number with a
    2026 one under one column heading.

    Three assertions, in the order a reader needs them:

      1. the files agree with each other;
      2. the seed is the last season with a DECIDED CHAMPION (seasons.py) and
         year one is the season after it;
      3. year one lines up with the roster the site shows it beside.

    (3) is deliberately a two-value window rather than an equality. Year one IS
    the roster season while that season is being played, but between the title
    game and September's league rollover the roster season is finished and year
    one is the one after it. Pinning equality would fire every January.
    """
    done = last_completed_season(DATA)
    roster = _roster_season()

    seen = {}
    for name, required in PROJECTION_FILES:
        f = DATA / name
        if not f.exists():
            if required:
                fail(f"{f} is missing")
            continue
        seed, first = _seed_and_first(jload(f).get("meta") or {})
        if seed is None and first is None:
            # tolerated: a file written before its producer stamped a seed.
            # Required files are not — projections.json has always carried one.
            if required:
                fail(f"{name} stamps no seed season / projected years")
            continue
        seen[name] = (seed, first)
    if not seen:
        fail("no projection file stamps a seed season")

    where = "; ".join(f"{n} seed {s} -> year {y}" for n, (s, y) in sorted(seen.items()))
    if len({s for s, _ in seen.values()}) > 1 or len({y for _, y in seen.values()}) > 1:
        fail(f"the projection arms disagree about which season they project "
             f"from — {where}")
    seed, first = next(iter(seen.values()))
    if seed is not None and first is not None and first != seed + 1:
        fail(f"projections seed from {seed} but publish year one as {first}")
    if done is not None and seed is not None and seed != done:
        fail(f"projections seed from {seed}, but the last season with a decided "
             f"champion is {done} — an in-progress season is not a seed "
             f"(scripts/seasons.py). {where}")
    if roster is not None and first is not None and not roster <= first <= roster + 1:
        fail(f"projections publish year one as {first} beside a {roster} roster "
             f"— the two are more than a rollover apart. {where}")


def check_points_model():
    """projections.json's own population count, when it is the points model's.

    project_points.py --site rewrites projections.json in place and stamps how
    many rows IT priced. A run that fit nothing still writes a full-shaped file
    (every row kept on the scalar, `src: scalar`), which parses, clears the
    projections floor, and publishes the previous model under this one's name.
    The count is the only thing that says so out loud — so it has to be both
    present and true.
    """
    pj = jload(DATA / "projections.json")
    meta, rows = pj.get("meta") or {}, pj.get("players") or []
    if not str(meta.get("model") or "").startswith("points-first"):
        return                      # the scalar model's file; nothing to count
    n = meta.get("points_players")
    if n is None:
        fail("projections.json says model points-first but stamps no "
             "points_players count")
    actual = sum(1 for r in rows if r.get("src") == "points")
    if n != actual:
        fail(f"projections.json meta.points_players {n} but {actual} rows carry "
             f"src:points")
    floor("points_players", n)


def check_matrix():
    """projections_matrix.json — the file every curve on the site is read from.

    Floors plus NO NULLS: a curve is an array of numbers per horizon year, and
    a null in one is not a missing figure the site can print a dash for — the
    picker would hand the index models a None and price the player at nothing.
    """
    mx = jload(DATA / "projections_matrix.json")
    rows = mx.get("players") or []
    meta = mx.get("meta") or {}
    floor("matrix", len(rows))
    if list(meta.get("curves") or []) != list(CURVES):
        fail(f"projections_matrix.json lists {list(meta.get('curves') or [])}, "
             f"expected curves.py's {list(CURVES)}")
    H = meta.get("horizon") or 3
    for r in rows:
        who = r.get("name") or r.get("pid")
        for c in CURVES:
            v = r.get(c)
            if not isinstance(v, list) or len(v) != H or any(x is None for x in v):
                fail(f"projections_matrix.json {who}: {c} is {v!r}, expected "
                     f"{H} non-null numbers")
            for i, x in enumerate(v):
                _num(x, *WAR_RANGE, what=f"projections_matrix.json {who} {c}[{i}]")


def check_inseason():
    """projections_matrix.json's `meta.inseason`, when it has one.

    The block is how the site knows that year 1 of every curve is a season
    already partly played, and `outlook = banked + year1 * remaining_frac` is
    computed from it in the browser (src/lib/outlook.ts). Three ways for that
    to go wrong silently, all of them arithmetic rather than emptiness:

      * a fraction outside [0, 1] — a negative one turns a projection into a
        subtraction and prints an outlook BELOW what the player has already
        banked;
      * a week count that does not match the season's own matchups.json, which
        is what a block carried over from a previous run looks like. The
        matchups file is the only source of "played" in the pipeline
        (build_site_data writes a week once it has points), so it is the
        arbiter here too;
      * a row missing `banked`. The site reads a null as 0 and would publish a
        star's outlook as his remaining projection alone.

    ABSENT IS NORMAL and passes: out of season there is nothing to prorate,
    and a file written before this existed simply has no block.
    """
    mx = jload(DATA / "projections_matrix.json")
    meta = mx.get("meta") or {}
    blk = meta.get("inseason")
    if not blk:
        return
    for k in inseason.BLOCK_KEYS:
        if blk.get(k) is None:
            fail(f"projections_matrix.json meta.inseason has no {k}: {blk}")
    frac, played, reg = blk["remaining_frac"], blk["weeks_played"], blk["reg_weeks"]
    _num(frac, 0.0, 1.0, what="projections_matrix.json meta.inseason.remaining_frac")
    if not 1 <= played <= reg:
        fail(f"projections_matrix.json meta.inseason plays {played} of {reg} "
             f"regular-season weeks")
    want = inseason.frac_of(played, reg)
    if abs(frac - want) > 1e-6:
        fail(f"projections_matrix.json meta.inseason remaining_frac {frac} is not "
             f"({reg} - {played}) / {reg} = {want}")
    mw = inseason.load_matchups(DATA, blk["season"])
    if not mw:
        fail(f"projections_matrix.json has an inseason block for {blk['season']} "
             f"but that season has no matchups.json")
    scored = inseason.weeks_played(mw)
    if scored != played:
        fail(f"projections_matrix.json meta.inseason says {played} weeks played "
             f"but {blk['season']}/matchups.json scores {scored}")
    if inseason.reg_weeks(mw) != reg:
        fail(f"projections_matrix.json meta.inseason reg_weeks {reg} but "
             f"{blk['season']}/matchups.json makes it {inseason.reg_weeks(mw)}")
    for r in mx.get("players") or []:
        _num(r.get("banked"), *WAR_RANGE,
             what=f"projections_matrix.json {r.get('name') or r.get('pid')}.banked")
        if r.get("banked") is None:
            fail(f"projections_matrix.json {r.get('name') or r.get('pid')} has no "
                 f"banked WAR, but the file carries an inseason block")


def check_current_season_features(season, scored):
    """<season>/usage.json and <season>/winshare.json for the roster season.

    Both are written only for the default league (nflverse skill features and
    playoff-style win shares), so ABSENT IS NORMAL and skipped — the redraft
    league has neither. They are also skipped until the season has a scored
    week: before kickoff there is nothing to summarise and a floor would fire
    on an empty September rather than on a gutted run.
    """
    if not scored:
        return
    uf = DATA / str(season) / "usage.json"
    if uf.exists():
        usage = jload(uf)
        floor("usage_players", len(usage))
        for pid, rec in usage.items():
            if not isinstance(rec, dict) or not rec:
                fail(f"{uf} {pid} has no usage scopes")
            for scope, cell in rec.items():
                if not isinstance(cell, dict) or not cell:
                    fail(f"{uf} {pid}.{scope} is empty")
                for k, x in cell.items():
                    if x is None:
                        fail(f"{uf} {pid}.{scope}.{k} is null")
    wf = DATA / str(season) / "winshare.json"
    if wf.exists():
        players = jload(wf).get("players") or {}
        floor("winshare_players", len(players))
        for pid, rec in players.items():
            if rec.get("ws") is None or rec.get("gs") is None:
                fail(f"{wf} {pid} has no win share / games started")
            _num(rec["ws"], 0, 20, what=f"{wf} {pid}.ws")


def check_record_vs_matchups(season):
    """teams.json W+L+T must equal the scored regular-season weeks in
    matchups.json.

    Sleeper's roster record and its matchup rows are pulled separately and land
    out of step mid-week: the record updates when a week is finalised, the
    matchup rows the moment scoring starts. A team showing 1-0 beside two
    scored weeks means the two halves of the season page disagree about how
    much of it has happened — WAR is summed off the matchups, records off the
    rosters, and nothing downstream would notice.

    Regular season only: the record Sleeper keeps excludes the bracket, and
    matchups.json carries playoff weeks too.
    """
    sd = DATA / str(season)
    mf = sd / "matchups.json"
    if not mf.exists():
        return
    m = jload(mf)
    rows = m.get("teams") or {}
    ps = m.get("playoff_start") or 99
    for t in jload(sd / "teams.json"):
        rid = str(t.get("roster_id"))
        played = 0
        for g in rows.get(rid) or []:
            wk = g[0] if isinstance(g, list) else (g or {}).get("week")
            if wk is not None and int(wk) < ps:
                played += 1
        rec = (t.get("wins") or 0) + (t.get("losses") or 0) + (t.get("ties") or 0)
        if rec != played:
            fail(f"{sd}/teams.json roster {rid} is {t.get('wins')}-"
                 f"{t.get('losses')}-{t.get('ties')} ({rec} games) but "
                 f"matchups.json scores {played} regular-season weeks")


def check_full():
    meta = jload(DATA / "meta.json")
    seasons = meta.get("seasons") or []
    if not seasons:
        fail("meta.json has no seasons")
    if not meta.get("latest"):
        fail("meta.json latest is null — no season produced summary data")
    roster_season = meta.get("rosterSeason")
    odds_weeks = 0
    for s in seasons:
        sd = DATA / s
        if len(jload(sd / "teams.json")) < 2:
            fail(f"{sd}/teams.json has fewer than 2 teams")
        # a season with scored matchups must have non-empty summary + weekly
        mf = sd / "matchups.json"
        scored = mf.exists() and bool(jload(mf).get("teams"))
        # rosters and matchups must agree about how much of the season has
        # been played — the one that goes wrong mid-week
        check_record_vs_matchups(s)
        if str(s) == str(roster_season):
            check_current_season_features(s, scored)
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
    check_projection_coherence()
    check_points_model()
    check_matrix()
    check_inseason()
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
