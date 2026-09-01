import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams,
} from "react-router-dom";
import type { Drafts, Team as TeamT } from "../lib/types";
import { useJson } from "../lib/useJson";
import { leagueSeg, useLeague, useLeaguePath } from "../lib/context";
import { IdentityContext, useIdentityState } from "../lib/identity";
import { latestSeasonOf, rosterSeasonOf, seasonSeg } from "../lib/league";
import { useSeasonData } from "../lib/useSeasonData";
import ErrorBoundary from "../components/ErrorBoundary";
import QuickJump from "../components/QuickJump";
import { RetryScope, Sheet, SheetRow, useBetaPath } from "./ui";
import League from "./screens/League";
import Team from "./screens/Team";
import Claim from "./screens/Claim";
import Players from "./screens/Players";
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

/**
 * The five destinations, in thumb order. Draft is a SEASONAL sixth — see
 * `draftPending` below.
 *
 * My Team leads: the reader is a manager before he is a spectator, and the
 * question a phone gets asked most is about his own roster. League holds an
 * explicit `league` segment rather than riding the index, which is what frees
 * the index to answer "who is reading" instead — see the redirect below.
 */
const TABS = [
  { id: "team", label: "My Team" },
  { id: "league", label: "League" },
  { id: "players", label: "Players" },
  { id: "trade", label: "Trade" },
  { id: "more", label: "More" },
];

/** Which tab owns a destination that isn't itself a tab, so the bar always
 *  answers "where am I". The ledger is deliberately absent: it is no longer a
 *  destination but a scope of Trade, and its route redirects there. */
const HUB_OF: Record<string, string> = {
  player: "players", claim: "team", drafts: "more", seasons: "more",
  history: "more", insights: "more",
};

/**
 * THE SHELL, wrapped in the one thing above it: a retry key.
 *
 * `useJson` re-fetches on a path change and at no other time, so nothing inside
 * can re-run its own failed fetch. `RetryScope` remounts this whole subtree
 * instead — `lib/data.ts` evicts rejected promises, so the remount issues real
 * second requests — and every `DataError` on every screen drives it. It has to
 * sit OUTSIDE the board because the board's own `teams.json` (identity, the
 * Team tab, More) is one of the fetches that can drop.
 */
export default function BetaShell() {
  return <RetryScope><BetaBoard /></RetryScope>;
}

