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
  * values       : the TRADE MACHINE's market lens, KTC band only (settled
                   with Max, 2026-08-20). Assets are priced in KeepTradeCut
                   points from data/values.json, and a package is worth
                   Σ v·s(v), NOT Σ v — the consolidation adjustment from
                   TRADE_MACHINE_MODEL.md §1 / src/lib/tradeModel.ts, with the
                   market lens's exact v1 parameters (uMin .10, v50 3400,
                   τ 1200). Quantity ≠ quality: two 4500s do not equal one
                   9000. KEEP THE PARAMETERS IN LOCKSTEP with tradeModel.ts.
                   No per-team delta is knowable for external leagues. An
                   asset KTC doesn't price counts 0 (throw-in), and a side
                   whose centerpiece is unpriced contributes no mover.
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


def eff(v):
    """an asset's consolidation-adjusted (effective) market value"""
    return v * s_market(v) if v > 0 else 0.0


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


def player_value(row):
    return float(row["ktc"]) if row.get("ktc") else 0.0


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
    ap.add_argument("--out", default=str(DATA / "dynasty_movers.json"))
    args = ap.parse_args()

    corpus = load(DATA / "trade_corpus.json")
    values = load(DATA / "values.json")
    if not corpus or not values:
        sys.exit("missing data/trade_corpus.json or data/values.json")
    players_meta = load(RAW / "players.json") or {}
    pval = {pid: player_value(r) for pid, r in values["players"].items()}
    pick_val = build_pick_table(values.get("picks") or {})

    trades = corpus["trades"]
    if args.as_of == "corpus":
        as_of = max(trade_ts(t["tid"]) for t in trades)
    elif args.as_of == "now":
        as_of = time.time()
    else:
        as_of = datetime.datetime.fromisoformat(args.as_of).timestamp()
    lo = as_of - args.window_days * 86400

    def side_assets(side):
        out = [("player", pid, pval.get(pid, 0.0)) for pid in side["players"]]
        out += [("pick", f"{pk['season']} {ORD.get(pk['round'], pk['round'])}",
                 pick_val(int(pk["season"]), int(pk["round"])))
                for pk in side["picks"]]
        return out

    # pid -> list of (delta, price_paid, tid)
    ledger = defaultdict(list)
    n_window = n_scored = 0
    for t in trades:
        ts = trade_ts(t["tid"])
        if not (lo <= ts <= as_of) or len(t["sides"]) != 2:
            continue
        n_window += 1
        if any(len(s["players"]) + len(s["picks"]) > args.max_assets
               for s in t["sides"]):
            continue                     # dispersal/roster swap, not a trade
        a, b = (side_assets(s) for s in t["sides"])
        # package value under the market lens: consolidation-weighted, so a
        # pile of mid assets is worth less than its face sum — same maths as
        # the trade machine's ledger
        va, vb = sum(eff(x[2]) for x in a), sum(eff(x[2]) for x in b)
        if not a or not b or (va == 0 and vb == 0):
            continue
        scored = False
        for mine, my_total, their_total in ((a, va, vb), (b, vb, va)):
            kind, key, v = max(mine, key=lambda x: x[2])   # centerpiece by face
            if kind != "player" or v <= 0:
                continue                     # pick-centerpiece side: no mover
            ev = eff(v)
            ledger[key].append({"delta": their_total - my_total,
                                "paid": their_total - (my_total - ev),
                                "eff": ev})
            scored = True
        n_scored += scored

    rows = []
    for pid, recs in ledger.items():
        if len(recs) < args.min_n:
            continue
        # the player's own worth on the same scale the packages are priced on:
        # his consolidation-adjusted value (for a centerpiece s ≈ 1, so this
        # sits within a few % of KTC face)
        v = recs[0]["eff"]
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
                    "unit": "KTC points, consolidation-adjusted (trade-machine market lens)",
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
