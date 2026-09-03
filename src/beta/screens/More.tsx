import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { Drafts, Insights, Team, TradesPayload } from "../../lib/types";
import { MATRIX_CURVES, type MatrixCurve } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { CLASSIC_SEG, leagueSeg, useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { useIdentity } from "../../lib/identity";
import { MODEL_NOTE, splitCurve, STREAM_NOTE, useModel } from "../../lib/model";
import { useIndexModels } from "../../lib/useIndices";
import { useSeasonPhase } from "../model";
import { Band, NUL, useBetaPath } from "../ui";
import { RouteLink } from "../../components/RouteLink";
import "./more.css";

/**
 * MORE — a screen with bands, not a menu.
 *
 * The distinction is the whole design. A menu lists destinations and makes the
 * reader open one to find out whether it was worth opening; this screen states
 * where each destination STANDS, so "Drafts — 2026 recorded" and "Insights —
 * 2026-07-20" answer the question the tap was going to ask. That doubles the
 * screen as the site's status page, which is the only honest place for one on
 * a shell with no footer.
 *
 * THE BANDS ARE ORDERED BY HOW OFTEN A READER OPENS THEM, not by importance:
 *   The season   — what changes weekly. Two rows, both time-sensitive.
 *   The long view — what is already settled, plus how the figures are built.
 *   This board   — the settings, the provenance, and the way back out.
 *
 * There is NO SCOPE CONTROL here and there will not be one. Every other screen
 * in the shell is scoped to a season or a lens; More is scoped to the board
 * itself, and a control that re-scoped it would have nothing to re-scope.
 *
 * The projection-model picker lives HERE, not in a masthead (decision #15). It
 * is a global control, which is exactly why the classic board put it up top —
 * a switch that changes figures on screens where it isn't visible is a trap.
 * On a phone that argument loses to the one about space: a masthead that spends
 * a row on a six-way control has no room left to be a header, and the picker's
 * own state is legible from the row itself whenever anyone goes looking.
 */
/** "blend_composite" -> "Blend · composite". The classic board's picker renders
 *  the two halves as separate segmented groups, which needs width this screen
 *  doesn't have; a row shows the pair as one label. */
const curveLabel = (c: MatrixCurve) => {
  const { model, stream } = splitCurve(c);
  return `${model[0].toUpperCase()}${model.slice(1)} · ${stream}`;
};

/**
 * EVERY FIGURE ON THE BOARD, one paragraph each.
 *
 * Data rather than markup so the row above it can count them: a status figure
 * that says "6 terms" while the list holds seven is exactly the kind of lie
 * this screen exists to prevent. A definition list rather than prose, because a
 * reader who stopped on "CVI" halfway down a table two screens ago is looking
 * up a term, not reading an essay.
 */
const GLOSSARY: { term: string; body: string }[] = [
  {
    term: "WAR",
    body: "Wins above replacement, on this league's own scoring. Each week every "
      + "startable slot in the league is filled by actual points, and a player's margin "
      + "over the best unrostered player at his position becomes a win-probability "
      + "shift at that week's spread of team scores. Regular season only.",
  },
  {
    term: "Projected WAR",
    body: "Three seasons ahead, under the projection model set below. Year 1 is what "
      + "the two indices weigh; the three-year total is what a roster totals.",
  },
  {
    term: "DVI",
    body: "Dynasty Value Index — what a player is worth in a dynasty trade. Half "
      + "market (KeepTradeCut + FantasyCalc), half projected WAR, roster share and "
      + "start share, each clamped into a meaningful range so no one signal decides "
      + "the rating.",
  },
  {
    term: "CVI",
    body: "Contender Value Index — what he is worth for this season alone. Half "
      + "FantasyPros redraft consensus, half the same signals reweighted toward start "
      + "share. It has no age channel; that is DVI's job.",
  },
  {
    term: "Picks",
    body: "Two bridges, blended by sample size: what each slot has actually returned "
      + "across a crawled corpus of superflex leagues, and a monotone fit from market "
      + "value to three-year WAR. A pick has a price and a WAR stream, never an index "
      + "of its own.",
  },
  {
    term: "Market",
    body: "KeepTradeCut and FantasyCalc dynasty superflex values, refreshed nightly "
      + "with everything else on the board.",
  },
];

export default function More() {
  const { meta, league, leagues } = useLeague();
  const betaPath = useBetaPath();
  const ident = useIdentity();
  const phase = useSeasonPhase();
  const model = useModel();
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const [openModel, setOpenModel] = useState(false);
  const [openMeth, setOpenMeth] = useState(false);

  /* THE CLASSIC BOARD'S OWN BASE. Not `useBetaPath` and not a bare "/": these
     three rows leave the shell on purpose, and the league segment has to
     survive the trip or the reader lands on whichever league the registry
     defaults to. `leagueSeg` is the same function the classic router resolves
     against, so the two can't drift. */
  const classic = `/${leagueSeg(league)}/${CLASSIC_SEG}`;

  const mine = teams?.find(t => t.roster_id === ident.rid);

  /* WHERE THE LEAGUE IS. `useSeasonPhase` reads the roster season's matchups
     file, so every one of these is a fact the pipeline states — no scored week
     yet, or a scored week, or a finished regular season — rather than a month
     boundary that approximates it. Once a week is scored the figure is that
     week, which is the one number this row exists for.

     THREE STATES, NOT TWO. The postseason is its own phase and gets its own
     word: the matchups file's week list stops at the regular season, so through
     the playoffs the "week now in progress" expression ran off the end and this
     row republished the last regular week — "Week 14" from December to
     February, which is a wrong number rather than a missing one. */
  const seasonState: ReactNode = phase.loading ? NUL
    : phase.offseason ? "Offseason"
      : phase.playoffs ? "Playoffs"
        : `Week ${phase.week}`;

  /* THE DRAFTS ROW, and why it names a state rather than counting down days.
     The row rides the same signal as the shell's seasonal sixth nav slot
     (`draftPending`): the roster season's rookie draft is either recorded or
     it is not. The committed data cannot carry a countdown — deployed
     `drafts.json` is a per-pick record (season, round, slot, the player taken)
     and Sleeper's draft `start_time` exists only in the raw scrape, which is
     gitignored and never deployed. A day count would have to be invented, so
     the row states the phase and the closing note says the date is absent
     rather than letting a reader assume there isn't one to show. */
  const drafts = useJson<Drafts>("drafts.json").data;
  const draftState = useMemo<ReactNode>(() => {
    if (!drafts) return NUL;
    const recorded = Object.values(drafts)
      .some(picks => picks.some(p => p.season === phase.rosterSeason));
    return recorded
      ? `${phase.rosterSeason} recorded`
      : `${phase.rosterSeason} not yet recorded`;
  }, [drafts, phase.rosterSeason]);

  /* SETTLED SEASONS — the ones that finished, which is every season before the
     one whose rosters are live. The roster season is the boundary in both
     phases: unplayed through the offseason, in progress once it starts,
     settled in neither. A league in its first year gets — rather than
     "0 seasons": no history yet is not a count of nothing. */
  const settled = meta.seasons.filter(s => Number(s) < Number(phase.rosterSeason)).length;

  const insights = useJson<Insights>("insights.json").data;

  /* HOW MANY PLAYERS THE TWO INDICES PRICE. Read from index_models.json rather
     than through `useDvi`/`useCvi`, for two reasons: the app's model provider
     has already fetched that file (so this figure costs no request), and those
     hooks also pull dvi.json and cvi.json as pre-matrix fallbacks, which this
     row does not need. The two counts are equal by construction — one file
     publishes both indices for every player it covers — and that is the truth
     the rows should tell, not a difference invented to make them look
     distinct. */
  const idx = useIndexModels().data;
  const rated: ReactNode = idx ? `${Object.keys(idx.players).length} players` : NUL;

  /* The ledger's own size. trades.json is the Trade screen's file, so a reader
     one tap from the ledger has it warm either way. */
  const trades = useJson<TradesPayload>("trades.json").data;
  const tradeState: ReactNode = !trades ? NUL
    : `${(Array.isArray(trades) ? trades : trades.trades).length} trades`;

  const franchiseState: ReactNode = mine ? mine.team
    : ident.user ? "No match here"
      : "Claim your team";
  const franchiseSub = mine
    ? ident.derived
      ? `Derived from the Sleeper name ${ident.user}`
      : "Claimed on this device — tap to change it"
    : ident.user
      ? `No roster in ${league.name} is managed by ${ident.user}`
      : "Name your franchise and the Team tab points at you";

  return (
    <>
      <div className="v3-head"><h1>More</h1></div>

      <Band label="The season" note="What moves week to week" />
      <div className="v3-more">
        <Row to={betaPath("/seasons")} name="Seasons"
          sub={`${phase.resultSeason} — results, matchups, bracket`}
          state={seasonState} />
        <Row to={betaPath("/drafts")} name="Drafts"
          sub="Every rookie board, scored against what the pick returned"
          state={draftState} />
        {/* THE PLAYERS BOARD, ONE GRAIN UP — same five currencies, same
            controls, a franchise on each row. It lives here rather than in the
            tab bar because the bar holds five and this is a weekly read, not a
            daily one; it lives in THIS band rather than the long view because
            it reprices every night with the market, which is the same cadence
            the two rows above it move on. The figure is the population, which
            is the one fact about it that never changes and therefore the one
            that tells a reader what they are opening. */}
        <Row to={betaPath("/teams")} name="Teams"
          sub="Every roster ranked on DVI, CVI, projected WAR and both market prices"
          state={teams ? `${teams.length} franchises` : NUL} />
      </div>

      <Band label="The long view" note="What the board has already settled" />
      <div className="v3-more">
        <Row to={betaPath("/history")} name="History"
          sub={`Year by year from ${meta.seasons[0]} — champions, finishes, streaks`}
          state={settled ? `${settled} season${settled === 1 ? "" : "s"}` : NUL} />
        <Row to={betaPath("/insights")} name="Insights"
          sub="Per-franchise outlooks, written from the preseason read"
          state={insights?.meta.generated ?? NUL} />
        {/* THE LEDGER MOVED. It is the Trade tab's other half now — the machine
            prices a hypothetical, the ledger prices what actually happened, and
            they are one screen under two scopes. The row stays because More is
            where a reader looks for "every trade ever"; only its address
            changed. */}
        <Row to={betaPath("/trade?scope=history")} name="Transaction ledger"
          sub="Every trade in league history, re-priced at today's values"
          state={tradeState} />
        {/* THE TWO INDEX PAGES STAY ON THE CLASSIC BOARD, and the sub-line says
            so rather than letting the tap surprise anyone. They carry the
            per-player component counts and the full derivation — a phone
            leaderboard has room for the figure and nothing that qualifies it,
            so rebuilding them here would have published a worse version of a
            page that already exists. */}
        <Row to={`${classic}/dvi`} name="DVI methodology"
          sub="Dynasty Value Index — components and derivation, on the classic board"
          state={rated} />
        <Row to={`${classic}/cvi`} name="CVI methodology"
          sub="Contender Value Index — components and derivation, on the classic board"
          state={rated} />
        {/* THE GLOSSARY, opened in place rather than linked somewhere else.
            The two rows above cover DVI and CVI in full; this covers the four
            figures that have no page of their own — WAR, projected WAR, picks
            and market — and gives all six in one paragraph each. The honest
            alternatives were the classic board's method paragraph, which lives
            in `SiteFooter` with no anchor to link to, or a new beta route.
            Both cost more than the answer is long. */}
        <Row onTap={() => setOpenMeth(v => !v)} expanded={openMeth}
          name="The figures, defined"
          sub="WAR, projected WAR, DVI, CVI, picks, market — the short form"
          state={openMeth ? "Close" : `${GLOSSARY.length} terms`} />
        {openMeth && (
          <div className="mox-body">
            {/* Fragments, not wrapper divs: `.v3-meth dt:first-child` is what
                closes the gap above the first term, and a div around each pair
                would make every dt a first child. */}
            <dl className="v3-meth">
              {GLOSSARY.map(g => (
                <Fragment key={g.term}>
                  <dt>{g.term}</dt>
                  <dd>{g.body}</dd>
                </Fragment>
              ))}
            </dl>
            <div className="tnote mnote">
              The short form. Each figure is owned by one script in the nightly
              pipeline, and the full derivation — including where each one breaks
              down — is the repository's METHODOLOGY.md.
            </div>
          </div>
        )}
      </div>

      <Band label="This board" note="Settings, provenance, and the way back" />
      <div className="v3-more">
        {/* The one row on this screen whose figure is gold: it is the only
            setting here that reprices every other screen. */}
        <Row onTap={() => setOpenModel(v => !v)} expanded={openModel}
          name="Projection model"
          sub="Drives DVI, CVI and projected WAR everywhere at once"
          state={model.available ? curveLabel(model.curve) : "default"} acc />
        {openModel && (
          <div className="mox-body">
            {!model.available && (
              <div className="tnote mox-note">
                This deploy's data predates the six-curve matrix, so there is one curve to
                choose from.
              </div>
            )}
            {MATRIX_CURVES.map(c => {
              const { model: m, stream: s } = splitCurve(c);
              const on = c === model.curve;
              return (
                <Row key={c} className={on ? "mox-on" : ""} pressed={on}
                  onTap={() => model.setCurve(c)} disabled={!model.available}
                  title={`${MODEL_NOTE[m]} ${STREAM_NOTE[s]}`}
                  name={curveLabel(c)} state={on ? "In use" : ""} />
              );
            })}
            <div className="tnote mox-note">
              Three models × two streams. The choice rides the URL — so a link you share
              shows the numbers you were reading — and is remembered on this device
              between visits.
            </div>
          </div>
        )}

        {/* IDENTITY IS ONE SURFACE (screens/Claim), not a copy of it here. This
            screen's job is to state what is currently set and hand the reader to
            the place that changes it — two editable copies of the username field
            is how they drift. */}
        <Row to={betaPath("/claim")} name="Your franchise"
          sub={franchiseSub} state={franchiseState} />
        <Row to={betaPath("/claim")} name="Sleeper account"
          sub="Stored on this device — never in a shared link"
          state={ident.user ?? "Not set"} />
        {/* THE SWITCHER IS THE SHELL'S, not this screen's (decision #6: the
            sheet IS the user level, which is what lets a whole user-home screen
            be deleted). A second copy of it here would be a second place to
            change one thing. So the row states how many leagues are loaded,
            says where the control is, and goes to the tab that holds it. */}
        <Row to={betaPath("/league")} name="League"
          sub="Hold the League tab, or tap the name in the header, to switch"
          state={`${leagues.leagues.length} loaded`} />
        {/* Display only: the build stamp is a fact about the data, and there is
            nothing on this device that could change it. */}
        <Row name="Data freshness"
          sub="Rebuilt nightly, 06:00 UTC, from Sleeper and the market feeds"
          state={meta.updated} />
        {/* THE WAY BACK. A plain row, deliberately: this is how a beta reader
            returns to the normal site, and the one destination on the screen
            that must never look like a setting or an experiment. It keeps the
            league segment, so it lands on the same league the reader is in. */}
        <Row to={classic} name="Classic War Board"
          sub="The full-width original — same nightly data, same figures, more of them"
          state="The original board" />
      </div>

      <div className="tnote screen">
        This is the beta shell, a phone-first prototype mounted beside the classic board.
        Both read the same nightly data — nothing here computes a figure the other screen
        would disagree with. The Drafts row names the rookie class rather than counting
        down to it: the nightly pull records picks once they are made and never carries
        the draft's start time, so there is no date on this deploy to count against.
      </div>
    </>
  );
}

/**
 * A STATUS ROW: what it is on the left, where it stands on the right.
 *
 * Three forms, one anatomy. `to` navigates — a real anchor, so a modifier
 * click opens a tab and the keyboard reaches it. `onTap` discloses in place.
 * Neither means the row states a fact nothing can change, which on this screen
 * is data freshness alone; it keeps the row's shape so the column of figures
 * stays a column, and drops the affordances that would promise a destination.
 *
 * `state` is never optional. A row without a status figure is a menu item, and
 * this screen does not have any — where a figure is still loading or the data
 * does not carry one, the caller passes `NUL`, never a zero and never nothing.
 */
function Row({
  to, onTap, expanded, pressed, disabled, title, name, sub, state, acc, className,
}: {
  /** where the row goes. In-app, already league-scoped. */
  to?: string;
  onTap?: () => void;
  /** the disclosure's state, for the row that opens one */
  expanded?: boolean;
  /** a chosen option inside a disclosure */
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
  name: ReactNode;
  /** what the destination IS, in prose. Wraps; it is not a table cell. */
  sub?: ReactNode;
  /** where it stands now — the reason the row is worth a tap, or isn't */
  state: ReactNode;
  /** the screen's one accent. Spent on the projection model's curve. */
  acc?: boolean;
  className?: string;
}) {
  const cls = ["mox-row", to || onTap ? "" : "mox-flat", className]
    .filter(Boolean).join(" ");
  const body = (
    <>
      <span className="mox-nm">
        <span className="mox-n1">{name}</span>
        {sub != null && <span className="mox-n2">{sub}</span>}
      </span>
      <span className={`mox-st${acc ? " mox-acc" : ""}`}>{state}</span>
    </>
  );
  if (to) return <RouteLink to={to} className={cls}>{body}</RouteLink>;
  if (onTap) {
    return (
      <button type="button" className={cls} onClick={onTap} disabled={disabled}
        title={title} aria-expanded={expanded} aria-pressed={pressed}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}
