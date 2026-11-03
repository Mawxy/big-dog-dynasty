#!/usr/bin/env python3
"""
merge_trade_corpus.py — union the sharded crawl outputs into one corpus.

The trades crawl runs as a 4-way matrix; each shard uploads
data/trade_corpus_<shard>.json as an artifact (too large to commit). This
script unions those shards, deduped by transaction_id, which is globally unique
on Sleeper.

There is NO committed corpus behind them: data/trade_corpus.json is gitignored, so
a CI checkout never has one and a shard that failed, or whose cache was evicted
(7-day window), really does shrink the merge. That is why fewer than EXPECTED_SHARDS
is a ::warning. An existing data/trade_corpus.json is still unioned in, which only
ever does anything on a machine that kept one from a hand run.

The merged file carries the league count from data/crawl_leagues.json: the
shard outputs don't know it, and dynasty_movers.py surfaces it in its meta.

Usage: python scripts/merge_trade_corpus.py  (run from anywhere; paths are
       repo-relative)
"""
import datetime, json, sys
from pathlib import Path

from ioutil import write_json

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
EXPECTED_SHARDS = 4        # the crawl-trades.yml matrix


def shard_warning(n_merged, expected=EXPECTED_SHARDS):
    """The ::warning for a merge that is missing shards, or None for a full set."""
    if n_merged >= expected:
        return None
    return (f"::warning title=Trade corpus short of shards::merged {n_merged} of "
            f"{expected} shards; the movers board and recent trades are missing "
            f"that share of the leagues this run")


def load(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        print(f"warning: {p} did not parse — skipping it", file=sys.stderr)
        return None


def main():
    trades = {}
    n_in = n_shards = 0
    shards = sorted(DATA.glob("trade_corpus_[0-9].json"))
    sources = [DATA / "trade_corpus.json", *shards]
    for src in sources:
        d = load(src)
        if d is not None and src in shards:
            n_shards += 1
        for t in (d or {}).get("trades", []):
            if t.get("tid"):
                n_in += 1
                # later sources win: a shard row carries `lid`, which a local
                # corpus from before that field predates
                trades[t["tid"]] = t
    if not trades:
        sys.exit("no shard files and no existing corpus — nothing to merge")
    warning = shard_warning(n_shards)
    if warning:
        print(warning)

    prev = load(DATA / "trade_corpus.json") or {}
    # Coverage, not eligibility: crawl_leagues.json counts every league the
    # crawl WILL work through (~80k), but the board's "across N leagues" claim
    # must only count leagues whose trades are actually in the corpus. Shard
    # rows carry `lid`; a local corpus may predate it, so fall back to the
    # previous count rather than undercounting to the lid-bearing subset.
    lids ={t["lid"] for t in trades.values() if t.get("lid")}
    out = {"generated": datetime.date.today().isoformat(),
           "season": prev.get("season"),
           "leagues": max(len(lids), prev.get("leagues") or 0) or None,
           "trades": list(trades.values())}
    write_json(DATA / "trade_corpus.json", out, separators=(",", ":"))
    print(f"merged {len(sources)} file(s), {n_in} rows -> "
          f"{len(trades)} unique trades, {out['leagues']} leagues")


if __name__ == "__main__":
    main()
