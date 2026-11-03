#!/usr/bin/env python3
"""
crawl_guard.py — refuse to publish a crawl output that lost its sample.

A crawl's real state lives in .crawl-state, a GitHub Actions cache with a 7-day
eviction window. A cold cache starts counting from zero, and the file it writes
looks perfectly healthy: valid JSON, right shape, exit 0. On 2026-08-09 that took
data/league_signals.json from 78,019 leagues to 1,000 (the first mid-run push, then
7,257 by the end of that run), and on 08-10 all four outcome shards from about
42,000 league-seasons to about 4,500. The site and the nightly DVI/CVI read those
as the whole market until the crawl caught up five days later.

So nothing stages one of these files until its count is back within FLOOR of what
origin already has. The refused file stays in the working tree and the crawl's state
still saves to the cache, so the next run carries on from it; only the publish waits.
Replayed over the whole git history this fires on the August incident and nothing
else, so it is not fighting the in-season stale-league gate's gradual decline.

A REAL FALL OF MORE THAN 20% IN ONE STEP HOLDS TOO. Nothing here can tell that from a
cold cache, so the committed file then freezes behind a ::warning on every run until
someone looks. If the drop is real, lower FLOOR for one run and put it back.

Used by the commit steps in crawl-signals*.yml and crawl-outcomes.yml, and by
sleeper_crawl.git_push: --commit-every publishes mid-run, which is how the 1,000
went out.

  python scripts/crawl_guard.py --path data/league_signals.json
  python scripts/crawl_guard.py --path data/outcome_signals_0.json --file /tmp/saved.json

Exit 0 = stage it; 1 = refused, with the ::warning already printed. Stdlib only.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLOOR = 0.80


def sample_size(doc):
    """How much of the crawl a file represents, or None if the shape is unknown.

    league_signals*.json states `leagues`, the size of the rolling window. An
    outcome shard is counters only, so `counts.league_seasons`; the key is absent
    rather than 0 when a run has no rows yet (the counters are a defaultdict), and
    that is exactly the cold shard this exists to catch, so absent reads as 0.
    """
    if not isinstance(doc, dict):
        return None
    n = doc.get("leagues")
    if isinstance(n, int) and not isinstance(n, bool):
        return n
    counts = doc.get("counts")
    if isinstance(counts, dict):
        return counts.get("league_seasons", 0)
    return None


def verdict(new_doc, origin_doc, floor=FLOOR):
    """(ok, why). The comparison, with no I/O: `origin_doc` None = nothing to protect.

    Fails closed on the new file and open on origin's. A new file with no readable
    count cannot be shown to be whole, so it waits; an origin with none (first
    publish, older shape) has nothing a refusal would be protecting.
    """
    new = sample_size(new_doc)
    if new is None:
        return False, "no readable count"
    old = sample_size(origin_doc)
    if not old:
        return True, f"{new} (nothing at origin to compare)"
    if new < floor * old:
        return False, (f"{new} is {new / old:.0%} of origin's {old}, "
                       f"below the {floor:.0%} floor")
    return True, f"{new} vs origin's {old}"


def origin_doc(path, ref="FETCH_HEAD", cwd=ROOT):
    """The file as committed at `ref`, or None if it isn't there or doesn't parse."""
    r = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=cwd, capture_output=True)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout.decode("utf-8"))
    except ValueError:
        return None


def allow(path, file=None, ref="FETCH_HEAD", cwd=ROOT):
    """True if `path` may be staged. `file` is where this run's copy is, when that
    isn't `path` itself (the outcomes job saves its shard aside before it checks out
    origin's). Prints the ::warning on refusal, on stdout where Actions reads it."""
    try:
        doc = json.loads(Path(file or Path(cwd) / path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        doc = None
    ok, why = verdict(doc, origin_doc(path, ref, cwd))
    if ok:
        print(f"crawl guard: {path}: {why}", flush=True)
    else:
        print(f"::warning title=Crawl output held back::{path}: {why}. Not staged, so "
              f"the committed file stays in place (a cold crawl cache looks like this; "
              f"state still saves and the next run carries on).", flush=True)
    return ok


def main():
    ap = argparse.ArgumentParser(description="may this crawl output be staged?")
    ap.add_argument("--path", required=True, help="repo-relative path, as committed")
    ap.add_argument("--file", help="this run's copy, if it isn't at --path")
    ap.add_argument("--ref", default="FETCH_HEAD", help="what to compare against")
    args = ap.parse_args()
    sys.exit(0 if allow(args.path, args.file, args.ref) else 1)


if __name__ == "__main__":
    main()
