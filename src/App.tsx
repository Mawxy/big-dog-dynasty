import { useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from "react-router-dom";
import type { LeagueEntry, Leagues, Meta, PlayersMin } from "./lib/types";
import { j, jl, probeLeagueBase, setVersion } from "./lib/data";
import { LeagueContext, leagueSeg, legacyRegistry, resolveLeague, useLeague } from "./lib/context";
import { useSeasonData } from "./lib/useSeasonData";
import { seasonSeg } from "./lib/league";
import Home from "./views/Home";
import Players from "./views/Players";
import Teams from "./views/Teams";
import WeeklyView from "./views/Weekly";
import Draft from "./views/Draft";
import Trades from "./views/Trades";
import Dvi from "./views/Dvi";
import Cvi from "./views/Cvi";
import FranchisePage from "./components/FranchisePage";
import PlayerPage from "./components/PlayerPage";
import SiteFooter from "./components/SiteFooter";

const VIEWS = ["home", "players", "standings", "weekly", "draft", "trades", "dvi", "cvi"] as const;
/** views that aren't scoped to a season (no season picker, plain route) */
const GLOBAL_VIEWS = ["home", "draft", "trades", "dvi", "cvi"];
const LABEL = (v: string) =>
  v === "dvi" || v === "cvi" ? v.toUpperCase()
    : v === "home" ? "League" : v[0].toUpperCase() + v.slice(1);

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

/** Old season-first URLs (#/players/2025) keep working: prefix the league and
 *  replace. Prefixing the whole pathname rather than rebuilding from params
 *  means every legacy shape — including /teams/:season/:rid/:tab — survives
 *  without being enumerated. */
function LegacyRedirect() {
  const { league } = useLeague();
  const loc = useLocation();
  return <Navigate to={`/${leagueSeg(league)}${loc.pathname}${loc.search}`} replace />;
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
  const [league, setLeague] = useState<LeagueEntry | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      // The registry comes FIRST and is global — it is what tells us where the
      // rest of this league's data lives. Everything after it is league-scoped
      // and goes through jl(), which falls back to the flat layout while the
      // files are still being moved.
      const reg = await j<Leagues>("data/leagues.json")
        .catch(() => null as Leagues | null);
      if (reg) {
        const l = resolveLeague(reg);
        await probeLeagueBase(l.key);
        setLeague(l);
      }
      const m = await jl<Meta>("meta.json");
      setVersion(m.updated);
      // data built before the registry existed: synthesise an entry from meta
      if (!reg) setLeague(resolveLeague(legacyRegistry(m)));
      setPlayers(await jl<PlayersMin>("players_min.json"));
      setMeta(m);
    })().catch(e => setErr(String(e)));
  }, []);
  if (err) return <div className="empty">Failed to load data: {err}</div>;
  if (!meta || !players || !league) return <div className="empty">Loading…</div>;
  return (
    <LeagueContext.Provider value={{ meta, players, league }}>
      <HashRouter>
        <Shell />
      </HashRouter>
    </LeagueContext.Provider>
  );
}

