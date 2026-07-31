#!/usr/bin/env python3
"""
playoff_wpa.py — win probability added, per player, per playoff game.

  python scripts/playoff_wpa.py                  # every season with a bracket
  python scripts/playoff_wpa.py --season 2025
  python scripts/playoff_wpa.py --probe          # report, write nothing

WHY NOT WAR. WAR needs two things the postseason doesn't have: a replacement
baseline built from league-wide weekly scoring, and wins that are fungible
across a long schedule. A three-week single-elimination bracket has neither —
the sample is two or three games, a semifinal win is not a round-1 win, and
half the league is in a consolation bracket where lineups stop being set. Any
league-wide baseline computed over weeks 15-17 is contaminated by teams that
have stopped trying.

WPA sidesteps all of it because it is computed INSIDE ONE MATCHUP and never
needs a league-wide anything. Consolation games simply never enter the
calculation; there is no shared baseline for them to poison.

METHOD, per elimination game (round 1, semifinals, final — see SCOPE below):

  1. Each starter's pregame distribution is his OWN regular-season form:
     mean and sd of his weekly points over the played weeks in weekly.json,
     shrunk toward a positional prior so a player with three games doesn't
     arrive with a wild sd (see shrink()).
  2. Team score ~ Normal(sum of starter means, sqrt(sum of variances)), so
     pregame P(win) = Phi((muA - muB) / sqrt(varA + varB)).
  3. A player's WPA is his SHAPLEY VALUE on that win probability: the average
     over all orderings of how much swapping his projection for his actual
     score moved his team's win probability, with teammates either at their
     actual score (already revealed) or still at expectation. Exact, not
     sampled — nine starters is 2^8 = 256 subsets per player.
  4. Shapley is EFFICIENT, which is the property that makes this honest: every
     player's WPA in a game sums exactly to (1 if won else 0) - pregame P(win).
     The game's entire swing is allocated to the players who caused it. No
     credit is invented and none goes missing. verify() asserts it.

Two consequences fall out for free:

  * Position neutrality. A superflex QB's 25 points is what was expected of
    him and adds almost nothing; a TE's 25 is a huge residual. Raw playoff
    points hand the award to quarterbacks by construction — WPA does not.
  * Leverage. Thirty points in a blowout adds ~0 because the win was already
    banked; 22 in a one-point semifinal is worth most of a win. "Most valuable"
    becomes "won games his team would otherwise have lost", which is the claim
    the award is supposed to make.

SCOPE — the elimination tree only. The 3rd- and 5th-place games decide a
finish, nothing advances from them, and by then the motivation is not the same
game. They are excluded from WPA entirely (`p > 1` games are skipped), which
matches how the site draws them: outside the bracket, under their own band.

ROUND WEIGHTS. A bye means the top seeds play one fewer game, and a
championship is not a round-1 game. Each game's WPA is scaled by its round:
round 1 counts 1.0, semifinals 1.25, the final 1.5. The weighted total is what
ranks MVP; the raw sum is kept alongside it so the unweighted figure stays
visible.

Output: merged into each season's bracket.json as "wpa":

  {"<pid>": {"rid": 4, "tot": 0.71, "wtot": 0.94,
             "wk": {"16": 0.42, "17": 0.29}}, ...}

plus per-game "wp": {"<week>": {"pre": 0.38, "t1": 1, ...}} so the site can
show the pregame line each game turned on.
"""
import argparse, json, math, sys
from itertools import combinations
from pathlib import Path

from leaguepaths import DataDir

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

# How much a game counts toward the MVP total. A bye costs the top seeds a
# game, and the championship is not round 1; without this the award drifts to
# whoever played the most rounds. Deliberately mild — these are multipliers on
# an already leverage-aware figure, not a second leverage model.
ROUND_WEIGHT = {1: 1.0, 2: 1.25, 3: 1.5}

# Prior strength for the shrinkage below, in "pseudo-games". A player with
# PRIOR_N regular-season games sits halfway between his own form and his
# position's. Four is roughly where a fantasy weekly mean stops being noise.
PRIOR_N = 4.0
# Floor on a starter's sd. A player whose weeks happened to land identically
# must not arrive as a certainty — that would hand him the entire swing.
MIN_SD = 2.0
# Fallback for a starter with NO regular-season weeks (a waiver-wire dart, a
# player who arrived mid-playoffs). Position prior only.
DEFAULT_POS = "?"


def phi(z):
    """Standard normal CDF."""
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def win_prob(mu_a, var_a, mu_b, var_b):
    """P(team A outscores team B) under the normal approximation."""
    sd = math.sqrt(max(var_a + var_b, 1e-9))
    return phi((mu_a - mu_b) / sd)


