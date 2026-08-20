#!/usr/bin/env python3
"""The outcome-crawl corpus layout, in one place.

Three scripts read the same corpus and used to each carry their own copy of its
shape. That is a silent-drift hazard rather than a style complaint: raise
LEAGUE_YEAR_CAP in the crawler and benchmarks.py keeps dropping year 9+ on the
floor, because its own copy still says 8 and nothing compares the two. Same for
the slot list, which was written out three times in three different spellings.

Constants only — no I/O, no argparse, nothing that runs on import. slot_value.py
used to reach ROW_FIELDS by importlib-exec'ing the whole 68 KB crawler just to
read one list; importing this instead is why that hack is gone.
"""

# Lineup slots priced on a championship roster. Mirrors ROSTER_POSITIONS
# (QB, RB, RB, WR, WR, WR, TE, FLEX, SUPER_FLEX): QB2 is the superflex slot.
# Slot n = the roster's nth-best player at that position by THAT season's WAR,
# which prices the lineup a manager could actually field rather than the one he
# did — the same "best legal lineup" convention the rest of the board uses.
LINEUP_SLOTS = [("QB", 1), ("QB", 2), ("RB", 1), ("RB", 2),
                ("WR", 1), ("WR", 2), ("WR", 3), ("TE", 1)]
# corpus column names, lowercase: qb1_war, qb2_war, ...
SLOT_FIELDS = [f"{p.lower()}{n}_war" for p, n in LINEUP_SLOTS]
# the same eight slots as published bucket labels: QB1, QB2, ...
SLOT_NAMES = [f"{p}{n}" for p, n in LINEUP_SLOTS]

# roster row layout, so a consumer never indexes by magic number
ROW_FIELDS = ["rid", "wins", "losses", "fpts",
              "held_r1", "held_r2", "held_r3", "held_r4",
              "kept_own_1st", "homegrown_n", "roster_n", "place",
              "qb", "rb", "wr", "te", "exp_sum", "exp_n",
              # THAT season: cleared the starter bar / the elite bar within it
              "start_qb", "start_rb", "start_wr", "start_te",
              "elite_qb", "elite_rb", "elite_wr", "elite_te",
              # CAREER: already had 3 qualifying seasons by then
              "fran_qb", "fran_rb", "fran_wr", "fran_te"] + SLOT_FIELDS

LEAGUE_YEAR_CAP = 8       # year 8+ pooled: chains that deep are a handful


def tep_class(league):
    """A league's TE-premium tier on KTC's own ladder (keeptradecut.com/about/
    tight-end-premium): '' none, 'tep' TE+ (mild rec bonus), 'tepp' TE++
    (2 TE starts OR a >=1 ppr bonus), 'teppp' TE+++ (both). Shared between the
    crawler (external leagues -> crawl_leagues.json "tep") and build_site_data
    (our own leagues -> meta.json "tep") so one league can never classify two
    ways. Consumers map the class to the KTC value column: ktc / ktcTep /
    ktcTepp / ktcTeppp."""
    bonus = float((league.get("scoring_settings") or {}).get("bonus_rec_te") or 0)
    te_slots = (league.get("roster_positions") or []).count("TE")
    if te_slots >= 2 and bonus > 0:
        return "teppp"
    if te_slots >= 2 or bonus >= 1:
        return "tepp"
    if bonus > 0:
        return "tep"
    return ""
