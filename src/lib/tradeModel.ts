import type { PicksOwned, PickValues, Projection, Team } from "./types";
import { optimalLineup } from "./league";

/** Shared trade-valuation model: franchise postures (per-year window weights),
 *  pick labels/streams, and the trade-suggestion search. Used by the Trade
 *  Calculator (team mode) and the franchise pages' "Suggested trades" card. */

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

/** Bridge A tier stream for a future pick: WAR by years-since-draft */
export const pickStream = (pv: PickValues, tier: string, round: number): number[] => {
  const b = pv.bands.find(x => x.label === `${tier} ${ORD[round - 1]}`);
  return b ? [1, 2, 3].map(y => b.raw[String(y)] ?? 0) : [0, 0, 0];
};

interface PoolP { id: string; pos: string; comp: number[]; age?: number }

const poolOf = (t: Team, byPid: Map<string, Projection>): PoolP[] =>
  t.players.map(pid => byPid.get(pid))
    .filter((p): p is Projection => !!p)
    .map(p => ({ id: p.pid, pos: p.pos, comp: p.composite, age: p.age }));

const lwY = (pool: PoolP[], y: number) =>
  optimalLineup(pool.map(p => ({ id: p.id, pos: p.pos, war: p.comp[y] ?? 0 })))
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

export interface SuggestedTrade {
  targetPid: string; targetName: string; targetPos: string;
  fromRid: number; fromName: string;
  sendPids: string[]; sendNames: string[];
  sendPicks: { season: number; round: number; label: string }[];
  netMe: number; netThem: number;
  needPos: string; needRank: number; shortfall: number;
  gainNow: number;
}

/** Find win-win trades that fill `rid`'s weakest starting position(s).
 *  Everything is valued as MARGINAL lineup impact (optimal lineup with vs
 *  without, per year, through each side's window weights) — a star displacing
 *  your worst starter counts in full, a fourth WR counts for almost nothing,
 *  which is the principled version of the market's "star bonus". Depth still
 *  gets a 15% residual so bench bodies aren't literally free. */
