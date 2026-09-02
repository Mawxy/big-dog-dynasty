import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from "react-router-dom";
import type { IndexModelsFile, LeagueEntry, Leagues, MatrixCurve, Meta, PlayersMin } from "./lib/types";
import { j, jl, retry, setLeagueBase, setVersion } from "./lib/data";
import { pageview } from "./lib/analytics";
import { useJson } from "./lib/useJson";
import { DEFAULT_CURVE, ModelContext, isCurve } from "./lib/model";
import ModelPicker from "./components/ModelPicker";
import { CLASSIC_SEG, LeagueContext, leagueSeg, legacyRegistry, resolveLeague, useLeague } from "./lib/context";
import { useSeasonData } from "./lib/useSeasonData";
import { latestSeasonOf, seasonSeg } from "./lib/league";
import Home from "./views/Home";
import SiteFooter from "./components/SiteFooter";
import ErrorBoundary from "./components/ErrorBoundary";
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
/**
 * THE BETA SHELL IS THE BOARD (Max, 2026-09-02). The phone-first redesign
 * (formerly "v3", then "beta") answers the bare league address —
 * `/<league>/...` — and the classic board moved under `/<league>/classic/...`.
 * `wantedLeague()` still reads the first segment, so league resolution is
 * untouched either way; the old `/beta` and `/v3` addresses redirect by
 * dropping their segment, and a classic view's old bare address is forwarded
 * to `/classic` by the beta shell (BetaShell's ClassicFallback), so every
 * link anyone has shared still lands.
 *
 * Nothing in the beta shell writes to a file the classic board reads. It is
 * lazy for the same reason every other route is: a reader on one board should
 * not download the other to look at a standings table.
 */
const BetaShell = lazy(() => import("./beta/BetaShell"));

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
        : v === "trades" ? "Trade" : v[0].toUpperCase() + v.slice(1);

/** URL segment -> internal season id, with fallback to the default season */
function seasonOf(seg: string | undefined, meta: Meta): string {
  if (seg?.toLowerCase() === "all") return "ALL";
  if (seg && meta.seasons.includes(seg)) return seg;
  return latestSeasonOf(meta);
}

/** One GoatCounter pageview per route change (lib/analytics.ts). Inside the
 *  router so useLocation exists; renders nothing. The hash path is the page —
 *  location.pathname is always "/" under hash routing, which is why the
 *  collector's automatic counting is off in index.html. */
function Track() {
  const loc = useLocation();
  useEffect(() => { pageview(loc.pathname); }, [loc.pathname]);
  return null;
}

/** Old season-first URLs (#/players/2025) keep working: prefix the league and
 *  the classic segment and replace. Prefixing the whole pathname rather than
 *  rebuilding from params means every legacy shape — including
 *  /teams/:season/:rid/:tab — survives without being enumerated. */
function LegacyRedirect() {
  const { league } = useLeague();
  const loc = useLocation();
  return <Navigate to={`/${leagueSeg(league)}/${CLASSIC_SEG}${loc.pathname}${loc.search}`} replace />;
}

/** the beta shell's old addresses: /<league>/beta/... and /<league>/v3/...
 *  -> /<league>/..., which is where the shell answers now */
function DropSegRedirect({ seg }: { seg: string }) {
  const loc = useLocation();
  return <Navigate replace
    to={{ pathname: loc.pathname.replace(`/${seg}`, ""), search: loc.search }} />;
}

/** the site's root: the default league's board */
function RootRedirect() {
  const { league } = useLeague();
  return <Navigate to={`/${leagueSeg(league)}`} replace />;
}

/** a route segment as a non-negative integer, or null for a bogus one (e.g.
 *  /teams/2025/abc) — keeps NaN out of rid/week props */
