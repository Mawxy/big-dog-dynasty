import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { Team, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import {
  DynTable, dynNote, GapTable, MARKET_WINDOWS, MarketTable, marketNote, SOURCE_NAME,
  useDynMovers, useGapRows, useMarketMovers, type MarketSource, type MarketWindow,
} from "../movers";
import { Band, DataError, LensStrip, useBetaPath } from "../ui";
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
  value: { title: "Win now vs dynasty", note: "CVI prices this season, DVI the horizon",
    halves: ["Win now", "Dynasty"] },
  dynasty: { title: "Dynasty movers", note: null, halves: ["Over value", "Under value"] },
  market: { title: "Market movers", note: null, halves: ["Risers", "Fallers"] },
} as const;
type Kind = keyof typeof KINDS;

export default function Movers() {
  const kind = useParams().kind as string | undefined;
  /* ONE HALF AT A TIME (Max, 2026-09-08). Each module is two lists, and on
     League they stack; here the second would start a screen or two down.
     A lens strip picks the half, the way Players picks a lens — same
     control, same accent budget: it is the one filled control on the screen. */
  const [half, setHalf] = useState<"a" | "b">("a");
  /* MARKET ONLY: which feed and how long a window (Max, 2026-09-08). Chips,
     not a second lens strip — a screen gets one filled control, and these
     narrow what the one table shows rather than swapping its columns. */
  const [source, setSource] = useState<MarketSource>("ktc");
  const [window, setWindow] = useState<MarketWindow>(7);
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const rosterSeason = rosterSeasonOf(league);

  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);
  const valsQ = useJson<Values>("data/values.json", "globalDaily");
  const dyn = useDynMovers();
  const gap = useGapRows(teamsQ.data);
  const movers = useMarketMovers(valsQ.data, source, window);

  if (!kind || !(kind in KINDS)) return <Navigate replace to={betaPath("/more")} />;
  const k = kind as Kind;
  const note = k === "value" ? KINDS.value.note
    : k === "dynasty" ? dynNote(dyn) : marketNote(movers);

  return (
    <>
      <div className="v3-head"><h1>{KINDS[k].title}</h1></div>
      <LensStrip label="Half" value={half} onChange={setHalf}
        options={[{ id: "a", label: KINDS[k].halves[0] }, { id: "b", label: KINDS[k].halves[1] }]} />
      {k === "market" && (
        <div className="v3-filters" role="group" aria-label="Market and window">
          {(["ktc", "fc"] as const).map(src => (
            <button key={src} type="button" className={`chip${source === src ? " on" : ""}`}
              aria-pressed={source === src} onClick={() => setSource(src)}>
              {src === "ktc" ? "KTC" : "FantasyCalc"}
            </button>
          ))}
          <span className="mvx-gap" aria-hidden="true" />
          {MARKET_WINDOWS.map(w => (
            <button key={w} type="button" className={`chip${window === w ? " on" : ""}`}
              aria-pressed={window === w} onClick={() => setWindow(w)}>{w}d</button>
          ))}
        </div>
      )}
      <Band label={k === "value" ? "Rostered players" : k === "dynasty" ? "Across leagues" : SOURCE_NAME[source]}
        note={note} />
      {k === "value" && (
        teamsQ.error ? <DataError what="Rosters didn't load" />
          : !gap ? <div className="empty">Loading…</div>
          : <GapTable rows={gap} half={half} />
      )}
      {k === "dynasty" && (
        !dyn ? <div className="empty">Waiting on the trade-corpus refresh…</div>
          : <DynTable dyn={dyn} half={half} />
      )}
      {k === "market" && (
        valsQ.error ? <DataError what="Market didn't load" />
          : !movers ? <div className="empty">Waiting on the nightly market pull…</div>
          : <MarketTable movers={movers} half={half} />
      )}
      <div className="tnote screen">
        {k === "value"
          ? `Gap is CVI minus DVI, in index points. Win now needs a CVI rank inside the top ${100}; dynasty needs a DVI rank inside it and a redraft ECR rank.`
          : k === "dynasty"
            ? "Δ is what centerpiece trades across the corpus paid against the blended market value. Positive means the market is paying over."
            : `${window}d is the ${window}-day change in ${SOURCE_NAME[source]} points${source === "ktc" ? ", in this league's TE-premium column" : ""}, measured off the board's own daily snapshots. Zero-change players are left out.`}
      </div>
    </>
  );
}