export function suggestTrades(rid: number, players: Projection[], teams: Team[],
  pv: PickValues, owned: PicksOwned | null, postures: Posture[],
  rosterSeason: number): SuggestedTrade[] {
  const byPid = new Map(players.map(p => [p.pid, p]));
  const me = teams.find(t => t.roster_id === rid);
  const myPost = postures.find(p => p.rid === rid);
  if (!me || !myPost) return [];
  const wOf = (r: number) => postures.find(p => p.rid === r)?.w ?? NEUTRAL;
  const wMe = wOf(rid);
  const pools = new Map(teams.map(t => [t.roster_id, poolOf(t, byPid)]));
  const baseLW = new Map<number, number[]>();
  const lw3 = (r: number) => {
    let v = baseLW.get(r);
    if (!v) { v = [0, 1, 2].map(y => lwY(pools.get(r)!, y)); baseLW.set(r, v); }
    return v;
  };
  const raw3 = (p: PoolP, w: number[]) =>
    p.comp.reduce((a, x, i) => a + x * (w[i] ?? 0), 0);
  const val = (w: number[], d: number[]) => d.reduce((a, x, i) => a + x * w[i], 0);
  const swapDelta = (r: number, add: PoolP[], remove: Set<string>): number[] => {
    const p = pools.get(r)!.filter(x => !remove.has(x.id)).concat(add);
    const base = lw3(r);
    return [0, 1, 2].map(y => lwY(p, y) - base[y]);
  };

  // ---- need diagnosis: startable strength per position vs the league -------
  const SLOTN: Record<string, number> = { QB: 2, RB: 2, WR: 3, TE: 1 };  // SF ~ QB2
  const posStr = (r: number, P: string) => {
    const top = pools.get(r)!.filter(p => p.pos === P)
      .map(p => p.comp[0] ?? 0).sort((a, b) => b - a).slice(0, SLOTN[P]);
    return top.reduce((a, b) => a + b, 0);
  };
  const allNeeds = Object.keys(SLOTN).map(P => {
    const all = teams.map(t => posStr(t.roster_id, P));
    const mine = posStr(rid, P);
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    return { P, shortfall: mean - mine, rank: 1 + all.filter(v => v > mine + 1e-9).length };
  });
  let needs = allNeeds.slice().sort((a, b) => b.shortfall - a.shortfall)
    .filter(x => x.shortfall > 0.05).slice(0, 2);
  // a top roster can be above the league mean everywhere — its "need" is then
  // its weakest spot RELATIVE to its own strength (worst positional rank)
  if (!needs.length)
    needs = allNeeds.slice().sort((a, b) => b.rank - a.rank).slice(0, 1);

  // ---- what I can send: players cheap to me but valuable to others ---------
  const sendables = pools.get(rid)!
    .map(p => ({ p, lossMe: -val(wMe, swapDelta(rid, [], new Set([p.id]))) }))
    .map(x => ({ ...x, surplus: raw3(x.p, wMe) - x.lossMe }))
    .sort((a, b) => b.surplus - a.surplus).slice(0, 8);
  const myPicks = (owned?.owned?.[String(rid)] ?? [])
    .slice().sort((a, b) => a.round - b.round || a.season - b.season).slice(0, 3)
    .map(pk => ({ ...pk, label: pickLabel(postures, pk) }));
  const pickVal = (w: number[], pk: { season: number; round: number; orig: number }) =>
    pickStream(pv, tierFor(postures, pk.orig), pk.round)
      .reduce((a, x, k) => a + x * wAt(w, (pk.season - rosterSeason) + k), 0);

  // ---- search ---------------------------------------------------------------
  const DEPTH = 0.15;    // residual value of non-lineup bodies
  const MIN_NET = 0.15;  // both sides must clear this to count as win-win
  const best = new Map<string, SuggestedTrade>();
  for (const need of needs) {
    for (const t of teams) {
      const g = t.roster_id;
      if (g === rid) continue;
      const wG = wOf(g);
      const targets = pools.get(g)!.filter(p => p.pos === need.P)
        .sort((a, b) => raw3(b, wMe) - raw3(a, wMe)).slice(0, 2);
      for (const X of targets) {
        // candidate packages I could send back
        const pkgs: { ps: typeof sendables; pk: typeof myPicks }[] = [];
        for (const s1 of sendables) pkgs.push({ ps: [s1], pk: [] });
        for (const k1 of myPicks) pkgs.push({ ps: [], pk: [k1] });
        for (let i = 0; i < Math.min(5, sendables.length); i++) {
          for (let j = i + 1; j < Math.min(5, sendables.length); j++)
            pkgs.push({ ps: [sendables[i], sendables[j]], pk: [] });
          for (const k1 of myPicks.slice(0, 2))
            pkgs.push({ ps: [sendables[i]], pk: [k1] });
        }
        for (const pkg of pkgs) {
          if (pkg.ps.some(x => x.p.id === X.id)) continue;
          const sentIds = new Set(pkg.ps.map(x => x.p.id));
          const dMe = swapDelta(rid, [X], sentIds);
          const dG = swapDelta(g, pkg.ps.map(x => x.p), new Set([X.id]));
          // depth residuals: what doesn't crack a lineup isn't worthless
          const depthMe = DEPTH * (raw3(X, wMe) - val(wMe, dMe) > 0.01 ? raw3(X, wMe) - Math.max(0, val(wMe, dMe)) : 0);
          const depthG = DEPTH * pkg.ps.reduce((a, x) =>
            a + Math.max(0, raw3(x.p, wG) - Math.max(0, val(wG, dG))), 0);
          const netMe = val(wMe, dMe) + Math.max(0, depthMe)
            - pkg.pk.reduce((a, k) => a + pickVal(wMe, k), 0);
          const netG = val(wG, dG) + depthG
            + pkg.pk.reduce((a, k) => a + pickVal(wG, k), 0);
          if (netMe < MIN_NET || netG < MIN_NET) continue;
          const score = Math.min(netMe, netG);
          const prev = best.get(X.id);
          if (prev && Math.min(prev.netMe, prev.netThem) >= score) continue;
          best.set(X.id, {
            targetPid: X.id, targetName: byPid.get(X.id)!.name, targetPos: X.pos,
            fromRid: g, fromName: t.team.trim(),
            sendPids: pkg.ps.map(x => x.p.id),
            sendNames: pkg.ps.map(x => byPid.get(x.p.id)!.name),
            sendPicks: pkg.pk.map(k => ({ season: k.season, round: k.round, label: k.label })),
            netMe, netThem: netG,
            needPos: need.P, needRank: need.rank, shortfall: need.shortfall,
            gainNow: dMe[0],
          });
        }
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => Math.min(b.netMe, b.netThem) - Math.min(a.netMe, a.netThem))
    .slice(0, 3);
}