function intParam(seg: string | undefined): number | null {
  if (seg == null) return null;
  const n = Number(seg);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The league the URL is asking for: the hash path's first segment.
 *
 * Read off `window.location` rather than through useParams, because the
 * registry has to resolve BEFORE <HashRouter> exists — jl() needs its base set
 * for meta.json, the very first league-scoped fetch. Nothing in the router is
 * mounted yet at that point, which is exactly why the :league segment was
 * decorative: every URL rendered the default league.
 */
function wantedLeague(): string {
  const h = window.location.hash;
  const path = (h.startsWith("#") ? h.slice(1) : h).split("?")[0];
  try { return decodeURIComponent(path.split("/")[1] ?? ""); }
  catch { return path.split("/")[1] ?? ""; }
}

/** First segments that are NOT a league — the pre-league routes at the bottom
 *  of the table below. Keep the two in step: a segment missing here is read as
 *  a bogus league name and bounced to the default league's base. */
const LEGACY_SEGS = new Set([
  "players", "stats", "teams", "weekly", "draft", "trades", "value",
  "dvi", "cvi", "player", "standings",
]);

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [players, setPlayers] = useState<PlayersMin | null>(null);
  const [league, setLeague] = useState<LeagueEntry | null>(null);
  const [leagues, setLeagues] = useState<Leagues | null>(null);
  const [err, setErr] = useState("");
  // Bumped by the boot error screen's Try again. Every boot fetch already
  // retries three times on its own; this is the manual arm for the case where
  // the outage outlasts that budget — a deploy still in flight, a phone that
  // hasn't reconnected yet. Without it the only exit was a reload, and on an
  // iOS web clip that means killing and reopening the app.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    (async () => {
      // The registry comes FIRST and is global — it is what tells us where the
      // rest of this league's data lives. Everything after it is league-scoped
      // and goes through jl().
      const reg = await retry(() => j<Leagues>("data/leagues.json"))
        .catch(() => null as Leagues | null);
      // The URL's own first segment picks the league — by key, then by alias,
      // then the registry default. Resolving with no `want` at all is what made
      // /<league>/... decorative.
      const want = wantedLeague();
      // Point jl() straight at the league layout. The probe request that used
      // to confirm the layout existed cost a serial round trip (and fetched
      // meta.json a second time, outside the cache).
      if (reg) setLeagueBase(resolveLeague(reg, want).key);
      // meta and players_min don't depend on each other — one round trip.
      // players_min is fetched before setVersion and so carries no ?v= — it
      // rides the same short max-age meta.json does, an accepted staleness.
      const [m, pl] = await Promise.all([
        retry(() => jl<Meta>("meta.json")),
        retry(() => jl<PlayersMin>("players_min.json")),
      ]);
      setVersion(m.updated);
      // data built before the registry existed: synthesize an entry from meta
      const registry = reg ?? legacyRegistry(m);
      setLeagues(registry);
      setLeague(resolveLeague(registry, want));
      setPlayers(pl);
      setMeta(m);
    })().catch(e => setErr(String(e)));
  }, [attempt]);
  // Same panel the render boundary uses, for the same reason: a dead end with
  // a raw exception string and no button is the worst version of this screen.
  if (err) return (
    <div className="errbox">
      <div className="k">Couldn't load the board</div>
      <div className="body">
        The league data didn't come back. That's usually a deploy still landing or a
        dropped connection, not a broken board — try again in a moment.
      </div>
      <div className="acts">
        <button type="button" className="retry"
          onClick={() => { setErr(""); setAttempt(a => a + 1); }}>Try again</button>
        <button type="button" className="retry"
          onClick={() => window.location.reload()}>Reload</button>
      </div>
      <div className="tnote">{err}</div>
    </div>
  );
  if (!meta || !players || !league || !leagues) return <div className="empty">Loading…</div>;
  return (
    <LeagueContext.Provider value={{ meta, players, league, leagues }}>
      <HashRouter>
        <Track />
        <ModelProvider>
          {/* Two shells, one league context and one model control. The beta
              branch is matched first and swallows its whole subtree, so the
              classic Shell — masthead, tab strip, footer — never renders
              underneath it. */}
          <Routes>
            {/* the classic board, under its own segment */}
            <Route path={`/:league/${CLASSIC_SEG}/*`} element={<Shell />} />
            {/* the beta shell's two old prefixes — shared links redirect */}
            <Route path="/:league/beta/*" element={<DropSegRedirect seg="beta" />} />
            <Route path="/:league/v3/*" element={<DropSegRedirect seg="v3" />} />
            {/* pre-league URLs (#/players/2025): static first segments outrank
                the dynamic :league below, so these can never be read as a
                league named "players" */}
            <Route path="/players/*" element={<LegacyRedirect />} />
            <Route path="/stats/*" element={<LegacyRedirect />} />
            <Route path="/teams/*" element={<LegacyRedirect />} />
            <Route path="/weekly/*" element={<LegacyRedirect />} />
            <Route path="/standings/*" element={<LegacyRedirect />} />
            <Route path="/draft" element={<LegacyRedirect />} />
            <Route path="/trades" element={<LegacyRedirect />} />
            <Route path="/value" element={<LegacyRedirect />} />
            <Route path="/dvi" element={<LegacyRedirect />} />
            <Route path="/cvi" element={<LegacyRedirect />} />
            <Route path="/player/*" element={<LegacyRedirect />} />
            {/* the board: the beta shell, at the bare league address */}
            <Route path="/:league/*" element={
              <ErrorBoundary resetKey="beta">
                <Suspense fallback={<div className="empty">Loading…</div>}>
                  <BetaShell />
                </Suspense>
              </ErrorBoundary>
            } />
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </ModelProvider>
      </HashRouter>
    </LeagueContext.Provider>
  );
}