function BetaBoard() {
  const { meta, league } = useLeague();
  const loc = useLocation();
  const nav = useNavigate();
  const navType = useNavigationType();
  const rosterSeason = rosterSeasonOf(league);

  // The rosters, hoisted: identity derives from them (a manager name IS a
  // Sleeper username), and both the Team screen and More want the same array.
  const teamsQ = useJson<TeamT[]>(`${rosterSeason}/teams.json`);
  const teams = teamsQ.data;
  const identity = useIdentityState(league.key || "default", teams);

  const base = `/${leagueSeg(league)}/beta`;
  // the segment after /beta — "" only on the index, which is a redirect
  const seg = loc.pathname.startsWith(base)
    ? loc.pathname.slice(base.length).split("/").filter(Boolean)[0] ?? ""
    : "";

  /* ---- the index is a REDIRECT, not a screen ----------------------------
     A reader who has claimed a franchise opens on his own roster; one who has
     not opens on the league, because a My Team tab with nothing to point at is
     a claim prompt wearing a screen's clothes.

     The claim derives from teams.json (lib/identity), so while a username is
     set and that file has not landed the answer is not yet KNOWN — deciding
     then sends a claimed reader to League and, because the redirect replaces,
     leaves him there with no back step to undo it. One paint of the loading
     line is the honest version. A manual claim needs no file and resolves
     immediately, which is why the wait is conditioned on the derivation.

     A FAILED FETCH IS AN ANSWER, not a longer wait. Without the error term this
     waits on a file that is never coming and the index route paints "Loading…"
     for the life of the page — a dead end with no screen, no bar affordance and
     nothing to retry. Unresolved is unresolved: the redirect runs, lands on
     League, and League states the failure with a Try again of its own. */
  const identityPending =
    identity.user != null && identity.rid == null && !teams && !teamsQ.error;
  const indexTo = `${base}/${identity.rid != null ? "team" : "league"}`;

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

  /* ---- which tab is lit --------------------------------------------------
     WHILE THE SIXTH TAB IS UP, DRAFTS IS A TAB. `HUB_OF` maps drafts -> more,
     which is right for the eleven months a year the Draft tab is not there and
     wrong for the weeks it is: on /drafts the bar lit both "Draft" (the tab
     itself) and "More" (its hub), which is two answers to "where am I". So the
     tab list is consulted BEFORE the hub table, and the tab list is the one
     that grew a sixth entry. */
  const active = tabs.some(t => t.id === seg) ? seg : HUB_OF[seg] ?? "";

  const [sheet, setSheet] = useState(false);
  /* The masthead has two states, and this is the second one: searching. Held
     here rather than inside MastSearch because it is the WHOLE bar that changes
     — the league name and the tag step aside for the field — and a component
     cannot restyle its own siblings. */
  const [finding, setFinding] = useState(false);
  // a screen change closes the field, for the same reason it un-hides the bar
  useEffect(() => { setFinding(false); }, [loc.pathname]);
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

  const onLeague = active === "league";

  return (
    <IdentityContext.Provider value={identity}>
      <div className="v3">
        <header className={`v3-mast${finding ? " finding" : ""}`}>
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
          <MastSearch open={finding} onToggle={setFinding} />
        </header>

        {/* Every screen below a tab needs an on-screen way back: an iOS web clip
            has no browser chrome at all. The player page is the exception — it
            carries its own ← Back in the split rail, and two of them on one
            screen is a question about which one is real. */}
        {!tabs.some(t => t.id === seg) && seg !== "" && seg !== "player" && (
          <a className="v3-back" href={`#${base}${active ? `/${active}` : ""}`}
            onClick={e => { e.preventDefault(); nav(-1); }}>← Back</a>
        )}

        <main>
          <ErrorBoundary resetKey={loc.pathname}>
            <Suspense fallback={<div className="empty">Loading…</div>}>
              <Routes>
                <Route index element={identityPending
                  ? <div className="empty">Loading…</div>
                  : <Navigate replace to={indexTo} />} />
                <Route path="league" element={<League />} />
                <Route path="team" element={<Team />} />
                <Route path="team/:rid" element={<TeamRoute />} />
                <Route path="claim" element={<Claim />} />
                <Route path="players" element={<Players />} />
                {/* the leaderboard's old address, and the lens segment it
                    carried. Players is one board with its own controls now, so
                    the scope has nowhere to land and is dropped rather than
                    translated into a filter it no longer has. */}
                <Route path="rankings" element={<Navigate replace to={`${base}/players`} />} />
                <Route path="rankings/:scope" element={<Navigate replace to={`${base}/players`} />} />
                <Route path="trade" element={<Trade />} />
                {/* THE LEDGER IS A SCOPE, NOT A SCREEN. Trade's History scope
                    is the settled-trades record the ledger page was, so the old
                    address lands on it with that scope already set rather than
                    on a Trade screen showing an empty machine. */}
                <Route path="ledger" element={<Navigate replace to={`${base}/trade?scope=history`} />} />
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
                <Route path="*" element={<Navigate to={base} replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>

        <nav className={`v3-nav${barAway ? " away" : ""}`} aria-label="Sections">
          <div className="railtop">{meta.league}<b>War Board Beta</b></div>
          {tabs.map(t => {
            const to = `${base}/${t.id}`;
            const on = active === t.id;
            return (
              <a key={t.id} href={`#${to}`} className={on ? "on" : ""}
                onClick={e => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  cancelHold();
                  if (held.current) { held.current = false; return; }
                  nav(to);
                }}
                onPointerDown={t.id === "league" ? startHold : undefined}
                onPointerUp={cancelHold} onPointerLeave={cancelHold}
                onPointerCancel={cancelHold} onPointerMove={moveHold}
                onContextMenu={t.id === "league" ? e => e.preventDefault() : undefined}>
                {t.label}
                {"dot" in t && t.dot && <span className="dot" />}
              </a>
            );
          })}
          {/* On desktop the rail exposes More's contents rather than making a
              mouse open a menu. Hidden on a phone by beta.css. */}
          <div className="railgrp desk">Explore</div>
          {[
            { id: "drafts", label: "Drafts", to: `${base}/drafts` },
            { id: "seasons", label: "Seasons", to: `${base}/seasons` },
            { id: "history", label: "History", to: `${base}/history` },
            { id: "insights", label: "Insights", to: `${base}/insights` },
            /* Ledger keeps its place in Explore and loses its page: it points
               at Trade's History scope, the same address the `ledger` route
               redirects to. It never lights, because the Trade tab above it
               does — two lit rows would be two answers to "where am I". */
            { id: "ledger", label: "Ledger", to: `${base}/trade?scope=history` },
          ].map(x => (
            <a key={x.id} className={`sub desk${seg === x.id ? " on" : ""}`}
              href={`#${x.to}`}
              onClick={e => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault(); nav(x.to);
              }}>{x.label}</a>
          ))}
        </nav>

        {sheet && <LeagueSheet onClose={() => setSheet(false)} />}
      </div>
    </IdentityContext.Provider>
  );
}

