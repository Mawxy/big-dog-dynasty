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
import argparse, json, sys
from pathlib import Path

from draft_slots import SLOT_FIX, build_slot_maps  # noqa: F401  (SLOT_FIX re-exported)

ROOT = Path(__file__).resolve().parent.parent
DATA, RAW = ROOT / "data", ROOT / "sleeper_data"
ORD = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th"}

# Per-team discount that collapses a multi-year WAR stream to one number.
# Year 1 counts in full, year 2 at delta, year 3 at delta^2 ... Max's settled
# range is 0.6-0.8; 0.7 is the midpoint.
DELTA = 0.7


def stream_value(stream, delta, lag=0):
    """Discounted sum of a WAR stream. `lag` defers the whole stream by N years
    (a 2028 pick can't produce until 2028)."""
    return round(sum(v * delta ** (lag + k) for k, v in enumerate(stream)), 3)

# SLOT_FIX and the roster -> draft-slot resolution now live in draft_slots.py,
# shared with draft_analysis.py.


def load(p):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delta", type=float, default=DELTA,
                    help="per-year discount on unrealized WAR (default %(default)s)")
    args = ap.parse_args()
    delta = args.delta

    meta = load(DATA / "meta.json")
    seasons = [int(s) for s in meta["seasons"]]
    players = load(RAW / "players.json")
    if players is None:
        # sleeper_data/ is gitignored and often absent locally — running
        # without it would overwrite committed trades.json with a gutted one
        sys.exit(f"{RAW / 'players.json'} not found — run sleeper_pull.py "
                 "(--players) first; refusing to rebuild data/trades.json")

    # ---- mark-to-market inputs -------------------------------------------
    # Realized WAR alone makes every recent trade look like a 0-0 tie, so each
    # asset ALSO carries what it's still expected to produce for the team that
    # holds it: composite projections for players, slot expectations for picks
    # that haven't been drafted yet.
    projf = load(DATA / "projections.json") or {}
    proj_season = int((projf.get("meta") or {}).get("roster_season") or max(seasons))
    comp = {r["pid"]: (r.get("composite") or []) for r in projf.get("players", [])}

    pv = load(DATA / "pick_values.json") or {}
    pv_years = sorted(int(y) for y in ((pv.get("meta") or {}).get("years_published") or []))
    # future picks have no draft slot yet, so a round is worth its slot average
    round_exp = {}
    for b in pv.get("picks", []):
        rnd = int(str(b["bucket"]).split(".")[0])
        round_exp.setdefault(rnd, []).append([float(b.get("raw", {}).get(str(y), 0.0)) for y in pv_years])
    round_exp = {r: [sum(c) / len(c) for c in zip(*v)] for r, v in round_exp.items() if v}

    # who holds what right now — unrealized value only counts for the team
    # that still has the asset, mirroring the one-hop realized rule
    held = {t["roster_id"]: set(t["players"] or [])
            for t in (load(DATA / str(proj_season) / "teams.json") or [])}

    def future_player(rid, pid):
        if not pid or pid not in held.get(rid, ()):
            return 0.0
        return stream_value(comp.get(str(pid), []), delta)

    def future_pick(pick_season, rnd):
        exp = round_exp.get(rnd)
        if not exp:
            return 0.0
        return stream_value(exp, delta, lag=max(0, pick_season - proj_season))

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

    # When each player LEFT each roster (traded away or dropped). Lets war_for
    # stop at the end of the continuous stint that began with a given trade — a
    # later re-acquisition is a different trade and must not accrue here.
    departures = {}
    for s in seasons:
        tdir = RAW / str(s) / "transactions"
        if not tdir.exists():
            continue
        for tf in sorted(tdir.glob("week_*.json")):
            for tx in (load(tf) or []):
                if tx.get("status") != "complete":
                    continue
                wk = tx.get("leg", 0)
                for pid, rid in (tx.get("drops") or {}).items():
                    departures.setdefault((rid, str(pid)), []).append((s, wk))
    for k in departures:
        departures[k].sort()

    def war_for(rid, pid, from_season, from_week):
        """WAR this player produced starting for `rid` during the single
        continuous stint that began with this trade — stops the moment they
        first leave `rid` (docstring's 'stops if they leave that roster')."""
        # first departure from rid at/after the trade point ends the stint
        end = next(((ds, dw) for ds, dw in departures.get((rid, str(pid)), [])
                    if (ds, dw) >= (from_season, from_week)), None)
        tot = 0.0
        for s in seasons:
            if s < from_season:
                continue
            if end and s > end[0]:
                break
            for wk, v in war_wk.get((s, rid, str(pid)), []):
                if s == from_season and wk < from_week:
                    continue
                if end and (s, wk) >= end:      # already left the roster
                    continue
                tot += v
        return round(tot, 3)

    # draft slot ownership + the selection made at each (round, slot).
    # Shared with draft_analysis.py — see scripts/draft_slots.py.
    slot_of, sel_at = build_slot_maps(seasons, RAW, load=load)
    # seasons whose rookie draft has actually happened (has selections). A pick
    # for a season NOT in here hasn't been drafted yet — it carries future
    # value, it is not an "unused" slot. `ps > max(seasons)` mislabeled every
    # current-year pick as unused each Feb–May before that draft ran.
    drafted_seasons = {k[0] for k in sel_at}

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
                                             "label": pname(pid), "war": w,
                                             "future": future_player(rid, str(pid))})
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
                                                 "label": f"{label} → {nm}", "war": w,
                                                 "future": future_player(rid, str(sel["player_id"]))})
                    else:   # not drafted yet (future pick) or the slot went unused
                        undrafted = ps not in drafted_seasons
                        tail = " (not yet drafted)" if undrafted else " (unused)"
                        side(rid)["got"].append({"kind": "pick", "pid": None,
                                                 "label": label + tail, "war": 0.0,
                                                 "future": future_pick(ps, rnd) if undrafted else 0.0})
                for wb in (tx.get("waiver_budget") or []):
                    side(wb.get("receiver"))["got"].append(
                        {"kind": "faab", "pid": None, "label": f"${wb.get('amount')} FAAB",
                         "war": 0.0, "future": 0.0})

                for sd in sides.values():
                    sd["war"] = round(sum(a["war"] for a in sd["got"]), 3)
                    sd["future"] = round(sum(a["future"] for a in sd["got"]), 3)
                    sd["total"] = round(sd["war"] + sd["future"], 3)
                if sides:
                    trades.append({"season": str(s), "week": wk, "ts": ts,
                                   # realized WAR decides the ordering; projection is informational
                                   "sides": sorted(sides.values(), key=lambda x: -x["war"])})

    trades.sort(key=lambda t: -t["ts"])
    prev = load(DATA / "trades.json")
    if not trades and prev and prev.get("trades"):
        sys.exit(f"built 0 trades but {DATA / 'trades.json'} holds "
                 f"{len(prev['trades'])} — transaction dumps missing? "
                 "refusing to overwrite")
    (DATA / "trades.json").write_text(json.dumps(
        {"meta": {"delta": delta, "proj_season": proj_season,
                  "note": "war = realized while starting for the acquiring team; "
                          "future = discounted expected WAR still to come for assets "
                          "that team still holds; total = war + future"},
         "trades": trades}), encoding="utf-8")
    zero = sum(1 for t in trades if all(abs(s["total"]) < 1e-9 for s in t["sides"]))
    print(f"wrote {DATA/'trades.json'} — {len(trades)} trades, delta {delta}, "
          f"{zero} still scoring 0-0")


if __name__ == "__main__":
    main()
