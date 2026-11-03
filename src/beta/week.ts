import type { Matchups, PlayersMin, WeekOdds, Weekly } from "../lib/types";
import { pInfo } from "../lib/league";

/**
 * ONE PLAYED WEEK, READ OFF THE SEASON FILES — the computation League's
 * "Last week" band and the Seasons screen share (Max, 2026-09-15: Seasons is
 * the week floor, and its week board is League's last-week module pointed at
 * any week). One computation and one vocabulary, so the figures a reader
 * sees on the League tab are literally the ones he finds on Seasons.
 */

/** one roster's scored entry for a week */
export interface WeekRow {
  rid: number; pts: number; opp: number | null; oppPts: number | null;
  starters: string[]; bench: string[];
}

/** every roster's scored entry for `wk`, empty when nothing is scored */
export function weekRows(mw: Matchups | null | undefined, wk: number): WeekRow[] {
  const rows: WeekRow[] = [];
  for (const [rid, list] of Object.entries(mw?.teams ?? {})) {
    const e = list.find(x => x[0] === wk);
    if (e) rows.push({ rid: Number(rid), pts: e[1], opp: e[2], oppPts: e[3], starters: e[4] ?? [], bench: e[5] ?? [] });
  }
  return rows;
}

/** the regular-season weeks with at least one scored entry, ascending */
export function playedWeeks(mw: Matchups | null | undefined): number[] {
  const ps = mw?.playoff_start || 15;
  const s = new Set<number>();
  for (const list of Object.values(mw?.teams ?? {}))
    for (const e of list) if (e[0] < ps) s.add(e[0]);
  return [...s].sort((a, b) => a - b);
}

/** the playoff weeks with a scored entry, ascending */
export function playedPlayoffWeeks(mw: Matchups | null | undefined): number[] {
  const ps = mw?.playoff_start || 15;
  const s = new Set<number>();
  for (const list of Object.values(mw?.teams ?? {}))
    for (const e of list) if (e[0] >= ps) s.add(e[0]);
  return [...s].sort((a, b) => a - b);
}

/** a week's games, each counted once, in the order the rows came */
export interface WeekGame { a: WeekRow; b: WeekRow }
export function weekGames(rows: WeekRow[]): WeekGame[] {
  const byRid = new Map(rows.map(r => [r.rid, r]));
  const seen = new Set<number>();
  const games: WeekGame[] = [];
  for (const r of rows) {
    if (seen.has(r.rid) || r.opp == null) continue;
    const o = byRid.get(r.opp);
    if (!o) continue;
    seen.add(r.rid); seen.add(o.rid);
    games.push({ a: r, b: o });
  }
  return games;
}

export interface WeekFigures {
  wk: number;
  top: WeekRow; low: WeekRow;
  /** THE UPSET: the winner the pregame line liked least, and only if the line
   *  had him under 50% — a 62% favorite winning is the line holding, however
   *  low the week's other winners were priced. Ties are not upsets. */
  upset: WeekRow | null; upsetWp: number | null;
  /** the week has a pregame line at all. No upset with a line means the
   *  favorites held; no upset without one means nobody quoted the week (the
   *  second league has no odds.json) — different facts, different words. */
  priced: boolean;
  /** THE CLOSEST SCORE (Max, 2026-09-08): the week's narrowest margin, each
   *  game counted once from its winner's side. A tie is a margin of zero. */
  closest: { rid: number; pts: number; opp: number; oppPts: number } | null;
  /** THE WEEK'S TOP SCORE AT EACH POSITION, bench or starter (Max,
   *  2026-09-08): weekly.json scores every rostered player, so a 40 left on
   *  a bench counts — it is a fact about the week, whoever sat him. */
  posTop: Record<string, { pid: string; pts: number } | null>;
  /** the median of the week's team scores */
  median: number | null;
}

export function weekFigures(
  rows: WeekRow[], wk: number,
  odds: WeekOdds | null | undefined, weekly: Weekly | null | undefined, players: PlayersMin,
): WeekFigures | null {
  if (!rows.length) return null;
  const top = rows.reduce((m, r) => (r.pts > m.pts ? r : m));
  const low = rows.reduce((m, r) => (r.pts < m.pts ? r : m));
  const line = odds?.weeks[String(wk)] ?? {};
  const priced = rows.some(r => line[String(r.rid)]?.wp != null);
  const winners = rows.filter(r => {
    const wp = line[String(r.rid)]?.wp;
    return r.oppPts != null && r.pts > r.oppPts && wp != null && wp < 0.5;
  });
  const upset = winners.length
    ? winners.reduce((m, r) => (line[String(r.rid)].wp! < line[String(m.rid)].wp! ? r : m))
    : null;
  let closest: WeekFigures["closest"] = null;
  for (const r of rows) {
    if (r.opp == null || r.oppPts == null || r.pts < r.oppPts) continue;
    if (!closest || r.pts - r.oppPts < closest.pts - closest.oppPts)
      closest = { rid: r.rid, pts: r.pts, opp: r.opp, oppPts: r.oppPts };
  }
  const posTop: WeekFigures["posTop"] = {};
  if (weekly) {
    for (const [pid, wrows] of Object.entries(weekly)) {
      const w = wrows.find(x => x[0] === wk);
      if (!w) continue;
      const pos = pInfo(players, pid)[1];
      const cur = posTop[pos];
      if (!cur || w[1] > cur.pts) posTop[pos] = { pid, pts: w[1] };
    }
  }
  const figs = rows.map(r => r.pts).sort((x, y) => x - y);
  const median = figs.length % 2 ? figs[(figs.length - 1) / 2] : (figs[figs.length / 2 - 1] + figs[figs.length / 2]) / 2;
  return { wk, top, low, upset, upsetWp: upset ? line[String(upset.rid)].wp! : null, priced, closest, posTop, median };
}

/**
 * HOW MANY SLOTS A SCORED WEEK DREW. The lineup the side actually fielded, not
 * today's slot list: Pineapple Pizza played 2024 with eight starters and has
 * nine now, so the longer of the two printed a ninth "SFLX — 0.0" row for a
 * seat that did not exist that year. The slot list stands in only for an entry
 * with no starters on file.
 */
export const playedSlotCount = (lineupLen: number, starters: readonly string[]): number =>
  starters.length || lineupLen;
