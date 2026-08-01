#!/usr/bin/env python3
"""
validate_data.py — sanity gate between the pipeline and `git add data`.

Catches the silent-empty failure class: a script that exited 0 but produced
gutted output (missing inputs, empty API responses) must not be committed and
deployed. Floors sit far below current values — they fire on catastrophic
emptiness, never on normal drift (2026-07: players_min 812, projections 390,
proj_sleeper 3103, values 550, trades 144, shards 812).

  python scripts/validate_data.py                # full check (data-refresh)
  python scripts/validate_data.py --values-only  # market-values workflow
"""
import argparse, json, sys
from pathlib import Path
from leaguepaths import DataDir


ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

FLOORS = {
    "players_min": 400,
    "ownership": 400,
    "shards": 400,
    "projections": 200,
    "proj_sleeper": 1000,
    "trades": 100,
    "values": 300,
    "franchises": 10,
    "dvi": 150,      # currently ~391
    "cvi": 150,      # currently ~391
}


def fail(msg):
    print(f"VALIDATION FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def jload(p):
    if not p.exists():
        fail(f"{p} is missing")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        fail(f"{p} is not valid JSON: {e}")


def floor(name, n):
    if n < FLOORS[name]:
        fail(f"{name}: {n} entries (< floor {FLOORS[name]})")


def check_values():
    floor("values", len(jload(DATA / "values.json").get("players") or {}))
    if not jload(DATA / "value_bridge.json").get("fits"):
        fail("value_bridge.json has no fits")
    check_ecr()


def check_ecr():
    """ecr.json's own reconciliation invariant: for every format the meta's
    `matched` must equal the players actually carrying that slug — a mismatch
    means a name collision silently overwrote someone (see HANDOFF 2026-07-29).
    The file persists across failed fetches (continue-on-error), so an old but
    internally consistent copy passes."""
    ecr = jload(DATA / "ecr.json")
    players = ecr.get("players") or {}
    for slug, m in (ecr.get("formats") or {}).items():
        n = sum(1 for by_fmt in players.values() if slug in by_fmt)
        if n != m.get("matched"):
            fail(f"ecr.json {slug}: {n} players carry the slug but meta says "
                 f"matched={m.get('matched')} — name collision overwriting someone?")


def check_full():
    meta = jload(DATA / "meta.json")
    seasons = meta.get("seasons") or []
    if not seasons:
        fail("meta.json has no seasons")
    if not meta.get("latest"):
        fail("meta.json latest is null — no season produced summary data")
    for s in seasons:
        sd = DATA / s
        if len(jload(sd / "teams.json")) < 2:
            fail(f"{sd}/teams.json has fewer than 2 teams")
        # a season with scored matchups must have non-empty summary + weekly
        mf = sd / "matchups.json"
        if mf.exists() and jload(mf).get("teams"):
            if not jload(sd / "summary.json"):
                fail(f"{sd}/summary.json is empty but the season has scored matchups")
            if not jload(sd / "weekly.json"):
                fail(f"{sd}/weekly.json is empty but the season has scored matchups")
        # a shipped bracket must have a decided game: Sleeper seeds a
        # placeholder bracket long before kickoff, and shipping that renders a
        # postseason for a season nobody has played
        bf = sd / "bracket.json"
        if bf.exists() and not any(g.get("w") for g in jload(bf).get("winners") or []):
            fail(f"{sd}/bracket.json has no decided game — placeholder seeding?")
    floor("players_min", len(jload(DATA / "players_min.json")))
    floor("ownership", len(jload(DATA / "ownership.json")))
    floor("franchises", len(jload(DATA / "franchises.json")))
    floor("projections", len(jload(DATA / "projections.json").get("players") or []))
    floor("proj_sleeper", len(jload(DATA / "proj_sleeper.json").get("players") or {}))
    floor("trades", len(jload(DATA / "trades.json").get("trades") or []))
    if not jload(DATA / "drafts.json"):
        fail("drafts.json is empty")
    floor("shards", len(list((DATA / "player").glob("*.json"))))
    floor("dvi", len(jload(DATA / "dvi.json").get("players") or {}))
    floor("cvi", len(jload(DATA / "cvi.json").get("players") or {}))
    check_values()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--values-only", action="store_true",
                    help="check only values.json / value_bridge.json "
                         "(the market-values workflow's outputs)")
    args = ap.parse_args()
    if args.values_only:
        check_values()
    else:
        check_full()
    print("data/ validation OK" + (" (values only)" if args.values_only else ""))


if __name__ == "__main__":
    main()
