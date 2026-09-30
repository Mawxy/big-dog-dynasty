#!/usr/bin/env python3
"""
defense_vs_position.py — how many fantasy points each NFL defense gives up to each
position, over what those players normally score. Feeds the lineup builder
(Max, 2026-09-30).

    data/leagues/<key>/<season>/defense_vs_position.json   (default league only)

NOT matchups.json: that name in the same folder is the fantasy head-to-head
schedule build_site_data.py writes, and this must never overwrite it.

THE NUMBER. For every player-week, `actual` is his Big Dog score
(nfl_history.score_row: the league's frozen scoring, TE premium included) and
`expected` is what he normally scores: his mean over his OTHER games this
season, shrunk toward last season's points per game by K_PLAYER games. A
defense's POE for a position is sum(actual - expected) over every player at
that position it faced, per game played: points over expectation allowed.
Raw points allowed per game ride alongside, but POE is what the estimate is
built from, because raw allowed mostly measures who a defense happened to play.

Positions: QB, RB (FB folded in), WR, TE. No slot/outside split yet — that
waits on slot1/slot2/slot3 depth labels (Max, 2026-09-30).

THIS SIGNAL IS NOISY, AND THE SHRINKAGE SAYS SO. Fitted on 2021-2025 regular
seasons (scratch fit, 2026-09-30):

    K    games of data at which a defense's POE is half signal, half noise.
         From split-half reliability (40 random week halves per season,
         2022-2025), K = n_half * (1 - r) / r, median across seasons:
         QB 21.2, RB 25.5, WR 23.2, TE 35.3. A full 17-game season is still
         under half signal.
    B    year-over-year slope of POE (2022->23, 23->24, 24->25), mean:
         QB 0.13, RB 0.26, WR 0.03, TE 0.18. Last season barely carries over.

    prior    = B * last season's POE
    estimate = prior + w * (this season's POE - prior),  w = n / (n + K)

At week 3, this season's games carry ~10-15% of the weight, so early
estimates sit near zero and the spread between softest and toughest is about
a point. That is the honest answer, not a bug: Max chose (2026-09-30) to lead
with the estimate in points and show the rank second, so a near-neutral
matchup reads as near neutral. Stripping touchdowns or switching to raw volume
allowed (targets, carries, air yards) was tested and is not meaningfully
steadier.

RANK. 1 = softest (most points over expectation allowed), 32 = toughest.

Club codes are Sleeper's (nflverse LA -> LAR), matching nfl_games.json and
players_min.json. Regular season only.

    python scripts/defense_vs_position.py [--out data] [--season 2026]
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ioutil import atomic_write                                   # noqa: E402
from nfl_history import score_row                                 # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
POSITIONS = ["QB", "RB", "WR", "TE"]
POS_ROLE = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE"}
NFLVERSE_TO_SLEEPER = {"LA": "LAR"}
TEAMS = 32

K_PLAYER = 3.0          # games of last season a player's expectation starts with
K = {"QB": 21.2, "RB": 25.5, "WR": 23.2, "TE": 35.3}
B_YOY = {"QB": 0.13, "RB": 0.26, "WR": 0.03, "TE": 0.18}


def club(code):
    return NFLVERSE_TO_SLEEPER.get(code, code)


# ------------------------------------------------------------------ math ----
# Everything below main()'s loaders is pure and stdlib, so tests/ can run it
# without nflreadpy.

def player_rows(stats):
    """nflverse weekly REG rows -> [{gsis, pos, team, opp, week, pts}]."""
    out = []
    for r in stats:
        pos = r.get("position")
        if pos not in POS_ROLE or not r.get("opponent_team"):
            continue
        out.append({"gsis": r["player_id"], "pos": POS_ROLE[pos],
                    "team": club(r["team"]), "opp": club(r["opponent_team"]),
                    "week": int(r["week"]), "pts": score_row(r, pos)})
    return out


def prior_ppg(rows):
    """gsis -> points per game over a season's rows."""
    tot, n = defaultdict(float), defaultdict(int)
    for r in rows:
        tot[r["gsis"]] += r["pts"]
        n[r["gsis"]] += 1
    return {g: tot[g] / n[g] for g in tot}


def add_expected(rows, prior=None, k_player=K_PLAYER):
    """Set `exp` on each row: mean of his OTHER games, shrunk toward his
    prior-season ppg by k_player games. A row with neither (a debut) gets
    None and stays out of POE: there is nothing to be over or under."""
    prior = prior or {}
    tot, n = defaultdict(float), defaultdict(int)
    for r in rows:
        tot[r["gsis"]] += r["pts"]
        n[r["gsis"]] += 1
    for r in rows:
        g = r["gsis"]
        o_n, o_tot = n[g] - 1, tot[g] - r["pts"]
        if g in prior:
            r["exp"] = (o_tot + k_player * prior[g]) / (o_n + k_player)
        elif o_n > 0:
            r["exp"] = o_tot / o_n
        else:
            r["exp"] = None
    return rows


