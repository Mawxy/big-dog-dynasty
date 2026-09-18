#!/usr/bin/env python3
"""
probe_sleeper_vintage.py — is a PAST season's Sleeper projection the August
forecast, or a number that has already seen the season?

WHY THIS EXISTS (Max, 2026-09-18)

The four composite curves are built on proj_sleeper.json and the repo keeps one
vintage of it, so backtest_curves.py grades only the four naturals. But the
endpoint takes a season in its path and /projections/nfl/2021 does return rows
(rotowire, category "proj", week null, every timestamp null). The question is
what those rows are worth.

  preseason vintage  -> the composites are gradeable eight seasons deep now
  in-season update   -> scoring a composite on them is scoring against the
                        answer sheet

WHAT THE FIRST VERSION OF THIS SCRIPT GOT WRONG

It pooled QB, RB, WR and TE into one correlation against realized points and
called 0.83 "suspicious". That number is mostly positional means: quarterbacks
outscore tight ends about two to one, so pooling four positions buys ~0.8
correlation before any player-level skill at all. It also joined only players
who appear in waa_war_<season>.csv, i.e. players who PLAYED, which drops every
week-1 injury and inflates the result again. Both are fixed below.

THE FOUR TESTS, in descending order of how much they settle

1. GAMES. `stats.gp` is in the payload. A forecast gives nearly everyone a full
   16 or 17 because it is not predicting injuries; a backfill gives the games
   actually played. This is binary and needs no threshold. It is the test.

2. THE WRECKED SEASONS. Players whose realized games came in far under a full
   year. A forecast still has them near a full season's points; an updated
   number has collapsed. Named, so the answer is checkable by eye.

3. PER-POSITION correlation, which is the honest version of test 1 from the
   first script. Preseason forecasts of fantasy points run about 0.5-0.7
   against the outcome WITHIN a position. Above ~0.9 within a position is not
   a forecast.

4. ADP AGREEMENT, where the payload carries ADP (2021 does, 2018 does not).
   ADP is definitionally a preseason quantity. A projection that tracks its own
   ADP closely was built alongside it, in August.

WRITES NOTHING. `fetch_projections.py --season 2021` would overwrite
data/<league>/proj_sleeper.json and stamp a fake vintage into
proj_sleeper_history/. Do not run that. Run this.

Usage:  python scripts/probe_sleeper_vintage.py            (2021 and 2018)
        python scripts/probe_sleeper_vintage.py 2024 2021 2018 2015
"""
import csv
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sleeper_http import get                                   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "nfl_history"
PROJ_HOST = "https://api.sleeper.app"
POSITIONS = ("QB", "RB", "WR", "TE")
FULL = 16          # seasons before 2021 are 16 games; 2021+ are 17


def pull(season, pos):
    return get(f"{PROJ_HOST}/projections/nfl/{season}"
               f"?season_type=regular&position[]={pos}&order_by=pts_ppr") or []


def realized(season):
    """gsis -> (points, games) actually recorded that season."""
    for d in (HIST, HIST / "early"):
        f = d / f"waa_war_{season}.csv"
        if f.exists():
            return {r["player_id"]: (float(r["pts"]), int(r["gp"]))
                    for r in csv.DictReader(open(f, encoding="utf-8")) if r["player_id"]}
    return {}


def norm(s):
    return s.strip().lower().replace(".", "").replace("'", "").replace("-", " ")


def meta_index():
    idx = {}
    for r in csv.DictReader(open(HIST / "players_meta.csv", encoding="utf-8")):
        if r["gsis_id"]:
            idx[(norm(r["name"]), r["pos"])] = r["gsis_id"]
            if r.get("common"):
                idx.setdefault((norm(r["common"]), r["pos"]), r["gsis_id"])
    return idx


def corr(xs, ys):
    n = len(xs)
    if n < 8:
        return None
    mx, my = sum(xs)/n, sum(ys)/n
    num = sum((a-mx)*(b-my) for a, b in zip(xs, ys))
    den = (sum((a-mx)**2 for a in xs) * sum((b-my)**2 for b in ys)) ** 0.5
    return num/den if den else None


