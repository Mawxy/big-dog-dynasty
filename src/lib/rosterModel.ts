import type { PickValues, Projection, Team } from "./types";
import { DEFAULT_LINEUP, optimalLineup } from "./league";

/**
 * Roster-level valuation shared across the board.
 *
 *  - `rosterShapes` — a franchise's optimal lineup and bench, ranked slot by
 *    slot against the league, in each of the two currencies (CVI and DVI).
 *    Consumed by the franchise page's strengths panel.
 *  - `pickStream` — a rookie pick's net option value as a three-year stream,
 *    by tier and round. Consumed by the Trade Calculator.
 *
 * (`suggestTrades`, the marginal-lineup trade search, lived here until the
 * franchise page's "Suggested trades" card was removed. `computePostures` and
 * the contend/rebuild window weights it fed went the same way once the Trade
 * Calculator stopped tilting by posture — recover either from git history.)
 */

/** round names for pick labels — TradeCalc used to carry its own copy */
export const ROUND_ORD = ["1st", "2nd", "3rd", "4th"];

const optStream = (pv: PickValues, label: string): number[] => {
  const b = pv.bands.find(x => x.label === label);
  if (!b) return [0, 0, 0];
  return [1, 2, 3].map(y => {
    const d = b.dist?.[String(y)];
    if (d?.length) return d.reduce((a, x) => a + Math.max(0, x), 0) / d.length;
    return Math.max(0, b.raw[String(y)] ?? 0);
  });
};

/** Bridge A tier stream for a future pick, as NET option value.
 *  Corrections over the raw band means:
 *  1. busts get cut for waiver bodies, so outcomes clamp at 0 (E[max(0,x)]) —
 *     raw means go negative for late rounds, which made "throwing in a pick"
 *     read as shedding toxic waste;
 *  2. the counterfactual isn't zero — every manager already holds unlimited
 *     free darts on the waiver wire, so a pick is only worth its option value
 *     ABOVE the free-agency dart. The Late 4th band is empirically waiver-tier
 *     and serves as that baseline (and itself nets to ~0, matching how the
 *     league actually treats 4ths: throw-ins);
 *  3. board monotonicity: an earlier pick can never be worth less than a later
 *     one. Thin adjacent bands (Mid 3rd vs Mid 4th) invert on sampling noise,
 *     so a pool-adjacent-violators pass makes 3-yr totals non-increasing down
 *     the board, each band's yearly shape rescaled to its adjusted total. */
const TIER_ORDER = ["Early", "Mid", "Late"];
const pickTableCache = new WeakMap<PickValues, Map<string, number[]>>();
function pickTable(pv: PickValues): Map<string, number[]> {
  let t = pickTableCache.get(pv);
  if (t) return t;
  const base = optStream(pv, "Late 4th");
  const entries: { key: string; stream: number[]; total: number }[] = [];
  for (let r = 1; r <= 4; r++)
    for (const tier of TIER_ORDER) {
      const stream = optStream(pv, `${tier} ${ROUND_ORD[r - 1]}`)
        .map((x, i) => Math.max(0, x - (base[i] ?? 0)));
      entries.push({ key: `${tier} ${ROUND_ORD[r - 1]}`, stream,
        total: stream.reduce((a, b) => a + b, 0) });
    }
  // PAV, non-increasing in board order
  const blocks: { sum: number; n: number }[] = [];
  for (const e of entries) {
    blocks.push({ sum: e.total, n: 1 });
    while (blocks.length > 1 &&
      blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n
      < blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].n += b.n;
    }
  }
  const fit: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) fit.push(b.sum / b.n);
  t = new Map(entries.map((e, i) => {
    const target = fit[i];
    const scaled = e.total > 1e-9
      ? e.stream.map(x => x * target / e.total)
      : [target / 3, target / 3, target / 3];
    return [e.key, scaled.map(x => Math.round(x * 1000) / 1000)];
  }));
  pickTableCache.set(pv, t);
  return t;
}
export const pickStream = (pv: PickValues, tier: string, round: number): number[] =>
  pickTable(pv).get(`${tier} ${ROUND_ORD[round - 1]}`) ?? [0, 0, 0];

interface PoolP { id: string; pos: string; comp: number[]; age?: number }

const poolOf = (t: Team, byPid: Map<string, Projection>): PoolP[] =>
  t.players.map(pid => byPid.get(pid))
    .filter((p): p is Projection => !!p)
    .map(p => ({ id: p.pid, pos: p.pos, comp: p.composite, age: p.age }));

const STRENGTH_POS = ["QB", "RB", "WR", "TE"];

/**
 * The seats these grids rank — dedicated positions only, no flex.
 *
 * FLEX is dropped because the COLUMN would not mean the same thing on every
 * roster: the slot splits roughly 6 RB / 5 WR / 1 TE across the league, so
 * "4th at FLX" would be comparing a tight end against a running back and
 * calling it a rank. One unranked seat beats a column that changes meaning
 * team to team.
 *
 * (Under raw WAR there was a second, stronger reason — WAR is measured from a
 * per-position replacement baseline, so cross-position comparison is comparing
 * distances from different origins. CVI and DVI are both single 0-100 scales
 * and do not have that problem, so a flex column is now merely ambiguous
 * rather than incoherent. It stays dropped on the first reason.)
 *
 * SUPER_FLEX becomes a second QB rather than being dropped. In this league
 * that is not an assumption — when the slot was left free the optimiser
 * independently seated exactly 24 QBs across 12 rosters.
 */
