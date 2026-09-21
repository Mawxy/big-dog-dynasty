#!/usr/bin/env python3
"""
seasons.py — which league seasons are FINISHED, and therefore which one a
projection model is allowed to seed from.

WHY THIS EXISTS

Every arm of the projection chain has to answer the same question — "what is
the last season that actually happened?" — and until 2026-09-15 each answered
it for itself:

  * project_war.py        meta.json `latest`
  * project_war_knn.py    max season in the nfl_history corpus
  * project_points.py     max season in the nfl_history corpus
  * pick_value.py         newest nfl_history/waa_war_<yr>.csv
  * value_bridge.py       newest NON-EMPTY <season>/summary.json

Four of those five mean "last COMPLETED season". `meta.latest` does not: it is
the newest season with any summary data at all, and it flipped to 2026 the
moment week 1 froze. The scalar arm then seeded off a ONE-GAME season and
published years [2027, 2028, 2029] while the analog arm still published 2026 —
so the default blend_composite curve averaged a 2027 number with a 2026 one and
nothing in the output said so. The non-empty-summary rule has exactly the same
hole; it was written to skip the EMPTY placeholder summary an upcoming season
carries all offseason, which stops being enough the week that season kicks off.

THE RULE. A season is complete when its winners bracket has a decided
champion — the same test build_site_data.py gates the FINISH column on and
draft_analysis.py gates `last_complete` on, so all of them move on one clock.
An in-progress season fails it by construction: Sleeper seeds a bracket months
ahead, and `p == 1` has no winner until the title game is played. Note that
this deliberately does NOT exclude the roster season — once the 2026 title game
is decided, 2026 IS the seed even though rosters still say 2026, which is the
correct offseason behaviour and what `meta.latest` used to get right.

Two sources, because the committed league tree carries the fact twice:
  * <season>/bracket.json — `winners` game with `p == 1` and a `w`
  * franchises.json       — that season's `finish == 1`, which build_site_data
                            only ever assigns off the same decided game
The bracket file is the primary read; franchises.json covers a season whose
bracket was never committed (the redraft league writes one only from 2023 on).
"""
import json
from pathlib import Path


def _load(path):
    """Parsed JSON, or None for absent/unreadable/unparseable."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def league_seasons(data_dir):
    """Every season this league has data for, ascending ints.

    meta.json first — it is the registry the site itself reads — falling back
    to the numeric season directories, so a temp dir assembled by a test or a
    league tree mid-build still answers."""
    meta = _load(data_dir / "meta.json") or {}
    yrs = [int(s) for s in (meta.get("seasons") or []) if str(s).isdigit()]
    if yrs:
        return sorted(yrs)
    try:
        entries = list(data_dir.iterdir())
    except OSError:
        return []
    return sorted(int(d.name) for d in entries if d.is_dir() and d.name.isdigit())


def _champion_in_bracket(bracket):
    """True when the winners bracket's title game has been decided."""
    if not isinstance(bracket, dict):
        return False
    for g in bracket.get("winners") or []:
        # `p` is the placement a game decides; 1 is the championship. `w` is
        # null on a seeded-but-unplayed bracket, which is the whole point.
        if g.get("p") == 1 and g.get("w"):
            return True
    return False


def _finish_one_seasons(data_dir):
    """Seasons franchises.json awards a 1st place in. build_site_data assigns
    `finish` only off a decided winners-bracket game, so this is the same fact
    read from the other file."""
    fr = _load(data_dir / "franchises.json")
    if not isinstance(fr, dict):
        return set()
    out = set()
    for f in fr.values():
        for row in (f or {}).get("seasons") or []:
            if row.get("finish") == 1 and str(row.get("season", "")).isdigit():
                out.add(int(row["season"]))
    return out


def season_complete(data_dir, season, _finished=None):
    """Is this league season finished? See the module docstring for the rule."""
    if _champion_in_bracket(_load(data_dir / str(season) / "bracket.json")):
        return True
    finished = _finish_one_seasons(data_dir) if _finished is None else _finished
    return int(season) in finished


def completed_seasons(data_dir, seasons=None):
    """The subset of `seasons` (default: all of this league's) that finished."""
    seasons = league_seasons(data_dir) if seasons is None else sorted(int(s) for s in seasons)
    finished = _finish_one_seasons(data_dir)       # one read, not one per season
    return [y for y in seasons if season_complete(data_dir, y, finished)]


def last_completed_season(data_dir, seasons=None):
    """Newest finished season, or None when none of them are.

    None is a real answer — a league in its first season has no completed one —
    and callers choose their own fallback rather than being handed a year that
    never happened.
    """
    done = completed_seasons(data_dir, seasons)
    return done[-1] if done else None
