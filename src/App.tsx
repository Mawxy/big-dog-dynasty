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
import PlayerPage from "./components/PlayerPage";
import Methodology from "./components/Methodology";

const VIEWS = ["players", "teams", "weekly", "draft", "trades"] as const;
/** views that aren't scoped to a season (no season picker, plain route) */
const GLOBAL_VIEWS = ["draft", "trades"];

/** 20x20 stroke icons, inlined to avoid pulling in an icon dependency */
const ICONS: Record<string, string> = {
  players: "M7 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 18c0-2.5 2.2-4 5-4s5 1.5 5 4M13 14c2.6.2 5 1.6 5 4",
  teams: "M10 2 3 5v5c0 4.2 2.9 7.4 7 8.5 4.1-1.1 7-4.3 7-8.5V5l-7-3Z",
  weekly: "M3 5h14v13H3zM3 9h14M7 2v4M13 2v4",
  draft: "M7 3h6v3H7zM5 5h10v13H5zM8 10h4M8 13h4",
  trades: "M4 7h10l-3-3M16 13H6l3 3",
};

const NAV_KEY = "bdd.nav.open";

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
  // sidebar: expanded vs icon rail on desktop, remembered across reloads
  const [navOpen, setNavOpen] = useState(() => {
    try { return localStorage.getItem(NAV_KEY) !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(NAV_KEY, navOpen ? "1" : "0"); } catch { /* private mode */ }
  }, [navOpen]);
  // on mobile the sidebar is an overlay drawer instead of a rail
  const [mobileOpen, setMobileOpen] = useState(false);
  // new page -> start at the top; browser back/forward keeps its own scroll
  useEffect(() => {
    if (navType === "PUSH") window.scrollTo(0, 0);
    setMobileOpen(false);
  }, [loc.pathname, navType]);
  const latest = defaultSeason(meta);
  const parts = loc.pathname.split("/");
  const onView = (VIEWS as readonly string[]).includes(parts[1]);
  const curView = onView ? parts[1] : "players";
  const curSeasonSeg = onView && parts[2] ? parts[2] : seasonSeg(latest);
  const showSeason = parts[1] !== "player" && !GLOBAL_VIEWS.includes(parts[1]);
  return (
    <div className={"app" + (navOpen ? "" : " navshut") + (mobileOpen ? " navdrawer" : "")}>
      <aside className="sidebar">
        <div className="sbtop">
          <button className="sbtoggle" onClick={() => setNavOpen(o => !o)}
            aria-label={navOpen ? "Collapse navigation" : "Expand navigation"} title="Toggle navigation">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" fill="none" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" />
            </svg>
          </button>
          <span className="sbtitle">{meta.league}</span>
        </div>

        <nav>
          {VIEWS.map(v => (
            <button key={v} className={parts[1] === v ? "on" : ""} title={v[0].toUpperCase() + v.slice(1)}
              onClick={() => { nav(GLOBAL_VIEWS.includes(v) ? `/${v}` : `/${v}/${curSeasonSeg}`); setMobileOpen(false); }}>
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                <path d={ICONS[v]} fill="none" stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="sblabel">{v[0].toUpperCase() + v.slice(1)}</span>
            </button>
          ))}
        </nav>

        <div className="sbfoot">
          {showSeason && (
            <select value={curSeasonSeg} onChange={e => nav(`/${curView}/${e.target.value}`)}>
              {meta.seasons.slice().reverse().map(s => <option key={s} value={s}>{s}</option>)}
              <option value="all">All-time</option>
            </select>
          )}
          <div className="sbupdated">updated {meta.updated}</div>
        </div>
      </aside>

      {mobileOpen && <div className="scrim" onClick={() => setMobileOpen(false)} />}
      <button className="navfab" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path d="M3 5h14M3 10h14M3 15h14" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" />
        </svg>
      </button>

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
          <Route path="/player/:pid" element={<PlayerRoute />} />
          <Route path="*" element={<Navigate to={`/players/${seasonSeg(latest)}`} replace />} />
        </Routes>
        <Methodology />
      </main>
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
  return <Teams data={data} season={season} players={players} detailRid={p.rid ? +p.rid : null}
    tab={p.tab} />;
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
