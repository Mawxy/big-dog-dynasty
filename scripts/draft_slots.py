#!/usr/bin/env python3
"""
draft_slots.py — resolve which draft slot each roster owns, and what was
selected at every (round, slot).

A traded pick names the ORIGINAL OWNER'S ROSTER, not a board position, so
answering "who did my traded 2nd become?" needs roster -> draft slot ->
selection. That mapping is shared by trade_analysis.py (to resolve traded
picks into players) and draft_analysis.py (to show a franchise the picks it
originally owned but dealt away). Keep it in one place so the two can't drift.

slot_of: {season: {roster_id: draft_slot}}
sel_at:  {(season, round, draft_slot): pick record}
"""
import json
from pathlib import Path

# 2023 roster 9 has owner_id = null (the seat was vacant that year, later taken
# over as PicklesPapa), so it never appears in draft_order. Slot 4 is confirmed
# by the picks themselves: roster 9 made 1.04 (Jahmyr Gibbs) and 4.04 (Stetson
# Bennett), having traded its 2nd and 3rd.
SLOT_FIX = {(2023, 9): 4}


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def build_slot_maps(seasons, raw: Path, load=_load, warn=print):
    """Return (slot_of, sel_at). `seasons` is an iterable of int seasons."""
    slot_of, sel_at = {}, {}
    for s in seasons:
        drafts = load(raw / str(s) / "drafts.json") or []
        rosters = load(raw / str(s) / "rosters.json") or []
        if not drafts:
            continue
        d = drafts[0]
        own = {r.get("owner_id"): r["roster_id"] for r in rosters}
        m = {own[u]: slot for u, slot in (d.get("draft_order") or {}).items() if u in own}
        for (fs, frid), slot in SLOT_FIX.items():           # known vacant seats
            if fs == s:
                m[frid] = slot
        missing_r = [r["roster_id"] for r in rosters if r["roster_id"] not in m]
        missing_s = [x for x in range(1, len(rosters) + 1) if x not in m.values()]
        if len(missing_r) == 1 and len(missing_s) == 1:      # infer the odd one out
            m[missing_r[0]] = missing_s[0]
        elif missing_r:
            warn(f"  ! {s}: no draft slot for roster(s) {missing_r} "
                 f"(free slots {missing_s}) — add to SLOT_FIX")
        slot_of[s] = m
        for p in (load(raw / str(s) / f"draft_{d['draft_id']}_picks.json") or []):
            sel_at[(s, p["round"], p.get("draft_slot"))] = p
    return slot_of, sel_at
