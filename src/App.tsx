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
import Trades from "./views/Trades";
import Dvi from "./views/Dvi";
import PlayerPage from "./components/PlayerPage";
import SiteFooter from "./components/SiteFooter";

const VIEWS = ["players", "teams", "weekly", "draft", "trades", "dvi"] as const;
/** views that aren't scoped to a season (no season picker, plain route) */
const GLOBAL_VIEWS = ["draft", "trades", "dvi"];
const LABEL = (v: string) => (v === "dvi" ? "DVI" : v[0].toUpperCase() + v.slice(1));

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

/** a route segment as a non-negative integer, or null for a bogus one (e.g.
 *  /teams/2025/abc) — keeps NaN out of rid/week props */
function intParam(seg: string | undefined): number | null {
  if (seg == null) return null;
  const n = Number(seg);
  return Number.isInteger(n) && n >= 0 ? n : null;
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
  const showSeason = onView && !GLOBAL_VIEWS.includes(parts[1]);
  return (
    <div className="app">
      <header className="mast">
        <div className="mast-in">
          <div className="mast-name">
            <span className="wordmark">{meta.league}</span>
            <span className="wordmark-tag">War Board</span>
          </div>
          <div className="mast-meta">
            <span className="mast-updated">Data refreshes Wed 1:00 AM ET · {meta.updated}</span>
            {showSeason && (
              <select className="season-chip" value={curSeasonSeg}
                onChange={e => nav(`/${curView}/${e.target.value}`)}>
                {meta.seasons.slice().reverse().map(s => <option key={s} value={s}>{s}</option>)}
                <option value="all">All-time</option>
              </select>
            )}
          </div>
        </div>
      </header>

      <nav className="tabs">
        {VIEWS.map(v => (
          <button key={v} className={parts[1] === v ? "on" : ""}
            onClick={() => nav(GLOBAL_VIEWS.includes(v) ? `/${v}` : `/${v}/${curSeasonSeg}`)}>
            {LABEL(v)}
          </button>
        ))}
      </nav>

      <main>
        <Routes>
          <Route path="/players/:season" element={<PlayersRoute />} />
          <Route path="/teams/:season" element={<TeamsRoute />} />
          <Route path="/teams/:season/:rid" element={<TeamsRoute />} />
          <Route path="/teams/:season/:rid/:tab" element={<TeamsRoute />} />
          <Route path="/weekly/:season" element={<WeeklyRoute />} />
          <Route path="/weekly/:season/:wk" element={<WeeklyRoute />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/dvi" element={<Dvi />} />
          <Route path="/player/:pid" element={<PlayerRoute />} />
          <Route path="*" element={<Navigate to={`/players/${seasonSeg(latest)}`} replace />} />
        </Routes>
      </main>
      <SiteFooter />
    </div>
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
  return <Teams data={data} season={season} players={players} detailRid={intParam(p.rid)}
    tab={p.tab} />;
}

function WeeklyRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const season = seasonOf(p.season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  return <WeeklyView data={data} season={season} players={players} week={intParam(p.wk)} />;
}

function PlayerRoute() {
  const { meta, players } = useLeague();
  const pid = useParams().pid!;
  const nav = useNavigate();
  // key={pid} forces a fresh mount per player: without it, QuickJump reuses the
  // component and a shard that 404s leaves the previous player's projection on
  // screen (state is never reset on fetch failure).
  return <div className="legacy"><PlayerPage key={pid} pid={pid} players={players} meta={meta} back={() => nav(-1)} /></div>;
}
