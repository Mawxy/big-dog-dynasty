import { useEffect, useState } from "react";
import type { SeasonData, SummaryRow, Team, Weekly } from "./types";
import { j } from "./data";
import { sd } from "./stats";
import { useLeague } from "./context";

export function useSeasonData(season: string): SeasonData | null {
  const { meta } = useLeague();
  const [d, setD] = useState<SeasonData | null>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    (async () => {
      if (season === "ALL") {
        const seasons = meta.seasons;
        const sums = await Promise.all(seasons.map(s => j<SummaryRow[]>(`data/${s}/summary.json`).catch(() => [] as SummaryRow[])));
        const weeks = await Promise.all(seasons.map(s => j<Weekly>(`data/${s}/weekly.json`).catch(() => ({} as Weekly))));
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
          +a.waa.toFixed(3), +a.war.toFixed(3), +sd(a.wpts).toFixed(2),
        ]);
        const teams = await j<Team[]>(`data/${seasons[seasons.length - 1]}/teams.json`);
        if (live) setD({ summary, teams, allData });
      } else {
        const [summary, teams] = await Promise.all([
          j<SummaryRow[]>(`data/${season}/summary.json`),
          j<Team[]>(`data/${season}/teams.json`),
        ]);
        if (live) setD({ summary, teams, allData: null });
      }
    })().catch(() => { if (live) setD({ summary: [], teams: [], allData: null }); });
    return () => { live = false; };
  }, [season, meta]);
  return d;
}
