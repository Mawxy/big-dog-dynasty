import { jl } from "./data";

/**
 * REGULAR-SEASON WIN SHARE — `<season>/winshare.json`, built by
 * scripts/season_wpa.py.
 *
 * Every game a team wins hands out exactly 1.0 among the nine who started it,
 * split half by leverage (each starter's Shapley win-probability contribution)
 * and half by production (his points over positional replacement). So a total
 * reads literally — "he accounted for 3.2 of his team's 9 wins" — and a
 * season's shares sum to the 84 games the league actually won, which the script
 * asserts rather than assumes.
 *
 * It is the same figure the postseason has carried since playoff_wpa.py, over
 * the other fourteen weeks, from the same allocation code. That is what lets
 * the two be added together for a full-season or all-time reading rather than
 * being two statistics that happen to share a name.
 */

export interface WinShareRow {
  /** the season total, in wins */
  ws: number;
  /** games started, which is the sample the share was drawn from */
  gs: number;
  w: number;
  l: number;
  /** week -> that week's share. Only weeks his team won carry one. */
  wk?: Record<string, number>;
}

export interface WinShareFile {
  meta: {
    scope: string; blend: number; wins: number; ties: number; note: string;
  };
  players: Record<string, WinShareRow>;
}

export interface WinShareIndex {
  /** pid -> season -> that season's share */
  byPlayer: Record<string, Record<string, WinShareRow>>;
  /** seasons that actually landed a file */
  seasons: string[];
}

let pending: Promise<WinShareIndex> | null = null;

/**
 * Build the index once per page load.
 *
 * A missing season is skipped rather than fatal: `winshare.json` is newer than
 * the seasons around it, and a deploy whose 2022 file has not been generated
 * yet should show three seasons of the column and an em dash on the fourth —
 * not an empty board.
 */
export function loadWinShare(seasons: string[]): Promise<WinShareIndex> {
  if (pending) return pending;

  pending = (async () => {
    const files = await Promise.all(seasons.map(s =>
      jl<WinShareFile>(`${s}/winshare.json`).catch(() => null)));

    const byPlayer: WinShareIndex["byPlayer"] = {};
    const got: string[] = [];
    seasons.forEach((season, i) => {
      const f = files[i];
      if (!f?.players) return;
      got.push(season);
      for (const [pid, row] of Object.entries(f.players))
        (byPlayer[pid] ??= {})[season] = row;
    });
    return { byPlayer, seasons: got };
  })();

  pending.catch(() => { pending = null; });
  return pending;
}

/**
 * One player's share over a set of seasons — one year, or a career.
 *
 * Null when he started nothing in the scope, never 0: a player who was never in
 * a lineup did not fail to win anything, and a zero in a column of wins reads
 * as though he did.
 */
export function winShareOf(
  idx: WinShareIndex | null, pid: string, seasons: string[],
): number | null {
  const bag = idx?.byPlayer[pid];
  if (!bag) return null;
  let sum = 0, seen = 0;
  for (const s of seasons) {
    const r = bag[s];
    if (!r) continue;
    sum += r.ws; seen++;
  }
  return seen ? sum : null;
}
