"""
Sleeper player id -> ESPN player id, for headshots.

ESPN serves every player's headshot as a PNG on a transparent ground
(https://a.espncdn.com/i/headshots/nfl/players/full/<espn_id>.png); Sleeper's
own CDN only has JPGs on white. Sleeper's player map carries `espn_id` for
barely a third of the active pool, so this pulls nflverse's player table —
which has both `sleeper_id` and `espn_id` for nearly everyone — and writes the
join to data/espn_ids.json. build_site_data.py reads that file when it builds
players_min.json, and this script also patches the committed players_min.json
files in place so the site does not have to wait for the next data refresh.

Run from the repo root, on a machine that can reach nflverse (GitHub release
assets):

    pip install nflreadpy
    python scripts/espn_ids.py

Both outputs are committed. Re-run whenever a rookie class lands.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "espn_ids.json"
SLEEPER_MAP = ROOT / "sleeper_data" / "players.json"


def as_int(v):
    try:
        return int(v) if v not in (None, "", "NA") else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    import nflreadpy as nfl

    rows = nfl.load_players().to_dicts()
    by_sleeper, by_gsis = {}, {}
    for r in rows:
        espn = as_int(r.get("espn_id"))
        if not espn:
            continue
        s = as_int(r.get("sleeper_id"))
        if s:
            by_sleeper[str(s)] = espn
        g = r.get("gsis_id")
        if g:
            by_gsis[g] = espn
    print(f"nflverse: {len(by_sleeper)} sleeper->espn, {len(by_gsis)} gsis->espn")

    # Sleeper's own map fills gaps two ways: its espn_id where nflverse lacks a
    # sleeper_id, and its gsis_id as a second join key.
    if SLEEPER_MAP.exists():
        sp = json.loads(SLEEPER_MAP.read_text(encoding="utf-8"))
        added = 0
        for pid, p in sp.items():
            if pid in by_sleeper:
                continue
            espn = as_int(p.get("espn_id")) or by_gsis.get(p.get("gsis_id") or "")
            if espn:
                by_sleeper[pid] = espn
                added += 1
        print(f"sleeper map: +{added} via its own espn_id / gsis_id")
    else:
        print("no sleeper_data/players.json — nflverse only", file=sys.stderr)

    OUT.write_text(json.dumps(dict(sorted(by_sleeper.items())), separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(by_sleeper)} ids)")

    # patch the committed players_min.json files in place: [name, pos, team, espn?]
    for f in sorted(DATA.glob("leagues/*/players_min.json")):
        pm = json.loads(f.read_text(encoding="utf-8"))
        hit = 0
        for pid, row in pm.items():
            del row[3:]
            espn = by_sleeper.get(pid)
            if espn:
                row.append(espn)
                hit += 1
        f.write_text(json.dumps(pm, separators=(",", ":")), encoding="utf-8")
        print(f"patched {f.relative_to(ROOT)}: {hit}/{len(pm)} rows with espn_id")
    return 0


if __name__ == "__main__":
    sys.exit(main())
