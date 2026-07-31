import type { PicksOwned, PickValues, Projection, Team } from "./types";
import { DEFAULT_LINEUP, optimalLineup } from "./league";

/**
 * Roster-level valuation shared across the board.
 *
 *  - `rosterShapes` — a franchise's optimal lineup and bench, ranked slot by
 *    slot against the league, in each of the two currencies (CVI and DVI).
 *    Consumed by the franchise page's strengths panel.
 *  - `computePostures` / `pickLabel` / `pickStream` — per-year window weights
 *    and rookie-pick streams. Consumed by the Trade Calculator.
 *
 * (`suggestTrades`, the marginal-lineup trade search, lived here until the
 * franchise page's "Suggested trades" card was removed — recover it from git
 * history if a trade-finder ever comes back.)
 */

export const NEUTRAL: number[] = [1, 0.9, 0.81];   // no team context: pure decay
export const ORD = ["1st", "2nd", "3rd", "4th"];

/** weight for team-year n (0-based); beyond the horizon decay 0.9/yr */
export const wAt = (w: number[], n: number) =>
  n < w.length ? w[n] : w[w.length - 1] * 0.9 ** (n - w.length + 1);

export interface Posture {
  rid: number; name: string;
  /** strength per team-year (lineup + owned picks' production) */
  s: number[];
  rankNow: number; status: string;
  /** per-year window weights (normalized budget; tilt only) */
  w: number[];
  /** WAR-weighted average age of the current optimal lineup */
  age: number | null;
}

export const tierFor = (postures: Posture[], orig: number) => {
  const rk = postures.find(p => p.rid === orig)?.rankNow ?? 6;
  return rk >= 9 ? "Early" : rk >= 5 ? "Mid" : "Late";
};
export const pickLabel = (postures: Posture[],
  pk: { season: number; round: number; orig: number }) =>
  `${pk.season} ${tierFor(postures, pk.orig)} ${ORD[pk.round - 1]}`;

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
      const stream = optStream(pv, `${tier} ${ORD[r - 1]}`)
        .map((x, i) => Math.max(0, x - (base[i] ?? 0)));
      entries.push({ key: `${tier} ${ORD[r - 1]}`, stream,
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
  pickTable(pv).get(`${tier} ${ORD[round - 1]}`) ?? [0, 0, 0];

interface PoolP { id: string; pos: string; comp: number[]; age?: number }

const poolOf = (t: Team, byPid: Map<string, Projection>): PoolP[] =>
  t.players.map(pid => byPid.get(pid))
    .filter((p): p is Projection => !!p)
    .map(p => ({ id: p.pid, pos: p.pos, comp: p.composite, age: p.age }));

// waiver floor: no rational lineup starts a negative-composite player when
// free agency offers ~0-WAR bodies, so lineup value clamps each starter at 0.
// This also kills "addition by subtraction" trades — shipping away a bad
// player gains nothing, because benching him was always free.
const lwY = (pool: PoolP[], y: number) =>
  optimalLineup(pool.map(p => ({ id: p.id, pos: p.pos, war: Math.max(0, p.comp[y] ?? 0) })))
    .slots.reduce((a, s) => a + (s.player?.war ?? 0), 0);

/** Per-franchise posture: strength per year = aged optimal lineup + owned
 *  picks' landed production (tiered by the original owner's projected finish).
 *  Each year is weighted by ABSOLUTE strength (+1 WAR liquidity floor) times
 *  0.9/yr uncertainty decay, normalized to a common budget — an aging #1
 *  tilts to now, an ascending rebuilder weights year 3 above year 1. */
export function computePostures(players: Projection[], teams: Team[],
  pv: PickValues, owned: PicksOwned | null, rosterSeason: number): Posture[] {
  const byPid = new Map(players.map(p => [p.pid, p]));
  const base = teams.map(t => ({ t, pool: poolOf(t, byPid) }));
  const n = base.length;
  const nowOf = new Map(base.map(b => [b.t.roster_id, lwY(b.pool, 0)]));
  const rankNowOf = new Map([...nowOf.entries()].sort((a, b) => b[1] - a[1])
    .map(([rid], i) => [rid, i + 1]));
  const preTier = (orig: number) => {
    const rk = rankNowOf.get(orig) ?? 6;
    return rk >= 9 ? "Early" : rk >= 5 ? "Mid" : "Late";
  };
  const strength = (b: typeof base[number], y: number) => {
    let s = lwY(b.pool, y - 1);
    for (const pk of owned?.owned?.[String(b.t.roster_id)] ?? []) {
      const k = (rosterSeason + y - 1) - pk.season;
      if (k >= 0 && k <= 2)
        s += pickStream(pv, preTier(pk.orig), pk.round)[k] ?? 0;
    }
    return s;
  };
  const lineupAge = (pool: PoolP[]) => {
    const starters = optimalLineup(pool.map(p => ({ ...p, war: p.comp[0] ?? 0 })))
      .slots.map(s => s.player).filter((p): p is NonNullable<typeof p> => !!p)
      .filter(p => p.age != null);
    const wt = starters.map(p => Math.max(0.1, p.war));
    const tot = wt.reduce((a, b) => a + b, 0);
    return tot ? starters.reduce((a, p, i) => a + p.age! * wt[i], 0) / tot : null;
  };
  const BUDGET = NEUTRAL.reduce((a, b) => a + b, 0);
  return base.map(b => {
    const rid = b.t.roster_id;
    const s = [1, 2, 3].map(y => strength(b, y));
    const raw = [0, 1, 2].map(y => (1 + Math.max(0, s[y])) * 0.9 ** y);
    const k = BUDGET / raw.reduce((a, x) => a + x, 0);
    const rankNow = rankNowOf.get(rid)!;
    return {
      rid, name: b.t.team.trim(), s: s.map(x => Math.round(x * 100) / 100),
      rankNow,
      status: rankNow <= 4 ? "contender" : rankNow <= 8 ? "middling" : "rebuilding",
      w: raw.map(x => Math.round(x * k * 100) / 100),
      age: lineupAge(b.pool),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

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

/** one seat in an optimised lineup and whoever holds it */
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

  /** Optimise every roster in ONE currency and keep the resulting seats and
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
        // `war` is just optimalLineup's name for the quantity being maximised;
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
  // cut, labelled onward from where the starters left off
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
  // consistent across teams. Each row uses its OWN optimised lineup and bench.
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
