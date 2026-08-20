import { useMemo, useState, type ReactNode } from "react";
import type { Drafts, Team } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { useIdentity } from "../../lib/identity";
import { MATRIX_CURVES, type MatrixCurve } from "../../lib/types";
import { MODEL_NOTE, splitCurve, STREAM_NOTE, useModel } from "../../lib/model";
import { useSeasonPhase } from "../model";
import { Band, NUL, useBetaPath } from "../ui";
import { RouteLink } from "../../components/RouteLink";

/**
 * MORE — everything else.
 *
 * Rows display their own current state, which is the point: this doubles as the
 * site's status page. "Projection model — Blend · composite" answers the
 * question the row exists to change, so a reader who only wanted to check what
 * the board is being priced under never has to open anything.
 *
 * The projection-model picker lives HERE, not in a masthead (decision #15). It
 * is a global control, which is exactly why the classic board put it up top —
 * a switch that changes figures on screens where it isn't visible is a trap.
 * On a phone that argument loses to the one about space: a masthead that spends
 * a row on a six-way control has no room left to be a header, and the picker's
 * own state is legible from the row below whenever anyone goes looking.
 */
/** "blend_composite" -> "Blend · composite". The classic board's picker renders
 *  the two halves as separate segmented groups, which needs width this screen
 *  doesn't have; a row shows the pair as one label. */
const curveLabel = (c: MatrixCurve) => {
  const { model, stream } = splitCurve(c);
  return `${model[0].toUpperCase()}${model.slice(1)} · ${stream}`;
};

