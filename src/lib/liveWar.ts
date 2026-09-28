import type { Matchups, PlayersMin, Weekly } from "./types";
import { normCdf } from "./stats";
import { FLEX_SLOTS, pInfo } from "./league";

/**
 * ESTIMATED WAR FOR A WEEK THE PIPELINE HAS NOT SCORED YET (Max, 2026-09-28).
 *
 * The official figure comes from scripts/sleeper_war.py, which runs once a
 * week is over: a player's points against his position's replacement level
 * that week, turned into wins with that week's spread of team scores —
 *
 *     WAR_week = Φ((pts − repl[pos]) / (σ_week · √2)) − 0.5
 *
 * The browser has the points (the live feed's `players_points`, the same
 * numbers the pipeline reads) and not the rest, so this estimates the two
 * baselines and says so on every figure it prints:
 *
 *   WEEK COMPLETE   every game is final. Replacement level is rebuilt from
 *                   this week's own rostered points with the pipeline's
 *                   greedy league-wide lineup, and σ is this week's spread
 *                   of the twelve team totals. The one thing missing is the
 *                   free-agent half of the pool (the full-NFL stats feed), so
 *                   the estimate lands within a few thousandths of the final
 *                   and is still labelled one.
 *   WEEK UNDER WAY  a partial week's replacement level and spread are not
 *                   yet facts — half the league has not played. So both come
 *                   from the season's settled weeks: each week's replacement
 *                   level per position recovered from weekly.json (pts minus
 *                   pts-above-replacement), and each week's σ from the team
 *                   scores, averaged. A player whose game is over is priced
 *                   against that; one still playing is priced on his points
 *                   so far and flagged live; one who has not kicked off has
 *                   no figure.
 *
 * Positions follow the pipeline: QB, RB, WR, TE. Anyone else has no WAR.
 */

const CORE = new Set(["QB", "RB", "WR", "TE"]);
const FLEX_ORDER = Object.keys(FLEX_SLOTS)
  .sort((a, b) => FLEX_SLOTS[a].length - FLEX_SLOTS[b].length);
const NON_STARTING = new Set(["BN", "IR", "TAXI"]);

/** single-week win shift from `points` over the baseline — the pipeline's
 *  norm_win_shift */
export function winShift(points: number, sigma: number): number {
  if (!(sigma > 0)) return 0;
  return normCdf(points / (sigma * Math.SQRT2)) - 0.5;
}

export interface WarBaseline {
  /** replacement level per position, in points */
  repl: Record<string, number>;
  /** the average startable player per position, in points — the "vs avg"
   *  baseline weekly.json's third column is measured against */
  avg: Record<string, number>;
  /** the spread of team scores the week is priced on */
  sigma: number;
  /** where the baselines came from */
  source: "week" | "season";
  /** settled weeks averaged, for a season baseline */
  weeks: number;
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const mu = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1));
};

/**
 * The settled weeks' baselines, averaged. Replacement level is the same
 * number for every player at a position in a week, so it is read back off any
 * of them — the median of the rows, which also absorbs a player whose
 * position the site's map files differently from the pipeline's.
 */
