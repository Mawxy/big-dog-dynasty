import { Navigate, useParams } from "react-router-dom";
import type { Team, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import {
  DynTable, dynNote, GapTable, MarketTable, marketNote, useDynMovers, useGapRows, useMarketMovers,
} from "../movers";
import { Band, DataError, useBetaPath } from "../ui";
import "./league.css";

/**
 * MOVERS — the whole of a module League shows five of (Max, 2026-09-08).
 *
 * Three kinds, one screen, addressed by path: `/movers/value` (win now vs
 * dynasty), `/movers/dynasty` (the cross-league over/underpay board) and
 * `/movers/market` (KeepTradeCut's seven-day change). Each is the SAME table
 * League renders, with no `limit`, so the five a reader tapped through from
 * are the first five here and the list simply keeps going. There is no scope
 * control: these read the current market and the current rosters, and a
 * historical version of "who moved this week" is not a thing this board has.
 *
 * The League band's own note is restated under the title so the figures are
 * qualified here too — a reader who arrived from More never saw the band.
 */
const KINDS = {
  value: { title: "Win now vs dynasty", note: "CVI prices this season, DVI the horizon" },
  dynasty: { title: "Dynasty movers", note: null },
  market: { title: "Market movers", note: null },
} as const;
type Kind = keyof typeof KINDS;

export default function Movers() {
  const kind = useParams().kind as string | undefined;
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const rosterSeason = rosterSeasonOf(league);

  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);
  const valsQ = useJson<Values>("data/values.json", "globalDaily");
  const dyn = useDynMovers();
  const gap = useGapRows(teamsQ.data);
  const movers = useMarketMovers(valsQ.data);

  if (!kind || !(kind in KINDS)) return <Navigate replace to={betaPath("/more")} />;
  const k = kind as Kind;
  const note = k === "value" ? KINDS.value.note
    : k === "dynasty" ? dynNote(dyn) : marketNote(movers);

  return (
    <>
      <div className="v3-head"><h1>{KINDS[k].title}</h1></div>
      <Band label={k === "value" ? "Rostered players" : k === "dynasty" ? "Across leagues" : "KeepTradeCut"}
        note={note} />
      {k === "value" && (
        teamsQ.error ? <DataError what="Rosters didn't load" />
          : !gap ? <div className="empty">Loading…</div>
          : <GapTable rows={gap} />
      )}
      {k === "dynasty" && (
        !dyn ? <div className="empty">Waiting on the trade-corpus refresh…</div>
          : <DynTable dyn={dyn} />
      )}
      {k === "market" && (
        valsQ.error ? <DataError what="Market didn't load" />
          : !movers ? <div className="empty">Waiting on the nightly market pull…</div>
          : <MarketTable movers={movers} />
      )}
      <div className="tnote screen">
        {k === "value"
          ? `Gap is CVI minus DVI, in index points. Win now needs a CVI rank inside the top ${100}; dynasty needs a DVI rank inside it and a redraft ECR rank.`
          : k === "dynasty"
            ? "Δ is what centerpiece trades across the corpus paid against the blended market value. Positive means the market is paying over."
            : "7d is the seven-day change in KeepTradeCut points, in this league's TE-premium column. Zero-change players are left out."}
      </div>
    </>
  );
}