export default function More() {
  const { meta, league, leagues } = useLeague();
  const betaPath = useBetaPath();
  const phase = useSeasonPhase();
  const ident = useIdentity();
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const model = useModel();
  const [openModel, setOpenModel] = useState(false);
  const [openMeth, setOpenMeth] = useState(false);

  const mine = teams?.find(t => t.roster_id === ident.rid);

  /* THE DRAFTS ROW'S COUNTDOWN — and why it counts a class rather than days.
     Decision 7 asks this row to carry a countdown, because it is the same
     signal the seasonal sixth nav slot rides on (BetaShell's `draftPending`).
     The committed data cannot carry one: deployed `drafts.json` is a per-pick
     record — season, round, slot, the player taken — and Sleeper's draft
     `start_time` exists only in the raw scrape, which is gitignored and never
     deployed. A day count would have to be invented, so the row states the
     phase the same way the nav slot derives it, and the footnote says the date
     is absent rather than letting a reader assume there isn't one to show. */
  const drafts = useJson<Drafts>("drafts.json").data;
  const draftState = useMemo<ReactNode>(() => {
    if (!drafts) return NUL;
    const drafted = Object.values(drafts)
      .some(picks => picks.some(p => p.season === phase.rosterSeason));
    // kept short deliberately: `.mrow .st` is a single nowrap line capped at
    // 48% of the row, so a longer state ellipsises away the half that matters
    return drafted
      ? `${phase.rosterSeason} drafted · ${Number(phase.rosterSeason) + 1} next`
      : `${phase.rosterSeason} not yet drafted`;
  }, [drafts, phase.rosterSeason]);

  return (
    <>
      <div className="v3-head"><h1>More</h1></div>

      <Band label="Explore" note="Opens the full board" />
      <div className="v3-more">
        <Row to={betaPath("/drafts")} name="Drafts" state={draftState} />
        <Row to={betaPath(`/seasons/${phase.resultSeason}`)} name="Seasons"
          state={`${phase.latest} · results, matchups, bracket`} />
        <Row to={betaPath("/history")} name="League history"
          state={`${meta.seasons[0]}–${meta.seasons[meta.seasons.length - 1]}`} />
        <Row to={betaPath("/insights")} name="Insights" state="Per-franchise outlooks" />
        <Row to={betaPath("/ledger")} name="Transaction ledger" state="Every trade, scored" />
      </div>

      <Band label="The model" note="What the figures on every screen are built from" />
      <div className="v3-more">
        <button className="mrow" onClick={() => setOpenModel(v => !v)} aria-expanded={openModel}>
          <span className="nm">Projection model</span>
          <span className="st acc">
            {model.available ? curveLabel(model.curve) : "default"}
          </span>
        </button>
        {openModel && (
          <div style={{ padding: "4px 0 8px" }}>
            {!model.available && (
              <div className="tnote" style={{ padding: "0 var(--v3pad) 8px" }}>
                This deploy's data predates the six-curve matrix, so there is one curve to
                choose from.
              </div>
            )}
            {MATRIX_CURVES.map(c => {
              const { model: m, stream: s } = splitCurve(c);
              return (
                <button key={c} className="mrow" onClick={() => model.setCurve(c)}
                  disabled={!model.available} title={`${MODEL_NOTE[m]} ${STREAM_NOTE[s]}`}>
                  <span className="nm" style={{ paddingLeft: 14, fontWeight: c === model.curve ? 700 : 400 }}>
                    {curveLabel(c)}
                  </span>
                  <span className="st">{c === model.curve ? "in use" : ""}</span>
                </button>
              );
            })}
            <div className="tnote" style={{ padding: "6px var(--v3pad) 10px" }}>
              Three models × two streams. The choice drives DVI, CVI and projected WAR
              everywhere at once, and rides the URL — so a link you share shows the numbers
              you were reading.
            </div>
          </div>
        )}
        {/* METHODOLOGY, in place, rather than a link to somewhere else.
            It used to point at `/history`, which is the league-history view and
            has nothing to say about how a figure is built. There are two honest
            destinations: the classic board's method paragraph, which lives in
            `SiteFooter` with no anchor to link to and no route of its own, or a
            beta page, which needs a route in `BetaShell`. Both cost more than the
            answer is long — every figure on the board is one sentence — so the
            row opens the answer where the reader already is, the same accordion
            shape as the projection picker above it. */}
        <button className="mrow" onClick={() => setOpenMeth(v => !v)} aria-expanded={openMeth}>
          <span className="nm">Methodology</span>
          <span className="st">{openMeth ? "Close" : "WAR · DVI · CVI · picks"}</span>
        </button>
        {openMeth && (
          <>
            <dl className="v3-meth">
              <dt>WAR</dt>
              <dd>
                Wins above replacement, on this league's own scoring. Each week every
                startable slot in the league is filled by actual points, and a player's
                margin over the best unrostered player at his position becomes a
                win-probability shift at that week's spread of team scores. Regular
                season only.
              </dd>
              <dt>Projected WAR</dt>
              <dd>
                Three seasons ahead, under the projection model set above. Year 1 is
                what the two indices weigh; the three-year total is what a roster totals.
              </dd>
              <dt>DVI</dt>
              <dd>
                Dynasty Value Index — what a player is worth in a dynasty trade.
                Half market (KeepTradeCut + FantasyCalc), half projected WAR, roster
                share and start share, each clamped into a meaningful range so no one
                signal decides the rating.
              </dd>
              <dt>CVI</dt>
              <dd>
                Contender Value Index — what he is worth for this season alone. Half
                FantasyPros redraft consensus, half the same signals reweighted toward
                start share. It has no age channel; that is DVI's job.
              </dd>
              <dt>Picks</dt>
              <dd>
                Two bridges, blended by sample size: what each slot has actually
                returned across a crawled corpus of superflex leagues, and a monotone
                fit from market value to three-year WAR. A pick has a price and a WAR
                stream, never an index of its own.
              </dd>
              <dt>Market</dt>
              <dd>
                KeepTradeCut and FantasyCalc dynasty superflex values, refreshed
                nightly with everything else on the board.
              </dd>
            </dl>
            <div className="tnote mnote">
              The short form. Each figure is owned by one script in the nightly
              pipeline, and the full derivation — including where each one breaks
              down — is the repository's METHODOLOGY.md.
            </div>
          </>
        )}
        <Row name="Data freshness" state={`Built ${meta.updated}`} />
      </div>

      {/* Identity is ONE surface (screens/Claim), not a copy of it here. This
          screen's job is to state what is currently set and hand the reader to
          the place that changes it — two editable copies of the username field
          is how they drift. */}
      <Band label="You" note="Stored on this device — never in a shared link" />
      <div className="v3-more">
        <Row to={betaPath("/claim")} name="Sleeper account"
          state={ident.user
            ? `${ident.user} · ${leagues.leagues.length} league loaded`
            : "Not set"} />
        <Row to={betaPath("/claim")} name="Your franchise"
          state={mine
            ? `${mine.team} · ${ident.derived ? "derived" : "claimed"}`
            : ident.user ? `no match in ${league.name}` : "Not set"} />
      </div>

      <div className="v3-more">
        <a className="mrow" href={`#/${league.alias || league.key}`}>
          <span className="nm">Classic board</span>
          <span className="st">The wide-screen version</span>
        </a>
      </div>
      <div className="tnote screen">
        This is the beta shell, a phone-first prototype mounted beside the classic board. Both read the
        same nightly data — nothing here computes a figure the other screen would disagree
        with. The Drafts row names the rookie class rather than counting down to it: the
        nightly pull records picks once they are made and never carries the draft's start
        time, so there is no date on this deploy to count against.
      </div>
    </>
  );
}

function Row({ to, name, state }: { to?: string; name: string; state: ReactNode }) {
  const body = (<><span className="nm">{name}</span><span className="st">{state}</span></>);
  return to
    ? <RouteLink to={to} className="mrow">{body}</RouteLink>
    : <div className="mrow" style={{ cursor: "default" }}>{body}</div>;
}
