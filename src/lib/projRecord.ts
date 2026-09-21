import type { MatchEntry, WeekOdds } from "./types";

/**
 * THE PROJECTED RECORD — banked results plus the odds file's own lines for the
 * weeks that have not happened.
 *
 * ONE CALCULATION, because there were two and they disagreed. The Standings
 * board (views/Franchises.tsx) adds Σ`wp` over the unplayed regular-season
 * weeks to the real won-lost record, which is the right shape: a projection has
 * to start from what already happened. The League home page instead sums a
 * normal CDF over `matchups.schedule`, and that file carries only the weeks
 * still to come — so a team's fourteen-game projection shrinks by one game
 * every week and its banked wins are never added at all. After week one a 1-0
 * team read 6.9-6.1 out of thirteen.
 *
 * DELIBERATELY PURE — only `import type`, so `tests/tradeModel.test.ts` can
 * import it under `node --test` (see the header of `lib/seasons.ts`).
 *
 * A WEEK COUNTS ONLY ONCE IT CARRIES A WIN PROBABILITY, not merely an entry:
 * `wp` is optional in WeekOdds, because week 1 without a snapshot is
 * deliberately left unpriced (a mu and no line). Filtering on the entry alone
 * let such a week into the game count while contributing `wp ?? 0` — a full
 * projected LOSS for a week nobody has priced.
 *
 * TIES ARE A THIRD FIGURE AND STAY ONE. Losses are the played losses plus the
 * unplayed weeks' complement, never `games − wins`: that subtraction folds
 * every tie into the loss column, so a 6-6-2 team read 6-8 and carried two
 * phantom losses into its projection. The odds file prices a win probability,
 * never a draw, so no unplayed week can add to the ties.
 */

export interface ProjRecord {
  /** banked wins + Σ wp over the unplayed priced weeks */
  wins: number;
  /** banked losses + Σ (1 − wp) over those same weeks */
  losses: number;
  /** banked ties, untouched — nothing unplayed can add to them */
  ties: number;
  /** the projection's own half of `wins`, for a caller that wants to show it */
  expWins: number;
  /** how many unplayed regular-season weeks carried a line */
  ahead: number;
  /** those weeks' projected points (`mu`), in week order — the input to a
   *  projected points-for total and to a projected PPG */
  projPts: number[];
  /** false when nothing was projected: no odds file, or the season is over.
   *  `text` is then the plain played record and the screen should say so. */
  projected: boolean;
  /** "9.2-4.8", "9.2-4.8-1", or "10-4" when nothing is projected */
  text: string;
}

export interface ProjRecordInput {
  /** the roster slot, which is how odds.json keys its sides */
  rid: number | string;
  /** the banked regular-season record */
  record: { wins: number; losses: number; ties: number };
  odds: WeekOdds | null | undefined;
  /** regular-season weeks this team has already played */
  played: Iterable<number>;
  /** the first playoff week — from matchups.json, never assumed */
  playoffStart: number;
}

export function projectedRecord(inp: ProjRecordInput): ProjRecord {
  const { wins: w, losses: l, ties: t } = inp.record;
  const done = new Set<number>(inp.played);
  const key = String(inp.rid);

  const ahead: { wk: number; wp: number; mu: number }[] = [];
  for (const [wkS, sides] of Object.entries(inp.odds?.weeks ?? {})) {
    const wk = Number(wkS);
    if (!Number.isFinite(wk) || wk >= inp.playoffStart || done.has(wk)) continue;
    const o = sides?.[key];
    if (o?.wp == null) continue;
    ahead.push({ wk, wp: o.wp, mu: o.mu ?? 0 });
  }
  ahead.sort((a, b) => a.wk - b.wk);

  const expWins = ahead.reduce((a, x) => a + x.wp, 0);
  const wins = w + expWins;
  const losses = l + (ahead.length - expWins);
  const projected = ahead.length > 0;
  const ties = t ? `-${t}` : "";
  return {
    wins, losses, ties: t, expWins,
    ahead: ahead.length,
    projPts: ahead.map(x => x.mu),
    projected,
    text: projected
      ? `${wins.toFixed(1)}-${losses.toFixed(1)}${ties}`
      : `${w}-${l}${ties}`,
  };
}

/**
 * The weeks a team has actually played, off its `matchups.json` rows — the
 * `played` argument above.
 *
 * A row with no opponent score is a week that has NOT been played: the roster
 * season's file carries the whole schedule, and `records.ts` skips the same
 * shape for the same reason. Reading it as played would drop that week out of
 * the projection entirely, which reads as a team with a shorter season.
 */
export function playedWeeks(
  rows: readonly MatchEntry[] | undefined, playoffStart: number,
): number[] {
  const out: number[] = [];
  for (const e of rows ?? []) if (e[0] < playoffStart && e[3] != null) out.push(e[0]);
  return out;
}
