import type { ReactNode } from "react";
import type { Team, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { RouteLink } from "../../components/RouteLink";
import { dynNote, marketNote, useDynMovers, useGapRows, useMarketMovers } from "../movers";
import { Band, NUL, useBetaPath } from "../ui";
import "./more.css";

/**
 * TRENDS — the hub for the three mover modules (Max, 2026-09-08).
 *
 * League shows five of each; this screen is the other way in. It sits in
 * the rail's Explore group beside Drafts and Seasons, and on a phone under
 * More. Like More it is a screen with rows that STATE something — the
 * population and the freshness — rather than a menu that makes a reader open
 * a page to find out whether it was worth opening. Each row opens the full
 * list on Movers, where a lens strip picks the half.
 */
export default function Trends() {
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const gap = useGapRows(teams);
  const dyn = useDynMovers();
  const movers = useMarketMovers(vals);
  const n = (a?: number, b?: number) => (a == null || b == null ? NUL : `${a + b} players`);

  return (
    <>
      <div className="v3-head"><h1>Trends</h1></div>
      <Band label="Who is moving" note="Repriced nightly with the market" />
      <div className="v3-more">
        <Row to={betaPath("/movers/value")} name="Win now vs dynasty"
          sub="Rostered players where CVI and DVI disagree most — contender assets one way, stashes the other"
          state={n(gap?.now.length, gap?.later.length)} />
        <Row to={betaPath("/movers/dynasty")} name="Dynasty movers"
          sub={`Who the wider dynasty market is paying over and under value for${dynNote(dyn) ? ` · ${dynNote(dyn)}` : ""}`}
          state={n(dyn?.overpaid.length, dyn?.underpaid.length)} />
        <Row to={betaPath("/movers/market")} name="Market movers"
          sub={`${marketNote(movers)} — risers and fallers`}
          state={n(movers?.up.length, movers?.down.length)} />
      </div>
      <div className="tnote screen">
        The League tab shows the top five of each. These are the whole lists.
      </div>
    </>
  );
}

/** More's row, restated: a name, what the destination is, where it stands. */
function Row({ to, name, sub, state }: {
  to: string; name: string; sub: string; state: ReactNode;
}) {
  return (
    <RouteLink to={to} className="mox-row">
      <span className="mox-nm">
        <span className="mox-n1">{name}</span>
        <span className="mox-n2">{sub}</span>
      </span>
      <span className="mox-st">{state}</span>
    </RouteLink>
  );
}
