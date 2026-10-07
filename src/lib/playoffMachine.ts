import type { Matchups, WeekOdds } from "./types";

/**
 * THE PLAYOFF MACHINE (Max, 2026-10-07).
 *
 * The season simulation from scripts/week_odds.py (`season_sim`), rebuilt in
 * the browser so a reader can lock the winner of any remaining game and watch
 * the playoff odds and the seeding move. Same inputs, same rules:
 *
 *  - the standings as played are taken as given (matchups.json);
 *  - every remaining regular-season game is drawn from the two sides'
 *    (mu, sd) lines in odds.json — the projected lineups, priced with no
 *    lookahead;
 *  - the table is seeded the way the league seeds: wins, then points for;
 *  - the top PLAYOFF_TEAMS make it, and the best seeds rest through round one
 *    until the field fills a power of two (six teams: two byes).
 *
 * A LOCKED GAME KEEPS ITS SCORES. The draw happens exactly as it would
 * unlocked, and when it lands on the wrong side the two scores swap. So a
 * locked game still moves points-for by a realistic amount, which is what
 * the tiebreak reads, rather than handing the winner a fixed figure.
 *
 * COMMON RANDOM NUMBERS. Every run uses the same seed and draws the games in
 * the same order, so the baseline (nothing locked) and the reader's scenario
 * see the identical season everywhere they agree. The difference between the
 * two columns is the picks, not Monte Carlo noise.
 */

/** this league runs six; week_odds.py reads the same from league settings */
export const PLAYOFF_TEAMS = 6;
export const SIMS = 10000;

export interface MachineGame {
  /** `${wk}:${lo}-${hi}`, stable across renders and data refreshes */
  id: string;
  wk: number;
  a: number; b: number;
  ma: number; sa: number; mb: number; sb: number;
  /** a's pregame win probability off the same line */
  wpA: number;
}

export interface MachineState {
  rids: number[];
  wins: Record<number, number>;
  losses: Record<number, number>;
  ties: Record<number, number>;
  pts: Record<number, number>;
  games: MachineGame[];
  weeks: number[];
}

/** rid -> winner rid, for the games the reader has locked */
export type Picks = Record<string, number>;

export interface MachineRow {
  rid: number;
  playoff: number;
  bye: number;
  /** mean final seed, 1 = best */
  seed: number;
  /** mean final regular-season wins */
  wins: number;
  /** share of sims finishing in each seed, index 0 = the 1 seed */
  seeds: number[];
}

export const firstRoundByes = (n: number) => {
  let size = 1;
  while (size < n) size *= 2;
  return size - n;
};

const erf = (x: number) => {
  // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7: plenty for a percentage
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
};
const winProb = (ma: number, sa: number, mb: number, sb: number) =>
  0.5 * (1 + erf((ma - mb) / Math.sqrt(2 * (sa * sa + sb * sb))));

export function buildState(mw: Matchups, odds: WeekOdds): MachineState | null {
  const ps = mw.playoff_start || 15;
  const rids = [...new Set([
    ...Object.keys(mw.teams).map(Number),
    ...Object.values(mw.schedule ?? {}).flatMap(pairs => pairs.flat()),
  ])].sort((x, y) => x - y);
  if (!rids.length) return null;
  const zero = () => Object.fromEntries(rids.map(r => [r, 0])) as Record<number, number>;
  const wins = zero(), losses = zero(), ties = zero(), pts = zero();
  const played = new Set<number>();
  for (const [r, list] of Object.entries(mw.teams)) {
    const rid = Number(r);
    for (const e of list) {
      if (e[0] >= ps || e[3] == null) continue;
      played.add(e[0]);
      pts[rid] += e[1];
      if (e[1] > e[3]) wins[rid] += 1;
      else if (e[1] < e[3]) losses[rid] += 1;
      else ties[rid] += 1;
    }
  }
  // a team's fallback line for a week odds.json has not priced: its own mean
  const fallback = (rid: number) => {
    const mus = Object.values(odds.weeks).map(w => w[String(rid)]?.mu).filter((m): m is number => m != null);
    return mus.length ? mus.reduce((a, b) => a + b, 0) / mus.length : 120;
  };
  const games: MachineGame[] = [];
  for (const [wkS, pairs] of Object.entries(mw.schedule ?? {})) {
    const wk = Number(wkS);
    if (wk >= ps || played.has(wk)) continue;
    const line = odds.weeks[wkS] ?? {};
    for (const [a, b] of pairs) {
      const la = line[String(a)], lb = line[String(b)];
      const ma = la?.mu ?? fallback(a), sa = la?.sd ?? 24;
      const mb = lb?.mu ?? fallback(b), sb = lb?.sd ?? 24;
      games.push({
        id: `${wk}:${Math.min(a, b)}-${Math.max(a, b)}`, wk, a, b, ma, sa, mb, sb,
        wpA: la?.wp ?? winProb(ma, sa, mb, sb),
      });
    }
  }
  games.sort((x, y) => x.wk - y.wk || x.id.localeCompare(y.id));
  const weeks = [...new Set(games.map(g => g.wk))];
  return { rids, wins, losses, ties, pts, games, weeks };
}

