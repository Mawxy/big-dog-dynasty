#!/usr/bin/env python3
"""
inseason.py — how much of the roster season has already happened, and what a
full-season projection is worth for the part that has not.

THE PROBLEM. Every projection curve's year 1 is a FULL-SEASON figure for the
roster season: a per-13 rate carried across the expected number of games, or
Sleeper's season points priced through the same line. That is the right input
to a model — DVI, CVI, the value bridge and the pick tiers all want to know
what a player is worth over a whole year, and banked WAR has no trade value —
but it is the wrong thing to SHOW a reader in week 4. By then four weeks of
that season are a settled fact with a realized WAR attached, and the projection
is still quoting all fourteen.

Max, 2026-09-21: "projections [should] utilize the existing 'proven' data and
continue projecting forward from there. In week 4, we should have 4 weeks of
actual data + the proj war for a final projected war outlook."

THE OUTLOOK. So the displayed figure splits the season at today:

    outlook = banked + year1 * remaining_frac
    remaining_frac = (reg_weeks - weeks_played) / reg_weeks

`banked` is what he has actually produced in the league's regular season so
far (<season>/summary.json, the same WAR column the stats page prints), and the
projection is prorated down to the games still to be played. Week 0: the factor
is 1.0 and the outlook IS the projection, so the offseason is untouched. Week
14: the factor is 0.0 and the outlook IS the banked season, because by then the
projection describes games that have all already happened.

WHAT THIS DOES **NOT** TOUCH. Nothing that consumes year-1 WAR as a model input
moves: index_models.py, value_bridge.py, the pick tiers, and every curve value
in projections_matrix.json stay on the full-season figure. A dynasty index that
shrank to a player's banked WAR by week 14 would price every asset at zero in
December and then jump in January; the outlook is a presentation of the season,
not a new valuation of the player.

WEEKS, NOT DATES. `weeks_played` is the number of scored REGULAR-SEASON weeks
in that season's matchups.json. build_site_data.py only writes a week into that
file once it has points, so its weeks ARE the played weeks and a week in
progress is correctly not one of them. `reg_weeks` is `playoff_start - 1` (14
for Big Dog), read off the same file — the league's own calendar, not the NFL's
18 weeks. This is the same pair usage_stats.windows(), week_odds.py and
trade_analysis.py derive, and the same fraction trade_analysis prorates its
future stream by; that file should import `weeks_played`/`remaining_frac` from
here rather than keep its own copy, so there is one definition of how much
season is left.

KEEP IN LOCKSTEP with src/lib/outlook.ts, which mirrors `outlook()` and the
shape of the published block for the front end. The pipeline publishes the two
FACTS (the block, and each player's `banked`) and the site does the arithmetic,
so the same formula exists in two languages on purpose; if one moves, both must.
"""
import json
from pathlib import Path

from seasons import season_complete

#: Sleeper's default when a league never set one. build_site_data.py,
#: usage_stats.py and week_odds.py all fall back to the same 15.
DEFAULT_PLAYOFF_START = 15

#: the keys of the published meta block, in the order the file carries them
BLOCK_KEYS = ("season", "weeks_played", "reg_weeks", "remaining_frac")