def defense_table(rows):
    """{defense: {pos: {"poe", "pa", "games"}}}, all per game played."""
    games = defaultdict(set)
    poe = defaultdict(lambda: defaultdict(float))
    pa = defaultdict(lambda: defaultdict(float))
    for r in rows:
        games[r["opp"]].add(r["week"])
        pa[r["opp"]][r["pos"]] += r["pts"]
        if r.get("exp") is not None:
            poe[r["opp"]][r["pos"]] += r["pts"] - r["exp"]
    return {d: {p: {"poe": poe[d][p] / len(w), "pa": pa[d][p] / len(w), "games": len(w)}
                for p in POSITIONS}
            for d, w in games.items()}


def blend(cur, prev, k, b):
    """This season's POE shrunk toward last season's, regressed by b."""
    prior = b * prev["poe"] if prev else 0.0
    if not cur or not cur["games"]:
        return prior
    w = cur["games"] / (cur["games"] + k)
    return prior + w * (cur["poe"] - prior)


def rank(values):
    """{key: value} -> {key: 1..n}, 1 = largest."""
    return {k: i + 1 for i, k in enumerate(sorted(values, key=lambda k: -values[k]))}


def build(cur_rows, prev_rows, season):
    """The published document. Pure: scored rows (with `exp`) in, dict out."""
    cur, prev = defense_table(cur_rows), defense_table(prev_rows)
    defenses = sorted(set(cur) | set(prev))
    est = {p: {d: blend(cur.get(d, {}).get(p), prev.get(d, {}).get(p), K[p], B_YOY[p])
               for d in defenses} for p in POSITIONS}
    ranks = {p: rank(est[p]) for p in POSITIONS}
    table = {}
    for d in defenses:
        table[d] = {}
        for p in POSITIONS:
            c = cur.get(d, {}).get(p)
            table[d][p] = {
                "est": round(est[p][d], 2),
                "rank": ranks[p][d],
                "poe": round(c["poe"], 2) if c else None,
                "pa": round(c["pa"], 2) if c else None,
                "games": c["games"] if c else 0,
            }
    weeks = [r["week"] for r in cur_rows]
    return {
        "season": season,
        "through_week": max(weeks) if weeks else 0,
        "positions": POSITIONS,
        "fields": {
            "est": "points per game over expectation this defense allows to the "
                   "position, shrunk toward last season; lead with this",
            "rank": "1 = softest, 32 = toughest, on est",
            "poe": "this season's raw points over expectation per game",
            "pa": "this season's raw points allowed per game",
            "games": "games played this season",
        },
        "method": {"k_player": K_PLAYER, "k": K, "b_yoy": B_YOY,
                   "scoring": "Big Dog league scoring (nfl_history.SCORING)"},
        "defenses": table,
    }


def validate(doc):
    """Refuse to publish a document the site can't trust."""
    d = doc["defenses"]
    if len(d) != TEAMS:
        raise ValueError(f"{len(d)} defenses, expected {TEAMS}")
    for club_, row in d.items():
        for p in POSITIONS:
            if not 1 <= row[p]["rank"] <= TEAMS or abs(row[p]["est"]) > 25:
                raise ValueError(f"{club_} {p}: implausible {row[p]}")
    return len(d)


# ---------------------------------------------------------------- loading ---

def load_rows(nfl, season):
    import polars as pl
    st = nfl.load_player_stats([season], summary_level="week")
    return player_rows(st.filter(pl.col("season_type") == "REG").to_dicts())


def default_league(out):
    reg = json.loads((out / "leagues.json").read_text(encoding="utf-8"))
    lg = next(l for l in reg["leagues"] if l["key"] == reg["default"])
    return str(lg["key"]), int(lg["rosterSeason"])


def main(argv=None):
    ap = argparse.ArgumentParser(description="Defense-vs-position matchup table.")
    ap.add_argument("--out", type=Path, default=ROOT / "data")
    ap.add_argument("--season", type=int, default=None)
    a = ap.parse_args(argv)
    import nflreadpy as nfl

    key, roster_season = default_league(a.out)
    season = a.season or roster_season
    # three seasons: this one, last one, and the one before so last season's
    # own expectations have a prior too
    older = load_rows(nfl, season - 2)
    prev = add_expected(load_rows(nfl, season - 1), prior_ppg(older))
    try:
        cur_raw = load_rows(nfl, season)
    except Exception as e:                                  # noqa: BLE001
        print(f"  ! no {season} stats yet ({e}); publishing last season's prior only")
        cur_raw = []
    cur = add_expected(cur_raw, prior_ppg(prev))
    doc = build(cur, prev, season)
    validate(doc)
    path = a.out / "leagues" / key / str(season) / "defense_vs_position.json"
    atomic_write(path, json.dumps(doc, separators=(",", ":")) + "\n")
    softest = {p: min(doc["defenses"], key=lambda d: doc["defenses"][d][p]["rank"])
               for p in POSITIONS}
    print(f"defense vs position {season} through week {doc['through_week']} -> {path}")
    print("  softest: " + ", ".join(
        f"{p} {d} {doc['defenses'][d][p]['est']:+.2f}" for p, d in softest.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
