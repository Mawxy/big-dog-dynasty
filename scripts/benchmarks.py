#!/usr/bin/env python3
"""
benchmarks.py — merge the outcome-crawl shards into one publishable file.

The crawl emits COUNTS AND SUMS only, per shard, because four shards merge by
addition and a rate cannot be added. This does the addition once, divides at
the end, and writes the rates the site reads.

Input:  data/outcome_signals_<shard>.json (committed by the outcomes crawl)
Output: data/benchmarks.json

Every published figure carries its own denominator alongside it, so a reader
can see what a rate is built on rather than trusting a percentage with three
observations behind it. Anything below MIN_N publishes null.

Usage:
  python scripts/benchmarks.py
  python scripts/benchmarks.py 'scratch/sample_signals_*.json' --out scratch/benchmarks.json
"""
import argparse
import glob
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from leaguepaths import DataDir                      # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SLOTS = ["qb1", "qb2", "rb1", "rb2", "wr1", "wr2", "wr3", "te1"]
MIN_N = 20            # below this a rate is noise and publishes null
LEAGUE_YEAR_CAP = 8


def merge(patterns):
    counts, meta = defaultdict(int), {}
    files = []
    for pat in patterns:
        files.extend(sorted(glob.glob(pat)))
    for f in files:
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        for k, v in (d.get("counts") or {}).items():
            counts[k] += v
        meta.setdefault("horizon", d.get("horizon"))
        meta.setdefault("row_fields", d.get("row_fields"))
        meta["generated"] = max(meta.get("generated", ""), d.get("generated", ""))
    return counts, meta, files


def rate(counts, num, den, floor=MIN_N):
    """num/den with its denominator attached, or null when too thin."""
    n, d = counts.get(num, 0), counts.get(den, 0)
    return {"v": round(n / d, 4) if d >= floor else None, "n": d, "of": n}


def per(counts, num, den, scale=1.0, floor=MIN_N):
    n, d = counts.get(num, 0), counts.get(den, 0)
    return {"v": round(n / d * scale, 3) if d >= floor else None, "n": d}


def build(counts, meta, files):
    champs = counts.get("champs", 0)
    out = {
        "meta": {
            "generated": meta.get("generated"),
            "shards": len(files),
            "league_seasons": counts.get("league_seasons", 0),
            "champions": champs,
            "rosters": counts.get("field_slot_n", 0),
            "horizon": meta.get("horizon"),
            "min_n": MIN_N,
            "note": "counts merged across shards, divided once here; every rate "
                    "carries its denominator",
        },
        # --- what a championship lineup is worth, slot by slot ---------------
        "slots": [{
            "slot": s.upper(),
            "champ": per(counts, f"champ_{s}_war_sum", "champ_slot_n", 0.001),
            "field": per(counts, f"field_{s}_war_sum", "field_slot_n", 0.001),
        } for s in SLOTS],
        # --- roster construction, champion against the field it beat ---------
        "construction": {
            "roster_size": {"champ": per(counts, "champ_roster_sum", "champ_roster_n"),
                            "field": per(counts, "field_roster_sum", "field_roster_n")},
            "homegrown": {"champ": rate(counts, "champ_homegrown_sum", "champ_roster_sum"),
                          "field": rate(counts, "field_homegrown_sum", "field_roster_sum")},
            "experience": {"champ": per(counts, "champ_exp_sum", "champ_exp_n"),
                           "field": per(counts, "field_exp_sum", "field_exp_n")},
            **{p: {"champ": per(counts, f"champ_{p}_sum", "champ_roster_n"),
                   "field": per(counts, f"field_{p}_sum", "field_roster_n")}
               for p in ("qb", "rb", "wr", "te")},
        },
        # --- draft capital ----------------------------------------------------
        "picks": {
            "kept_own_1st": rate(counts, "champ_kept_own_1st", "champs"),
            "traded_own_1st": {"v": round(1 - counts.get("champ_kept_own_1st", 0) / champs, 4)
                               if champs >= MIN_N else None, "n": champs},
            "r1_held": {"champ": per(counts, "champ_r1_held", "champs"),
                        "field": per(counts, "field_r1_held", "field_rosters")},
            "net_picks": per(counts, "champ_net_picks", "champs"),
            "bought": rate(counts, "champ_bought", "champs"),
            "sold": rate(counts, "champ_sold", "champs"),
        },
        # --- drafted share by LEAGUE year, not calendar year ------------------
        # A dynasty roster starts fully drafted and is traded away from over
        # time, so this only means anything against the league's own age.
        "by_league_year": [{
            "year": y,
            "league_seasons": counts.get(f"y{y}_league_seasons", 0),
            "champ": rate(counts, f"y{y}_champ_homegrown_sum", f"y{y}_champ_roster_sum"),
            "field": rate(counts, f"y{y}_field_homegrown_sum", f"y{y}_field_roster_sum"),
        } for y in range(1, LEAGUE_YEAR_CAP + 1)],
        # --- playoff persistence and how teams climb in --------------------
        "playoffs": {
            "stayed": rate(counts, "playoff_stayed", "made_playoffs"),
            "climbed": rate(counts, "missed_then_made", "missed_playoffs"),
            "climber_homegrown": rate(counts, "climber_homegrown_sum", "climber_roster_sum"),
            "stuck_homegrown": rate(counts, "stuck_homegrown_sum", "stuck_roster_sum"),
        },
        # --- turnaround, keyed by how many seasons a finish actually had ------
        "turnaround": {
            "bottom_finishes": counts.get("bottom_finishes", 0),
            "no_room": counts.get("bottom_no_room", 0),
            "within": [{
                "years": k,
                "title": rate(counts, f"to_title_within_{k}", f"room_{k}"),
                "top_third": rate(counts, f"to_top_within_{k}", f"room_{k}"),
            } for k in range(1, (meta.get("horizon") or 5) + 1)],
            "avg_place_move": per(counts, "move_abs_sum", "move_n"),
        },
    }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="*", default=None,
                    help="signals files or globs (default: data/outcome_signals_*.json)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    pats = args.inputs or [str(ROOT / "data" / "outcome_signals_*.json")]
    counts, meta, files = merge(pats)
    if not files:
        raise SystemExit(f"no signals files matched {pats}")
    out = build(counts, meta, files)
    dest = Path(args.out) if args.out else DataDir(ROOT / "data") / "benchmarks.json"
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    Path(dest).write_text(json.dumps(out), encoding="utf-8")
    m = out["meta"]
    print(f"wrote {dest} — {len(files)} shard(s), {m['league_seasons']} league-seasons, "
          f"{m['champions']} champions, {m['rosters']} rosters")
    for s in out["slots"]:
        print(f"  {s['slot']:<5} champ {s['champ']['v']}  field {s['field']['v']}")


if __name__ == "__main__":
    main()
