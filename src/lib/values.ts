import type { TradeSide, Values } from "./types";

/** one player row of data/values.json */
export type ValueRow = Values["players"][string];

/**
 * The KTC column that prices THIS league.
 *
 * KTC publishes four value ladders — no premium, TE+, TE++, TE+++ — and a
 * league belongs to exactly one of them (meta.tep, classified server-side by
 * crawl_schema.tep_class from scoring_settings + TE slots). Reading `row.ktc`
 * directly prices a TE-premium league's tight ends in the wrong market; every
 * KTC figure the site shows goes through here instead.
 *
 * Fallback walks DOWN the ladder (TE+++ → TE++ → TE+ → base) so a values.json
 * built before the premium columns existed degrades to base KTC everywhere
 * rather than to holes.
 */
const LADDER: Record<string, (keyof ValueRow)[]> = {
  tep: ["ktcTep", "ktc"],
  tepp: ["ktcTepp", "ktcTep", "ktc"],
  teppp: ["ktcTeppp", "ktcTepp", "ktcTep", "ktc"],
};

export function ktcOf(row: ValueRow | undefined, tep: string | undefined): number | null {
  if (!row) return null;
  for (const f of LADDER[tep ?? ""] ?? ["ktc" as const]) {
    const v = row[f];
    if (typeof v === "number" && v > 0) return v;
  }
  return row.ktc ?? null;
}

/* ========================================================================
   A TRADE SIDE'S MARKET TODAY
   Moved here from beta/screens/tradeGrid.tsx so both ledgers share it: the
   classic drawer had its own copy that priced every unmade pick at Mid while
   `mktThen` froze at the pick's tier, so most pick-holding sides reported a
   delta between two different measurements. This module has no runtime imports,
   which is what lets the node test runner load it (tests/tradeModel.test.ts) —
   hence the local ordinals rather than rosterModel's, which drags in lib/league.
   ======================================================================== */

const ROUND_ORD = ["1st", "2nd", "3rd", "4th"];

/** the sum both sources share; see `marketNow` for the rules */
function sideSum(
  s: TradeSide, vals: Values | null,
  pick: (key: string) => number | undefined,
  player: (row: ValueRow | undefined) => number | null | undefined,
): number | null {
  if (!vals) return null;
  let sum = 0;
  for (const a of s.got) {
    if (a.kind === "faab") continue;
    let v: number | null | undefined;
    if (a.kind === "pick" && !a.pid && a.ps != null && a.rnd != null) {
      // an UNMADE pick: the writer's `pick_key`, glyph for glyph — the pick at
      // its tier, so the delta against the frozen "then" is a delta
      v = pick(`${a.ps} ${a.tier ?? "Mid"} ${ROUND_ORD[a.rnd - 1] ?? `${a.rnd}th`}`);
    } else if (a.pid) {
      // a player — including a pick that has been MADE, which is the player
      // now (Max, 2026-09-02): "what the slot cost -> what he is worth"
      v = player(vals.players[a.pid]);
    }
    if (!v) return null;
    sum += v;
  }
  return sum || null;
}

/**
 * A side's KTC TODAY, on the same basis the snapshot froze.
 *
 * THIS IS A PORT OF `scripts/trade_analysis.py: mkt_side`, asset for asset, and
 * it has to stay one: it supplies the right-hand end of `then → now`, and a
 * delta between two different measurements is not a delta.
 *
 *  - PICKS ARE PRICED (settled with Max, 2026-08-21: a pick IS a market asset
 *    until draft night), AT THEIR TIER (Max, 2026-09-02). The writer keys
 *    them `"<ps> <tier> <ord>"` off `values.json`'s pick ladder, where the
 *    tier is a drafted pick's actual slot or an undrafted one's projected
 *    slot off its original owner's projected finish; the asset carries it as
 *    `tier`, and rows written before that date carry none and read Mid. A
 *    CONVERTED pick is the PLAYER (Max, 2026-09-02): once made it prices by
 *    the drafted player's pid, here and in the writer from draft day on.
 *  - FAAB IS SKIPPED, not declined — same as the writer's `continue`.
 *  - THE LEAGUE'S KTC COLUMN, LIKE FOR LIKE (2026-10-07). The writer now prices
 *    players on `ktc_of(row, meta.tep)` at both ends (history rows scaled by
 *    today's league/base ratio) and stamps each side's `mktBasis`. A side on
 *    "tier+tep" prices today's end through `ktcOf`, the column every other KTC
 *    figure on the site uses; a side frozen before the history reached (older
 *    basis) keeps the base ladder at both ends, because pricing one end on the
 *    premium would credit a scoring rule to the market.
 *  - ONE UNPRICEABLE ASSET VOIDS THE SIDE, which is the writer's rule too: it
 *    sets the running total to None the moment a source can't price an asset,
 *    a zero included (`v if v else None`).
 */
export function marketNow(
  s: TradeSide, vals: Values | null, pickKtc: Map<string, number>, tep?: string,
): number | null {
  const premium = s.mktBasis === "tier+tep";
  return sideSum(s, vals, k => pickKtc.get(k),
    row => (premium ? ktcOf(row, tep) : row?.ktc));
}

/**
 * The FantasyCalc pick ladder, keyed the way `marketNow` keys KTC's: the
 * writer's `cur_pick`. FC labels a tier in parentheses and its plain "2027 1st"
 * is Mid; an explicit "(Mid)" beats the plain label whichever comes first.
 */
export function fcPickLadder(vals: Values | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const [label, v] of vals?.picks?.fc ?? []) {
    const g = /^(20\d\d) (\d\w\w)( \((Early|Mid|Late)\))?$/.exec(label);
    if (!g) continue;
    const key = `${g[1]} ${g[4] ?? "Mid"} ${g[2]}`;
    if (!g[3] && m.has(key)) continue;
    m.set(key, v);
  }
  return m;
}

/** a side's FantasyCalc today — `marketNow`'s rules on FC's one column */
export function marketNowFc(
  s: TradeSide, vals: Values | null, pickFc: Map<string, number>,
): number | null {
  return sideSum(s, vals, k => pickFc.get(k), row => row?.fc);
}
