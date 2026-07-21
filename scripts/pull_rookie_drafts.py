#!/usr/bin/env python3
"""
pull_rookie_drafts.py — append a Sleeper league's rookie drafts to the
Bridge A corpus (nfl_history/rookie_drafts.csv).

Walks the previous_league_id chain backward from the league you give it and
collects every ROOKIE draft it finds. Startup drafts are skipped: they price
veterans, not rookie slots, so they'd poison the slot->WAR fit. The rookie
test is the same one draft_analysis.py already uses — max round <= 6.

The corpus is a flat CSV of picks tagged by `source` (one tag per league), so
adding a league is additive and reversible: drop the rows with that tag to
undo. Existing rows are never rewritten; a source+season already present is
left alone unless --force.

Usage:
  python scripts/pull_rookie_drafts.py 1312481172676182016 --source ninthyear
  python scripts/pull_rookie_drafts.py <league_id> --source foo --dry-run

Sanity-check the league is comparable before adding it (12-team superflex,
4-round linear rookie drafts) — --dry-run prints the shape of every draft
without writing.

No dependencies beyond the standard library. Read-only API, no auth.
"""
import argparse, csv, json, sys, time, urllib.error, urllib.request
from collections import defaultdict
from pathlib import Path

BASE = "https://api.sleeper.app/v1"
DELAY = 0.15                # keeps well under Sleeper's ~1000/min limit
RETRIES = 3
ROOKIE_MAX_ROUND = 6        # > this many rounds means it's a startup draft
ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "nfl_history" / "rookie_drafts.csv"
COLUMNS = ["season", "pick_no", "round", "sleeper_id", "name", "pos", "source"]


def get(path):
    """GET a Sleeper endpoint, return parsed JSON (None ONLY on 404/null)."""
    url = path if path.startswith("http") else BASE + path
    attempt = rate_hits = 0
    while True:
        try:
            time.sleep(DELAY)
            with urllib.request.urlopen(url, timeout=30) as r:
                body = r.read().decode("utf-8")
            return json.loads(body) if body and body != "null" else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:
                rate_hits += 1
                if rate_hits >= 10:
                    # a silent None here reads as "league not found" and quietly
                    # truncates the corpus — fail loudly instead
                    raise RuntimeError(f"rate-limited {rate_hits}x, giving up: {url}")
                time.sleep(30)
                continue
            attempt += 1
            if attempt >= RETRIES:
                raise
            time.sleep(2 ** attempt)
        except Exception:
            attempt += 1
            if attempt >= RETRIES:
                raise
            time.sleep(2 ** attempt)


def walk_chain(league_id):
    """Yield (season, league) newest first, following previous_league_id."""
    seen = set()
    while league_id and league_id not in seen:
        seen.add(league_id)
        lg = get(f"/league/{league_id}")
        if not lg:
            print(f"  !! league {league_id} not found", file=sys.stderr)
            return
        yield lg.get("season"), lg
        league_id = lg.get("previous_league_id")


def pick_rows(draft, picks, source):
    """Flatten one draft's picks into corpus rows."""
    rows = []
    for p in sorted(picks, key=lambda x: x["pick_no"]):
        pid = p.get("player_id")
        if not pid:                      # unfilled/forfeited slot
            continue
        md = p.get("metadata") or {}
        name = f"{md.get('first_name', '')} {md.get('last_name', '')}".strip()
        rows.append({
            "season": draft["season"],
            "pick_no": p["pick_no"],
            "round": p["round"],
            "sleeper_id": pid,
            "name": name,
            "pos": md.get("position", ""),
            "source": source,
        })
    return rows


def describe(lg, draft, picks, kind):
    rp = lg.get("roster_positions") or []
    sf = "SF" if "SUPER_FLEX" in rp else "1QB"
    starters = [s for s in rp if s != "BN"]
    return (f"  {draft['season']}  {kind:7} rounds={draft['settings']['rounds']:<2} "
            f"type={draft.get('type','?'):6} picks={len(picks):<3} "
            f"teams={lg.get('total_rosters')} {sf} "
            f"lineup={'/'.join(starters)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("league_id", help="Most recent league_id; chain is walked backward")
    ap.add_argument("--source", required=True, help="Short tag for this league in the corpus")
    ap.add_argument("--csv", default=str(CSV_PATH), help="Corpus CSV to append to")
    ap.add_argument("--dry-run", action="store_true", help="Print what would be added, write nothing")
    ap.add_argument("--force", action="store_true", help="Replace existing rows for this source")
    args = ap.parse_args()

    csv_path = Path(args.csv)
    existing = []
    if csv_path.exists():
        with open(csv_path, newline="", encoding="utf-8") as f:
            existing = list(csv.DictReader(f))
    have = {(r["source"], r["season"]) for r in existing}
    if args.force:
        existing = [r for r in existing if r["source"] != args.source]
        have = {(r["source"], r["season"]) for r in existing}

    new_rows, skipped = [], []
    for season, lg in walk_chain(args.league_id):
        for draft in get(f"/league/{lg['league_id']}/drafts") or []:
            picks = get(f"/draft/{draft['draft_id']}/picks") or []
            if not picks:
                continue
            kind = "rookie" if max(p["round"] for p in picks) <= ROOKIE_MAX_ROUND else "startup"
            print(describe(lg, draft, picks, kind))
            if kind != "rookie":
                skipped.append((draft["season"], "startup draft"))
                continue
            if (args.source, draft["season"]) in have:
                skipped.append((draft["season"], "already in corpus"))
                continue
            new_rows.extend(pick_rows(draft, picks, args.source))

    for season, why in sorted(skipped):
        print(f"  skipped {season}: {why}")

    if not new_rows:
        print("\nNothing to add.")
        return

    by_season = defaultdict(int)
    for r in new_rows:
        by_season[r["season"]] += 1
    print(f"\n{len(new_rows)} picks from {len(by_season)} drafts "
          f"({', '.join(f'{s}:{n}' for s, n in sorted(by_season.items()))})")

    if args.dry_run:
        print("dry run — nothing written")
        return

    combined = existing + new_rows
    combined.sort(key=lambda r: (r["source"], int(r["season"]), int(r["pick_no"])))
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows({k: r[k] for k in COLUMNS} for r in combined)
    print(f"wrote {csv_path}  ({len(existing)} -> {len(combined)} rows)")


if __name__ == "__main__":
    main()
