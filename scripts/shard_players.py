#!/usr/bin/env python3
"""
shard_players.py — split the two big per-player JSON blobs into one small file
per player, so a player page fetches ~2 KB instead of ~600 KB.

  python scripts/shard_players.py --out data

Run AFTER project_war.py and fetch_projections.py (it reads their output).

Inputs:
  data/projections.json    {meta:{years,...}, players:[{pid,...}, ...]}   ~324 KB
  data/proj_sleeper.json   {meta:{...}, players:{pid: {...}}}             ~273 KB
  data/players_min.json    the ids the site actually references (the gate)

Output:
  data/player/<pid>.json   {"years": [...], "proj": {...}|null, "sproj": {...}|null}

proj_sleeper covers every NFL player (~3100), but only ids in players_min.json
are reachable from the site, so shards are gated on that (~800 files) rather
than committing thousands of files nothing can link to.

A player with no record in either source gets no shard; the site treats a 404
as "no projection" and falls back to the plain WAR trend chart, which is the
same behaviour as before sharding.
"""
import argparse, json, shutil
from pathlib import Path

def load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    out = Path(args.out)

    projf = load(out / "projections.json") or {}
    sprojf = load(out / "proj_sleeper.json") or {}
    years = ((projf.get("meta") or {}).get("years")) or []
    proj = {r["pid"]: r for r in (projf.get("players") or []) if r.get("pid")}
    sproj = sprojf.get("players") or {}
    reachable = set(load(out / "players_min.json") or {})

    pdir = out / "player"
    # rebuild from scratch: a player who drops off every roster must lose his
    # shard, or the site would serve last season's projection forever
    if pdir.exists():
        shutil.rmtree(pdir)
    pdir.mkdir(parents=True)

    wanted = (set(proj) | set(sproj)) & reachable
    for pid in sorted(wanted):
        (pdir / f"{pid}.json").write_text(json.dumps({
            "years": years,
            "proj": proj.get(pid),
            "sproj": sproj.get(pid),
        }), encoding="utf-8")

    print(f"wrote {len(wanted)} player shards to {pdir}/ "
          f"({len(proj)} projected, {len(sproj)} with Sleeper projections, "
          f"{len(reachable)} reachable ids)")

if __name__ == "__main__":
    main()