export function rankingLineup(lineup: string[]): string[] {
  const out: string[] = [];
  for (const s of lineup) {
    if (STRENGTH_POS.includes(s)) out.push(s);
    else if (s === "SUPER_FLEX") out.push("QB");
  }
  // dedicated seats first, grouped, so labels come out QB1 QB2 RB1 RB2 …
  return STRENGTH_POS.flatMap(P => out.filter(s => s === P));
}

/** an index's reading for one player: the 0-100 value and its rank WITHIN the
 *  player's position, straight out of cvi.json / dvi.json */
export interface IndexEntry { value: number; posRank: number }
const NO_ENTRY: IndexEntry = { value: 0, posRank: 0 };

/** one seat in an optimized lineup and whoever holds it */
export interface SlotRow {
  slot: string; label: string;
  pid: string | null; name: string; pos: string;
  cvi: IndexEntry; dvi: IndexEntry;
}

/** one currency's league ranks, seat by seat: QB1, RB1, RB2, … FLX, SFLX */
export interface RankCell {
  label: string; value: number; rank: number;
  /** rank within position in this currency — the RB5 in "CMC · 75.0 · RB5".
   *  Distinct from `rank`, which is this SEAT against the same seat league-wide. */
  posRank: number;
  pid: string | null; name: string; pos: string;
}
export interface RankRow {
  key: "cvi" | "dvi";
  label: string; note: string;
  cells: RankCell[];
}

export interface RosterShape {
  /** the starting eight, one row per currency */
  ranks: RankRow[];
  /** the same seats refilled from everyone who missed the first cut */
  benchRanks: RankRow[];
}

/**
 * A franchise's shape: its optimal starting lineup slot by slot, and the
 * second string behind it.
 *
 * STARTERS are shown as league-wide positional ranks, by both currencies —
 * CVI (value this season) and DVI (dynasty asset value) — because the two
 * disagree in the interesting cases. A 33-year-old WR1 by CVI who is WR20 by
 * DVI is a very different roster spot from a 23-year-old who is both.
 *
 * CVI replaced raw projected WAR here. Both are win-now measures, but WAR is
 * per-position baselined, which made it a distance from one of four different
 * origins rather than a value; and its sub-replacement population collapsed
 * (73% of rostered RBs projected <= 0), so bench seats tied en masse. CVI is a
 * single 0-100 scale for every position with 10 exact ties at the floor
 * instead, and it carries expert consensus and real starter usage on top of
 * the same projection.
 *
 * DEPTH is a SECOND-STRING LINEUP rather than a scored pile. Everyone who
 * misses the first eleven is run through the same optimiser again, filling the
 * same nine seats, and each of those seats is ranked against the same seat on
 * every other roster. So "your backup RB1 is 3rd in the league" is a plain
 * statement about one player, in the same shape as the starters grid.
 *
 * This replaced a weighted bench score — surplus over a replacement bar,
 * softened by a per-position tau and discounted per body. That machinery is
 * gone: it collapsed a whole bench into one number that could not be checked
 * by eye, and its answer swung hard on where the bar sat. A second lineup says
 * the same thing without a free parameter.
 */
