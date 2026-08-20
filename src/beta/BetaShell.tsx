import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams,
} from "react-router-dom";
import type { Drafts, Team as TeamT } from "../lib/types";
import { useJson } from "../lib/useJson";
import { leagueSeg, useLeague } from "../lib/context";
import { IdentityContext, useIdentityState } from "../lib/identity";
import { latestSeasonOf, rosterSeasonOf, seasonSeg } from "../lib/league";
import { useSeasonData } from "../lib/useSeasonData";
import ErrorBoundary from "../components/ErrorBoundary";
import { Sheet, SheetRow } from "./ui";
import League from "./screens/League";
import Team from "./screens/Team";
import Claim from "./screens/Claim";
import Rankings from "./screens/Rankings";
import Trade from "./screens/Trade";
import More from "./screens/More";
import "./beta.css";

/* The deep destinations More points at are the classic board's views, mounted
   INSIDE this shell rather than linked out to. They are prop-compatible as they
   stand, and keeping them here is what stops a tap on "Drafts" silently
   dropping the reader out of the beta shell with no bottom bar and no way back. They are
   desktop-shaped, which is honest: they are the "everything else" bucket, not
   redesigned surfaces. */
const Player = lazy(() => import("../views/Player"));
const Draft = lazy(() => import("../views/Draft"));
const DraftDetail = lazy(() => import("../views/DraftDetail"));
const Weekly = lazy(() => import("../views/Weekly"));
const History = lazy(() => import("../views/History"));
const Insights = lazy(() => import("../views/Insights"));
const Ledger = lazy(() => import("../views/Ledger"));

/** The five destinations, in thumb order. Draft is a SEASONAL sixth — see
 *  `draftPending` below. */
const TABS = [
  { id: "", label: "League" },
  { id: "team", label: "Team" },
  { id: "rankings", label: "Rankings" },
  { id: "trade", label: "Trade" },
  { id: "more", label: "More" },
];

/** Which tab owns a destination that isn't itself a tab, so the bar always
 *  answers "where am I". */
const HUB_OF: Record<string, string> = {
  player: "rankings", claim: "team", drafts: "more", seasons: "more",
  history: "more", insights: "more", ledger: "more",
};