/* ---- the masthead's typeahead -------------------------------------------- */

/**
 * QUICKJUMP, PHONE-SHAPED.
 *
 * The typeahead is components/QuickJump — the classic board's, mounted rather
 * than reimplemented, so a name resolves identically on both shells and there is
 * one list to fix when it is wrong.
 *
 * What it cannot be here is resident. Its field asks for 170px and this masthead
 * is 42px tall carrying a league name and a tag, so on a phone the field is
 * REVEALED: the Search button swaps the bar's contents for the field and Close
 * swaps them back (the name and tag are hidden by beta.css off the `.finding`
 * class, since a component cannot restyle its siblings). At the desktop rail's
 * width the button is hidden and the field is simply there — the same component
 * either way, so the shell never has two search boxes.
 *
 * The control is the WORD "Search", not a magnifier. The board has no icon
 * library and is not getting one for this, and the ⌕ glyph that would avoid one
 * is missing from most of the stack's faces — a tofu box is worse than a label.
 */
function MastSearch({ open, onToggle }: {
  open: boolean; onToggle: (v: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // QuickJump owns its field, so the reveal focuses it through the DOM rather
  // than through an API it does not have. Revealing a field the reader then
  // has to tap is half a control.
  useEffect(() => {
    if (open) box.current?.querySelector("input")?.focus();
  }, [open]);
  // QuickJump builds the classic board's addresses; rebasing them here is what
  // keeps a jump inside this shell. Franchise pages live at team/:rid in it.
  const bp = useBetaPath();
  const lp = useLeaguePath();
  const path = useCallback((p: string) => {
    const fkey = /^\/franchise\/([^/]+)$/.exec(p)?.[1];
    /* A FRANCHISE KEY IS NOT ALWAYS A ROSTER ID. It is the roster_id in a
       dynasty league and the owner's Sleeper user_id in a redraft or keeper one
       (build_site_data.py: an inherited roster slot is a new franchise). This
       shell's Team screen looks a franchise up strictly by roster_id, so
       rebasing an 18-digit user_id onto /team/<id> landed every redraft team
       hit on "No franchise …". Those keep the classic franchise page, which
       knows how to read either shape — leaving the shell is the honest
       outcome when the shell has no such screen. */
    if (fkey != null && !/^\d{1,3}$/.test(fkey)) return lp(p);
    return bp(fkey != null ? `/team/${fkey}` : p);
  }, [bp, lp]);
  return (
    // Escape bubbles up from the input (QuickJump closes its list and lets the
    // event through), so one press closes the list and the field together.
    <div className={`v3-find${open ? " open" : ""}`}
      onKeyDown={e => { if (e.key === "Escape") onToggle(false); }}>
      <div className="findbox" ref={box}><QuickJump path={path} /></div>
      <button type="button" className="findbtn"
        aria-expanded={open} aria-label={open ? "Close search" : "Search"}
        onClick={() => onToggle(!open)}>{open ? "Close" : "Search"}</button>
    </div>
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