export function settledBaseline(
  weekly: Weekly | null | undefined, mw: Matchups | null | undefined,
  players: PlayersMin,
): WarBaseline | null {
  if (!weekly || !mw) return null;
  const ps = mw.playoff_start || 15;
  const per: Record<string, Map<number, number[]>> = {};
  const perAvg: Record<string, Map<number, number[]>> = {};
  for (const [pid, rows] of Object.entries(weekly)) {
    const pos = pInfo(players, pid)[1];
    if (!CORE.has(pos)) continue;
    for (const w of rows) {
      if (w[0] >= ps) continue;
      const m = (per[pos] ??= new Map());
      const l = m.get(w[0]) ?? [];
      l.push(w[1] - w[3]);
      m.set(w[0], l);
      const ma = (perAvg[pos] ??= new Map());
      const la = ma.get(w[0]) ?? [];
      la.push(w[1] - w[2]);
      ma.set(w[0], la);
    }
  }
  const meanOfMedians = (m: Map<number, number[]>) => {
    const wk = [...m.values()].map(median);
    return wk.length ? wk.reduce((a, x) => a + x, 0) / wk.length : null;
  };
  const repl: Record<string, number> = {};
  const avg: Record<string, number> = {};
  for (const [pos, m] of Object.entries(per)) {
    const v = meanOfMedians(m);
    if (v != null) repl[pos] = v;
  }
  for (const [pos, m] of Object.entries(perAvg)) {
    const v = meanOfMedians(m);
    if (v != null) avg[pos] = v;
  }
  const byWeek = new Map<number, number[]>();
  for (const list of Object.values(mw.teams))
    for (const e of list) {
      if (e[0] >= ps || e[3] == null || !e[1]) continue;
      const l = byWeek.get(e[0]) ?? [];
      l.push(e[1]);
      byWeek.set(e[0], l);
    }
  const sigmas = [...byWeek.values()].filter(l => l.length >= 2).map(sd);
  if (!sigmas.length || !Object.keys(repl).length) return null;
  return {
    repl, avg,
    sigma: sigmas.reduce((a, x) => a + x, 0) / sigmas.length,
    source: "season",
    weeks: sigmas.length,
  };
}

/**
 * One week's own baselines, from every rostered player's points — the
 * pipeline's `build_week` over the rostered pool (its fallback path when the
 * full-NFL feed is absent): fill every team's dedicated slots league-wide by
 * points, then the flex slots narrowest first; replacement is the best player
 * at the position left out. A 0.0 is read as did-not-play, as the pipeline
 * does without its played list.
 */
export function weekBaseline(
  ppts: Record<string, number>, teamTotals: number[],
  players: PlayersMin, lineup: string[], nTeams: number,
): WarBaseline | null {
  const open: Record<string, number> = {};
  for (const s of lineup) if (!NON_STARTING.has(s)) open[s] = (open[s] ?? 0) + nTeams;
  const posOf = (pid: string) => pInfo(players, pid)[1];
  const pool = Object.keys(ppts)
    .filter(pid => CORE.has(posOf(pid)) && ppts[pid])
    .sort((a, b) => ppts[b] - ppts[a]);
  const left: string[] = [];
  const startable: string[] = [];
  for (const pid of pool) {
    const pos = posOf(pid);
    if ((open[pos] ?? 0) > 0) { open[pos]--; startable.push(pid); }
    else left.push(pid);
  }
  const rest: string[] = [];
  for (const pid of left) {
    const pos = posOf(pid);
    const slot = FLEX_ORDER.find(s => FLEX_SLOTS[s].includes(pos) && (open[s] ?? 0) > 0);
    if (slot) { open[slot]--; startable.push(pid); }
    else rest.push(pid);
  }
  const repl: Record<string, number> = {};
  const avg: Record<string, number> = {};
  for (const pos of CORE) {
    const nxt = rest.find(p => posOf(p) === pos);
    repl[pos] = nxt ? ppts[nxt] : 0;
    const st = startable.filter(p => posOf(p) === pos).map(p => ppts[p]);
    avg[pos] = st.length ? st.reduce((a, x) => a + x, 0) / st.length : repl[pos];
  }
  const sigma = sd(teamTotals.filter(x => x > 0));
  if (!(sigma > 0)) return null;
  return { repl, avg, sigma, source: "week", weeks: 1 };
}

/** a player's estimated WAR for the week against a baseline, or null for a
 *  position the model does not price */
export function estWar(pts: number, pos: string, base: WarBaseline | null): number | null {
  if (!base || !CORE.has(pos) || base.repl[pos] == null) return null;
  return winShift(pts - base.repl[pos], base.sigma);
}
