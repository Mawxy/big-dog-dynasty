#!/usr/bin/env python3
"""
draft_analysis.py — per-franchise rookie-draft results with hit/miss analysis.

For every rookie pick a franchise has made:
  * who they took and what that pick has produced (career WAR since drafted)
  * WAR earned while the player was actually on their roster
  * how that stacks up against the EXPECTED WAR for that draft slot
    (from data/pick_values.json — Bridge A). Compared over the same elapsed
    window: a 2024 pick with 2 seasons played is measured against the slot's
    expected years 1-2, so it's apples-to-apples.
  * who they could have taken instead — players drafted LATER in that same
    rookie draft who out-produced the actual pick (realistic alternatives only)

Inputs (all local): sleeper_data/<season>/drafts.json + draft_<id>_picks.json,
data/<season>/summary.json (player season WAR), data/<season>/teams.json
(roster membership), data/pick_values.json (expected WAR by slot).

Output: data/drafts.json  -> { roster_id: [pick records, newest draft first] }

Usage: python scripts/draft_analysis.py
"""
import json, sys
from pathlib import Path

from draft_slots import build_slot_maps

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = ROOT / "sleeper_data"
TOP_ALTS = 3          # how many "could have had" names to keep
EXP_YEARS_FALLBACK = 3   # only used if pick_values.json omits years_published


def load(p):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def main():
    if not RAW.exists():
        # sleeper_data/ is gitignored and often absent locally — running
        # without it would overwrite committed drafts.json with an empty one
        sys.exit(f"{RAW} not found — run sleeper_pull.py first; "
                 "refusing to rebuild data/drafts.json")
    meta = load(DATA / "meta.json")
    seasons = [int(s) for s in meta["seasons"]]
    latest = int(meta.get("latest") or max(seasons))

    # player season WAR, and roster membership per season
    war = {}                      # pid -> {season: war}
    roster = {}                   # season -> {roster_id: set(pids)}
    for s in seasons:
        for row in (load(DATA / str(s) / "summary.json") or []):
            war.setdefault(row[0], {})[s] = float(row[6])
        roster[s] = {t["roster_id"]: set(t["players"] or [])
                     for t in (load(DATA / str(s) / "teams.json") or [])}

    # expected WAR by slot, e.g. "1.05" -> {"1": .., "2": .., "3": ..}
    pvj = load(DATA / "pick_values.json") or {}
    pv = {b["bucket"]: b.get("raw", {}) for b in pvj.get("picks", [])}
    # How deep the comparison can go is whatever Bridge A actually publishes.
    # pick_value.py unlocks a year once every slot has enough observations, so
    # this widens on its own — a pick with 4 finished seasons starts being
    # measured over 4 the moment year 4 is published, with no change here.
    published = (pvj.get("meta") or {}).get("years_published") or []
    exp_years = max(published) if published else EXP_YEARS_FALLBACK

    # roster -> draft slot, and what was selected at each (round, slot);
    # lets us list picks a franchise originally owned but traded away.
    slot_of, sel_at = build_slot_maps(seasons, RAW, load=load)

    out = {}
    for s in seasons:
        drafts = load(RAW / str(s) / "drafts.json") or []
        if not drafts:
            continue
        did = drafts[0].get("draft_id")
        picks = load(RAW / str(s) / f"draft_{did}_picks.json") or []
        if not picks:
            continue
        elapsed = [y for y in seasons if s <= y <= latest]      # seasons since drafted
        n_exp = min(len(elapsed), exp_years)

        def career(pid):
            return round(sum(war.get(pid, {}).get(y, 0.0) for y in elapsed), 3)

        def window(pid):     # WAR over the first n_exp seasons (for expected compare)
            return round(sum(war.get(pid, {}).get(y, 0.0) for y in elapsed[:n_exp]), 3)

        board = sorted(picks, key=lambda p: p["pick_no"])
        # the inaugural season is a full startup draft (many rounds of vets);
        # every later year is a 4-round rookie draft, which is what pick_values prices
        kind = "rookie" if max(p["round"] for p in board) <= 6 else "startup"
        for p in board:
            pid, rid = p.get("player_id"), p.get("roster_id")
            if not pid or rid is None:
                continue
            md = p.get("metadata") or {}
            slot = f"{p['round']}.{p.get('draft_slot', 0):02d}"
            exp = pv.get(slot, {})
            expected = round(sum(float(exp.get(str(y), 0.0)) for y in range(1, n_exp + 1)), 3) \
                if exp else None
            on_roster = round(sum(war.get(pid, {}).get(y, 0.0)
                                  for y in elapsed if pid in roster.get(y, {}).get(rid, set())), 3)
            actual_win = window(pid)
            # realistic alternatives: taken later in this same draft, better career WAR
            mine = career(pid)
            alts = [{"pid": q["player_id"], "name": f"{(q.get('metadata') or {}).get('first_name','')} "
                                                    f"{(q.get('metadata') or {}).get('last_name','')}".strip(),
                     "pick_no": q["pick_no"], "war": career(q["player_id"])}
                    for q in board
                    if q["pick_no"] > p["pick_no"] and q.get("player_id")
                    and career(q["player_id"]) > mine]
            alts.sort(key=lambda a: -a["war"])
            out.setdefault(str(rid), []).append({
                "season": str(s), "kind": kind, "round": p["round"], "pick_no": p["pick_no"], "slot": slot,
                "pid": pid, "name": f"{md.get('first_name','')} {md.get('last_name','')}".strip(),
                "pos": md.get("position") or "?",
                "war": mine, "war_roster": on_roster,
                "expected": expected, "years": n_exp,
                "diff": round(actual_win - expected, 3) if expected is not None else None,
                "alts": alts[:TOP_ALTS],
                "traded": False,
            })

        # Picks this franchise originally owned but dealt away. Listed for
        # awareness only — informational, never scored: no expected, no diff,
        # no roster WAR, and the site leaves them out of season subtotals.
        if kind == "rookie":
            made = {(p["round"], p.get("draft_slot")) for p in board}
            rounds = sorted({p["round"] for p in board})
            for rid, my_slot in (slot_of.get(s) or {}).items():
                for rnd in rounds:
                    if (rnd, my_slot) not in made:
                        continue
                    sel = sel_at.get((s, rnd, my_slot))
                    if not sel or sel.get("roster_id") == rid:
                        continue                      # kept it, already listed
                    pid = sel.get("player_id")
                    if not pid:
                        continue
                    md = sel.get("metadata") or {}
                    out.setdefault(str(rid), []).append({
                        "season": str(s), "kind": kind, "round": rnd,
                        "pick_no": sel["pick_no"], "slot": f"{rnd}.{my_slot:02d}",
                        "pid": pid,
                        "name": f"{md.get('first_name','')} {md.get('last_name','')}".strip(),
                        "pos": md.get("position") or "?",
                        "war": career(pid), "war_roster": None,
                        "expected": None, "years": n_exp, "diff": None,
                        "alts": [],
                        "traded": True, "drafted_by": sel.get("roster_id"),
                    })

    for rid in out:                                  # newest draft first
        out[rid].sort(key=lambda r: (r["season"], r["pick_no"]), reverse=True)
    if not out and load(DATA / "drafts.json"):
        sys.exit(f"built 0 picks but {DATA / 'drafts.json'} is non-empty — "
                 "draft dumps missing? refusing to overwrite")
    (DATA / "drafts.json").write_text(json.dumps(out), encoding="utf-8")
    n = sum(len(v) for v in out.values())
    print(f"wrote {DATA/'drafts.json'} — {n} picks across {len(out)} franchises")


if __name__ == "__main__":
    main()
