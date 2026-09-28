import type { Matchups, WeeklyRow } from "../lib/types";
import { emptyWL, type WL } from "../lib/records";

/**
 * A WEEK WINDOW ON THE STATS BOARD (Max, 2026-09-28).
 *
 * One season's board, narrowed to a run of its regular-season weeks: "who
 * scored the most over the last four", "what did he do before the bye". Every
 * figure the box score prints is a sum over weeks or is recomputed from sums,
 * so each one survives the narrowing:
 *
 *   GP, points, WAR   summed over weekly.json's rows inside the window —
 *                     weekly.json and summary.json agree to the hundredth, so
 *                     the full window reproduces the season row exactly
 *   PPG               recomputed from the window's totals, never averaged
 *   σ                 the sample SD of the window's weeks (ddof 1, as the
 *                     pipeline writes it); null under two games
 *   Win share         winshare.json's per-week `wk` map, summed in the window
 *   the two records   re-read off matchups.json for the window's weeks
 *
 * What does NOT survive is anything that is a fact about the whole season:
 * the honor marks (a season award), the position finish's meaning (it is
 * restated as the finish inside the window) and snap share, which usage.json
 * only carries as a season rate. Those are dropped rather than shown against
 * a window they were never measured over.
 *
 * Regular season only, like weekly.json itself — the phase filter already
 * owns the bracket.
 */
export interface WeekSpan { from: number; to: number }

/** "3-7" or "5", from the URL. Anything else is no window. */
export function parseSpan(s: string | null): WeekSpan | null {
  if (!s) return null;
  const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
  if (!a || !b) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

export const spanParam = (sp: WeekSpan) =>
  sp.from === sp.to ? `${sp.from}` : `${sp.from}-${sp.to}`;

export const spanText = (sp: WeekSpan) =>
  sp.from === sp.to ? `Week ${sp.from}` : `Weeks ${sp.from}–${sp.to}`;

export const inSpan = (sp: WeekSpan, wk: number) => wk >= sp.from && wk <= sp.to;

/**
 * The window as it applies to the weeks this season has actually settled.
 * Null — no narrowing at all — when it covers every one of them, so a link
 * that says "1-14" in week 16 and a board with no window are the same board,
 * and when it misses them entirely, so a window carried from a longer season
 * onto one still in week 2 falls back to the season rather than to nothing.
 */
export function effectiveSpan(sp: WeekSpan | null, weeks: number[]): WeekSpan | null {
  if (!sp || !weeks.length) return null;
  const lo = weeks[0], hi = weeks[weeks.length - 1];
  const from = Math.max(sp.from, lo), to = Math.min(sp.to, hi);
  if (from > to) return null;
  if (from === lo && to === hi) return null;
  return { from, to };
}

/** one player's box line over the window, or null if he scored in none of it */
export function spanLine(rows: WeeklyRow[] | undefined, sp: WeekSpan) {
  const r = (rows ?? []).filter(x => inSpan(sp, x[0]));
  if (!r.length) return null;
  const gp = r.length;
  const pts = r.reduce((a, x) => a + x[1], 0);
  const war = r.reduce((a, x) => a + x[5], 0);
  let sdv: number | null = null;
  if (gp > 1) {
    const mu = pts / gp;
    sdv = Math.sqrt(r.reduce((a, x) => a + (x[1] - mu) ** 2, 0) / (gp - 1));
  }
  return { gp, pts, ppg: pts / gp, war, sdv };
}

/**
 * Both records for every player over the window's weeks — `loadRecords`'s
 * rule exactly (regular season, a week with no opponent score is unplayed,
 * starters and bench kept disjoint), restricted to the window.
 */
export function spanRecords(
  mw: Matchups, sp: WeekSpan,
): Map<string, { start: WL; roster: WL }> {
  const ps = mw.playoff_start || 15;
  const out = new Map<string, { start: WL; roster: WL }>();
  const bag = (pid: string) => {
    let b = out.get(pid);
    if (!b) { b = { start: emptyWL(), roster: emptyWL() }; out.set(pid, b); }
    return b;
  };
  for (const weeks of Object.values(mw.teams)) {
    for (const e of weeks) {
      const [wk, pts, , oppPts] = e;
      if (wk >= ps || !inSpan(sp, wk) || oppPts == null) continue;
      const key = pts > oppPts ? "w" : pts < oppPts ? "l" : "t";
      const starters = (e[4] ?? []).filter(p => p && p !== "0");
      const bench = (e[5] ?? []).filter(p => p && p !== "0");
      for (const pid of starters) {
        const b = bag(pid);
        b.start[key]++; b.roster[key]++;
      }
      for (const pid of bench) {
        if (starters.includes(pid)) continue;
        bag(pid).roster[key]++;
      }
    }
  }
  return out;
}

/**
 * Win share over the window: the per-week shares inside it. `wk` lists only
 * the weeks that earned a share (a loss earns none), so a starter with no win
 * in the window has 0 — while a player who started nothing in it has null,
 * the same "never in a lineup is not a zero" rule `winShareOf` keeps.
 */
export function spanWinShare(
  wk: Record<string, number> | undefined, sp: WeekSpan, starts: number,
): number | null {
  if (!starts) return null;
  let sum = 0;
  for (const [w, v] of Object.entries(wk ?? {})) if (inSpan(sp, Number(w))) sum += v;
  return sum;
}