def main():
    seasons = [int(a) for a in sys.argv[1:]] or [2021, 2018]
    idx = meta_index()

    for season in seasons:
        full = 17 if season >= 2021 else FULL
        print(f"\n{'='*72}\nSEASON {season}   (a full year is {full} games)\n{'='*72}")
        rows = []
        for pos in POSITIONS:
            for it in pull(season, pos):
                rows.append((pos, it))
        if not rows:
            print("  nothing returned — the endpoint does not serve this season")
            continue
        it0 = rows[0][1]
        st0 = it0.get("stats") or {}
        print(f"  {len(rows)} rows · company {it0.get('company')} · "
              f"category {it0.get('category')} · week {it0.get('week')}")
        print(f"  has ADP keys: {'yes' if any(k.startswith('adp') for k in st0) else 'no'}"
              f" · stat keys {len(st0)}")

        act = realized(season)
        if not act:
            print(f"  no nfl_history/waa_war_{season}.csv — cannot judge this season")
            continue

        joined = []
        for pos, it in rows:
            pl = it.get("player") or {}
            nm = norm(f"{pl.get('first_name','')} {pl.get('last_name','')}")
            g = idx.get((nm, pos))
            s = it.get("stats") or {}
            pts = s.get("pts_ppr") or s.get("pts_half_ppr") or s.get("pts_std")
            if g and g in act and isinstance(pts, (int, float)):
                a_pts, a_gp = act[g]
                joined.append({"pos": pos, "name": nm, "pts": float(pts),
                               "gp": s.get("gp"), "a_pts": a_pts, "a_gp": a_gp,
                               "adp": s.get("adp_ppr")})
        print(f"  joined {len(joined)} players to realized {season}")
        if len(joined) < 30:
            print("  too few joins to judge")
            continue

        # ---- 1. GAMES -----------------------------------------------------
        print("\n  [1] PROJECTED GAMES — the decisive one")
        with_gp = [j for j in joined if isinstance(j["gp"], (int, float))]
        if not with_gp:
            print("      no `gp` in the payload; falls through to the other tests")
        else:
            gps = [float(j["gp"]) for j in with_gp]
            fullish = sum(1 for g in gps if g >= full - 1)
            rg = corr(gps, [float(j["a_gp"]) for j in with_gp])
            print(f"      median projected gp {statistics.median(gps):.1f} of {full} · "
                  f"{fullish/len(gps):.0%} at a full season")
            print(f"      corr(projected gp, ACTUAL gp) = "
                  f"{rg:.3f}" if rg is not None else "      corr n/a")
            if fullish > 0.85 and (rg is None or rg < 0.5):
                print("      -> FORECAST. Everyone is given a full year, which is what a")
                print("         projection does and what a backfill never does.")
            elif rg is not None and rg > 0.8:
                print("      -> BACKFILL. Projected games track the games actually played.")
            else:
                print("      -> ambiguous; lean on tests 2 and 3.")

        # ---- 2. THE WRECKED SEASONS ---------------------------------------
        print("\n  [2] PLAYERS WHOSE SEASON WAS WRECKED (realized games <= 40% of a year)")
        hurt = sorted([j for j in joined if j["a_gp"] <= full * 0.4 and j["pts"] > 40],
                      key=lambda j: -j["pts"])[:8]
        if not hurt:
            print("      none joined")
        else:
            print(f"      {'player':<24}{'pos':>4}{'proj pts':>10}{'actual':>9}{'act gp':>8}")
            for j in hurt:
                print(f"      {j['name'][:23]:<24}{j['pos']:>4}{j['pts']:>10.1f}"
                      f"{j['a_pts']:>9.1f}{j['a_gp']:>8}")
            print("      A projection still has these men near a full season's points.")
            print("      An updated number has collapsed to roughly what they scored.")

        # ---- 3. PER-POSITION CORRELATION ----------------------------------
        print("\n  [3] CORRELATION WITHIN EACH POSITION (pooling four positions was the")
        print("      first script's error — it buys ~0.8 from positional means alone)")
        by = defaultdict(list)
        for j in joined:
            by[j["pos"]].append(j)
        for pos in POSITIONS:
            v = by[pos]
            r = corr([j["pts"] for j in v], [j["a_pts"] for j in v])
            print(f"      {pos}: n={len(v):<4} r={r:.3f}" if r is not None
                  else f"      {pos}: n={len(v):<4} r=n/a")
        allr = [corr([j["pts"] for j in by[p]], [j["a_pts"] for j in by[p]])
                for p in POSITIONS if corr([j["pts"] for j in by[p]],
                                           [j["a_pts"] for j in by[p]]) is not None]
        if allr:
            m = statistics.mean(allr)
            print(f"      mean within-position r = {m:.3f}  ->  "
                  + ("FORECAST range (0.5-0.7 is normal for August)" if m < 0.75
                     else "TOO HIGH for a forecast; treat as leaky" if m > 0.9
                     else "borderline; test 1 decides"))

        # ---- 4. ADP -------------------------------------------------------
        adp = [j for j in joined if isinstance(j["adp"], (int, float)) and j["adp"] > 0]
        if adp:
            r = corr([-j["adp"] for j in adp], [j["pts"] for j in adp])
            r2 = corr([-j["adp"] for j in adp], [j["a_pts"] for j in adp])
            print(f"\n  [4] ADP is present on {len(adp)} rows (a preseason quantity by definition)")
            print(f"      corr(ADP, THIS projection) = {r:.3f}")
            print(f"      corr(ADP, actual points)   = {r2:.3f}")
            print("      -> the projection tracking ADP more tightly than the outcome does"
                  if r is not None and r2 is not None and r > r2
                  else "      -> the projection tracks the OUTCOME more tightly than ADP does,"
                       " which a August number should not")


if __name__ == "__main__":
    main()
