import { useState } from "react";
import type { Team } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { useIdentity } from "../../lib/identity";
import { MATRIX_CURVES, type MatrixCurve } from "../../lib/types";
import { MODEL_NOTE, splitCurve, STREAM_NOTE, useModel } from "../../lib/model";
import { useSeasonPhase } from "../model";
import { Band, useV3Path } from "../ui";
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
  const v3p = useV3Path();
  const phase = useSeasonPhase();
  const ident = useIdentity();
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const model = useModel();
  const [openModel, setOpenModel] = useState(false);

  const mine = teams?.find(t => t.roster_id === ident.rid);

  return (
    <>
      <div className="v3-head"><h1>More</h1></div>

      <Band label="Explore" note="Opens the full board" />
      <div className="v3-more">
        <Row to={v3p("/drafts")} name="Drafts"
          state={phase.offseason ? `${phase.rosterSeason} class drafted` : "By slot and tier"} />
        <Row to={v3p(`/seasons/${phase.resultSeason}`)} name="Seasons"
          state={`${phase.latest} · results, matchups, bracket`} />
        <Row to={v3p("/history")} name="League history"
          state={`${meta.seasons[0]}–${meta.seasons[meta.seasons.length - 1]}`} />
        <Row to={v3p("/insights")} name="Insights" state="Per-franchise outlooks" />
        <Row to={v3p("/ledger")} name="Transaction ledger" state="Every trade, scored" />
      </div>

      <Band label="The model" note="What the figures on every screen are built from" />
      <div className="v3-more">
        <button className="mrow" onClick={() => setOpenModel(v => !v)}>
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
        <Row to={v3p("/history")} name="Methodology" state="WAR, DVI, CVI" />
        <Row name="Data freshness" state={`Built ${meta.updated}`} />
      </div>

      {/* Identity is ONE surface (screens/Claim), not a copy of it here. This
          screen's job is to state what is currently set and hand the reader to
          the place that changes it — two editable copies of the username field
          is how they drift. */}
      <Band label="You" note="Stored on this device — never in a shared link" />
      <div className="v3-more">
        <Row to={v3p("/claim")} name="Sleeper account"
          state={ident.user
            ? `${ident.user} · ${leagues.leagues.length} league loaded`
            : "Not set"} />
        <Row to={v3p("/claim")} name="Your franchise"
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
        This is v3, a phone-first prototype mounted beside the classic board. Both read the
        same nightly data — nothing here computes a figure the other screen would disagree
        with.
      </div>
    </>
  );
}

function Row({ to, name, state }: { to?: string; name: string; state: string }) {
  const body = (<><span className="nm">{name}</span><span className="st">{state}</span></>);
  return to
    ? <RouteLink to={to} className="mrow">{body}</RouteLink>
    : <div className="mrow" style={{ cursor: "default" }}>{body}</div>;
}
