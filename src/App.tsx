import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from "react-router-dom";
import type { LeagueEntry, Leagues, Meta, PlayersMin } from "./lib/types";
import { j, jl, setLeagueBase, setVersion } from "./lib/data";
import { LeagueContext, leagueSeg, legacyRegistry, resolveLeague, useLeague } from "./lib/context";
import { useSeasonData } from "./lib/useSeasonData";
import { seasonSeg } from "./lib/league";
import Home from "./views/Home";
import SiteFooter from "./components/SiteFooter";
// Every route off the landing page loads lazily: one eager chunk held all 14
// views, so a first-time visitor downloaded and parsed the whole site to
// render the dashboard. Home stays eager — it IS the landing page.
const Stats = lazy(() => import("./views/Stats"));
const Value = lazy(() => import("./views/Value"));
const FranchisesView = lazy(() => import("./views/Franchises"));
const WeeklyView = lazy(() => import("./views/Weekly"));
const Draft = lazy(() => import("./views/Draft"));
const DraftDetail = lazy(() => import("./views/DraftDetail"));
const Trades = lazy(() => import("./views/Trades"));
const Ledger = lazy(() => import("./views/Ledger"));
const History = lazy(() => import("./views/History"));
const Insights = lazy(() => import("./views/Insights"));
const Dvi = lazy(() => import("./views/Dvi"));
const Cvi = lazy(() => import("./views/Cvi"));
const FranchisePage = lazy(() => import("./components/FranchisePage"));
const Player = lazy(() => import("./views/Player"));

/** The tab bar. Players is ONE tab holding two boards — Value (what a player
 *  is worth now) and Stats (what he did in a given year). They are separate
 *  screens rather than lenses on one table, because the two answer different
 *  questions, but they share a tab because they share a population and a
 *  reader moves between them constantly. Standings, DVI and CVI keep their
 *  routes but live off the bar — a route without a tab is a destination; a
 *  tab is a starting point. */
