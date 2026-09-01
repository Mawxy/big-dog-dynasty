#!/usr/bin/env python3
"""
shard_players.py — split the big per-player JSON blobs into one small file per
player, so a player page fetches ~2 KB instead of ~1.6 MB.

  python scripts/shard_players.py --out data

Run LAST of the projection chain — after project_war.py, fetch_projections.py,
project_war_knn.py and project_matrix.py, all of which it reads. Running it
before the last two (where it sat in data-refresh.yml until 2026-09-01) is not
merely stale: it pairs the PREVIOUS night's six curves with the current night's
scalar projection inside one file, so the player page's projection table would
disagree with itself by a day.

Inputs:
  data/projections.json              {meta:{years,...}, players:[{pid,...}]}
  data/proj_sleeper.json             {meta:{...}, players:{pid: {...}}}
  data/projections_matrix.json       the six curves, one row per priced player
  data/projections_knn_hybrid.json   the analog model + named comparables
  data/players_min.json              the ids the site actually references (gate)

Output:
  data/player/<pid>.json
    {"years":[...], "proj":{...}|null, "sproj":{...}|null,
     "mx":{...}, "blend_w":[...], "knn":{...}}

WHAT GOES IN, AND WHAT DOES NOT. The shard carries exactly what
`src/views/Player.tsx` renders and nothing else — its whole reason to exist is
that a page should not download a league-wide file to read one row:

  * `mx` is the player's WHOLE matrix row (~600 B). Every field but `totals` is
    on screen, and typing the shard field as `MatrixRow` keeps the page's
    fifteen reads of it working; splitting it would save ~150 B a visit and buy
    a silent breakage the next time the table shows one more figure.
  * `knn` is a SUBSET of his KnnProjection — `n`, `sim_med`, `low`, `high` and
    the `near` comparables. That is 554 B of a 1013 B row; the rest is the
    cohort's own diagnostics and the fitted/expected paths, none of which the
    page draws. Here the cut is worth making, and `near` is the reason the
    analog file is 788 KB in the first place.
  * `blend_w` is projections_matrix.json's meta.blend_w, the one figure the page
    reads out of that file's HEADER (the Sleeper-weight tooltip). Copying three
    numbers into every shard costs ~14 KB across the tree and removes the last
    reason to fetch the whole matrix.

A field is OMITTED, never written as null, when the player has no row in that
source — the page reads `shard?.mx ?? null` either way, and an absent key keeps
the ~200 shards that carry only an analog read small.

The gate is players_min.json: proj_sleeper and the analog corpus between them
cover every NFL player (~3100), but only ids the site can name are reachable, so
shards are gated on it rather than committing thousands of files nothing links
to. A player with no record in ANY source gets no shard; the site treats a 404
as "no projection" and falls back to the plain WAR trend chart, which is the
same behaviour as before sharding.

CRASH SAFETY. This used to `shutil.rmtree(player/)` and then make ~800
`write_text` calls: a crash, a cancelled run or a job timeout anywhere in that
loop left the COMMITTED shard directory gutted, and the next commit step
published the hole. Each shard is now written atomically in place (ioutil), and
files no longer wanted are pruned only after every write has landed. A rebuild
is therefore not all-or-nothing — but nothing here needs it to be, because a
shard is self-contained and shares no invariant with its neighbours. What
matters is that the directory is never empty and every file in it always parses,
which a dir-swap could not promise on Windows without a rename window of its
own.
"""
import argparse, json, sys
from pathlib import Path

from ioutil import atomic_write
from leaguepaths import DataDir

#: the fields of a KnnProjection the player page actually renders
KNN_KEYS = ("n", "sim_med", "low", "high", "near")

def load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None

def by_pid(rows):
    """List-of-rows -> {pid: row}, skipping rows with no Sleeper id.

    The analog corpus is keyed by gsis and carries `pid: null` for a historical
    player who could not be joined — a row nothing on the site can link to.
    """
    return {r["pid"]: r for r in (rows or []) if r.get("pid")}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    # --out is the data ROOT; the shards belong to the league inside it
    out = DataDir(Path(args.out))

    projf = load(out / "projections.json") or {}
    sprojf = load(out / "proj_sleeper.json") or {}
    mxf = load(out / "projections_matrix.json") or {}
    knnf = load(out / "projections_knn_hybrid.json") or {}
    years = ((projf.get("meta") or {}).get("years")) or []
    blend_w = ((mxf.get("meta") or {}).get("blend_w")) or None
    proj = by_pid(projf.get("players"))
    sproj = sprojf.get("players") or {}
    mx = by_pid(mxf.get("players"))
    knn = {pid: {k: r[k] for k in KNN_KEYS if k in r}
           for pid, r in by_pid(knnf.get("players")).items()}
    reachable = set(load(out / "players_min.json") or {})

    pdir = out / "player"
    # The PROJECTION sources decide whether a rebuild is legitimate at all...
    core = (set(proj) | set(sproj)) & reachable
    # ...but a player the analog arm alone knows about still gets a shard: his
    # page draws the comparables table, which before enrichment came out of the
    # whole-file fetch. Dropping him here would delete that table from ~200
    # pages while calling it a performance fix.
    wanted = core | ((set(mx) | set(knn)) & reachable)
    # never wipe committed shards because the inputs were missing — that's a
    # silent local-run data-loss mode, not a legitimate rebuild
    if not reachable:
        sys.exit(f"refusing to rebuild {pdir}: {out / 'players_min.json'} "
                 "missing or empty")
    if not core and pdir.exists() and any(pdir.iterdir()):
        sys.exit(f"refusing to wipe {pdir}: no projection inputs loaded "
                 f"(projections.json={bool(projf)}, "
                 f"proj_sleeper.json={bool(sprojf)}) but shards are present")

    pdir.mkdir(parents=True, exist_ok=True)
    for pid in sorted(wanted):
        rec = {"years": years, "proj": proj.get(pid), "sproj": sproj.get(pid)}
        row = mx.get(pid)
        if row is not None:
            rec["mx"] = row
            if blend_w:
                rec["blend_w"] = blend_w
        k = knn.get(pid)
        if k:
            rec["knn"] = k
        # same serialization as ever — compact, no trailing newline — only now
        # it lands whole or not at all
        atomic_write(pdir / f"{pid}.json",
                     json.dumps(rec, separators=(",", ":")))

    # Prune LAST, so a crash mid-write leaves a directory of valid shards rather
    # than a hole. A player who drops off every roster must lose his shard or
    # the site serves last season's projection forever; anything that is not a
    # wanted shard goes, which also sweeps a `.tmp` orphan left by a hard kill
    # (the commit step stages this directory, so a stray temp file would be
    # published).
    stale = 0
    for f in pdir.iterdir():
        if f.is_file() and (f.suffix != ".json" or f.stem not in wanted):
            f.unlink()
            stale += 1

    print(f"wrote {len(wanted)} player shards to {pdir}/ "
          f"({len(proj)} projected, {len(sproj)} with Sleeper projections, "
          f"{len(set(mx) & wanted)} with a matrix row, "
          f"{len(set(knn) & wanted)} with an analog read, "
          f"{len(reachable)} reachable ids, {stale} stale removed)")

if __name__ == "__main__":
    main()