def shrink(scores, pos_mean, pos_sd):
    """A starter's (mean, sd) — his own weekly form pulled toward his
    position's, weighted by how many weeks he actually played. Someone with
    two games is mostly his position; someone with fourteen is mostly himself."""
    n = len(scores)
    if not n:
        return pos_mean, max(pos_sd, MIN_SD)
    m = sum(scores) / n
    if n > 1:
        var = sum((x - m) ** 2 for x in scores) / (n - 1)
        sd = math.sqrt(var)
    else:
        sd = pos_sd
    w = n / (n + PRIOR_N)
    return (w * m + (1 - w) * pos_mean,
            max(w * sd + (1 - w) * pos_sd, MIN_SD))


def shapley_wpa(mus, vars_, actuals, opp_actual):
    """Exact Shapley values of each starter's result on his team's P(win),
    CONDITIONAL ON THE OPPONENT'S FINAL SCORE.

    The characteristic function of a coalition S is the team's win probability
    when every player in S has been revealed at his ACTUAL score and everyone
    else is still an unresolved draw from his own distribution. Player i's
    value is the average marginal gain of adding him to S, over all orderings.

    Conditioning on `opp_actual` is what makes the allocation exact. Revealing
    only our own nine while the opponent stayed a distribution left the full
    coalition at "P(our final score beats their distribution)" — near 1 or 0
    but not equal to it — so the values summed to the wrong total and had to be
    rescaled, which blew up whenever that sum was small. With the opponent's
    score known, the full coalition IS the result: variance goes to zero and
    the probability is exactly 1 or 0. So the values sum, with no correction,
    to (1 if won else 0) - P(win | opponent's score, our pregame form).

    That baseline is the honest one for attribution: it asks what the nine
    starters did about the number they actually had to beat. The two-sided
    pregame probability is still reported per game, for display.

    Returns (values, baseline). len(values) == len(mus).
    """
    n = len(mus)
    if n == 0:
        return [], 0.0
    idx = list(range(n))

    cache = {}

    def wp(s):
        """win probability with the coalition `s` revealed at actual score"""
        if s not in cache:
            mu = sum(actuals[i] if i in s else mus[i] for i in idx)
            # a revealed player carries no uncertainty any more
            var = sum(0.0 if i in s else vars_[i] for i in idx)
            cache[s] = win_prob(mu, var, opp_actual, 0.0)
        return cache[s]

    # weight of a coalition of size k in the Shapley sum over n players
    fact = [math.factorial(k) for k in range(n + 1)]
    out = []
    for i in idx:
        others = [j for j in idx if j != i]
        total = 0.0
        for k in range(n):
            w = fact[k] * fact[n - k - 1] / fact[n]
            for combo in combinations(others, k):
                s = frozenset(combo)
                total += w * (wp(s | {i}) - wp(s))
        out.append(total)
    return out, wp(frozenset())


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8")) if Path(p).exists() else None


