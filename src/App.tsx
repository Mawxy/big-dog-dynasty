import { useEffect, useMemo, useState } from "react";
import type { Meta, PlayersMin, SeasonData, SummaryRow, Team, Weekly } from "./lib/types";
import { j, setVersion } from "./lib/data";
import { sd } from "./lib/stats";
import Players from "./views/Players";
import Teams from "./views/Teams";
import WeeklyView from "./views/Weekly";
import Methodology from "./components/Methodology";
import PlayerPage from "./components/PlayerPage";
import { OpenPlayerContext } from "./components/PlayerLink";

type View = "players" | "teams" | "weekly";

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [players, setPlayers] = useState<PlayersMin>({});
  const [season, setSeason] = useState("");
  const [view, setView] = useState<View>("players");
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const m = await j<Meta>("data/meta.json");
      setVersion(m.updated);
      setPlayers(await j<PlayersMin>("data/players_min.json"));
      setMeta(m);
      setSeason(m.seasons[m.seasons.length - 1]);
    })().catch(e => setErr(String(e)));
  }, []);

  const data = useSeasonData(season, meta);

  if (err) return <div className="empty">Failed to load data: {err}</div>;
  if (!meta || !season) return <div className="empty">Loading…</div>;

  return (
    <>
      <header>
        <h1>🏈 <span>{meta.league}</span> — WAR Board</h1>
        <div id="updated">updated {meta.updated}</div>
      </header>
      <nav>
        {(["players", "teams", "weekly"] as View[]).map(v => (
          <button key={v} className={view === v ? "on" : ""} onClick={() => { setView(v); setOpenPlayer(null); }}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <select style={{ marginLeft: "auto" }} value={season} onChange={e => { setSeason(e.target.value); setOpenPlayer(null); }}>
          {meta.seasons.slice().reverse().map(s => <option key={s} value={s}>{s}</option>)}
          <option value="ALL">All-time</option>
        </select>
      </nav>
      <main>
        <OpenPlayerContext.Provider value={pid => setOpenPlayer(pid)}>
          {/* keep the view mounted (hidden) so its state survives visiting a player page */}
          <div style={{ display: openPlayer ? "none" : undefined }}>
            {!data ? <div className="empty">Loading…</div> : (
              view === "players"
                ? <Players data={data} players={players}
                    defaultMinGp={Math.round(data.summary.reduce((m, r) => Math.max(m, r[2]), 0) * 0.45)} />
                : view === "teams"
                  ? <Teams data={data} season={season} players={players} />
                  : <WeeklyView data={data} season={season} players={players} />
            )}
          </div>
          {openPlayer && <PlayerPage pid={openPlayer} players={players} meta={meta} back={() => setOpenPlayer(null)} />}
        </OpenPlayerContext.Provider>
      </main>
      <Methodology />
    </>
  );
}

function useSeasonData(season: string, meta: Meta | null): SeasonData | null {
  const [d, setD] = useState<SeasonData | null>(null);
  useEffect(() => {
    if (!meta || !season) return;
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
