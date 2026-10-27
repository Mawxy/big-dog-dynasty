/**
 * WHERE EVERY ASSET IN A TRADE WENT NEXT (Max, 2026-10-27).
 *
 * A trade page answers "what did each side do with what it got": every asset
 * is followed forward, hop by hop, to wherever it sits today. A pick is
 * followed through every later trade of that pick, then through the draft into
 * the player it became, and from there along the player's own path. A player
 * is followed through trades, drops, waiver claims, signings and commissioner
 * moves. Each trade hop carries what the giving side got back, and the hop's
 * own trade page is one tap away, so a whole tree is walked a trade at a time.
 *
 * TWO SOURCES, MERGED, NEITHER SECOND-GUESSED.
 *  - `trades.json` is the authority on trades: it carries roster ids (names
 *    change every season; slots do not) and what every side received.
 *  - `ownership.json` is the authority on everything else — drafted, dropped,
 *    waiver claim, signed, commissioner — as `[season, week, text]` in
 *    chronological order, with the team named as it was named THEN.
 *  A player's timeline walks his ownership list in order; each `traded` entry
 *  there consumes his next trade from trades.json (by timestamp), which is how
 *  a drop between two trades lands between them and not after both. Trades the
 *  ownership list never mentions are appended in time order rather than lost.
 *
 * A COMMISSIONER MOVE RIGHT AFTER A TRADE, in the same week, is the commissioner
 * undoing it (Higgins and Jameson Williams, 2025 week 1). The trade is kept and
 * marked reversed: it happened on Sleeper and sits in the ledger, so hiding it
 * here would make the two screens disagree about what the league did.
 *
 * DEPENDENCY-FREE, like `tradeModel.ts`: type imports only, so
 * `tests/tradeLineage.test.ts` imports it under Node's type stripping.
 */
import type { OwnEvent, Ownership, Trade, TradeAsset } from "./types";

/** A trade's permanent id: its timestamp, then its roster ids ascending — the
 *  ledger's snapshot key with URL-safe separators. Unique even for two trades
 *  Sleeper stamped in one batch. */
export const tradeId = (t: Trade): string =>
  `${t.ts}-${t.sides.map(s => s.rid).sort((a, b) => a - b).join("-")}`;

export type Step =
  /** a trade moved the asset from `from` to `to`; `got` is what `from` received
   *  for it (its whole side of that deal) */
  | { kind: "trade"; trade: Trade; from: number | null; to: number; got: TradeAsset[]; reversed: boolean }
  /** a pick became a player. `team` is the drafting team's name at the time */
  | { kind: "drafted"; season: string; slot: string | null; team: string | null; pid: string }
  | { kind: "dropped"; season: string; week: number; team: string }
  | { kind: "claimed"; season: string; week: number; team: string; how: "waiver" | "signed" }
  | { kind: "commissioner"; season: string; week: number; team: string };

export type End =
  /** on a roster today */
  | { kind: "rostered"; rid: number }
  /** dropped and never picked up again */
  | { kind: "free agent"; season: string; week: number }
  /** off every roster with no drop on record (the history before the data starts) */
  | { kind: "gone" }
  /** a pick still to be made, and who holds it */
  | { kind: "pick"; rid: number; ps: number; rnd: number }
  /** a pick whose slot went unused in the draft */
  | { kind: "unused" }
  /** FAAB is spent, not held; it has no lineage */
  | { kind: "faab" };

export interface Lineage {
  asset: TradeAsset;
  /** who sent it in THIS trade (null in a three-team deal the record can't
   *  attribute) */
  from: number | null;
  /** how the sender came to hold it: the step before this trade. Null when the
   *  sender held it from the start — its own pick, or a player before the
   *  league's history begins. */
  origin: Step | null;
  /** everything after this trade, oldest first */
  steps: Step[];
  end: End;
}

type Ev =
  | { kind: "trade"; trade: Trade; to: number }
  | { kind: "own"; e: OwnEvent };

export interface LineageIndex {
  byId: Map<string, Trade>;
  /** trade ids a commissioner move undid */
  reversed: Set<string>;
  trace: (t: Trade, rid: number) => Lineage[];
}

const pickKey = (ps: number, rnd: number, orig: number) => `${ps}:${rnd}:${orig}`;

/** the side that gave an asset up: the other side of a two-team deal, else the
 *  holder before, else unknown */