export default function BetaShell() {
  const { meta, league } = useLeague();
  const loc = useLocation();
  const nav = useNavigate();
  const navType = useNavigationType();
  const rosterSeason = rosterSeasonOf(league);

  // The rosters, hoisted: identity derives from them (a manager name IS a
  // Sleeper username), and both the Team screen and More want the same array.
  const teams = useJson<TeamT[]>(`${rosterSeason}/teams.json`).data;
  const identity = useIdentityState(league.key || "default", teams);

  const base = `/${leagueSeg(league)}/beta`;
  // the segment after /beta — "" on the League tab
  const seg = loc.pathname.startsWith(base)
    ? loc.pathname.slice(base.length).split("/").filter(Boolean)[0] ?? ""
    : "";
  const active = TABS.some(t => t.id === seg) ? seg : HUB_OF[seg] ?? "";

  useEffect(() => {
    if (navType === "PUSH") window.scrollTo(0, 0);
  }, [loc.pathname, navType]);

  /* ---- the bar hides on scroll-down and returns on scroll-up ------------
     Decision #5's other half: the bar costs 54px of a 667px screen, which is a
     row and a half of a standings table. It comes back on the first upward
     flick, so it is never more than one gesture away. */
  const [barAway, setBarAway] = useState(false);
  const lastY = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;
      // a threshold, so a jittery thumb doesn't strobe the bar
      if (Math.abs(dy) > 6) {
        setBarAway(dy > 0 && y > 80);
        lastY.current = y;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // a tab change must never leave the bar hidden
  useEffect(() => { setBarAway(false); lastY.current = window.scrollY; }, [loc.pathname]);

  /* ---- the seasonal sixth slot ------------------------------------------
     OPEN QUESTION in the redesign: the exact trigger and window. This is the
     data-driven reading — the Draft tab appears while the roster season's
     rookie draft has not yet been recorded, and disappears the moment it has.
     That is a fact the pipeline states rather than a month boundary, and it
     ties the promotion to the countdown the Drafts row already shows. What it
     does NOT yet encode is a lead time: it promotes the day the previous
     season's data lands, not four weeks out. */
  const drafts = useJson<Drafts>("drafts.json").data;
  const draftPending = useMemo(() => {
    if (!drafts) return false;
    return !Object.values(drafts).some(picks => picks.some(p => p.season === rosterSeason));
  }, [drafts, rosterSeason]);

  const tabs = draftPending
    ? [...TABS.slice(0, 4), { id: "drafts", label: "Draft", dot: true }, TABS[4]]
    : TABS;

  const [sheet, setSheet] = useState(false);
  // Long-press the League tab opens the switcher from anywhere — the bonus path
  // the redesign names. A pointer held for 500ms, cancelled by movement or
  // release, so it never fights an ordinary tap.
  const holdTimer = useRef<number | null>(null);
  // Set when the hold actually fired. A long press still ends in a `click`, so
  // without this the gesture both opened the sheet and navigated to League —
  // which reads as the sheet having a screen behind it that the reader did not
  // ask for, and is plainly wrong the moment a second league exists.
  const held = useRef(false);
  const cancelHold = () => {
    if (holdTimer.current != null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
  };
  const holdAt = useRef({ x: 0, y: 0 });
  const startHold = (e: React.PointerEvent) => {
    held.current = false;
    holdAt.current = { x: e.clientX, y: e.clientY };
    holdTimer.current = window.setTimeout(() => { held.current = true; setSheet(true); }, 500);
  };
  // A held finger jitters, so a bare pointermove cancel would make the gesture
  // impossible; 10px is the slop every platform's own long-press allows.
  const moveHold = (e: React.PointerEvent) => {
    if (holdTimer.current == null) return;
    const { x, y } = holdAt.current;
    if (Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 10) cancelHold();
  };

  const onLeague = active === "";

  return (
    <IdentityContext.Provider value={identity}>
      <div className="v3">
        <header className="v3-mast">
          {/* The league name is on every screen. On the League tab it is the
              switcher (decision #6 — the sheet IS the user level, which is what
              lets the whole user-home screen be deleted); everywhere else it is
              a plain label, because a control that re-contexts the entire app
              should not be sitting under the reader's thumb on the Trade
              screen. */}
          {onLeague ? (
            <button className="lg" onClick={() => setSheet(true)}
              aria-haspopup="dialog" aria-expanded={sheet}>
              {league.name}<span className="caret">▾</span>
            </button>
          ) : (
            <span className="lg flat">{league.name}</span>
          )}
          <span className="tag">War Board Beta</span>
        </header>

        {/* Every screen below a tab needs an on-screen way back: an iOS web clip
            has no browser chrome at all. The player page is the exception — it
            carries its own ← Back in the split rail, and two of them on one
            screen is a question about which one is real. */}
        {!TABS.some(t => t.id === seg) && seg !== "" && seg !== "player" && (
          <a className="v3-back" href={`#${base}${active ? `/${active}` : ""}`}
            onClick={e => { e.preventDefault(); nav(-1); }}>← Back</a>
        )}

        <main>
          <ErrorBoundary resetKey={loc.pathname}>
            <Suspense fallback={<div className="empty">Loading…</div>}>
              <Routes>
                <Route index element={<League />} />
                <Route path="team" element={<Team />} />
                <Route path="team/:rid" element={<TeamRoute />} />
                <Route path="claim" element={<Claim />} />
                <Route path="rankings" element={<Rankings />} />
                <Route path="rankings/:scope" element={<Rankings />} />
                <Route path="trade" element={<Trade />} />
                <Route path="more" element={<More />} />
                <Route path="player/:pid" element={<PlayerRoute />} />
                <Route path="drafts" element={<Draft />} />
                <Route path="drafts/:sub" element={<Draft />} />
                <Route path="drafts/history/:season" element={<DraftDetailRoute />} />
                <Route path="seasons" element={<SeasonRedirect />} />
                <Route path="seasons/:season" element={<WeeklyRoute />} />
                <Route path="seasons/:season/:wk" element={<WeeklyRoute />} />
                <Route path="seasons/:season/:wk/:mid" element={<WeeklyRoute />} />
                <Route path="history" element={<History />} />
                <Route path="insights" element={<Insights />} />
                <Route path="ledger" element={<Ledger />} />
                <Route path="*" element={<Navigate to={base} replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>

        <nav className={`v3-nav${barAway ? " away" : ""}`} aria-label="Sections">
          <div className="railtop">{meta.league}<b>War Board Beta</b></div>
          {tabs.map(t => {
            const to = t.id ? `${base}/${t.id}` : base;
            const on = active === t.id || (t.id === "drafts" && seg === "drafts");
            return (
              <a key={t.id || "league"} href={`#${to}`} className={on ? "on" : ""}
                onClick={e => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  cancelHold();
                  if (held.current) { held.current = false; return; }
                  nav(to);
                }}
                onPointerDown={t.id === "" ? startHold : undefined}
                onPointerUp={cancelHold} onPointerLeave={cancelHold}
                onPointerCancel={cancelHold} onPointerMove={moveHold}
                onContextMenu={t.id === "" ? e => e.preventDefault() : undefined}>
                {t.label}
                {"dot" in t && t.dot && <span className="dot" />}
              </a>
            );
          })}
          {/* On desktop the rail exposes More's contents rather than making a
              mouse open a menu. Hidden on a phone by beta.css. */}
          <div className="railgrp desk">Explore</div>
          {[
            { id: "drafts", label: "Drafts" }, { id: "seasons", label: "Seasons" },
            { id: "history", label: "History" }, { id: "insights", label: "Insights" },
            { id: "ledger", label: "Ledger" },
          ].map(x => (
            <a key={x.id} className={`sub desk${seg === x.id ? " on" : ""}`}
              href={`#${base}/${x.id}`}
              onClick={e => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault(); nav(`${base}/${x.id}`);
              }}>{x.label}</a>
          ))}
        </nav>

        {sheet && <LeagueSheet onClose={() => setSheet(false)} />}
      </div>
    </IdentityContext.Provider>
  );
}

/* ---- the league switcher ------------------------------------------------- */

/**
 * The Instagram pattern: the whole user level, as a sheet.
 *
 * There is no user-home screen anywhere in the beta shell, and this is why — a screen whose
 * only job is "pick a league" is a level of navigation that a sheet deletes.
 *
 * Switching league RELOADS. Every league-scoped file was already fetched under
 * the loaded league's base (see lib/data.ts), so re-pointing the router without
 * re-booting would render one league's name over another league's figures. The
 * reload cannot loop: it resolves to the requested key, which then matches.
 */
function LeagueSheet({ onClose }: { onClose: () => void }) {
  const { league, leagues } = useLeague();
  return (
    <Sheet label="Switch league" title="Your leagues" onClose={onClose}>
      {leagues.leagues.map(l => {
        const on = l.key === league.key;
        return (
          <SheetRow key={l.key} on={on} mark={on ? "Here" : undefined}
            name={l.name}
            meta={`${l.seasons[0]}–${l.seasons[l.seasons.length - 1]} · ${l.members.length} managers`}
            onClick={() => {
              if (on) { onClose(); return; }
              window.location.hash = `/${l.alias || l.key}/beta`;
              window.location.reload();
            }} />
        );
      })}
      {/* The future door. Cross-league screens (my week everywhere, exposure)
          are parked, and so is the walk-up path that would let a visitor load
          a league this deploy has never built. Both land on this row, so it
          is present and honestly disabled rather than absent — absent is what
          makes a reader assume the product cannot do it. */}
      <SheetRow disabled name="All leagues" meta="Cross-league views — not built yet" />
      <SheetRow disabled name="Add a league by username"
        meta="Needs the in-browser engine — parked" />
    </Sheet>
  );
}

/* ---- route wrappers ------------------------------------------------------ */

/** key={rid} so switching franchise resets the screen's lens and scroll */
function TeamRoute() {
  const rid = useParams().rid;
  return <Team key={rid} />;
}

/** key={pid} — the classic board's Player reuses its component otherwise, and a
 *  shard that 404s leaves the previous player's projection on screen */
function PlayerRoute() {
  const pid = useParams().pid!;
  return <Player key={pid} pid={pid} />;
}

function DraftDetailRoute() {
  const season = useParams().season!;
  return <DraftDetail key={season} />;
}

function SeasonRedirect() {
  const { meta, league } = useLeague();
  return <Navigate replace
    to={`/${leagueSeg(league)}/beta/seasons/${seasonSeg(latestSeasonOf(meta))}`} />;
}

function WeeklyRoute() {
  const { meta, players } = useLeague();
  const p = useParams();
  const seg = p.season;
  const season = seg && meta.seasons.includes(seg) ? seg
    : seg?.toLowerCase() === "all" ? "ALL" : latestSeasonOf(meta);
  const data = useSeasonData(season);
  const int = (s: string | undefined) => {
    if (s == null) return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  if (!data) return <div className="empty">Loading…</div>;
  return <Weekly data={data} season={season} players={players}
    week={int(p.wk)} matchupRid={int(p.mid)}
    playoffs={p.wk?.toLowerCase() === "playoffs"} />;
}
