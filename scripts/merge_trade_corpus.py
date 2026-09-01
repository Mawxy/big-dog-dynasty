#!/usr/bin/env python3
"""
merge_trade_corpus.py — union the sharded crawl outputs into one corpus.

The trades crawl runs as a 4-way matrix; each shard uploads
data/trade_corpus_<shard>.json as an artifact (too large to commit). This
script unions those shards — plus any existing data/trade_corpus.json, so a
shard whose CI cache was evicted (7-day window) cannot silently shrink the
corpus — deduped by transaction_id, which is globally unique on Sleeper.

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
    n_in = 0
    sources = [DATA / "trade_corpus.json",
               *sorted(DATA.glob("trade_corpus_[0-9].json"))]
    for src in sources:
        d = load(src)
        for t in (d or {}).get("trades", []):
            if t.get("tid"):
                n_in += 1
                # later sources win: a shard row carries `lid`, which the
                # oldest committed corpus predates
                trades[t["tid"]] = t
    if not trades:
        sys.exit("no shard files and no existing corpus — nothing to merge")

    prev = load(DATA / "trade_corpus.json") or {}
    # Coverage, not eligibility: crawl_leagues.json counts every league the
    # crawl WILL work through (~80k), but the board's "across N leagues" claim
    # must only count leagues whose trades are actually in the corpus. Shard
    # rows carry `lid`; the oldest committed rows predate it, so fall back to
    # the previous count rather than undercounting to the lid-bearing subset.
    lids = {t["lid"] for t in trades.values() if t.get("lid")}
    out = {"generated": datetime.date.today().isoformat(),
           "season": prev.get("season"),
           "leagues": max(len(lids), prev.get("leagues") or 0) or None,
           "trades": list(trades.values())}
    write_json(DATA / "trade_corpus.json", out, separators=(",", ":"))
    print(f"merged {len(sources)} file(s), {n_in} rows -> "
          f"{len(trades)} unique trades, {out['leagues']} leagues")


if __name__ == "__main__":
    main()