def season_wpa(season, ld, raw_root, verbose=True):
    """Compute WPA for one season. Returns (wpa, wp_by_game) or None."""
    sdir = ld / season
    bracket = load(sdir / "bracket.json")
    weekly = load(sdir / "weekly.json")
    if not bracket or not weekly:
        return None
    players = load(ld / "players_min.json") or {}

    # --- each player's regular-season form -----------------------------------
    # weekly.json rows are [week, pts, paa, par, waa, war]; it holds the
    # REGULAR season only, which is exactly the baseline we want — playoff
    # weeks must not calibrate the yardstick they are measured against.
    form = {pid: [r[1] for r in rows] for pid, rows in weekly.items()}
    by_pos = {}
    for pid, scores in form.items():
        pos = (players.get(pid) or [None, DEFAULT_POS])[1]
        by_pos.setdefault(pos, []).extend(scores)
    pos_stat = {}
    for pos, xs in by_pos.items():
        m = sum(xs) / len(xs)
        var = sum((x - m) ** 2 for x in xs) / max(len(xs) - 1, 1)
        pos_stat[pos] = (m, max(math.sqrt(var), MIN_SD))
    all_scores = [x for xs in by_pos.values() for x in xs]
    if all_scores:
        gm = sum(all_scores) / len(all_scores)
        gsd = math.sqrt(sum((x - gm) ** 2 for x in all_scores) / max(len(all_scores) - 1, 1))
    else:
        gm, gsd = 10.0, 6.0
    pos_stat.setdefault(DEFAULT_POS, (gm, max(gsd, MIN_SD)))

    def dist(pid):
        pos = (players.get(pid) or [None, DEFAULT_POS])[1]
        pm, psd = pos_stat.get(pos, pos_stat[DEFAULT_POS])
        return shrink(form.get(pid, []), pm, psd)

    # --- starters and their actual points, per playoff week -------------------
    # bracket.json's `stars` is keyed by pid; we need it keyed by (week, rid),
    # so re-read the raw week dumps, which carry the lineups directly.
    wpa = {}
    wp_games = {}
    checks = []
    for g in bracket["winners"]:
        # ELIMINATION TREE ONLY — placement games decide a finish and nothing
        # advances from them, so they never enter WPA (see module docstring).
        if g.get("p") and g["p"] > 1:
            continue
        wk = g["week"]
        wf = load(raw_root / season / "matchups" / f"week_{wk}.json") or []
        by_rid = {t.get("roster_id"): t for t in wf}
        t1, t2 = g.get("t1"), g.get("t2")
        if t1 is None or t2 is None or t1 not in by_rid or t2 not in by_rid:
            continue

        sides = {}
        for rid in (t1, t2):
            t = by_rid[rid]
            pp = t.get("players_points") or {}
            starters = [str(p) for p in (t.get("starters") or []) if p]
            mus, vs, acts = [], [], []
            for pid in starters:
                m, sd = dist(pid)
                mus.append(m); vs.append(sd * sd)
                acts.append(float(pp.get(pid, 0.0)))
            sides[rid] = {"pids": starters, "mus": mus, "vars": vs, "acts": acts}

        a, b = sides[t1], sides[t2]
        mu_a, var_a = sum(a["mus"]), sum(a["vars"])
        mu_b, var_b = sum(b["mus"]), sum(b["vars"])
        pre_a = win_prob(mu_a, var_a, mu_b, var_b)
        w = ROUND_WEIGHT.get(g["r"], 1.0)

        for rid, opp in ((t1, t2), (t2, t1)):
            s, o = sides[rid], sides[opp]
            opp_actual = sum(o["acts"])
            vals, base = shapley_wpa(s["mus"], s["vars"], s["acts"], opp_actual)
            checks.append((season, wk, rid, sum(vals),
                           (1.0 if g.get("w") == rid else 0.0) - base))
            for pid, v in zip(s["pids"], vals):
                rec = wpa.setdefault(pid, {"rid": rid, "tot": 0.0, "wtot": 0.0, "wk": {}})
                rec["rid"] = rid
                rec["tot"] += v
                rec["wtot"] += v * w
                rec["wk"][str(wk)] = round(rec["wk"].get(str(wk), 0.0) + v, 4)

        wp_games[str(wk) + "." + str(t1)] = {
            "week": wk, "r": g["r"], "weight": w,
            "t1": t1, "t2": t2, "pre_t1": round(pre_a, 4),
            "mu_t1": round(mu_a, 2), "mu_t2": round(mu_b, 2),
        }

    for pid, rec in wpa.items():
        rec["tot"] = round(rec["tot"], 4)
        rec["wtot"] = round(rec["wtot"], 4)

    # efficiency: every side's values must sum to its realised swing
    bad = [c for c in checks if abs(c[3] - c[4]) > 1e-6]
    if bad:
        raise AssertionError(f"Shapley efficiency violated: {bad[:3]}")
    if verbose:
        top = sorted(wpa.items(), key=lambda kv: -kv[1]["wtot"])[:3]
        names = {p: (players.get(p) or ["?"])[0] for p, _ in top}
        line = " · ".join(f"{names[p]} {v['wtot']:+.3f}" for p, v in top)
        print(f"  {season}: {len(checks)} sides over "
              f"{len(wp_games)} games · MVP {line}")
    return wpa, wp_games


def main():
    ap = argparse.ArgumentParser(description="playoff WPA (Shapley, per matchup)")
    ap.add_argument("--season", help="one season (default: all with a bracket)")
    ap.add_argument("--raw", default=str(ROOT / "sleeper_data"),
                    help="raw Sleeper dumps (week lineups live here)")
    ap.add_argument("--probe", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    ld = Path(str(DATA))
    raw_root = Path(args.raw)
    seasons = ([args.season] if args.season
               else sorted(d.name for d in ld.iterdir()
                           if d.is_dir() and d.name.isdigit()
                           and (d / "bracket.json").exists()))
    if not seasons:
        sys.exit("no season has a bracket.json — run build_site_data.py first")

    print(f"playoff WPA · round weights {ROUND_WEIGHT}")
    n = 0
    for s in seasons:
        got = season_wpa(s, ld, raw_root)
        if not got:
            print(f"  {s}: no bracket/weekly — skipped")
            continue
        wpa, wp_games = got
        if args.probe:
            continue
        f = ld / s / "bracket.json"
        b = json.loads(f.read_text(encoding="utf-8"))
        b["wpa"] = wpa
        b["wp"] = wp_games
        b["wpa_meta"] = {"round_weight": {str(k): v for k, v in ROUND_WEIGHT.items()},
                         "prior_n": PRIOR_N, "min_sd": MIN_SD,
                         "scope": "elimination games only; placement games excluded"}
        f.write_text(json.dumps(b), encoding="utf-8")
        n += 1
    print(f"\n{'probe: nothing written' if args.probe else f'wrote {n} bracket.json'}")


if __name__ == "__main__":
    main()