function giver(t: Trade, to: number, before: number | null): number | null {
  if (t.sides.length === 2) return t.sides.find(s => s.rid !== to)?.rid ?? before;
  return before;
}

function gotBy(t: Trade, rid: number | null): TradeAsset[] {
  return rid == null ? [] : t.sides.find(s => s.rid === rid)?.got ?? [];
}

/** an ownership entry as a step; `traded` entries are consumed by the merge and
 *  never reach here. Unknown wording returns null rather than a guessed step. */
export function ownStep(e: OwnEvent, pid: string): Step | null {
  const [season, week, text] = e;
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^drafted (\d+\.\d+) by (.+)$/)))
    return { kind: "drafted", season, slot: m[1], team: m[2].trim(), pid };
  if ((m = t.match(/^dropped by (.+)$/)))
    return { kind: "dropped", season, week, team: m[1].trim() };
  if ((m = t.match(/^waiver claim by (.+)$/)))
    return { kind: "claimed", season, week, team: m[1].trim(), how: "waiver" };
  if ((m = t.match(/^signed by (.+)$/)))
    return { kind: "claimed", season, week, team: m[1].trim(), how: "signed" };
  if ((m = t.match(/^commissioner to (.+)$/)))
    return { kind: "commissioner", season, week, team: m[1].trim() };
  return null;
}