def load_matchups(data_dir, season):
    """One season's parsed matchups.json, or {} when there is none.

    A season directory with no matchups file is a season nobody has played —
    which answers "how many weeks are in the books" with zero rather than with
    an exception."""
    try:
        return json.loads((Path(data_dir) / str(season) / "matchups.json")
                          .read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def reg_weeks(mw):
    """How many weeks the league's REGULAR season is, from its matchups.json.

    `playoff_start - 1`, never below 1 — a league whose bracket starts in week
    1 has no regular season to prorate and dividing by zero is not a better
    answer than treating it as one week."""
    ps = int((mw or {}).get("playoff_start") or DEFAULT_PLAYOFF_START)
    return max(1, ps - 1)


def weeks_played(mw):
    """Scored regular-season weeks in that season's matchups.json.

    Counted as DISTINCT weeks across every roster's rows, so a week that only
    some teams have rows for still counts once. Playoff weeks are excluded: the
    thing being prorated is a regular-season WAR figure, and summary.json's WAR
    column stops at playoff_start too."""
    ps = int((mw or {}).get("playoff_start") or DEFAULT_PLAYOFF_START)
    seen = set()
    for rows in ((mw or {}).get("teams") or {}).values():
        for e in rows or []:
            if isinstance(e, (list, tuple)):
                wk = e[0] if e else None
            elif isinstance(e, dict):
                wk = e.get("week")
            else:
                wk = None
            if wk is not None and int(wk) < ps:
                seen.add(int(wk))
    return len(seen)


def frac_of(played, reg):
    """(reg - played) / reg, clamped to [0, 1]. The arithmetic on its own."""
    reg = max(1, int(reg))
    return max(0.0, min(1.0, (reg - int(played)) / reg))


def remaining_frac(mw):
    """The fraction of a season's regular season still to be played, 0..1.

    1.0 before a ball is snapped and 0.0 once the regular season is over.
    Clamped at both ends: a league that somehow scored more weeks than its
    regular season has must not hand back a NEGATIVE factor, which would turn
    a projection into a subtraction."""
    return frac_of(weeks_played(mw), reg_weeks(mw))


def banked_war(summary):
    """pid -> (realized regular-season WAR, games played) from a summary.json.

    summary.json rows are [pid, pos, gp, pts, ppg, WAA, WAR, sdv, VoWP] — the
    league's own scored figures, regular season only (sleeper_war.py sums
    weekly shifts below playoff_start). A player with no row has not dressed
    for anybody and banks 0.0, which callers get from `.get(pid, (0.0, 0))`
    rather than from a dict of zeros over every player alive.
    """
    out = {}
    for row in summary or []:
        if not isinstance(row, (list, tuple)) or len(row) < 7:
            continue
        try:
            out[str(row[0])] = (float(row[6]), int(row[2]))
        except (TypeError, ValueError):
            continue
    return out


def outlook(y1, banked, block):
    """banked + year1 * remaining_frac — the displayed season figure.

    MIRRORED IN src/lib/outlook.ts (outlookY1); keep the two in lockstep.

      * no block (the offseason, or a projection whose year 1 is not the
        roster season) -> the projection, unchanged. There is nothing banked
        to add and nothing of the season to take away.
      * y1 None -> None. A player with no projection has no outlook; he must
        not be published at his banked WAR as though the model had spoken.
      * banked None/absent -> 0.0. He has not played, which is a real zero
        here: the summary carries no row for him.

    Deliberately not rounded — the caller formats. Rounding here would mean
    Python's banker's rounding and JavaScript's half-up disagreeing in the last
    digit on the two sides of a formula whose whole point is that they agree.
    """
    if y1 is None:
        return None
    if not block:
        return y1
    frac = block.get("remaining_frac")
    if frac is None:
        return y1
    return (banked or 0.0) + y1 * float(frac)


def block(data_dir, roster_season, year1, mw=None):
    """The `inseason` meta block for projections_matrix.json, or None.

    Published only when all three hold, because outside them the outlook IS
    the projection and a block would invite the site to prorate something it
    must not:

      1. year 1 of the projection is the roster season. Between the title game
         and September's league rollover year 1 is the season AFTER the roster
         one (see validate_data.check_projection_coherence), and that season
         has no banked anything.
      2. that season has at least one scored regular-season week. Before
         kickoff `remaining_frac` is 1.0 and every `banked` is 0.0 — a block
         that changes no figure is just a thing to get wrong.
      3. the season is not complete (seasons.season_complete — a decided
         champion). Once it is, the projection has already rolled forward and
         (1) is false anyway; this is the belt to that suspenders.

    `mw` lets a caller pass the matchups payload it has already loaded.
    """
    if roster_season is None or year1 is None:
        return None
    try:
        roster_season, year1 = int(roster_season), int(year1)
    except (TypeError, ValueError):
        return None
    if year1 != roster_season:
        return None
    if season_complete(data_dir, roster_season):
        return None
    mw = load_matchups(data_dir, roster_season) if mw is None else mw
    played, reg = weeks_played(mw), reg_weeks(mw)
    if played < 1:
        return None
    return {"season": roster_season, "weeks_played": played, "reg_weeks": reg,
            "remaining_frac": round(frac_of(played, reg), 6)}


def label(blk):
    """"2026 outlook · 1 wk banked" — the same words as outlook.ts's
    outlookLabel, for a pipeline log line or a print. Empty for no block."""
    if not blk:
        return ""
    n = blk.get("weeks_played") or 0
    return (f"{blk.get('season')} outlook · {n} wk{'s' if n != 1 else ''} banked")
