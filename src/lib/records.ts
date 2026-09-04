import type { Matchups } from "./types";
import { jl } from "./data";

/**
 * A PLAYER'S WON-LOST RECORD — two of them, and they answer different
 * questions.
 *
 *   AS A STARTER   the weeks he was in somebody's lineup, and how that lineup
 *                  did. This is the one a manager means by "he wins you games":
 *                  it counts only the weeks a manager actually trusted him.
 *   AS A ROSTERED  every week he was on a roster at all, started or benched.
 *                  The gap between the two is how often he was owned and left
 *                  out, which for a boom-week bench stash is most of his career.
 *
 * NEITHER IS A STAT ABOUT THE PLAYER ALONE, and the board has to say so: a
 * running back on the best roster in the league wins games he had nothing to do
 * with. It is a fact about the weeks he was there, which is why it sits beside
 * WAR rather than instead of it — WAR is what he contributed, this is what
 * happened around him.
 *
 * REGULAR SEASON ONLY, the same window every other figure on the Stats board
 * uses (`week < playoff_start`). Mixing the postseason in would make a record
 * that is partly a team-quality selection effect — only good teams play week 16
 * — and it would silently disagree with the GP beside it.
 *
 * Read off matchups.json, which is the only file that states who was in a
 * lineup in week N. teams.json is the END-OF-SEASON roster and cannot answer
 * either question: a player traded in week 8 would take the wrong franchise's
 * whole season.
 */

/** wins, losses, ties */
export interface WL { w: number; l: number; t: number }

export const emptyWL = (): WL => ({ w: 0, l: 0, t: 0 });

/** games behind a record — the sample, and the reason a 3-0 is not a 12-2 */
export const wlGames = (r: WL) => r.w + r.l + r.t;

/**
 * "12-2", or "12-2-1" when there were ties. A tie component that is always
 * printed makes every record on the board a character wider for a fact that is
 * false in the overwhelming majority of rows.
 */
export const wlText = (r: WL | null): string | null =>
  r == null || wlGames(r) === 0 ? null : `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}`;

/**
 * A RECORD SORTS TWO WAYS, AND THEY ARE TWO KEYS — not two directions of one
 * (Max, 2026-09-03).
 *
 *   first click   BY WINS, most first      30-15 · 26-6 · 21-16 · 4-10
 *   second click  BY LOSSES, most first    21-16 · 30-15 · 4-10 · 26-6
 *
 * The obvious implementation — one composite key read from both ends — gives
 * the wrong second list. Reversing "wins, then losses" is "fewest wins, then
 * most losses", which sorts 4-10 to the top: a player who barely started
 * outranks the one who started all year and lost, and the question the second
 * click is asking is exactly the opposite of that. Losses are their own
 * quantity and get their own key.
 *
 * Both are read DESCENDING. The tiebreak in each is the other column, pointing
 * the way that keeps the list saying one thing: equal wins puts the fewer
 * losses first, equal losses puts the fewer wins first — 0-14 above 5-14,
 * because the one with nothing to show for them is the more extreme case of
 * what that column is for.
 *
 * 1000 is a safe multiplier: nobody will start a thousand weeks in a league
 * that has played fifty-six.
 */
export const wlByWins = (r: WL | null): number | null =>
  r == null || wlGames(r) === 0 ? null : r.w * 1000 - r.l;

export const wlByLosses = (r: WL | null): number | null =>
  r == null || wlGames(r) === 0 ? null : r.l * 1000 - r.w;

/** the sum of several seasons — what the all-time scope prints */
export function wlSum(parts: (WL | undefined)[]): WL {
  const out = emptyWL();
  for (const p of parts) if (p) { out.w += p.w; out.l += p.l; out.t += p.t; }
  return out;
}

export interface RecordIndex {
  /** pid -> season -> the two records */
  byPlayer: Record<string, Record<string, { start: WL; roster: WL }>>;
  /** seasons that actually contributed, so a caller can tell "no games" from
   *  "that season's matchups file didn't load" */
  seasons: string[];
}

let pending: Promise<RecordIndex> | null = null;

/**
 * Build the whole-league record index once per page load.
 *
 * One module-level promise, the same shape `loadHonors` uses: the Stats board
 * asks for this on every scope change and a season's matchups file is 100-200
 * KB. A rejected build clears the cache so a retry is a real second attempt.
 */
export function loadRecords(seasons: string[]): Promise<RecordIndex> {
  if (pending) return pending;

  pending = (async () => {
    const files = await Promise.all(seasons.map(s =>
      jl<Matchups>(`${s}/matchups.json`).catch(() => null)));

    const byPlayer: RecordIndex["byPlayer"] = {};
    const played: string[] = [];

    seasons.forEach((season, i) => {
      const m = files[i];
      if (!m) return;
      const ps = m.playoff_start || 15;
      let any = false;

      for (const weeks of Object.values(m.teams)) {
        for (const e of weeks) {
          const [wk, pts, , oppPts] = e;
          if (wk >= ps) continue;
          // A week with no opponent score is a week that has not been played —
          // a scheduled row in the roster season's file, or a bye. It is not a
          // loss, and counting it as one is how a 0-0 team ends up 0-14.
          if (oppPts == null) continue;
          any = true;
          const key = pts > oppPts ? "w" : pts < oppPts ? "l" : "t";

          // Sleeper writes "0" into a lineup slot nobody filled
          const starters = (e[4] ?? []).filter(p => p && p !== "0");
          const bench = (e[5] ?? []).filter(p => p && p !== "0");

          for (const pid of starters) {
            const bag = (byPlayer[pid] ??= {})[season]
              ??= { start: emptyWL(), roster: emptyWL() };
            bag.start[key]++;
            bag.roster[key]++;
          }
          /* The bench arm alone — a starter has already been counted into
             `roster` above. A player who appears in both lists in one week is
             a data fault, not a double week, so the sets are kept disjoint by
             construction rather than by trusting the file. */
          for (const pid of bench) {
            if (starters.includes(pid)) continue;
            const bag = (byPlayer[pid] ??= {})[season]
              ??= { start: emptyWL(), roster: emptyWL() };
            bag.roster[key]++;
          }
        }
      }
      if (any) played.push(season);
    });

    return { byPlayer, seasons: played };
  })();

  pending.catch(() => { pending = null; });
  return pending;
}

/** one player's two records over a set of seasons — one season, or a career */
export function recordsOf(
  idx: RecordIndex | null, pid: string, seasons: string[],
): { start: WL; roster: WL } {
  const bag = idx?.byPlayer[pid];
  return {
    start: wlSum(seasons.map(s => bag?.[s]?.start)),
    roster: wlSum(seasons.map(s => bag?.[s]?.roster)),
  };
}