export function buildLineage(trades: Trade[], ownership: Ownership, rostered: Map<string, number>): LineageIndex {
  const asc = trades.slice().sort((a, b) => a.ts - b.ts);
  const byId = new Map(asc.map(t => [tradeId(t), t]));

  /* every hop of every pick, oldest first */
  const pickHops = new Map<string, { trade: Trade; rid: number; a: TradeAsset }[]>();
  /* every trade of every player AS A PLAYER — a pick asset carries its drafted
     player's pid too, but trading the pick before the draft is not the player
     moving, so only kind === "player" counts here */
  const playerTrades = new Map<string, { trade: Trade; rid: number }[]>();
  for (const t of asc) for (const s of t.sides) for (const a of s.got) {
    if (a.kind === "pick" && a.ps != null && a.rnd != null && a.orig != null) {
      const k = pickKey(a.ps, a.rnd, a.orig);
      (pickHops.get(k) ?? pickHops.set(k, []).get(k)!).push({ trade: t, rid: s.rid, a });
    } else if (a.kind === "player" && a.pid) {
      (playerTrades.get(a.pid) ?? playerTrades.set(a.pid, []).get(a.pid)!).push({ trade: t, rid: s.rid });
    }
  }

  /* one player's whole path, trades from trades.json slotted where his
     ownership list says they happened */
  const timelines = new Map<string, Ev[]>();
  const reversed = new Set<string>();
  const timeline = (pid: string): Ev[] => {
    const hit = timelines.get(pid);
    if (hit) return hit;
    const queue = (playerTrades.get(pid) ?? []).slice();
    const out: Ev[] = [];
    for (const e of ownership[pid] ?? []) {
      if (e[2].startsWith("traded")) {
        const next = queue.shift();
        if (next) out.push({ kind: "trade", trade: next.trade, to: next.rid });
      } else {
        out.push({ kind: "own", e });
      }
    }
    for (const q of queue) out.push({ kind: "trade", trade: q.trade, to: q.rid });
    timelines.set(pid, out);
    return out;
  };
  // REVERSALS, found once for every traded player so any page can say so
  for (const pid of playerTrades.keys()) {
    const tl = timeline(pid);
    tl.forEach((ev, i) => {
      const nx = tl[i + 1];
      if (ev.kind === "trade" && nx?.kind === "own" && nx.e[2].startsWith("commissioner")
        && nx.e[0] === ev.trade.season && nx.e[1] === ev.trade.week) reversed.add(tradeId(ev.trade));
    });
  }

  /** a timeline slice as steps, tracking the holder so a three-team hop can
   *  still name who gave the player up when the last holder is known */
  const stepsOf = (pid: string, evs: Ev[], holder: number | null): Step[] => {
    const out: Step[] = [];
    let h = holder;
    for (const ev of evs) {
      if (ev.kind === "trade") {
        const from = giver(ev.trade, ev.to, h);
        out.push({ kind: "trade", trade: ev.trade, from, to: ev.to,
          got: gotBy(ev.trade, from), reversed: reversed.has(tradeId(ev.trade)) });
        h = ev.to;
      } else {
        const s = ownStep(ev.e, pid);
        if (s) out.push(s);
        h = null;            // a name, not a slot, from here until the next trade
      }
    }
    return out;
  };

  const playerEnd = (pid: string, steps: Step[]): End => {
    const rid = rostered.get(pid);
    if (rid != null) return { kind: "rostered", rid };
    const last = steps[steps.length - 1];
    if (last?.kind === "dropped") return { kind: "free agent", season: last.season, week: last.week };
    return { kind: "gone" };
  };

  /** the step that put a player on the sender's roster */
  const evStep = (pid: string, ev: Ev | undefined, before: number | null): Step | null =>
    !ev ? null : stepsOf(pid, [ev], before)[0] ?? null;

  const tracePlayer = (t: Trade, rid: number, a: TradeAsset): Lineage => {
    const pid = a.pid!;
    const tl = timeline(pid);
    const i = tl.findIndex(ev => ev.kind === "trade" && ev.trade === t && ev.to === rid);
    const from = giver(t, rid, null);
    if (i < 0) {
      // not on his timeline (shouldn't happen): later trades only
      const later = tl.filter(ev => ev.kind === "trade" && ev.trade.ts > t.ts);
      const steps = stepsOf(pid, later, rid);
      return { asset: a, from, origin: null, steps, end: playerEnd(pid, steps) };
    }
    const prev = tl[i - 1];
    const steps = stepsOf(pid, tl.slice(i + 1), rid);
    return {
      asset: a, from,
      origin: evStep(pid, prev, null),
      steps, end: playerEnd(pid, steps),
    };
  };

  const tracePick = (t: Trade, rid: number, a: TradeAsset): Lineage => {
    const hops = pickHops.get(pickKey(a.ps!, a.rnd!, a.orig!)) ?? [];
    const i = hops.findIndex(h => h.trade === t && h.rid === rid);
    const holderBefore = (j: number) => (j > 0 ? hops[j - 1].rid : a.orig!);
    const hopStep = (j: number): Step => {
      const h = hops[j];
      const from = giver(h.trade, h.rid, holderBefore(j));
      return { kind: "trade", trade: h.trade, from, to: h.rid, got: gotBy(h.trade, from),
        reversed: reversed.has(tradeId(h.trade)) };
    };
    const from = i >= 0 ? giver(t, rid, holderBefore(i)) : giver(t, rid, null);
    const origin = i > 0 ? hopStep(i - 1) : null;
    const steps: Step[] = [];
    for (let j = i + 1; j < hops.length; j++) steps.push(hopStep(j));
    const holder = hops.length ? hops[hops.length - 1].rid : rid;
    // the drafted player, off whichever record of the pick carries it
    const pid = hops.map(h => h.a.pid).find(Boolean) ?? a.pid;
    if (pid) {
      const tl = timeline(pid);
      const d = tl.findIndex(ev => ev.kind === "own" && ev.e[2].startsWith("drafted"));
      if (d >= 0) {
        steps.push(...stepsOf(pid, tl.slice(d), holder));
      } else {
        // no draft entry on record: say what the trade record knows
        steps.push({ kind: "drafted", season: String(a.ps), team: null, pid,
          slot: a.slot != null && a.rnd != null ? `${a.rnd}.${a.slot}` : null });
        steps.push(...stepsOf(pid, tl, holder));
      }
      return { asset: a, from, origin, steps, end: playerEnd(pid, steps) };
    }
    if (/\(unused\)$/.test(a.label)) return { asset: a, from, origin, steps, end: { kind: "unused" } };
    return { asset: a, from, origin, steps, end: { kind: "pick", rid: holder, ps: a.ps!, rnd: a.rnd! } };
  };

  const trace = (t: Trade, rid: number): Lineage[] =>
    (t.sides.find(s => s.rid === rid)?.got ?? []).map(a => {
      if (a.kind === "faab")
        return { asset: a, from: giver(t, rid, null), origin: null, steps: [], end: { kind: "faab" } };
      if (a.kind === "pick" && a.ps != null && a.rnd != null && a.orig != null) return tracePick(t, rid, a);
      if (a.pid) return tracePlayer(t, rid, a);
      return { asset: a, from: giver(t, rid, null), origin: null, steps: [], end: { kind: "gone" } };
    });

  return { byId, reversed, trace };
}
