#!/usr/bin/env python3
"""
dynasty_movers.py — who is going for MORE than their value, and who for LESS,
across the crawled dynasty-league trade corpus.

Method (settled with Max, 2026-08-20):
  * window       : trailing 7 days (--window-days), anchored at the corpus's
                   newest trade (--as-of now to anchor at wall clock instead —
                   the default protects a stale local corpus from producing an
                   empty board).
  * attribution  : CENTERPIECE. For a 2-sided trade, each side's full package
                   delta is assigned to that side's highest-valued asset when
                   that asset is a player:
                       delta(P on side A) = value(side B) - value(side A)
                   i.e. what the other side paid, net of P's own throw-ins,
                   minus P's market value. Positive = P fetched an overpay.
                   A side whose top asset is a pick contributes no mover (pick
                   movers are a different board).
  * TE premium   : each trade is priced in the KTC column matching its
                   league's TE-premium class: none -> ktc, TE+ -> ktcTep,
                   TE++ -> ktcTepp, TE+++ -> ktcTeppp, falling back down the
                   ladder when a variant is missing. The class comes from the
                   crawl's map (crawl_leagues.json "tep") when known, and is
                   otherwise FETCHED LIVE: a window only touches a few hundred
                   distinct leagues, so one /league/<id> call each (~30s
                   total) classifies every trade being scored instead of
                   waiting a cooldown cycle for the signals crawl to re-visit
                   (settled with Max, 2026-08-20). --no-fetch skips the live
                   lookups for offline runs. Rows without a lid (oldest
                   corpus) price at the base column.
  * values       : KeepTradeCut points from data/values.json, KTC band only.
                   A PLAYER'S OWN VALUE IS NEVER DEFLATED (settled with Max,
                   2026-08-20): every asset is shown and denominated at face
                   KTC. The trade model enters as a package-level
                   CONSOLIDATION ADJUSTMENT instead — a package is worth its
                   best asset at face plus each lesser asset at v·s(v), where
                   s is the market lens's utilization weight from
                   TRADE_MACHINE_MODEL.md §1 / src/lib/tradeModel.ts (uMin
                   .10, v50 3400, τ 1200 — KEEP IN LOCKSTEP). So a 1-for-1
                   reads in pure KTC numbers, and only the quantity side of a
                   2-for-1 pays the adjustment. Quantity ≠ quality: two 4500s
                   still fall short of one 9000. No per-team delta is knowable
                   for external leagues. An asset KTC doesn't price counts 0
                   (throw-in), and a side whose centerpiece is unpriced
                   contributes no mover.
  * picks        : (season, round) -> KTC's generic mid value
                   ("2026 Mid 1st"); external leagues' slots are unknowable, so
                   every pick is priced at the round's midpoint. Seasons past
                   the published horizon decay by the ratio of the last two
                   published seasons; unpublished rounds price at 0 (throw-in).
  * FAAB         : priced at 0, recorded in the trade's asset labels.
  * timestamps   : Sleeper transaction_ids are snowflakes; created_ms =
                   (tid >> 22) + SNOWFLAKE_EPOCH_MS. Epoch fitted against our
                   own league's dumps (1,759 pairs, max error 1 ms).

Inputs : data/trade_corpus.json, data/values.json, sleeper_data/players.json
Output : data/dynasty_movers.json — {"meta", "overpaid", "underpaid"}
Usage  : python scripts/dynasty_movers.py [--window-days 7] [--min-n 3]
"""
import argparse, datetime, json, re, sys, time
from collections import defaultdict
from pathlib import Path

from crawl_schema import tep_class
import sleeper_http

ROOT = Path(__file__).resolve().parent.parent
DATA, RAW = ROOT / "data", ROOT / "sleeper_data"

# fitted, not documented by Sleeper — see module docstring
SNOWFLAKE_EPOCH_MS = 1454362509301
ORD = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th"}

# generic (mid) round values only — a slotless external pick IS the midpoint
KTC_GENERIC = re.compile(r"^(20\d\d) Mid (\d)(?:st|nd|rd|th)$")       # "2026 Mid 1st"

# Trade machine market lens, v1 parameters — mirror of src/lib/tradeModel.ts
# CURVES.market. s(v) is the share of weeks an asset of KTC value v actually
# starts; a package is worth the sum of consolidation-weighted values.
U_MIN, V50, TAU = 0.10, 3400.0, 1200.0


