import type { BracketFile, Weekly } from "./types";
import { jl } from "./data";

/**
 * EVERY WEEK A PLAYER SCORED, across every season — the source for the
 * all-time and both-halves box plots.
 *
 * The single-season drawer does not use this. It already fetches one
 * `weekly.json` on open and that file is 140 KB; pooling four of them to answer
 * a question about one season would be half a megabyte spent on nothing. This
 * exists for the scopes where the pooled answer IS the question.
 *
 * FETCHED ON DRAWER OPEN, NOT WITH THE BOARD, for the same reason: nobody
 * scrolling a leaderboard has asked for the shape of anybody's weeks yet. Once
 * a reader opens one, the module cache means every other row on the board is
 * free.
 *
 * Two arms, kept separate rather than concatenated:
 *
 *   REG   from `<season>/weekly.json`, which is regular season by construction
 *         — the engine writes weeks 1..playoff_start-1 and nothing else.
 *   POST  from `<season>/bracket.json`'s WAR block, which carries each starter's
 *         points per elimination game. It is the only per-player postseason
 *         scoring on the site; matchups.json has the team total and no more.
 *
 * A bye week is absent from both, and that is right for a distribution: the
 * postseason index carries it as a game at the player's own average so his
 * totals count the week, but an imputed number has no business inside a picture
 * of how his weeks actually landed.
 */

export interface WeekPointsIndex {
  /** pid -> season -> the two arms */
  byPlayer: Record<string, Record<string, { reg: number[]; post: number[] }>>;
  seasons: string[];
}

let pending: Promise<WeekPointsIndex> | null = null;

export function loadWeekPoints(seasons: string[]): Promise<WeekPointsIndex> {
  if (pending) return pending;

  pending = (async () => {
    const [weeklies, brackets] = await Promise.all([
      Promise.all(seasons.map(s => jl<Weekly>(`${s}/weekly.json`).catch(() => null))),
      Promise.all(seasons.map(s => jl<BracketFile>(`${s}/bracket.json`).catch(() => null))),
    ]);

    const byPlayer: WeekPointsIndex["byPlayer"] = {};
    const got: string[] = [];

    const bag = (pid: string, season: string) =>
      ((byPlayer[pid] ??= {})[season] ??= { reg: [], post: [] });

    seasons.forEach((season, i) => {
      const w = weeklies[i], b = brackets[i];
      let any = false;
      for (const [pid, rows] of Object.entries(w ?? {})) {
        if (!rows?.length) continue;
        any = true;
        bag(pid, season).reg = rows.map(r => r[1]);
      }
      for (const [pid, rec] of Object.entries(b?.war ?? {})) {
        const wk = Object.values(rec.wk ?? {});
        if (!wk.length) continue;
        any = true;
        bag(pid, season).post = wk;
      }
      if (any) got.push(season);
    });

    return { byPlayer, seasons: got };
  })();

  pending.catch(() => { pending = null; });
  return pending;
}

/** one player's scored weeks over a set of seasons, in the arms asked for */
export function weekPointsOf(
  idx: WeekPointsIndex | null, pid: string, seasons: string[],
  arms: { reg?: boolean; post?: boolean } = { reg: true },
): number[] {
  const bag = idx?.byPlayer[pid];
  if (!bag) return [];
  const out: number[] = [];
  for (const s of seasons) {
    const b = bag[s];
    if (!b) continue;
    if (arms.reg) out.push(...b.reg);
    if (arms.post) out.push(...b.post);
  }
  return out;
}