/**
 * The projection-model switch, held for the whole site.
 *
 * Inside the router, because the URL is where the choice actually lives:
 * `?m=analog_natural` travels with a shared link, so two people reading the
 * same address see the same numbers. localStorage only remembers it between
 * sessions — if the two ever disagree the URL wins, since the URL is the one
 * the sender chose deliberately.
 *
 * `available` is false for data built before index_models.json, which keeps the
 * control from offering six choices that all return the same file.
 */
function ModelProvider({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  const mx = useJson<IndexModelsFile>("index_models.json", "leagueDaily");
  const fromUrl = new URLSearchParams(loc.search).get("m");
  const stored = (() => {
    try { return window.localStorage.getItem("warboard.curve"); } catch { return null; }
  })();
  const curve = isCurve(fromUrl) ? fromUrl : isCurve(stored) ? stored : DEFAULT_CURVE;
  const setCurve = useCallback((c: MatrixCurve) => {
    try { window.localStorage.setItem("warboard.curve", c); } catch { /* private mode */ }
    const q = new URLSearchParams(loc.search);
    // the default is the absence of the param, so a link to the site as it
    // ships doesn't carry a setting that only means "unchanged"
    if (c === DEFAULT_CURVE) q.delete("m"); else q.set("m", c);
    const s = q.toString();
    nav({ pathname: loc.pathname, search: s ? `?${s}` : "" }, { replace: true });
  }, [loc.pathname, loc.search, nav]);
  const value = useMemo(() => ({
    curve, setCurve, loading: mx.loading, available: !!mx.data,
  }), [curve, setCurve, mx.loading, mx.data]);
  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}

function Shell() {
  const { meta, league, leagues } = useLeague();
  const nav = useNavigate();
  const loc = useLocation();
  const navType = useNavigationType();
  // new page -> start at the top; browser back/forward keeps its own scroll
  useEffect(() => {
    if (navType === "PUSH") window.scrollTo(0, 0);
  }, [loc.pathname, navType]);
  const latest = latestSeasonOf(meta);
  // paths are league-first, then the classic segment:
  // /<league>/classic/<view>[/<season>...]. `parts` drops the classic segment
  // so the view/season indices below read as they always have.
  const base = `/${leagueSeg(league)}/${CLASSIC_SEG}`;
  const raw = loc.pathname.split("/");
  const parts = raw[2] === CLASSIC_SEG ? [raw[0], raw[1], ...raw.slice(3)] : raw;

  /**
   * The URL's league segment against the one actually loaded.
   *
   * Three cases. It names the loaded league (by key or alias) — render. It
   * names nothing in the registry, and isn't one of the pre-league segments
   * below — bounce to the default league's base, because leaving it renders
   * the default league at an address claiming another one, and that address is
   * what gets shared. It names a DIFFERENT registered league — every
   * league-scoped file was already fetched under the loaded one, so the only
   * honest answer is to boot again against the requested key. That cannot loop:
   * the reload resolves to the requested league and the segment then matches.
   */
  const seg = parts[1] ?? "";
  const wantEntry = seg ? leagues.leagues.find(l => l.key === seg || l.alias === seg) : undefined;
  // leagueSeg() is checked on its own because it invents "league" for data
  // built before the registry existed, where key and alias are both empty. That
  // segment resolves to nothing in the registry, so without this it would read
  // as unknown and redirect to itself, forever.
  const onLoaded = seg === leagueSeg(league) || wantEntry?.key === league.key;
  const otherLeague = !!wantEntry && !onLoaded;
  const unknownLeague = !!seg && !onLoaded && !wantEntry && !LEGACY_SEGS.has(seg);
  useEffect(() => {
    if (otherLeague) window.location.reload();
  }, [otherLeague]);
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
  // index pages and any player page to Players; franchise pages to Teams;
  // the ledger to Trade, whose machine/ledger lens it is the other half of.
  const HUB_OF: Record<string, string> = {
    standings: "teams", ledger: "trades", history: "home", value: "players", stats: "players",
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
            {/* The season selector lives in the views that are season-scoped,
                not here — see components/SeasonPicker. The MODEL picker is the
                deliberate opposite: it is the one control that is not
                view-scoped, and it belongs beside the freshness line because
                the two say the same kind of thing. That line says when what
                you are looking at was built; the picker says under which
                assumptions. */}
            <ModelPicker />
            <span className="mast-updated">Rebuilt nightly, 06:00 UTC · {meta.updated}</span>
            {/* THE WAY ACROSS. The beta shell is the board now and this is
                the classic one, kept at /classic; a plain link in the
                masthead's own label vocabulary, not a toggle — the two shells
                are places, not a setting. The way back is the beta masthead's
                "← Classic board" and More's row. */}
            <a className="mast-beta" href={`#/${leagueSeg(league)}`}
              onClick={e => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault(); nav(`/${leagueSeg(league)}`);
              }}>← Beta board</a>
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
        {/* One malformed row used to take the whole SPA down: an uncaught
            render throw unmounts the tree, masthead and tab bar included. The
            boundary sits INSIDE the shell so a broken page leaves the
            navigation standing, and outside Suspense so a lazy chunk that
            fails to load lands here too. Keyed on the pathname, so walking
            away from the broken page clears it. */}
        <ErrorBoundary resetKey={loc.pathname}>
        <Suspense fallback={<div className="empty">Loading…</div>}>
        {unknownLeague ? <Navigate to={base} replace /> : <Routes>
          {/* RELATIVE to the /:league/classic mount in App: "stats" here is
              /<league>/classic/stats. The pre-league legacy redirects moved up
              to App's table, where their static first segments outrank the
              dynamic :league route. */}
          <Route index element={<Home />} />
          <Route path="home" element={<Home />} />
          {/* the Players tab's two boards. /stats is the latest played season,
              /stats/<season> a given year, /stats/all the career board;
              /value is the one merged price table. /players is the tab's own
              address and rests on Value. */}
          <Route path="stats" element={<Stats />} />
          <Route path="stats/:season" element={<Stats />} />
          <Route path="value" element={<Value />} />
          {/* /players once held both boards behind a lens control */}
          <Route path="players" element={<PlayersRedirect />} />
          <Route path="players/:season" element={<PlayersRedirect />} />
          <Route path="standings/:season" element={<StandingsRedirect />} />
          {/* A franchise is keyed by roster_id, which is stable across seasons —
              so its URL carries no year. The page picks its own roster season. */}
          <Route path="franchise/:rid" element={<FranchiseRoute />} />
          <Route path="franchise/:rid/:tab" element={<FranchiseRoute />} />

          {/* franchise-level hub: the 5C board plus the season spine.
              /teams is the roster board, /teams/<season> that year's
              standings, /teams/all the franchise history board. */}
          <Route path="teams" element={<FranchisesView />} />
          <Route path="teams/:season" element={<FranchisesView />} />
          {/* the season-scoped franchise URLs the franchise pages replaced */}
          <Route path="teams/:season/:rid/:tab" element={<TeamRedirect />} />
          <Route path="teams/:season/:rid" element={<TeamRedirect />} />
          <Route path="weekly/:season" element={<WeeklyRoute />} />
          <Route path="weekly/:season/:wk" element={<WeeklyRoute />} />
          <Route path="weekly/:season/:wk/:mid" element={<WeeklyRoute />} />
          <Route path="draft" element={<Draft />} />
          {/* /draft/history is the draft-boards scope of the Draft page;
              /draft/history/<season> is that draft's own page */}
          <Route path="draft/:sub" element={<Draft />} />
          <Route path="draft/history/:season" element={<DraftDetailRoute />} />
          <Route path="trades" element={<Trades />} />
          <Route path="ledger" element={<Ledger />} />
          {/* the year-by-year league story — off the tab bar, reached from the
              League dashboard's summary band */}
          <Route path="history" element={<History />} />
          <Route path="insights" element={<Insights />} />
          <Route path="dvi" element={<Dvi />} />
          <Route path="cvi" element={<Cvi />} />
          <Route path="player/:pid" element={<PlayerRoute />} />

          {/* pre-restructure URLs — bookmarks, and anything already shared */}
          <Route path="playoffs/:season" element={<PlayoffsRedirect />} />

          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>}
        </Suspense>
        </ErrorBoundary>
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
    to={`/${leagueSeg(league)}/${CLASSIC_SEG}/teams/${seasonSeg(seasonOf(p.season, meta))}`} />;
}

/**
 * `/teams/<season>/<rid>[/<tab>]` -> a franchise page. The form predates the
 * franchise rename and is already shared, so it redirects rather than 404s.
 * (`/teams/<season>` without a rid is now a real address — the season spine.)
 */
function TeamRedirect() {
  const { league } = useLeague();
  const p = useParams();
  const base = `/${leagueSeg(league)}/${CLASSIC_SEG}`;
  const rid = intParam(p.rid);
  if (rid == null) return <Navigate replace to={`${base}/teams`} />;
  return <Navigate replace to={`${base}/franchise/${rid}${p.tab ? `/${p.tab}` : ""}`} />;
}

/** /playoffs/<season> was its own page for one release; the season view's
 *  Playoffs chip owns that content now. */
function PlayoffsRedirect() {
  const { league } = useLeague();
  const p = useParams();
  return <Navigate replace to={`/${leagueSeg(league)}/${CLASSIC_SEG}/weekly/${p.season}/playoffs`} />;
}

/** key={season} forces a fresh mount per draft, resetting sort/scroll state */
function DraftDetailRoute() {
  const season = useParams().season!;
  return <DraftDetail key={season} />;
}

function FranchiseRoute() {
  const { players, league } = useLeague();
  const p = useParams();
  // the param is a FRANCHISE KEY: a rid for dynasty leagues, an owner user_id
  // for redraft (see Franchises in types.ts). FranchisePage itself resolves
  // legacy rid-shaped links against owner-keyed data.
  const fkey = p.rid || "";
  const base = `/${leagueSeg(league)}/${CLASSIC_SEG}`;
  if (!fkey) return <Navigate replace to={base} />;
  return <FranchisePage key={fkey} fkey={fkey} players={players} tab={p.tab} />;
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
