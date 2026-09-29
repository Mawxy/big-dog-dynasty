import { useMemo } from "react";
import type { Matchups, WeekOdds } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useSeasonPhase } from "../model";

/**
 * THE WEEKS STILL TO COME, for one franchise (Max, 2026-09-29).
 *
 * Tapping a season on the Team page drops its weeks; for the season being
 * played that is now the WHOLE schedule — the weeks already scored, the week
 * in progress, and every regular-season week still to come. This hook is the
 * second half: each unplayed regular-season week's opponent (the schedule's
 * pairing, else the line's `opp`), both sides' projected totals and this
 * team's pregame chance to win, off week_odds.py's line — the one Seasons
 * quotes — and the opponent's record so far.
 */
export interface Upcoming {
  wk: number; opp: number; live: boolean;
  mu: number | null; oppMu: number | null; wp: number | null;
  oppRec: [number, number, number] | null;
}

export function useUpcoming(season: string, rid: number, mw: Matchups | null | undefined): Upcoming[] {
  const phase = useSeasonPhase();
  const odds = useJson<WeekOdds>(`${season}/odds.json`).data;
  return useMemo(() => {
    if (!mw) return [];
    const ps = mw.playoff_start || 15;
    const recs = new Map<number, [number, number, number]>();
    for (const [r, list] of Object.entries(mw.teams)) {
      const x: [number, number, number] = [0, 0, 0];
      for (const e of list) if (e[0] < ps && e[3] != null)
        x[e[1] > e[3] ? 0 : e[1] < e[3] ? 1 : 2]++;
      recs.set(Number(r), x);
    }
    const played = new Set((mw.teams[String(rid)] ?? []).filter(e => e[3] != null).map(e => e[0]));
    const out: Upcoming[] = [];
    for (let wk = 1; wk < ps; wk++) {
      if (played.has(wk)) continue;
      const line = odds?.weeks[String(wk)]?.[String(rid)];
      const pair = mw.schedule?.[String(wk)]?.find(p => p[0] === rid || p[1] === rid);
      const opp = pair ? (pair[0] === rid ? pair[1] : pair[0]) : line?.opp ?? null;
      if (opp == null) continue;
      const oppLine = odds?.weeks[String(wk)]?.[String(opp)];
      out.push({
        wk, opp, live: season === phase.rosterSeason && wk === phase.week,
        mu: line?.mu ?? null, oppMu: oppLine?.mu ?? null, wp: line?.wp ?? null,
        oppRec: recs.get(opp) ?? null,
      });
    }
    return out;
  }, [mw, odds, rid, season, phase.rosterSeason, phase.week]);
}
