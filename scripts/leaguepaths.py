#!/usr/bin/env python3
"""
Where a data file lives: global, or under this league.

A league is keyed by its FOUNDING league_id and its files live in
`data/leagues/<key>/`. Sleeper mints a new league_id every season and chains
them backward, so the founder is the only id that never moves — keying on the
current one would relocate every path annually.

The split is by what a file is calibrated to, NOT by where it came from:

  * GLOBAL — raw market pulls and the crawl corpora. Player- or league-corpus
    level, true regardless of whose league is being looked at.
  * LEAGUE — anything derived from this league's WAR. That includes some files
    that look like market data: dvi.json, blended_values.json and
    value_bridge.json are all built from data/projections.json, so they are
    calibrated to this league and belong to it.

`DATA / "x.json"` at every call site keeps working; this routes it. Keeping the
classification in ONE list is the point — scattering it across nine scripts is
how the two halves drift apart.
"""
import json
from pathlib import Path

GLOBAL_FILES = {
    "leagues.json",           # the registry itself
    "values.json",            # KTC / FantasyCalc market pull
    "values_history.json",
    "ecr.json",                # FantasyPros consensus — a property of the FORMAT
    "crawl_leagues.json",     # crawler state and corpora
    "league_signals.json",
    "draft_signals.json",
    "draft_index.json",       # draft_id -> [league_id, season, kind]
    "rookie_pick_corpus.json",
    "trade_corpus.json",
    "tep_map.json",           # league_id -> TE-premium class, movers job cache
    "outcome_signals.json",   # league-wide benchmarks (sharded: _0.._3)
    "outcome_corpus.json",
    "benchmarks.json",        # merged cross-league benchmarks (Insights tab)
    "slot_values.json",       # lineup-slot pricing from the outcome corpus —
                              # cross-league, like benchmarks.json
}


def league_key(data_root: Path) -> str:
    """The default league's founding id, or "" when there is no registry yet."""
    try:
        reg = json.loads((Path(data_root) / "leagues.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return reg.get("default") or ""


class DataDir:
    """Path-like router. `DataDir(root) / "values.json"` -> data/values.json;
    `DataDir(root) / "projections.json"` -> data/leagues/<key>/projections.json.

    A name that isn't a known global (a season, "player", anything unlisted) is
    treated as league-scoped, so new league files need no registration and a new
    global one has to be added deliberately."""

    def __init__(self, root, key=None):
        self.root = Path(root)
        self.key = league_key(self.root) if key is None else key
        self.league = self.root / "leagues" / self.key if self.key else self.root

    def __truediv__(self, name):
        return (self.root if str(name) in GLOBAL_FILES else self.league) / str(name)

    # the league dir is what callers mean by "the data directory"
    def __fspath__(self):
        return str(self.league)

    def __str__(self):
        return str(self.league)

    def mkdir(self, **kw):
        return self.league.mkdir(**kw)

    def glob(self, pat):
        return self.league.glob(pat)

    def iterdir(self):
        return self.league.iterdir()

    def exists(self):
        return self.league.exists()
