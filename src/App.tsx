import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { IndexModelsFile, LeagueEntry, Leagues, MatrixCurve, Meta, PlayersMin } from "./lib/types";
import { BUST_PARAM, j, jl, retry, setBust, setLeagueBase, setVersion } from "./lib/data";
import { pageview } from "./lib/analytics";
import { useJson } from "./lib/useJson";
import { DEFAULT_CURVE, ModelContext, isCurve } from "./lib/model";
import { CLASSIC_SEG, LAB_SEG, LeagueContext, classicToBeta, leagueSeg, legacyRegistry, resolveLeague, useLeague } from "./lib/context";
import { useLeagueCaps } from "./lib/caps";
import ErrorBoundary from "./components/ErrorBoundary";
/**
 * ONE BOARD, TWO MOUNTS (Max, 2026-11-04). The beta shell answers the bare
 * league address — `/<league>/...` — and the same shell, screen for screen,
 * answers `/<league>/lab/...` wearing a trial look (C4 "Tale of the Tape").
 * The classic board is retired: every address it ever answered, and the
 * pre-league `#/players/2025` shapes before it, forwards through
 * `lib/context.classicToBeta` onto the live board's matching screen.
 *
 * Both mounts are lazy, and the lab is its own chunk (its stylesheet with
 * it), so a reader on the live board never downloads the trial.
 */
const BetaShell = lazy(() => import("./beta/BetaShell"));
const LabShell = lazy(() => import("./beta/lab/LabShell"));

/** One GoatCounter pageview per route change (lib/analytics.ts). Inside the
 *  router so useLocation exists; renders nothing. The hash path is the page —
 *  location.pathname is always "/" under hash routing, which is why the
 *  collector's automatic counting is off in index.html. */
function Track() {
  const loc = useLocation();
  useEffect(() => { pageview(loc.pathname); }, [loc.pathname]);
  return null;
}

/** Old season-first URLs (#/players/2025) keep working: the whole pathname is
 *  a classic-board path, so it is rewritten onto the live board's matching
 *  screen under the default league. */
function LegacyRedirect() {
  const { league } = useLeague();
  const loc = useLocation();
  return <Navigate replace
    to={`/${leagueSeg(league)}${classicToBeta(`${loc.pathname}${loc.search}`)}`} />;
}

/** `/<league>/classic/...` — the retired classic board's mount. Whatever it
 *  named lands on the live board's equivalent, query (and `?m=`) intact.
 *  The league segment is kept as written, key or alias. */
function ClassicRedirect() {
  const loc = useLocation();
  const [, lg = ""] = loc.pathname.split("/");
  const rest = loc.pathname.split("/").slice(3).join("/");
  return <Navigate replace to={`/${lg}${classicToBeta(`/${rest}${loc.search}`)}`} />;
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
      /* THE HARD-REFRESH NONCE, read before the first fetch. More's refresh row
         reloads the page with `?r=<nonce>`; picking it up here is what makes
         that reload bypass the browser's copy of meta.json, which is the file
         every other bust key is derived from and therefore the one that keeps a
         stale board stale. It rides `location.search`, which is free — this app
         routes on the hash. */
      const q = new URLSearchParams(window.location.search).get(BUST_PARAM);
      if (q) setBust(q);
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
          {/* One shell, two mounts. Static segments outrank the dynamic
              :league/* below, so /lab and /classic are matched first. */}
          <Routes>
            {/* the trial looks: the beta shell, re-skinned, screen for screen */}
            <Route path={`/:league/${LAB_SEG}/*`} element={
              <ErrorBoundary resetKey="lab">
                <Suspense fallback={<div className="empty">Loading…</div>}>
                  <LabShell />
                </Suspense>
              </ErrorBoundary>
            } />
            {/* the retired classic board: forwards onto the live board */}
            <Route path={`/:league/${CLASSIC_SEG}/*`} element={<ClassicRedirect />} />
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
  const caps = useLeagueCaps();
  const mx = useJson<IndexModelsFile>(caps.indices ? "index_models.json" : null, "leagueDaily");
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