def s_market(v):
    """utilization weight under the market lens (never negative, floored)"""
    import math
    return U_MIN + (1.0 - U_MIN) / (1.0 + math.exp(-(v - V50) / TAU))


def pkg_value(faces):
    """A package's worth: best asset at face, each lesser asset weighted by
    s(v). The weight models sitting behind someone — which the piece you
    acquired the package FOR never does — so a single asset is always pure
    face KTC and the consolidation adjustment (pkg_value − Σ face, ≤ 0) only
    bites the quantity side of a trade."""
    vs = sorted((v for v in faces if v > 0), reverse=True)
    return vs[0] + sum(v * s_market(v) for v in vs[1:]) if vs else 0.0


def load(p):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def trade_ts(tid):
    return ((int(tid) >> 22) + SNOWFLAKE_EPOCH_MS) / 1000.0


def build_pick_table(picks):
    """(season, round) -> KTC generic mid value, with season-decay fallback."""
    table = {}
    for label, val in (picks.get("ktc") or []):
        m = KTC_GENERIC.match(label)
        if m:
            table[(int(m.group(1)), int(m.group(2)))] = float(val)

    def value(season, rnd):
        if (season, rnd) in table:
            return table[(season, rnd)]
        years = sorted(s for s, r in table if r == rnd)
        if not years or season < years[0]:
            return 0.0
        # beyond the horizon: decay by the last published year-over-year ratio
        last = table[(years[-1], rnd)]
        ratio = (table[(years[-1], rnd)] / table[(years[-2], rnd)]
                 if len(years) > 1 and table[(years[-2], rnd)] else 0.85)
        ratio = min(ratio, 1.0)
        return last * (ratio ** (season - years[-1]))
    return value


# TE-premium ladder: a league's class (from crawl_leagues.json "tep", written
# by sleeper_crawl.tep_class) picks the KTC column its trades are priced in.
# Fallback walks DOWN the ladder so a missing variant degrades to the nearest
# milder premium rather than to nothing.
TEP_FIELDS = {"": ("ktc",),
              "tep": ("ktcTep", "ktc"),
              "tepp": ("ktcTepp", "ktcTep", "ktc"),
              "teppp": ("ktcTeppp", "ktcTepp", "ktcTep", "ktc")}


