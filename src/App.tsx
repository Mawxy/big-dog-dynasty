import { useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from "react-router-dom";
import type { Meta, PlayersMin } from "./lib/types";
import { j, setVersion } from "./lib/data";
import { LeagueContext, useLeague } from "./lib/context";
import { useSeasonData } from "./lib/useSeasonData";
import { seasonSeg } from "./lib/league";
import Players from "./views/Players";
import Teams from "./views/Teams";
import WeeklyView from "./views/Weekly";
import Draft from "./views/Draft";
import PlayerPage from "./components/PlayerPage";
import Methodology from "./components/Methodology";

const VIEWS = ["players", "teams", "weekly", "draft"] as const;

/** newest season that actually has WAR data (falls back to newest listed) */
function defaultSeason(meta: Meta): string {
  if (meta.latest && meta.seasons.includes(meta.latest)) return meta.latest;
  return meta.seasons[meta.seasons.length - 1];
}

/** URL segment -> internal season id, with fallback to the default season */
function seasonOf(seg: string | undefined, meta: Meta): string {
  if (seg?.toLowerCase() === "all") return "ALL";
  if (seg && meta.seasons.includes(seg)) return seg;
  return defaultSeason(meta);
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [players, setPlayers] = useState<PlayersMin | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      const m = await j<Meta>("data/meta.json");
      setVersion(m.updated);
      setPlayers(await j<PlayersMin>("data/players_min.json"));
      setMeta(m);
    })().catch(e => setErr(String(e)));
  }, []);
  if (err) return <div className="empty">Failed to load data: {err}</div>;
  if (!meta || !players) return <div className="empty">Loading…</div>;
  return (
    <LeagueContext.Provider value={{ meta, players }}>
      <HashRouter>
        <Shell />
      </HashRouter>
    </LeagueContext.Provider>
  );
}

function Shell() {
  const { meta } = useLeague();
  const nav = useNavigate();
  const loc = useLocation();
  const navType = useNavigationType();
  // new page -> start at the top; browser back/forward keeps its own scroll
  useEffect(() => {
    if (navType === "PUSH") window.scrollTo(0, 0);
  }, [loc.pathname, navType]);
  const latest = defaultSeason(meta);
  const parts = loc.pathname.split("/");
  const onView = (VIEWS as readonly string[]).includes(parts[1]);
  const curView = onView ? parts[1] : "players";
  const curSeasonSeg = onView && parts[2] ? parts[2] : seasonSeg(latest);
  return (
    <>
      <header>
        <h1>🏈 <span>{meta.league}</span> — WAR Board</h1>
        <div id="updated">updated {meta.updated}</div>
      </header>
      <nav>
        {VIEWS.map(v => (
          <button key={v} className={parts[1] === v ? "on" : ""}
            onClick={() => nav(v === "draft" ? "/draft" : `/${v}/${curSeasonSeg}`)}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        {parts[1] !== "player" && parts[1] !== "draft" && (
          <select style={{ marginLeft: "auto" }} value={curSeasonSeg} onChange={e => nav(`/${curView}/${e.target.value}`)}>
            {meta.seasons.slice().reverse().map(s => <option key={s} value={s}>{s}</option>)}
            <option value="all">All-time</option>
          </select>
        )}
      </nav>
      <main>
        <Routes>
          <Route path="/players/:season" element={<PlayersRoute />} />
          <Route path="/teams/:season" element={<TeamsRoute />} />
          <Route path="/teams/:season/:rid" element={<TeamsRoute />} />
          <Route path="/weekly/:season" element={<WeeklyRoute />} />
          <Route path="/weekly/:season/:wk" element={<WeeklyRoute />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/player/:pid" element={<PlayerRoute />} />
          <Route path="*" element={<Navigate to={`/players/${seasonSeg(latest)}`} replace />} />
        </Routes>
      </main>
      <Methodology />
    </>
  );
}

function PlayersRoute() {
  const { meta, players } = useLeague();
  const season = seasonOf(useParams().season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  return <Players data={data} season={season} seasons={meta.seasons} players={players}
    defaultMinGp={Math.round(data.summary.reduce((m, r) => Math.max(m, r[2]), 0) * 0.45)} />;
}

function TeamsRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const season = seasonOf(p.season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  return <Teams data={data} season={season} players={players} detailRid={p.rid ? +p.rid : null} />;
}

function WeeklyRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const season = seasonOf(p.season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  return <WeeklyView data={data} season={season} players={players} week={p.wk ? +p.wk : null} />;
}

function PlayerRoute() {
  const { meta, players } = useLeague();
  const pid = useParams().pid!;
  const nav = useNavigate();
  return <PlayerPage pid={pid} players={players} meta={meta} back={() => nav(-1)} />;
}