function Shell() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const loc = useLocation();
  const navType = useNavigationType();
  // new page -> start at the top; browser back/forward keeps its own scroll
  useEffect(() => {
    if (navType === "PUSH") window.scrollTo(0, 0);
  }, [loc.pathname, navType]);
  const latest = defaultSeason(meta);
  // paths are league-first now: /<league>/<view>[/<season>...]
  const base = `/${leagueSeg(league)}`;
  const parts = loc.pathname.split("/");
  const onView = (VIEWS as readonly string[]).includes(parts[2]);
  const curSeasonSeg = onView && parts[3] ? parts[3] : seasonSeg(latest);
  return (
    <div className="app">
      <header className="mast">
        <div className="mast-in">
          <div className="mast-name">
            <span className="wordmark">{meta.league}</span>
            <span className="wordmark-tag">War Board</span>
          </div>
          <div className="mast-meta">
            {/* the season selector lives in the views that are season-scoped,
                not here — see components/SeasonPicker */}
            <span className="mast-updated">Data refreshes Wed 1:00 AM ET · {meta.updated}</span>
          </div>
        </div>
      </header>

      <nav className="tabs">
        {VIEWS.map(v => (
          <button key={v} className={parts[2] === v ? "on" : ""}
            onClick={() => nav(GLOBAL_VIEWS.includes(v)
              ? `${base}/${v}` : `${base}/${v}/${curSeasonSeg}`)}>
            {LABEL(v)}
          </button>
        ))}
      </nav>

      <main>
        <Routes>
          {/* league-first. A static first segment outranks the dynamic
              :league, so the legacy block below can never be shadowed. */}
          <Route path="/:league" element={<Home />} />
          <Route path="/:league/home" element={<Home />} />
          <Route path="/:league/players/:season" element={<PlayersRoute />} />
          <Route path="/:league/standings/:season" element={<TeamsRoute />} />
          {/* A franchise is keyed by roster_id, which is stable across seasons —
              so its URL carries no year. The page picks its own roster season. */}
          <Route path="/:league/franchise/:rid" element={<FranchiseRoute />} />
          <Route path="/:league/franchise/:rid/:tab" element={<FranchiseRoute />} />

          {/* the season-scoped team URLs this replaced */}
          <Route path="/:league/teams/:season/:rid/:tab" element={<TeamRedirect />} />
          <Route path="/:league/teams/:season/:rid" element={<TeamRedirect />} />
          <Route path="/:league/teams/:season" element={<TeamRedirect />} />
          <Route path="/:league/teams" element={<TeamRedirect />} />
          <Route path="/:league/weekly/:season" element={<WeeklyRoute />} />
          <Route path="/:league/weekly/:season/:wk" element={<WeeklyRoute />} />
          <Route path="/:league/weekly/:season/:wk/:mid" element={<WeeklyRoute />} />
          <Route path="/:league/draft" element={<Draft />} />
          <Route path="/:league/trades" element={<Trades />} />
          <Route path="/:league/dvi" element={<Dvi />} />
          <Route path="/:league/cvi" element={<Cvi />} />
          <Route path="/:league/player/:pid" element={<PlayerRoute />} />

          {/* pre-restructure URLs — bookmarks, and anything already shared */}
          <Route path="/players/*" element={<LegacyRedirect />} />
          <Route path="/teams/*" element={<LegacyRedirect />} />
          <Route path="/weekly/*" element={<LegacyRedirect />} />
          <Route path="/draft" element={<LegacyRedirect />} />
          <Route path="/trades" element={<LegacyRedirect />} />
          <Route path="/dvi" element={<LegacyRedirect />} />
          <Route path="/cvi" element={<LegacyRedirect />} />
          <Route path="/player/*" element={<LegacyRedirect />} />

          <Route path="*" element={<Navigate to={base} replace />} />
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

/**
 * `/teams/<season>[/<rid>[/<tab>]]` -> standings or a franchise.
 *
 * A rid in the path means a franchise, which no longer takes a season; without
 * one it's the standings for that year. Both forms predate the rename and are
 * already shared, so they redirect rather than 404.
 */
function TeamRedirect() {
  const { meta, league } = useLeague();
  const p = useParams();
  const base = `/${leagueSeg(league)}`;
  const rid = intParam(p.rid);
  return <Navigate replace to={rid != null
    ? `${base}/franchise/${rid}${p.tab ? `/${p.tab}` : ""}`
    : `${base}/standings/${seasonSeg(seasonOf(p.season, meta))}`} />;
}

function FranchiseRoute() {
  const { players, league } = useLeague();
  const nav = useNavigate();
  const p = useParams();
  const rid = intParam(p.rid);
  const base = `/${leagueSeg(league)}`;
  if (rid == null) return <Navigate replace to={base} />;
  return <div className="legacy">
    <FranchisePage key={rid} rid={rid} players={players} tab={p.tab}
      onTab={t => nav(`${base}/franchise/${rid}/${t}`, { replace: true })}
      back={() => nav(-1)} />
  </div>;
}

function TeamsRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const season = seasonOf(p.season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  return <Teams data={data} season={season} players={players} />;
}

function WeeklyRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const season = seasonOf(p.season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  return <WeeklyView data={data} season={season} players={players}
    week={intParam(p.wk)} matchupRid={intParam(p.mid)} />;
}

function PlayerRoute() {
  const { meta, players } = useLeague();
  const pid = useParams().pid!;
  const nav = useNavigate();
  // key={pid} forces a fresh mount per player: without it, QuickJump reuses the
  // component and a shard that 404s leaves the previous player's projection on
  // screen (state is never reset on fetch failure).
  return <PlayerPage key={pid} pid={pid} players={players} meta={meta} back={() => nav(-1)} />;
}
