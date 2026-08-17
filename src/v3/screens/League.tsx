import { useMemo } from "react";
import type {
  Franchises, Matchups, PicksOwned, Team, TradesPayload, Values,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { fmt } from "../../lib/stats";
import { ROUND_ORD } from "../../lib/rosterModel";
import {
  useActivity, useSeasonPhase, useStandings, type Activity, type StandingRow,
} from "../model";
import { Band, IdCell, NUL, Spine, Strip, TapRow, useV3Path, type Figure } from "../ui";

/**
 * LEAGUE — what's going on.
 *
 * Three modules: a figure band, the whole standings table, and the activity
 * feed. No prose summaries anywhere: the classic board's dashboard wrote
 * sentences about the figures beside them, and a sentence is the slowest way to
 * deliver a number to someone standing up on a train.
 *
 * OFFSEASON RE-WEIGHTING. From the last scored week until the first of the next
 * season, "who is winning" has no answer and the screen reorders around the
 * questions that do: draft capital first, then recent trades, then last
 * season's final board. Same modules, seasonal order — which is why the phase
 * is derived from the data (has a week been scored?) rather than from a month
 * boundary, and why the standings module takes the season it renders as a prop
 * instead of assuming the current one.
 */
export default function League() {
  const { meta } = useLeague();
  const v3p = useV3Path();
  const phase = useSeasonPhase();
  const rows = useStandings(phase.loading ? null : phase.resultSeason);
  const acts = useActivity(14);
  const fr = useJson<Franchises>("franchises.json").data;
  const mw = useJson<Matchups>(
    phase.loading ? null : `${phase.resultSeason}/matchups.json`).data;

  /** the season's biggest single-week score, and who put it up */
  const topScore = useMemo(() => {
    if (!mw || !rows) return null;
    const ps = mw.playoff_start || 15;
    let best: { rid: number; wk: number; pts: number } | null = null;
    for (const [rid, list] of Object.entries(mw.teams))
      for (const e of list)
        if (e[0] < ps && (!best || e[1] > best.pts))
          best = { rid: Number(rid), wk: e[0], pts: e[1] };
    if (!best) return null;
    return { ...best, team: rows.find(r => r.rid === best!.rid)?.team ?? "—" };
  }, [mw, rows]);

  const champion = useMemo(() => {
    if (!fr) return null;
    for (const [rid, f] of Object.entries(fr)) {
      const s = f.seasons.find(x => x.season === phase.resultSeason);
      if (s?.finish === 1) return { rid: Number(rid), name: s.name };
    }
    return null;
  }, [fr, phase.resultSeason]);

  // In season: this week's trades. Offseason: every trade of the roster season
  // so far, which is the window a reader is actually asking about — and which
  // has to come from the whole file, not from the truncated activity feed.
  const tradesFile = useJson<TradesPayload>("trades.json").data;
  const tradeCount = useMemo(() => {
    if (!tradesFile) return 0;
    const list = Array.isArray(tradesFile) ? tradesFile : tradesFile.trades;
    return phase.week == null
      ? list.filter(t => t.season === phase.rosterSeason).length
      : list.filter(t => t.season === phase.resultSeason && t.week === phase.week).length;
  }, [tradesFile, phase.week, phase.resultSeason, phase.rosterSeason]);

  const leader = rows?.[0];
  const figures: Figure[] = [
    phase.week != null
      ? { key: "wk", label: "Week", value: phase.week, sub: `${phase.resultSeason} season`,
        to: v3p(`/seasons/${phase.resultSeason}`) }
      : { key: "wk", label: "Offseason", value: phase.rosterSeason,
        sub: `${phase.latest} is the last played season`, to: v3p("/seasons") },
    champion
      ? { key: "ld", label: "Champion", value: "1st", sub: champion.name, acc: true,
        to: v3p(`/team/${champion.rid}`) }
      : leader
        ? { key: "ld", label: "Leader", value: leader.rec, sub: leader.team, acc: true,
          to: v3p(`/team/${leader.rid}`) }
        : { key: "ld", label: "Leader", value: NUL },
    topScore
      ? { key: "hi", label: "Top score", value: fmt(topScore.pts, 1),
        sub: `${topScore.team} · wk ${topScore.wk}`, to: v3p(`/seasons/${phase.resultSeason}`) }
      : { key: "hi", label: "Top score", value: NUL },
    { key: "tr", label: phase.week != null ? "Trades this week" : `Trades ${phase.rosterSeason}`,
      value: tradeCount, sub: "tap to re-price", to: v3p("/trade") },
  ];

  const standings = rows && (
    <Standings rows={rows} season={phase.resultSeason}
      final={phase.offseason} playoffCut={6} />
  );
  const feed = <Feed acts={acts} tradesOnly={phase.offseason} />;
  const capital = <DraftCapital />;

  return (
    <>
      <Strip figures={figures} />
      {phase.offseason
        ? <>{capital}{feed}{standings}</>
        : <>{standings}{feed}</>}
      <div className="tnote screen">
        {phase.offseason
          ? `No week of ${phase.rosterSeason} has been scored, so this screen leads with what
             a franchise holds rather than with how it is doing. Standings below are
             ${phase.latest}'s final board.`
          : `Vs median is the record against each week's league median score — the
             schedule-luck signature. The gold rule marks the playoff cutline.`}
        {" "}Figures refresh nightly · built {meta.updated}.
      </div>
    </>
  );
}

/* ---- standings ---------------------------------------------------------- */

function Standings({ rows, season, final, playoffCut }: {
  rows: StandingRow[]; season: string; final: boolean; playoffCut: number;
}) {
  const v3p = useV3Path();
  return (
    <>
      <Band label={final ? `${season} final` : `Standings · ${season}`}
        note={final ? "Last played season" : "Gold rule is the playoff cutline"} />
      <table className="v3tbl">
        <thead>
          <tr>
            <th className="c sp">#</th>
            <th className="t">Franchise</th>
            <th className="n" style={{ width: "16%" }}>W-L</th>
            <th className="n" style={{ width: "16%" }}>PPG</th>
            <th className="n" style={{ width: "18%" }}>Vs med</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TapRow key={r.rid} to={v3p(`/team/${r.rid}`)}
              className={[
                i % 2 ? "zebra" : "",
                r.rank === playoffCut ? "cut" : "",
                r.rank > playoffCut ? "below" : "",
              ].filter(Boolean).join(" ")}>
              <Spine color={r.rank <= playoffCut ? "var(--acc)" : "var(--rule-2)"}
                rank={r.rank} top={r.rank <= playoffCut} />
              <IdCell name={r.team} sub={r.manager} to={v3p(`/team/${r.rid}`)} />
              <td className="n"><span className="f hd">{r.rec}</span></td>
              <td className="n"><span className="f">{r.played ? fmt(r.ppg, 1) : NUL}</span></td>
              <td className="n"><span className="f q">{r.med ?? NUL}</span></td>
            </TapRow>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ---- activity feed ------------------------------------------------------ */

function Feed({ acts, tradesOnly }: { acts: Activity[] | null; tradesOnly: boolean }) {
  const v3p = useV3Path();
  const shown = (acts ?? []).filter(a => !tradesOnly || a.kind === "trade").slice(0, 10);
  return (
    <>
      <Band label={tradesOnly ? "Recent trades" : "Activity"}
        note={tradesOnly ? "Tap to re-price at today's values" : "Newest first"} />
      <div className="v3-feed">
        {!acts && <div className="empty">Loading…</div>}
        {acts && !shown.length && <div className="empty">Nothing yet.</div>}
        {shown.map(a => a.kind === "trade" ? (
          <a key={`t${a.ts}`} className="v3-act" href={`#${v3p("/trade")}?load=${a.ts}`}
            style={{ display: "block", color: "inherit" }}>
            <div className="when">
              <span>{a.season} · wk {a.week}</span>
              <span>Trade</span>
              <span className="go">Re-price →</span>
            </div>
            {/* Two baskets, both in the same ink. A settled trade is a record,
                not a verdict — colouring a side would declare a winner the
                ledger deliberately refuses to declare. */}
            <div className="v3-baskets">
              {a.sides.map((s, i) => (
                <div className="bk" key={i}>
                  <div className="who">{s.team} gets</div>
                  {s.got.map((g, j) => (
                    <div className={`it${g.pick ? " pick" : ""}`} key={j}>{g.label}</div>
                  ))}
                </div>
              ))}
            </div>
          </a>
        ) : (
          <div className="v3-act" key={`m${a.ts}${a.team}`}>
            <div className="when">
              <span>{a.season} · wk {a.week}</span>
              <span>{a.waiver ? "Waiver" : "Free agent"}</span>
            </div>
            <div className="v3-wv">
              <span className="add"><span className="k">Add</span>{a.adds.join(", ") || "—"}</span>
              <span className="drop"><span className="k">Drop</span>{a.drops.join(", ") || "—"}</span>
            </div>
            <div className="idc-s" style={{ marginTop: 4 }}>{a.team}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---- draft capital (offseason lead module) ------------------------------ */

/**
 * Who holds what, priced. The offseason's version of a standings table: the
 * only board that moves between February and August is the one made of picks.
 */
function DraftCapital() {
  const { league } = useLeague();
  const v3p = useV3Path();
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const teams = useJson<Team[]>(`${league.rosterSeason}/teams.json`).data;

  const rows = useMemo(() => {
    if (!owned || !teams) return null;
    const ktc = new Map(vals?.picks?.ktc ?? []);
    return teams.map(t => {
      const list = owned.owned[String(t.roster_id)] ?? [];
      // every future pick is priced Mid: the slot depends on a finish nobody
      // knows yet. Uniform across all twelve, so the ORDER is honest even where
      // the absolute figure is a placeholder.
      const value = list.reduce((a, p) =>
        a + (ktc.get(`${p.season} Mid ${ROUND_ORD[p.round - 1]}`) ?? 0), 0);
      return {
        rid: t.roster_id, team: t.team, manager: t.manager,
        n: list.length, firsts: list.filter(p => p.round === 1).length, value,
      };
    }).sort((a, b) => b.value - a.value || b.firsts - a.firsts);
  }, [owned, teams, vals]);

  if (!rows) return <><Band label="Draft capital" /><div className="empty">Loading…</div></>;
  return (
    <>
      <Band label="Draft capital"
        note={`Picks owned for ${owned?.meta.seasons.join(" and ")} · every future pick priced at its round's Mid tier`} />
      <table className="v3tbl">
        <thead>
          <tr>
            <th className="c sp">#</th>
            <th className="t">Franchise</th>
            <th className="n" style={{ width: "14%" }}>Picks</th>
            <th className="n" style={{ width: "14%" }}>1sts</th>
            <th className="n" style={{ width: "22%" }}>Market</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TapRow key={r.rid} to={v3p(`/team/${r.rid}`)}
              className={i % 2 ? "zebra" : ""}>
              <Spine color={i === 0 ? "var(--acc)" : "var(--rule-2)"} rank={i + 1} top={i === 0} />
              <IdCell name={r.team} sub={r.manager} to={v3p(`/team/${r.rid}`)} />
              <td className="n"><span className="f">{r.n}</span></td>
              <td className="n"><span className="f q">{r.firsts}</span></td>
              <td className="n"><span className="f hd">{r.value ? r.value.toLocaleString() : NUL}</span></td>
            </TapRow>
          ))}
        </tbody>
      </table>
    </>
  );
}
