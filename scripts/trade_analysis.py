#!/usr/bin/env python3
"""
trade_analysis.py — every trade in league history, with what each side actually got.

For each trade we resolve the assets and score them:
  * players  -> WAR they produced WHILE STARTING for the team that acquired them,
                from the trade forward (trade season: weeks >= the trade week;
                later seasons: all weeks). Stops if they leave that roster.
  * picks    -> resolved one hop to the player actually drafted with them
                (round + the original owner's draft slot), then scored the same way.
  * FAAB     -> recorded, not scored.

One hop only: if the acquired player is later traded again we don't chase the
chain — the WAR simply stops accruing for that team.

Inputs: sleeper_data/<season>/{transactions,drafts,rosters,draft_*_picks}.json,
        data/<season>/{matchups,weekly}.json, data/<season>/teams.json
Output: data/trades.json — newest first.

Usage: python scripts/trade_analysis.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA, RAW = ROOT / "data", ROOT / "sleeper_data"
ORD = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th"}


def load(p):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def main():
    meta = load(DATA / "meta.json")
    seasons = [int(s) for s in meta["seasons"]]
    players = load(RAW / "players.json") or {}

    def pname(pid):
        p = players.get(str(pid))
        return f"{p.get('first_name','')} {p.get('last_name','')}".strip() if p else f"#{pid}"

    # team names + per-(season, roster, player) weekly WAR while starting
    tname, war_wk = {}, {}
    for s in seasons:
        tname[s] = {t["roster_id"]: t["team"] for t in (load(DATA / str(s) / "teams.json") or [])}
        weekly = load(DATA / str(s) / "weekly.json") or {}
        widx = {}
        for pid, rows in weekly.items():
            for w in rows:
                widx[(pid, w[0])] = w[5]
        mw = (load(DATA / str(s) / "matchups.json") or {}).get("teams", {})
        for rid_str, ents in mw.items():
            for e in ents:
                for pid in e[4]:
                    v = widx.get((pid, e[0]))
                    if v:
                        war_wk.setdefault((s, int(rid_str), pid), []).append((e[0], v))

    def war_for(rid, pid, from_season, from_week):
        """WAR this player produced starting for `rid` from the trade onward."""
        tot = 0.0
        for s in seasons:
            if s < from_season:
                continue
            for wk, v in war_wk.get((s, rid, str(pid)), []):
                if s == from_season and wk < from_week:
                    continue
                tot += v
        return round(tot, 3)

    # draft slot ownership + the selection made at each (round, slot)
    slot_of, sel_at = {}, {}
    for s in seasons:
        drafts = load(RAW / str(s) / "drafts.json") or []
        rosters = load(RAW / str(s) / "rosters.json") or []
        if not drafts:
            continue
        d = drafts[0]
        own = {r.get("owner_id"): r["roster_id"] for r in rosters}
        m = {own[u]: slot for u, slot in (d.get("draft_order") or {}).items() if u in own}
        missing_r = [r["roster_id"] for r in rosters if r["roster_id"] not in m]
        missing_s = [x for x in range(1, len(rosters) + 1) if x not in m.values()]
        if len(missing_r) == 1 and len(missing_s) == 1:      # infer the odd one out
            m[missing_r[0]] = missing_s[0]
        slot_of[s] = m
        for p in (load(RAW / str(s) / f"draft_{d['draft_id']}_picks.json") or []):
            sel_at[(s, p["round"], p.get("draft_slot"))] = p

    trades = []
    for s in seasons:
        tdir = RAW / str(s) / "transactions"
        if not tdir.exists():
            continue
        for tf in sorted(tdir.glob("week_*.json")):
            for tx in (load(tf) or []):
                if tx.get("type") != "trade" or tx.get("status") != "complete":
                    continue
                wk, ts = tx.get("leg", 0), tx.get("created", 0)
                sides = {}

                def side(rid):
                    return sides.setdefault(rid, {"rid": rid, "team": tname.get(s, {}).get(rid, f"Team {rid}"),
                                                  "got": [], "war": 0.0})

                for pid, rid in (tx.get("adds") or {}).items():
                    w = war_for(rid, pid, s, wk)
                    side(rid)["got"].append({"kind": "player", "pid": str(pid),
                                             "label": pname(pid), "war": w})
                for pk in (tx.get("draft_picks") or []):
                    rid, ps, rnd = pk.get("owner_id"), int(pk.get("season")), pk.get("round")
                    orig = pk.get("roster_id")
                    label = f"{ps} {ORD.get(rnd, str(rnd)+'th')}"
                    sel = sel_at.get((ps, rnd, slot_of.get(ps, {}).get(orig)))
                    if sel and sel.get("player_id"):
                        md = sel.get("metadata") or {}
                        nm = f"{md.get('first_name','')} {md.get('last_name','')}".strip()
                        w = war_for(rid, sel["player_id"], ps, 0)
                        side(rid)["got"].append({"kind": "pick", "pid": str(sel["player_id"]),
                                                 "label": f"{label} → {nm}", "war": w})
                    else:
                        side(rid)["got"].append({"kind": "pick", "pid": None,
                                                 "label": label + " (unused)", "war": 0.0})
                for wb in (tx.get("waiver_budget") or []):
                    side(wb.get("receiver"))["got"].append(
                        {"kind": "faab", "pid": None, "label": f"${wb.get('amount')} FAAB", "war": 0.0})

                for sd in sides.values():
                    sd["war"] = round(sum(a["war"] for a in sd["got"]), 3)
                if sides:
                    trades.append({"season": str(s), "week": wk, "ts": ts,
                                   "sides": sorted(sides.values(), key=lambda x: -x["war"])})

    trades.sort(key=lambda t: -t["ts"])
    (DATA / "trades.json").write_text(json.dumps(trades), encoding="utf-8")
    print(f"wrote {DATA/'trades.json'} — {len(trades)} trades")


if __name__ == "__main__":
    main()