const VIEWS = ["home", "players", "teams", "weekly", "draft", "trades", "insights"] as const;
/** views that aren't scoped to a season (no season picker, plain route) */
const GLOBAL_VIEWS = ["home", "players", "value", "teams", "draft", "trades", "dvi", "cvi", "insights"];
const LABEL = (v: string) =>
  v === "dvi" || v === "cvi" ? v.toUpperCase()
    : v === "home" ? "League"
      // the weekly view owns the whole season now — weeks, then the bracket
      : v === "weekly" ? "Season"
        : v === "trades" ? "Trade machine" : v[0].toUpperCase() + v.slice(1);

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
      // and goes through jl().
      const reg = await j<Leagues>("data/leagues.json")
        .catch(() => null as Leagues | null);
      // Point jl() straight at the league layout. The probe request that used
      // to confirm the layout existed cost a serial round trip (and fetched
      // meta.json a second time, outside the cache); jl()'s own per-file
      // fallback already covers anything missing.
      if (reg) setLeagueBase(resolveLeague(reg).key);
      // meta and players_min don't depend on each other — one round trip.
      // players_min is fetched before setVersion and so carries no ?v= — it
      // rides the same short max-age meta.json does, an accepted staleness.
      const [m, pl] = await Promise.all([
        jl<Meta>("meta.json"),
        jl<PlayersMin>("players_min.json"),
      ]);
      setVersion(m.updated);
      // data built before the registry existed: synthesise an entry from meta
      setLeague(resolveLeague(reg ?? legacyRegistry(m)));
      setPlayers(pl);
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
  // Carry the current season across a tab switch — but only if that segment
  // IS a season. Several views take a non-season fourth segment (/draft/history,
  // /players/market), and carrying one of those produced "/weekly/history",
  // which rendered the Season tab with its picker reading "history".
  const seg3 = parts[3];
  const isSeason = !!seg3 && (meta.seasons.includes(seg3) || seg3.toLowerCase() === "all");
  const curSeasonSeg = onView && isSeason ? seg3 : seasonSeg(latest);
  // Off-tab pages still light their hub's tab, so the bar always answers
  // "where am I": standings belongs to League; both player boards, the two
  // index pages and any player page to Players; franchise pages to Teams.
  const HUB_OF: Record<string, string> = {
    standings: "teams", ledger: "home", history: "home", value: "players", stats: "players",
    dvi: "players", cvi: "players", player: "players", franchise: "teams",
    playoffs: "weekly",
  };
  const active = onView ? parts[2] : HUB_OF[parts[2]] ?? "";
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

      <TabBar>
        {VIEWS.map(v => (
          <button key={v} className={active === v ? "on" : ""}
            onClick={() => nav(GLOBAL_VIEWS.includes(v)
              ? `${base}/${v}` : `${base}/${v}/${curSeasonSeg}`)}>
            {LABEL(v)}
          </button>
        ))}
      </TabBar>

      <main>
        <Suspense fallback={<div className="empty">Loading…</div>}>
        <Routes>
          {/* league-first. A static first segment outranks the dynamic
              :league, so the legacy block below can never be shadowed. */}
          <Route path="/:league" element={<Home />} />
          <Route path="/:league/home" element={<Home />} />
          {/* the Players tab's two boards. /stats is the latest played season,
              /stats/<season> a given year, /stats/all the career board;
              /value is the one merged price table. /players is the tab's own
              address and rests on Value. */}
          <Route path="/:league/stats" element={<Stats />} />
          <Route path="/:league/stats/:season" element={<Stats />} />
          <Route path="/:league/value" element={<Value />} />
          {/* /players once held both boards behind a lens control */}
          <Route path="/:league/players" element={<PlayersRedirect />} />
          <Route path="/:league/players/:season" element={<PlayersRedirect />} />
          <Route path="/:league/standings/:season" element={<StandingsRedirect />} />
          {/* A franchise is keyed by roster_id, which is stable across seasons —
              so its URL carries no year. The page picks its own roster season. */}
          <Route path="/:league/franchise/:rid" element={<FranchiseRoute />} />
          <Route path="/:league/franchise/:rid/:tab" element={<FranchiseRoute />} />

          {/* franchise-level hub: the 5C board plus the season spine.
              /teams is the roster board, /teams/<season> that year's
              standings, /teams/all the franchise history board. */}
          <Route path="/:league/teams" element={<FranchisesView />} />
          <Route path="/:league/teams/:season" element={<FranchisesView />} />
          {/* the season-scoped franchise URLs the franchise pages replaced */}
          <Route path="/:league/teams/:season/:rid/:tab" element={<TeamRedirect />} />
          <Route path="/:league/teams/:season/:rid" element={<TeamRedirect />} />
          <Route path="/:league/weekly/:season" element={<WeeklyRoute />} />
          <Route path="/:league/weekly/:season/:wk" element={<WeeklyRoute />} />
          <Route path="/:league/weekly/:season/:wk/:mid" element={<WeeklyRoute />} />
          <Route path="/:league/draft" element={<Draft />} />
          {/* /draft/history is the draft-boards scope of the Draft page;
              /draft/history/<season> is that draft's own page */}
          <Route path="/:league/draft/:sub" element={<Draft />} />
          <Route path="/:league/draft/history/:season" element={<DraftDetailRoute />} />
          <Route path="/:league/trades" element={<Trades />} />
          <Route path="/:league/ledger" element={<Ledger />} />
          {/* the year-by-year league story — off the tab bar, reached from the
              League dashboard's summary band */}
          <Route path="/:league/history" element={<History />} />
          <Route path="/:league/insights" element={<Insights />} />
          <Route path="/:league/dvi" element={<Dvi />} />
          <Route path="/:league/cvi" element={<Cvi />} />
          <Route path="/:league/player/:pid" element={<PlayerRoute />} />

          {/* pre-restructure URLs — bookmarks, and anything already shared */}
          <Route path="/:league/playoffs/:season" element={<PlayoffsRedirect />} />

          <Route path="/players/*" element={<LegacyRedirect />} />
          <Route path="/stats/*" element={<LegacyRedirect />} />
          <Route path="/teams/*" element={<LegacyRedirect />} />
          <Route path="/weekly/*" element={<LegacyRedirect />} />
          <Route path="/draft" element={<LegacyRedirect />} />
          <Route path="/trades" element={<LegacyRedirect />} />
          <Route path="/value" element={<LegacyRedirect />} />
          <Route path="/dvi" element={<LegacyRedirect />} />
          <Route path="/cvi" element={<LegacyRedirect />} />
          <Route path="/player/*" element={<LegacyRedirect />} />

          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * The tab strip, plus the fact that it scrolls.
 *
 * Six tabs need 652px and a phone has 375, so Draft and Trade machine sat off
 * the right edge with nothing indicating they existed — the bar looked like
 * the whole of the site's navigation. The wrapper carries the same right-edge
 * fade the boards use, dropped once the last tab is reached.
 */
function TabBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", measure); };
  }, []);
  return (
    <div className={`tabwrap${more ? " more" : ""}`}>
      <nav className="tabs" ref={ref}>{children}</nav>
    </div>
  );
}

/**
 * /players held both boards behind a lens control, so its old addresses split
 * two ways: the market lens was a value measure and lands on Value, every
 * season lens (including /players/all) lands on the matching Stats scope.
 * Bare /players was the value lens at rest.
 */
function PlayersRedirect() {
  const { league } = useLeague();
  const seg = useParams().season;
  const to = !seg || seg === "market" ? "/value" : `/stats/${seg}`;
  return <Navigate replace to={`/${leagueSeg(league)}${to}`} />;
}

/** /standings/<season> moved onto the Teams page's season spine.
 *  Kept as a redirect for one release. */
function StandingsRedirect() {
  const { meta, league } = useLeague();
  const p = useParams();
  return <Navigate replace
    to={`/${leagueSeg(league)}/teams/${seasonSeg(seasonOf(p.season, meta))}`} />;
}

/**
 * `/teams/<season>/<rid>[/<tab>]` -> a franchise page. The form predates the
 * franchise rename and is already shared, so it redirects rather than 404s.
 * (`/teams/<season>` without a rid is now a real address — the season spine.)
 */
function TeamRedirect() {
  const { league } = useLeague();
  const p = useParams();
  const base = `/${leagueSeg(league)}`;
  const rid = intParam(p.rid);
  if (rid == null) return <Navigate replace to={`${base}/teams`} />;
  return <Navigate replace to={`${base}/franchise/${rid}${p.tab ? `/${p.tab}` : ""}`} />;
}

/** /playoffs/<season> was its own page for one release; the season view's
 *  Playoffs chip owns that content now. */
function PlayoffsRedirect() {
  const { league } = useLeague();
  const p = useParams();
  return <Navigate replace to={`/${leagueSeg(league)}/weekly/${p.season}/playoffs`} />;
}

/** key={season} forces a fresh mount per draft, resetting sort/scroll state */
function DraftDetailRoute() {
  const season = useParams().season!;
  return <DraftDetail key={season} />;
}

function FranchiseRoute() {
  const { players, league } = useLeague();
  const p = useParams();
  const rid = intParam(p.rid);
  const base = `/${leagueSeg(league)}`;
  if (rid == null) return <Navigate replace to={base} />;
  return <FranchisePage key={rid} rid={rid} players={players} tab={p.tab} />;
}

function WeeklyRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const season = seasonOf(p.season, meta);
  const data = useSeasonData(season);
  if (!data) return <div className="empty">Loading…</div>;
  // /weekly/<season>/playoffs is the bracket scope, the season's last chip
  return <WeeklyView data={data} season={season} players={players}
    week={intParam(p.wk)} matchupRid={intParam(p.mid)}
    playoffs={p.wk?.toLowerCase() === "playoffs"} />;
}

function PlayerRoute() {
  const pid = useParams().pid!;
  // key={pid} forces a fresh mount per player: without it, QuickJump reuses the
  // component and a shard that 404s leaves the previous player's projection on
  // screen (state is never reset on fetch failure).
  return <Player key={pid} pid={pid} />;
}
