import { useEffect, useState } from "react";
import type { SeasonData, SummaryRow, Team, Weekly } from "./types";
import { jl } from "./data";
import { sd, WAR_DP } from "./stats";
import { useLeague } from "./context";
import { rosterSeasonOf } from "./league";

/** null season = "this view doesn't need season data right now" — no fetch */
export function useSeasonData(season: string | null): SeasonData | null {
  const { meta, league } = useLeague();
  const [d, setD] = useState<SeasonData | null>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    if (season == null) return;
    (async () => {
      if (season === "ALL") {
        const seasons = meta.seasons;
        const sums = await Promise.all(seasons.map(s => jl<SummaryRow[]>(`${s}/summary.json`).catch(() => [] as SummaryRow[])));
        const weeks = await Promise.all(seasons.map(s => jl<Weekly>(`${s}/weekly.json`).catch(() => ({} as Weekly))));
        // NFL club at the time; merged oldest-first so the last played club
        // wins — a retired player keeps his final team instead of going blank
        const tms = await Promise.all(seasons.map(s => jl<Record<string, string>>(`${s}/nfl_teams.json`).catch(() => ({} as Record<string, string>))));
        const nflTeams = Object.assign({}, ...tms) as Record<string, string>;
        const allData: NonNullable<SeasonData["allData"]> = {};
        seasons.forEach((s, i) => { allData[s] = { summary: sums[i], weekly: weeks[i] }; });
        const agg: Record<string, { pos: string; gp: number; pts: number; waa: number; war: number; wpts: number[] }> = {};
        seasons.forEach((_s, i) => {
          for (const r of sums[i]) {
            const a = agg[r[0]] ??= { pos: r[1], gp: 0, pts: 0, waa: 0, war: 0, wpts: [] };
            a.gp += r[2]; a.pts += r[3]; a.waa += r[5]; a.war += r[6]; a.pos = r[1];
            for (const w of weeks[i][r[0]] || []) a.wpts.push(w[1]);
          }
        });
        const summary: SummaryRow[] = Object.entries(agg).map(([pid, a]) => [
          pid, a.pos, a.gp, +a.pts.toFixed(1), +(a.pts / a.gp).toFixed(2),
          +a.waa.toFixed(WAR_DP), +a.war.toFixed(WAR_DP), +sd(a.wpts).toFixed(2),
        ]);
        // all-time: ownership is CURRENT ownership, not ownership in the last
        // season that happened to be played
        const teams = await jl<Team[]>(`${rosterSeasonOf(league)}/teams.json`);
        if (live) setD({ summary, teams, nflTeams, allData });
      } else {
        const [summary, teams, nflTeams] = await Promise.all([
          jl<SummaryRow[]>(`${season}/summary.json`),
          jl<Team[]>(`${season}/teams.json`),
          jl<Record<string, string>>(`${season}/nfl_teams.json`).catch(() => ({} as Record<string, string>)),
        ]);
        if (live) setD({ summary, teams, nflTeams, allData: null });
      }
    })().catch(() => { if (live) setD({ summary: [], teams: [], allData: null }); });
    return () => { live = false; };
  }, [season, meta, league]);
  return d;
}