export function rosterShapes(
  players: Projection[], teams: Team[],
  idx: { cvi: Record<string, IndexEntry>; dvi: Record<string, IndexEntry> },
  rosterPositions: string[] = DEFAULT_LINEUP,
): Map<number, RosterShape> {
  const lineup = rankingLineup(rosterPositions);
  const byPid = new Map(players.map(p => [p.pid, p]));
  const dviOf = (id: string) => idx.dvi[id] ?? NO_ENTRY;
  // cvi.json is built FROM projections.json, so coverage here is 1:1 and the
  // fallback never fires for a projected player. It matters for anyone rostered
  // without a projection, who correctly reads as no win-now value at all.
  const cviOf = (id: string) => idx.cvi[id] ?? NO_ENTRY;

  /** Optimize every roster in ONE currency and keep the resulting seats and
   *  bench. Run twice: each row of the grid is that currency's own best nine,
   *  so the DVI row is the most valuable legal lineup rather than the win-now
   *  lineup re-priced. A slot can therefore hold different players in the two
   *  rows — which is the point, and why each cell names who is in it. */
  const buildLineup = (
    val: (p: PoolP) => number, poolFor?: Map<number, PoolP[]>,
    labelFrom: Record<string, number> = {},
  ) => {
    const slotsOf = new Map<number, SlotRow[]>();
    const benchOf = new Map<number, PoolP[]>();
    for (const t of teams) {
      const pool = poolFor ? poolFor.get(t.roster_id) ?? [] : poolOf(t, byPid);
      const { slots, starters } = optimalLineup(
        // `war` is just optimalLineup's name for the quantity being maximized;
        // here it carries a CVI or DVI index value, never WAR
        pool.map(p => ({ id: p.id, pos: p.pos, war: val(p) })), lineup);
      // Seats are numbered within their position and the numbering CONTINUES
      // into the second string — QB3, QB4, RB3, RB4, WR4… — so a column header
      // names the exact seat on the depth chart. Without the offset the bench
      // grid repeated QB1/QB2 and an empty cell read as a hole in the starting
      // lineup rather than as "no fourth quarterback", which is what it is.
      const seen: Record<string, number> = { ...labelFrom };
      slotsOf.set(t.roster_id, slots.map(s => {
        const p = s.player ? byPid.get(s.player.id) : null;
        seen[s.slot] = (seen[s.slot] ?? 0) + 1;
        return {
          slot: s.slot, label: `${s.slot}${seen[s.slot]}`,
          pid: p?.pid ?? null, name: p?.name ?? "—", pos: p?.pos ?? "",
          cvi: p ? cviOf(p.pid) : NO_ENTRY, dvi: p ? dviOf(p.pid) : NO_ENTRY,
        };
      }));
      benchOf.set(t.roster_id, pool.filter(p => !starters.has(p.id)));
    }
    return { slotsOf, benchOf };
  };
  const cviVal = (p: PoolP) => cviOf(p.id).value;
  const dviVal = (p: PoolP) => dviOf(p.id).value;
  const byCvi = buildLineup(cviVal);
  const byDvi = buildLineup(dviVal);
  // second string: the same seats again, filled from whoever missed the first
  // cut, labeled onward from where the starters left off
  const seatsPerPos: Record<string, number> = {};
  for (const s of lineup) seatsPerPos[s] = (seatsPerPos[s] ?? 0) + 1;
  const benchCvi = buildLineup(cviVal, byCvi.benchOf, seatsPerPos);
  const benchDvi = buildLineup(dviVal, byDvi.benchOf, seatsPerPos);

  // ---- the two headline series -------------------------------------------
  // Same columns twice, in the two currencies, because they answer different
  // questions and the gap between them IS the read on a franchise: a team 1st
  // by CVI and 9th by DVI is winning now with assets that are draining.
  //   CVI = this season's value of whoever wins the seat (consensus + usage +
  //         projection), on one 0-100 scale across every position.
  //   DVI = dynasty value of whoever wins the seat.
  // Slot i is compared against slot i on every other roster, so "RB2 4th" means
  // the fourth-best second running back in the league, not the fourth-best RB.
  // optimalLineup fills repeated dedicated slots best-first, so slot order is
  // consistent across teams. Each row uses its OWN optimized lineup and bench.
  const series = (
    key: RankRow["key"], label: string, note: string,
    L: { slotsOf: Map<number, SlotRow[]> }, entryOf: (s: SlotRow) => IndexEntry,
  ) => {
    const slotVal = (s: SlotRow) => entryOf(s).value;
    const nSlots = L.slotsOf.get(teams[0].roster_id)!.length;
    // An EMPTY seat ranks last, not at zero. Owning a fourth quarterback is
    // strictly better than not owning one, even a bad fourth quarterback —
    // scoring the gap at 0 let an empty seat tie the ten players sitting at
    // CVI 0.00, which reads as a reward for having nobody.
    const seatVal = (s: SlotRow) => s.pid ? slotVal(s) : -Infinity;
    const cols: number[][] = [];
    for (let i = 0; i < nSlots; i++)
      cols.push(teams.map(t => seatVal(L.slotsOf.get(t.roster_id)![i])));
    // epsilon still applies to real values; -Infinity + 1e-9 is -Infinity, so
    // empty seats all tie with each other and lose to every real body
    const rankIn = (vals: number[], v: number) => 1 + vals.filter(x => x > v + 1e-9).length;
    return (rid: number): RankRow => ({
      key, label, note,
      cells: L.slotsOf.get(rid)!.map((s, i) => ({
        label: s.label, value: slotVal(s), rank: rankIn(cols[i], seatVal(s)),
        posRank: entryOf(s).posRank,
        pid: s.pid, name: s.name, pos: s.pos,
      })),
    });
  };
  const cviOfSlot = (s: SlotRow): IndexEntry => s.cvi;
  const dviOfSlot = (s: SlotRow): IndexEntry => s.dvi;
  const starters = [
    series("cvi", "CVI", "value this season", byCvi, cviOfSlot),
    series("dvi", "DVI", "dynasty value", byDvi, dviOfSlot),
  ];
  const second = [
    series("cvi", "CVI", "value this season", benchCvi, cviOfSlot),
    series("dvi", "DVI", "dynasty value", benchDvi, dviOfSlot),
  ];

  const out = new Map<number, RosterShape>();
  for (const t of teams) out.set(t.roster_id, {
    ranks: starters.map(f => f(t.roster_id)),
    benchRanks: second.map(f => f(t.roster_id)),
  });
  return out;
}
