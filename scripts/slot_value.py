#!/usr/bin/env python3
"""
slot_value.py — what a lineup slot is worth, priced the way a draft pick is.

Bridge A asks "what does 1.01 return?" by pooling every 1.01 ever made and
taking the distribution. This asks the same question of a LINEUP slot: pool
every roster's second-best running back and see what RB2 is actually worth.
The output mirrors pick_values.json field for field, so the site's existing
box plots and tables render it without new components.

    bucket     "QB1" ... "TE1", the eight starting slots (QB2 = superflex)
    n          roster-seasons behind the figure, by scope
    raw        MEDIAN WAR, by scope — median not mean, because a champion's
               mean is inflated by a handful of superteams
    hit_rate   share of rosters clearing that position's FRANCHISE_BAR in the
               slot. The analogue of a pick "hitting": did this slot hold a
               starter-grade player at all?
    dist       every observation, sorted, for the box plot

Three scopes per slot: `all` (every roster-season), `champ` (title winners) and
`field` (everyone else). The champ-vs-field gap is the point — a slot where
champions and the field agree is a slot that does not decide titles.

Input:  the outcome corpus written by `sleeper_crawl.py --mode outcomes`,
        one or more shards. Artifact-only and gitignored, so pass the path.
Output: data/slot_values.json

Usage:
  python scripts/slot_value.py scratch/sample_corpus_0.json
  python scripts/slot_value.py 'data/outcome_corpus_*.json' --out data/slot_values.json
"""
import argparse
import glob
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from franchise_players import FRANCHISE_BAR          # noqa: E402
from leaguepaths import DataDir                      # noqa: E402
from crawl_schema import LINEUP_SLOTS, ROW_FIELDS    # noqa: E402
from ioutil import write_json                        # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# Slot -> the position whose bar decides whether the slot "hit". QB2 is judged
# against the QB bar: a superflex starter is a starting quarterback, and
# holding him to a lower standard would hide the very hole we are measuring.
SLOTS = [(f"{p}{n}", p) for p, n in LINEUP_SLOTS]
MIN_OBS = 8              # below this a median is noise; the slot publishes null


def load_rows(patterns):
    rows, seen = [], set()
    for pat in patterns:
        for f in sorted(glob.glob(pat)):
            payload = json.loads(Path(f).read_text(encoding="utf-8"))
            for r in payload.get("rows", []):
                # a league-season can appear in two shard files if the shard
                # count changed between runs; the corpus key is the dedup
                key = (r.get("lid"), r.get("season"))
                if key in seen:
                    continue
                seen.add(key)
                rows.append(r)
    return rows


def collect(rows, fields):
    """slot -> scope -> [WAR]. Scope is all / champ / field."""
    idx = {name: i for i, name in enumerate(fields)}
    out = {s: {"all": [], "champ": [], "field": []} for s, _ in SLOTS}
    n_champ = n_field = 0
    for r in rows:
        champ = r.get("champ")
        for roster in r.get("rosters") or []:
            if len(roster) != len(fields):
                continue                       # written before a column existed
            scope = "champ" if roster[0] == champ else "field"
            if champ is None:
                scope = None                   # season unfinished: no verdict
            if scope == "champ":
                n_champ += 1
            elif scope == "field":
                n_field += 1
            for slot, _pos in SLOTS:
                v = roster[idx[f"{slot.lower()}_war"]]
                out[slot]["all"].append(v)
                if scope:
                    out[slot][scope].append(v)
    return out, n_champ, n_field


def summarize(values, pos):
    bar = FRANCHISE_BAR[pos]
    row = {"bucket": None, "n": {}, "raw": {}, "mean": {}, "hit_rate": {},
           "q1": {}, "q3": {}, "dist": {}}
    for scope, vals in values.items():
        row["n"][scope] = len(vals)
        if len(vals) < MIN_OBS:
            row["raw"][scope] = None
            continue
        v = sorted(vals)
        row["raw"][scope] = round(statistics.median(v), 3)
        row["mean"][scope] = round(statistics.mean(v), 3)
        row["hit_rate"][scope] = round(sum(1 for x in v if x >= bar) / len(v), 4)
        qs = statistics.quantiles(v, n=4)
        row["q1"][scope], row["q3"][scope] = round(qs[0], 3), round(qs[2], 3)
        row["dist"][scope] = [round(x, 3) for x in v]
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("corpus", nargs="+", help="outcome corpus file(s) or glob")
    ap.add_argument("--out", default=None, help="default: data/slot_values.json")
    ap.add_argument("--fields", default=None,
                    help="row field names, if the corpus predates row_fields")
    args = ap.parse_args()
    rows = load_rows(args.corpus)
    if not rows:
        raise SystemExit("no rows found — check the corpus path")
    # A corpus carries its layout implicitly — the rows are bare lists — so the
    # column names come from the shared schema the crawler writes them with.
    # This used to importlib-exec the entire 68 KB crawler to read one list.
    fields = args.fields.split(",") if args.fields else ROW_FIELDS
    by_slot, n_champ, n_field = collect(rows, fields)
    slots = []
    for slot, pos in SLOTS:
        row = summarize(by_slot[slot], pos)
        row["bucket"] = slot
        row["pos"] = pos
        row["bar"] = FRANCHISE_BAR[pos]
        slots.append(row)
    seasons = sorted({r.get("season") for r in rows if r.get("season")})
    out = {
        "meta": {
            "league_seasons": len(rows),
            "champion_rosters": n_champ, "field_rosters": n_field,
            "chains": len({r.get("chain") or r.get("lid") for r in rows}),
            "seasons": [seasons[0], seasons[-1]] if seasons else [],
            "min_obs": MIN_OBS,
            "bars": FRANCHISE_BAR,
            "source": "outcome corpus (crawled leagues), WAR from nfl_history",
            "note": "raw is the MEDIAN; hit_rate is the share clearing the "
                    "position's starter bar in that slot",
        },
        "slots": slots,
    }
    dest = Path(args.out) if args.out else DataDir(ROOT / "data") / "slot_values.json"
    write_json(dest, out)
    print(f"wrote {dest} — {len(rows)} league-seasons, "
          f"{n_champ} champions, {n_field} field rosters")
    hdr = f"{'slot':<6}{'median':>8}{'champ':>8}{'field':>8}{'gap':>7}{'hit%':>7}{'champ hit%':>12}"
    print(hdr)
    for s in slots:
        c, f = s["raw"].get("champ"), s["raw"].get("field")
        print(f"{s['bucket']:<6}{s['raw'].get('all', 0):>8.3f}"
              f"{c if c is not None else 0:>8.3f}{f if f is not None else 0:>8.3f}"
              f"{(c - f) if c is not None and f is not None else 0:>+7.3f}"
              f"{s['hit_rate'].get('all', 0) * 100:>6.0f}%"
              f"{s['hit_rate'].get('champ', 0) * 100:>11.0f}%")


if __name__ == "__main__":
    main()