/** mulberry32: small, fast, seedable — the same season on every run */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(st: MachineState, picks: Picks, sims = SIMS, seed = 20261007): Record<number, MachineRow> {
  const n = st.rids.length;
  const nPo = Math.max(2, Math.min(PLAYOFF_TEAMS, n));
  const nBye = firstRoundByes(nPo);
  const idx = new Map(st.rids.map((r, i) => [r, i]));
  const baseW = st.rids.map(r => st.wins[r] + 0.5 * st.ties[r]);
  const baseP = st.rids.map(r => st.pts[r]);
  const G = st.games.map(g => ({
    a: idx.get(g.a)!, b: idx.get(g.b)!, ma: g.ma, sa: g.sa, mb: g.mb, sb: g.sb,
    lock: picks[g.id] == null ? -1 : picks[g.id] === g.a ? 0 : 1,
  }));
  const made = new Float64Array(n), bye = new Float64Array(n);
  const seedSum = new Float64Array(n), winSum = new Float64Array(n);
  const seedCount = Array.from({ length: n }, () => new Float64Array(n));
  const w = new Float64Array(n), p = new Float64Array(n);
  const order = st.rids.map((_, i) => i);
  const rand = rng(seed);
  // Box-Muller, both halves used: two normals per game, one per side
  const gauss2 = (): [number, number] => {
    let u = rand(); if (u < 1e-12) u = 1e-12;
    const v = rand(), r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
    return [r * Math.cos(th), r * Math.sin(th)];
  };
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) { w[i] = baseW[i]; p[i] = baseP[i]; }
    for (const g of G) {
      const [za, zb] = gauss2();
      let xa = g.ma + g.sa * za, xb = g.mb + g.sb * zb;
      if ((g.lock === 0 && xa < xb) || (g.lock === 1 && xb < xa)) { const t = xa; xa = xb; xb = t; }
      p[g.a] += xa; p[g.b] += xb;
      if (xa > xb) w[g.a] += 1; else if (xb > xa) w[g.b] += 1; else { w[g.a] += 0.5; w[g.b] += 0.5; }
    }
    order.sort((x, y) => w[y] - w[x] || p[y] - p[x]);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      seedSum[i] += k + 1; seedCount[i][k] += 1; winSum[i] += w[i];
      if (k < nPo) made[i] += 1;
      if (k < nBye) bye[i] += 1;
    }
  }
  const out: Record<number, MachineRow> = {};
  st.rids.forEach((rid, i) => {
    out[rid] = {
      rid, playoff: made[i] / sims, bye: bye[i] / sims,
      seed: seedSum[i] / sims, wins: winSum[i] / sims,
      seeds: Array.from(seedCount[i], c => c / sims),
    };
  });
  return out;
}

/** fill every remaining game by one rule: the side with the higher figure wins */
export function fillBy(st: MachineState, score: (rid: number, g: MachineGame) => number): Picks {
  const picks: Picks = {};
  for (const g of st.games) {
    const sa = score(g.a, g), sb = score(g.b, g);
    picks[g.id] = sa >= sb ? g.a : g.b;
  }
  return picks;
}
