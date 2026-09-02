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
import argparse, datetime, json, re, sys, time
from pathlib import Path
from ioutil import write_json
from leaguepaths import DataDir


from draft_slots import SLOT_FIX, build_slot_maps  # noqa: F401  (SLOT_FIX re-exported)
from week_odds import best_lineup

ROOT = Path(__file__).resolve().parent.parent
DATA, RAW = DataDir(ROOT / "data"), ROOT / "sleeper_data"
ORD = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th"}
TIERS = ("Early", "Mid", "Late")


def tier_of_slot(slot, n_teams):
    """Draft slot 1..n -> Early / Mid / Late, thirds of the round — the same
    floor((slot-1)/4) partition the site uses for a 12-team league."""
    per = max(1, n_teams / 3)
    return TIERS[min(2, int((slot - 1) // per))]


def projected_slots(data_dir, load):
    """roster_id -> (projected draft slot, tier) for every franchise, off the
    projected year-one lineup WAR of the CURRENT rosters (Max, 2026-09-02).
    The worst projected team picks first. Mirrors src/beta/model.ts
    usePickTiers, which the site uses for the same figure; the two must agree
    or a pick prices differently on the ledger and in the machine."""
    projf = load(data_dir / "projections.json") or {}
    meta = load(data_dir / "meta.json") or {}
    season = str((projf.get("meta") or {}).get("roster_season")
                 or meta.get("rosterSeason") or "")
    teams = (load(data_dir / season / "teams.json") or []) if season else []
    slots = meta.get("rosterPositions") or []
    if not teams or not slots:
        return {}
    y1 = {r["pid"]: ((r.get("composite") or [0.0])[0], r.get("pos"))
          for r in projf.get("players", [])}
    strength = []
    for t in teams:
        cands = [(pid, y1[pid][1], y1[pid][0]) for pid in (t.get("players") or []) if pid in y1]
        war = sum(v for _, _, v in best_lineup(cands, slots))
        strength.append((war, t["roster_id"]))
    strength.sort()                                   # weakest first = picks first
    n = len(strength)
    return {rid: (i + 1, tier_of_slot(i + 1, n)) for i, (_, rid) in enumerate(strength)}

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
    # where each franchise's OWN picks project to land, for the picks that
    # have not been drafted yet; a drafted pick's tier is its actual slot's
    proj_slot = projected_slots(DATA, load)
    n_teams = max(12, len(proj_slot))

    def pick_tier(ps, orig):
        slot = slot_of.get(ps, {}).get(orig)
        if slot and ps in drafted_seasons:
            return tier_of_slot(slot, n_teams)
        return proj_slot.get(orig, (None, "Mid"))[1]

    # ---- the tier AT THE TIME OF THE TRADE (Max, 2026-09-02) ------------
    # "A projected mid first should be priced as such": the ledger's THEN end
    # prices a pick where it looked like landing on the day of the deal, and
    # the NOW end where it lands today (or did land), so the delta carries the
    # tier drift too. What "looked like" means, in order:
    #   * the draft had already happened -> the actual slot (known then);
    #   * four or more weeks into the season -> the original owner's standing
    #     through the trade week (wins, then points);
    #   * earlier than that, or the offseason -> the previous season's final
    #     standing, the last finish anybody had to go on;
    #   * nothing to go on (the league's first season) -> Mid.
    # Snapshots frozen from today on carry these tiers per asset, so a later
    # run cannot re-derive them differently; older snapshots are re-frozen
    # off the same rule, which is the only record of "then" they can have.
    mw_all = {s: (load(DATA / str(s) / "matchups.json") or {}) for s in seasons}
    final_std = {}
    for s in seasons:
        rows = load(DATA / str(s) / "teams.json") or []
        if rows and any(t.get("wins") or t.get("losses") for t in rows):
            order = sorted(rows, key=lambda t: (t.get("wins", 0), t.get("fpts", 0.0)))
            final_std[s] = {t["roster_id"]: i + 1 for i, t in enumerate(order)}

    def standing_tier(season, week, orig):
        if week >= 4:
            mw = mw_all.get(season) or {}
            ps_ = mw.get("playoff_start") or 15
            rec = {}
            for rid_str, ents in (mw.get("teams") or {}).items():
                w = pts = 0.0
                for e in ents:
                    if e[0] <= week and e[0] < ps_:
                        pts += e[1]
                        w += 1 if e[1] > e[3] else 0.5 if e[1] == e[3] else 0
                rec[int(rid_str)] = (w, pts)
            if orig in rec:
                order = sorted(rec, key=lambda r: rec[r])
                return tier_of_slot(order.index(orig) + 1, len(order))
        prev = final_std.get(season - 1)
        if prev and orig in prev:
            return tier_of_slot(prev[orig], len(prev))
        return "Mid"

    def tier_then(a, t):
        ps, orig = a.get("ps"), a.get("orig")
        if ps is None or orig is None:
            return a.get("tier") or "Mid"
        slot = slot_of.get(ps, {}).get(orig)
        # drafted before the trade: the slot was a fact, not a projection.
        # (A same-season trade after draft day is caught by draft_day below.)
        season = int(t["season"])
        if slot and ps < season:
            return tier_of_slot(slot, n_teams)
        return standing_tier(season, int(t["week"] or 0), orig)

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
                                                 "ps": ps, "rnd": rnd, "orig": orig,
                                                 "tier": pick_tier(ps, orig),
                                                 "future": future_player(rid, str(sel["player_id"]))})
                    else:   # not drafted yet (future pick) or the slot went unused
                        undrafted = ps not in drafted_seasons
                        tail = " (not yet drafted)" if undrafted else " (unused)"
                        side(rid)["got"].append({"kind": "pick", "pid": None,
                                                 "label": label + tail, "war": 0.0,
                                                 "ps": ps, "rnd": rnd, "orig": orig,
                                                 "tier": pick_tier(ps, orig),
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

    # ---- projection-at-trade snapshots (settled with Max, 2026-08-20) ----
    # The first daily run that sees a trade FREEZES what the model expected
    # each side's haul to be worth (side total: realized-so-far + discounted
    # stream — within the capture window that is the at-trade expectation),
    # plus its market price. Frozen means never overwritten: today's
    # projection overwriting yesterday's is exactly what made "projected then"
    # impossible until now. Trades older than the capture window can't be
    # re-projected honestly — they get a market backfill where
    # values_history.json reaches, and stay em-dashed before that (SKILL §3:
    # unknown reads as "—", never as a fake number).
    SNAP_MAX_AGE_DAYS = 14
    snap_path = DATA / "trade_snapshots.json"
    snaps = load(snap_path) or {}
    values_file = load(ROOT / "data" / "values.json") or {}
    valsg = values_file.get("players", {})
    # deep backfill (years, static) under the nightly rolling window — merged
    # per-field, nightly rows winning where both price a date
    hist = load(ROOT / "data" / "values_history_deep.json") or {}
    for k, rows in (load(ROOT / "data" / "values_history.json") or {}).items():
        base = {r[0]: r for r in hist.get(k, [])}
        for r in rows:
            row = base.setdefault(r[0], [r[0], None, None])
            for i in (1, 2):
                if len(r) > i and r[i] is not None:
                    row[i] = r[i]
        hist[k] = sorted(base.values())
    hist_start = min((r[0][0] for r in hist.values() if r), default=None)
    today = datetime.date.today().isoformat()

    # current pick prices at EVERY tier, keyed like the history:
    # "pick:<season> <Early|Mid|Late> <ord>". KTC labels the tier directly;
    # FC's plain "2027 1st" is its Mid and "(Early)" / "(Late)" the others.
    cur_pick = {}
    for label, val in (values_file.get("picks") or {}).get("ktc", []):
        m = re.match(r"^(20\d\d) (Early|Mid|Late) (\d\w\w)$", label)
        if m:
            cur_pick.setdefault(f"pick:{m.group(1)} {m.group(2)} {m.group(3)}", {})["ktc"] = val
    for label, val in (values_file.get("picks") or {}).get("fc", []):
        m = re.match(r"^(20\d\d) (\d\w\w)( \((Early|Mid|Late)\))?$", label)
        if m:
            tier = m.group(4) or "Mid"
            e = cur_pick.setdefault(f"pick:{m.group(1)} {tier} {m.group(2)}", {})
            if "fc" not in e or m.group(3):          # "(Mid)" beats plain
                e["fc"] = val

    def pick_key(a, tier=None):
        """A pick prices AT ITS TIER (Max, 2026-09-02): a drafted pick at the
        tier its actual slot fell in, an undrafted one at the tier its
        original owner's projected finish puts it in. Both ends of "then ->
        now" use the same key, so the delta is a delta."""
        return f"pick:{a['ps']} {tier or a.get('tier') or 'Mid'} {ORD.get(a['rnd'], str(a['rnd']) + 'th')}"

    def mid_key(key):
        return re.sub(r" (Early|Late) ", " Mid ", key)

    def tier_scale(key, src):
        """Early/Late history only began 2026-09-02; before that the ladders
        recorded Mid alone. A tiered price on an earlier day is the Mid price
        that day scaled by TODAY's tier/Mid ratio for the same pick — the tier
        spread on a rookie ladder is slow-moving and this beats an em dash."""
        cur, mid = cur_pick.get(key, {}).get(src), cur_pick.get(mid_key(key), {}).get(src)
        return (cur / mid) if cur and mid else None

    def mkt_side(side, price, tier_for=None):
        """Market sums of a side {ktc, fc}. Players price by pid, picks by
        their pick key at a tier (settled with Max, 2026-08-21: a pick IS a
        market asset until draft night) — `tier_for(asset)` chooses it, the
        asset's own `tier` (today's) when None. Each SOURCE goes None
        independently when it can't price every asset on the side."""
        tots = {"ktc": 0, "fc": 0}
        for a in side["got"]:
            if a["kind"] == "faab":
                continue
            key = (pick_key(a, tier_for(a) if tier_for else None)
                   if a["kind"] == "pick" and "ps" in a else str(a["pid"] or ""))
            row = (price(key) if key else None) or {}
            for src in ("ktc", "fc"):
                if tots[src] is None:
                    continue
                v = row.get(src)
                tots[src] = tots[src] + v if v else None
        return {s: (v or None) for s, v in tots.items()}

    # When the history doesn't reach back to the trade day, the earliest row
    # AFTER it within this window still prices the asset. Exists for the pick
    # ladders, whose nightly history only began 2026-08-27 — an August trade's
    # 2027 2nd is better priced by a two-week-later snapshot of a slow-moving
    # ladder than left as a permanent em dash. Bounded so a today price never
    # masquerades as a months-old one.
    AFTER_TOL_DAYS = 45

    def price_at(day):
        def rows_at(key):
            best = after = None
            for d, ktc, fc in hist.get(key) or []:
                if d <= day and (best is None or d > best[0]):
                    best = (d, ktc, fc)
                elif d > day and (after is None or d < after[0]):
                    after = (d, ktc, fc)
            if best is None and after is not None:
                gap = (datetime.date.fromisoformat(after[0])
                       - datetime.date.fromisoformat(day)).days
                if gap <= AFTER_TOL_DAYS:
                    best = after
            return {"ktc": best[1], "fc": best[2]} if best else None

        def p(key):
            row = rows_at(key)
            if key.startswith("pick:") and " Mid " not in key:
                # a tiered pick: its own history where it exists, else the Mid
                # row that day scaled by today's tier spread (see tier_scale)
                mid = rows_at(mid_key(key)) or {}
                out = dict(row or {})
                for src in ("ktc", "fc"):
                    if out.get(src) is None and mid.get(src) is not None:
                        k = tier_scale(key, src)
                        if k:
                            out[src] = round(mid[src] * k)
                row = out or None
            return row
        return p

    def price_now(key):
        if key.startswith("pick:"):
            return cur_pick.get(key)
        row = valsg.get(key) or {}
        return {"ktc": row.get("ktc"), "fc": row.get("fc")}

    # ---- draft-day splice (settled with Max, 2026-08-21) -----------------
    # A converted pick carries the pick's mid-tier market price ON DRAFT DAY,
    # so its story reads "what the slot cost -> what the player it became is
    # worth". Derived from the immutable value history each run rather than
    # frozen — same answer every time, no snapshot needed. The draft date is
    # that season's latest completed draft (the rookie draft; startups run
    # earlier). Seasons the pick history doesn't reach stay em-dashed.
    draft_day = {}
    for s in seasons:
        starts = [d.get("start_time") for d in (load(RAW / str(s) / "drafts.json") or [])
                  if d.get("start_time") and d.get("status") == "complete"]
        if starts:
            draft_day[s] = datetime.date.fromtimestamp(max(starts) / 1000).isoformat()
    for t in trades:
        for sd in t["sides"]:
            for a in sd["got"]:
                if a["kind"] == "pick" and a.get("pid") and a.get("ps") in draft_day:
                    # the pick at its ACTUAL slot's tier on draft day — the slot
                    # is a fact by then, whatever it projected as
                    row = price_at(draft_day[a["ps"]])(pick_key(a)) or {}
                    if row.get("ktc") is not None:
                        a["mktDraft"] = row["ktc"]
                    if row.get("fc") is not None:
                        a["fcDraft"] = row["fc"]

    # THE PRICING BASIS. Snapshots frozen before 2026-09-02 priced every pick
    # Mid; the ledger now prices a pick at its tier, and a frozen market sum
    # on the old basis against a live one on the new is not a delta. A
    # snapshot without `basis: "tier"` gets its mkt/fc RE-FROZEN off the
    # immutable history at its own day — same source, same day, new basis —
    # and stamped. `exp` is sacred and untouched.
    BASIS = "tier"

    n_new = 0
    for t in trades:
        key = f"{t['ts']}:" + "-".join(
            str(r) for r in sorted(s["rid"] for s in t["sides"]))
        sn = snaps.get(key)
        ts_s = (t["ts"] or 0) / 1000
        day = datetime.date.fromtimestamp(ts_s).isoformat() if ts_s else ""
        # the tier each pick priced at THEN: frozen in the snapshot when one
        # exists, derived by `tier_then` otherwise (and frozen on first use)
        def then_tiers(sn_):
            got = (sn_ or {}).get("tiers") or {}
            out = {}
            for s in t["sides"]:
                lst = got.get(str(s["rid"]))
                out[str(s["rid"])] = lst if isinstance(lst, list) and len(lst) == len(s["got"]) \
                    else [tier_then(a, t) if a["kind"] == "pick" else None for a in s["got"]]
            return out

        def tier_chooser(tiers, s):
            lst = tiers[str(s["rid"])]
            return lambda a: lst[s["got"].index(a)] or a.get("tier") or "Mid"

        if sn is not None and (sn.get("basis") != BASIS or "tiers" not in sn) and day and \
                day >= (hist_start or "9999"):
            tiers = then_tiers(sn)
            for s in t["sides"]:
                rec = sn["sides"].get(str(s["rid"]))
                if rec is None:
                    continue
                m = mkt_side(s, price_at(day), tier_chooser(tiers, s))
                # NEVER TRADE A NUMBER FOR A NONE. A figure frozen when the
                # history reached further (the deep backfill is not in every
                # checkout) is kept on its old basis rather than blanked; a
                # re-freeze that loses the figure is worse than the basis gap.
                for field, src in (("mkt", "ktc"), ("fc", "fc")):
                    if m[src] is not None:
                        rec[field] = m[src]
            sn["basis"], sn["tiers"] = BASIS, tiers
            n_new += 1
        if sn is None:
            tiers = then_tiers(None)
            if ts_s and (time.time() - ts_s) / 86400 <= SNAP_MAX_AGE_DAYS:
                sn = {"taken": today, "kind": "model", "basis": BASIS,
                      "tiers": tiers, "sides": {}}
                for s in t["sides"]:
                    m = mkt_side(s, price_now, tier_chooser(tiers, s))
                    sn["sides"][str(s["rid"])] = {"exp": s["total"],
                                                  "mkt": m["ktc"], "fc": m["fc"]}
            elif hist_start and day >= hist_start:
                sides = {}
                for s in t["sides"]:
                    m = mkt_side(s, price_at(day), tier_chooser(tiers, s))
                    sides[str(s["rid"])] = {"exp": None,
                                            "mkt": m["ktc"], "fc": m["fc"]}
                if any(v["mkt"] is not None or v["fc"] is not None
                       for v in sides.values()):
                    sn = {"taken": today, "kind": "market", "basis": BASIS,
                          "tiers": tiers, "sides": sides}
            if sn:
                snaps[key] = sn
                n_new += 1
        elif sn and sn["kind"] in ("market", "model") and day and \
                day >= (hist_start or "9999") and \
                any(v.get("mkt") is None or v.get("fc") is None
                    for v in sn["sides"].values()):
            # ENRICH, never overwrite: an entry frozen when the history was
            # shallow (pre-deep-backfill, pre-FC, pre-pick-pricing) holds
            # Nones that the immutable history can now answer. Filling a None
            # from the same source that would have filled it then is a
            # backfill; a field that has a number is never touched. This
            # includes "model" snapshots: their exp is sacred, but a mkt/fc
            # that froze as None (a side with picks, before picks priced)
            # deserves the same healing — that gap is exactly what left
            # pick-heavy sides reading "KTC then —" forever.
            filled = False
            tiers = then_tiers(sn)
            for s in t["sides"]:
                rec = sn["sides"].get(str(s["rid"]))
                if rec is None:
                    continue
                m = mkt_side(s, price_at(day), tier_chooser(tiers, s))
                for field, src in (("mkt", "ktc"), ("fc", "fc")):
                    if rec.get(field) is None and m[src] is not None:
                        rec[field] = m[src]
                        filled = True
            n_new += filled
        if sn:
            tiers = then_tiers(sn)
            for s in t["sides"]:
                rec = sn["sides"].get(str(s["rid"])) or {}
                s["expThen"], s["mktThen"] = rec.get("exp"), rec.get("mkt")
                s["fcThen"] = rec.get("fc")
                for a, tier in zip(s["got"], tiers[str(s["rid"])]):
                    if tier:
                        a["tierThen"] = tier
    if n_new or not Path(snap_path).exists():
        write_json(snap_path, snaps, separators=(",", ":"))
    print(f"trade snapshots: {len(snaps)} frozen, {n_new} new this run")

    trades.sort(key=lambda t: -t["ts"])
    prev = load(DATA / "trades.json")
    if not trades and prev and prev.get("trades"):
        sys.exit(f"built 0 trades but {DATA / 'trades.json'} holds "
                 f"{len(prev['trades'])} — transaction dumps missing? "
                 "refusing to overwrite")
    # Time never runs backwards. A rebuild whose NEWEST trade is older than
    # the committed file's was built from stale sleeper_data/ (gitignored, so
    # a dev machine's copy silently ages while CI's stays fresh) — and on
    # 2026-08-21 exactly such a rebuild rode a feature push onto main and
    # clobbered three August trades off the ledger. Refuse instead.
    if trades and prev and prev.get("trades"):
        prev_ts = max((t.get("ts") or 0) for t in prev["trades"])
        if max(t["ts"] for t in trades) < prev_ts:
            sys.exit(f"newest rebuilt trade predates the committed ledger's "
                     f"({DATA / 'trades.json'}) — sleeper_data/ is stale; "
                     "run sleeper_pull.py first; refusing to overwrite")
    write_json(
        DATA / "trades.json",
        {"meta": {"delta": delta, "proj_season": proj_season,
                  "note": "war = realized while starting for the acquiring team; "
                          "future = discounted expected WAR still to come for assets "
                          "that team still holds; total = war + future"},
         "trades": trades}, separators=(",", ":"))
    zero = sum(1 for t in trades if all(abs(s["total"]) < 1e-9 for s in t["sides"]))
    print(f"wrote {DATA/'trades.json'} — {len(trades)} trades, delta {delta}, "
          f"{zero} still scoring 0-0")


if __name__ == "__main__":
    main()