def player_value(row, cls=""):
    for f in TEP_FIELDS.get(cls, ("ktc",)):
        if row.get(f):
            return float(row[f])
    return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-days", type=int, default=7)
    ap.add_argument("--min-n", type=int, default=3,
                    help="trades required before a player can make the board")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--max-assets", type=int, default=6,
                    help="skip trades with more assets than this on either side "
                         "(dispersal drafts and roster swaps executed as trades "
                         "are not market signals)")
    ap.add_argument("--as-of", default="corpus",
                    help="'corpus' (newest trade, default), 'now', or ISO date")
    ap.add_argument("--no-fetch", action="store_true",
                    help="don't hit Sleeper for unknown leagues' TE-premium "
                         "class; unknowns price at base KTC")
    ap.add_argument("--out", default=str(DATA / "dynasty_movers.json"))
    args = ap.parse_args()

    corpus = load(DATA / "trade_corpus.json")
    values = load(DATA / "values.json")
    if not corpus or not values:
        sys.exit("missing data/trade_corpus.json or data/values.json")
    players_meta = load(RAW / "players.json") or {}
    # one value table per TE-premium class, built lazily — most corpora are
    # dominated by one or two classes
    _pv = {}

    def pval(cls):
        if cls not in _pv:
            _pv[cls] = {pid: player_value(r, cls)
                        for pid, r in values["players"].items()}
        return _pv[cls]

    # league -> TE-premium class; absent = no premium. Old corpus rows carry
    # no lid and also price at the base column.
    tep_map = (load(DATA / "crawl_leagues.json") or {}).get("tep") or {}
    pick_val = build_pick_table(values.get("picks") or {})

    trades = corpus["trades"]
    if args.as_of == "corpus":
        as_of = max(trade_ts(t["tid"]) for t in trades)
    elif args.as_of == "now":
        as_of = time.time()
    else:
        as_of = datetime.datetime.fromisoformat(args.as_of).timestamp()
    lo = as_of - args.window_days * 86400

    def side_assets(side, cls):
        pv = pval(cls)
        out = [("player", pid, pv.get(pid, 0.0)) for pid in side["players"]]
        out += [("pick", f"{pk['season']} {ORD.get(pk['round'], pk['round'])}",
                 pick_val(int(pk["season"]), int(pk["round"])))
                for pk in side["picks"]]
        return out

    # ---- the window, then its leagues' TE-premium classes ----------------
    window, n_window = [], 0
    for t in trades:
        ts = trade_ts(t["tid"])
        if not (lo <= ts <= as_of) or len(t["sides"]) != 2:
            continue
        n_window += 1
        if any(len(s["players"]) + len(s["picks"]) > args.max_assets
               for s in t["sides"]):
            continue                     # dispersal/roster swap, not a trade
        window.append(t)

    # every league actually being scored gets a definite class NOW: the crawl
    # map answers what it can, and the remainder is one /league/<id> call each
    # (NARROW retry — a dead league prices at base rather than killing the run)
    need = sorted({str(t["lid"]) for t in window if t.get("lid")} - set(tep_map))
    n_fetched = 0
    if need and not args.no_fetch:
        for lid in need:
            try:
                lg = sleeper_http.get(f"/league/{lid}", retry=sleeper_http.NARROW)
            except Exception:
                continue
            if lg:
                tep_map[lid] = tep_class(lg)
                n_fetched += 1
        print(f"TE premium: fetched {n_fetched}/{len(need)} unmapped leagues live")

    # pid -> list of (delta, price_paid, face)
    ledger = defaultdict(list)
    n_scored = 0
    for t in window:
        cls = tep_map.get(str(t.get("lid") or ""), "")
        a, b = (side_assets(s, cls) for s in t["sides"])
        # package value: face KTC with the consolidation adjustment on the
        # lesser assets — a 1-for-1 is pure face numbers on both sides
        va, vb = pkg_value([x[2] for x in a]), pkg_value([x[2] for x in b])
        if not a or not b or (va == 0 and vb == 0):
            continue
        scored = False
        for mine, my_total, their_total in ((a, va, vb), (b, vb, va)):
            kind, key, v = max(mine, key=lambda x: x[2])   # centerpiece by face
            if kind != "player" or v <= 0:
                continue                     # pick-centerpiece side: no mover
            # v is the package's best asset, so it sits in my_total at face —
            # paid nets out the (weighted) throw-ins that rode along with him
            ledger[key].append({"delta": their_total - my_total,
                                "paid": their_total - (my_total - v),
                                "face": v})
            scored = True
        n_scored += scored

    rows = []
    for pid, recs in ledger.items():
        if len(recs) < args.min_n:
            continue
        # the player's own worth: face KTC, never deflated — the board must
        # read against KeepTradeCut's published number. Averaged because his
        # face differs by each trade's TE-premium class.
        v = sum(r["face"] for r in recs) / len(recs)
        avg_delta = sum(r["delta"] for r in recs) / len(recs)
        meta = players_meta.get(pid) or {}
        rows.append({
            "pid": pid,
            "name": (f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip()
                     or f"#{pid}"),
            "pos": meta.get("position"), "team": meta.get("team"),
            "n": len(recs), "value": round(v),
            "avg_paid": round(sum(r["paid"] for r in recs) / len(recs)),
            "avg_delta": round(avg_delta),
            "avg_pct": round(100 * avg_delta / v, 1) if v else None,
        })

    rows.sort(key=lambda r: -(r["avg_pct"] if r["avg_pct"] is not None else 0))
    over = [r for r in rows if r["avg_delta"] > 0][:args.top]
    under = sorted((r for r in rows if r["avg_delta"] < 0),
                   key=lambda r: r["avg_pct"] or 0)[:args.top]

    out = {"meta": {"generated": datetime.date.today().isoformat(),
                    "as_of": datetime.datetime.utcfromtimestamp(as_of).isoformat() + "Z",
                    "window_days": args.window_days, "min_n": args.min_n,
                    "attribution": "centerpiece", "max_assets": args.max_assets,
                    "unit": "face KTC points, TE-premium-matched per league; packages carry the market lens's consolidation adjustment on non-centerpiece assets",
                    "tep_leagues_known": len(tep_map), "tep_fetched": n_fetched,
                    "leagues": corpus.get("leagues"),
                    "trades_in_window": n_window, "trades_scored": n_scored,
                    "players_qualified": len(rows)},
           "overpaid": over, "underpaid": under}
    Path(args.out).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {args.out} — window {args.window_days}d ending "
          f"{out['meta']['as_of'][:10]}, {n_window} trades, {n_scored} scored, "
          f"{len(rows)} players ≥{args.min_n} trades, "
          f"{len(over)} overpaid / {len(under)} underpaid listed")


if __name__ == "__main__":
    main()
