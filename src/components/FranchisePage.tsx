import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  CviFile, DraftPick, Drafts, DviFile, Franchise, Franchises, Insights,
  PlayersMin, ProjectionsFile, SleeperProjFile, Team, Trade, TradesPayload,
} from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { fmt, sgn, clsOf, ord } from "../lib/stats";
import { DEFAULT_LINEUP, optimalLineup, pInfo, SLOT_LABEL } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { readTrades, tradeWhen } from "../lib/trades";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";
import QuickJump from "./QuickJump";
import TeamStrengths from "./TeamStrengths";

const POS_ORDER = ["QB", "RB", "WR", "TE"];
const posIdx = (p: string) => { const i = POS_ORDER.indexOf(p); return i < 0 ? POS_ORDER.length : i; };

interface RosterRow {
  id: string; nm: string; pos: string; nfl: string;
  age: number | null; ppg: number | null;
  dvi: number | null; cvi: number | null;
  war: number; tag: string;
}

const SECTIONS = [
  ["roster", "Roster"], ["strengths", "Strengths"], ["years", "Year by year"],
  ["draft", "Draft history"], ["trades", "Trades"], ["waivers", "Waivers"],
] as const;
type SectionKey = typeof SECTIONS[number][0];
/** old tab URLs (/franchise/:rid/:tab) land on the matching section */
const TAB_SECTION: Record<string, SectionKey> = {
  overview: "roster", draft: "draft", trades: "trades", waivers: "waivers",
};

/**
 * Franchise page (1C): split rail. The rail carries the season ladder — one
 * row per season with that year's team name on the second line, which is
 * where the rename history reads — and the content column carries the figure
 * strip, the outlook, and every section as bands on one page.
 */
export default function FranchisePage({ rid, players, tab }:
  { rid: number; players: PlayersMin; tab?: string }) {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const rosterSeason = league.rosterSeason && league.seasons.includes(league.rosterSeason)
    ? league.rosterSeason : league.seasons[league.seasons.length - 1];

  const [fr, setFr] = useState<Franchise | null | undefined>(undefined);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [draftSeasons, setDraftSeasons] = useState<string[]>([]);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [proj, setProj] = useState<Map<string, { war: number; age: number }> | null>(null);
  const [sppg, setSppg] = useState<Map<string, number>>(new Map());
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [cvi, setCvi] = useState<CviFile | null>(null);

  useEffect(() => {
    let live = true;
    jl<Franchises>("franchises.json").then(f => {
      if (live) setFr(f[String(rid)] ?? null);
    }).catch(() => { if (live) setFr(null); });
    jl<Insights>("insights.json").then(x => { if (live) setInsights(x); }).catch(() => {});
    jl<Drafts>("drafts.json").then(d => {
      if (!live) return;
      setPicks(d[String(rid)] || []);
      const all = new Set<string>();
      for (const list of Object.values(d))
        for (const p of list) if (p.kind === "rookie") all.add(p.season);
      setDraftSeasons([...all].sort((a, b) => b.localeCompare(a)));
    }).catch(() => {});
    jl<TradesPayload>("trades.json")
      .then(p => { if (live) setTrades(readTrades(p).trades.filter(t => t.sides.some(s => s.rid === rid))); })
      .catch(() => { if (live) setTrades([]); });
    jl<Team[]>(`${rosterSeason}/teams.json`)
      .then(ts => { if (live) setTeam(ts.find(t => t.roster_id === rid) ?? null); })
      .catch(() => {});
    Promise.all([
      jl<ProjectionsFile>("projections.json"),
      jl<SleeperProjFile>("proj_sleeper.json").catch(() => ({ players: {} } as SleeperProjFile)),
    ]).then(([p, sp]) => {
      if (!live) return;
      setProj(new Map(p.players.map(r => [r.pid, { war: r.composite?.[0] ?? 0, age: r.age }])));
      setSppg(new Map(Object.entries(sp.players ?? {}).map(([pid, x]) => [pid, x.ppg])));
    }).catch(() => { if (live) setProj(new Map()); });
    jlDaily<DviFile>("dvi.json").then(d => { if (live) setDvi(d); }).catch(() => {});
    jlDaily<CviFile>("cvi.json").then(c => { if (live) setCvi(c); }).catch(() => {});
    return () => { live = false; };
  }, [rid, rosterSeason]);

  const refs = useRef<Record<SectionKey, HTMLDivElement | null>>({
    roster: null, strengths: null, years: null, draft: null, trades: null, waivers: null,
  });
  const goto = (k: SectionKey) =>
    refs.current[k]?.scrollIntoView({ behavior: "smooth", block: "start" });
  // pre-restructure tab URLs scroll to their section once content exists
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !tab || !fr) return;
    const k = TAB_SECTION[tab];
    if (k) { scrolled.current = true; setTimeout(() => goto(k), 60); }
  }, [tab, fr]);

  /** roster rows with everything a row needs, priced in every currency */
  const roster = useMemo(() => {
    if (!team) return null;
    const rows: RosterRow[] = team.players.map(pid => {
      const [nm, pos, nfl] = pInfo(players, pid);
      const pj = proj?.get(pid);
      return {
        id: pid, nm, pos, nfl,
        age: pj?.age ?? null, ppg: sppg.get(pid) ?? null,
        dvi: dvi?.players[pid]?.dvi ?? null, cvi: cvi?.players[pid]?.cvi ?? null,
        war: pj?.war ?? 0,
        tag: team.taxi.includes(pid) ? "TAXI" : team.reserve.includes(pid) ? "IR" : "",
      };
    });
    const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;
    // taxi and IR players can't start, so they never enter the lineup pool
    const eligible = rows.filter(r => r.tag !== "TAXI" && r.tag !== "IR");
    const { slots, starters } = optimalLineup(eligible, lineup);
    const benched = rows.filter(r => !starters.has(r.id))
      .sort((a, b) => posIdx(a.pos) - posIdx(b.pos) || b.war - a.war);
    const bench = benched.filter(r => r.tag !== "TAXI");
    const taxi = benched.filter(r => r.tag === "TAXI");
    const startTot = slots.reduce((s, x) => s + (x.player?.war ?? 0), 0);
    const warMax = Math.max(0.01, ...rows.map(r => r.war));
    return { rows, slots, bench, taxi, startTot, warMax };
  }, [team, players, proj, sppg, dvi, cvi, meta]);

  /** starters/roster totals in an index currency (lineup optimised in it) */
  const indexTotals = useMemo(() => {
    if (!team) return null;
    const priced = (idx: Record<string, { pos: string }> | undefined, of: (pid: string) => number) => {
      if (!idx) return null;
      const pool = team.players.filter(p => idx[p])
        .map(p => ({ id: p, pos: idx[p].pos, war: of(p) }));
      const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;
      const { slots } = optimalLineup(pool, lineup);
      return {
        s: slots.reduce((a, sl) => a + (sl.player?.war ?? 0), 0),
        t: pool.reduce((a, p) => a + p.war, 0),
      };
    };
    return {
      dvi: priced(dvi?.players, p => dvi!.players[p].dvi),
      cvi: priced(cvi?.players, p => cvi!.players[p].cvi),
    };
  }, [team, dvi, cvi, meta]);

  if (fr === undefined) return <div className="empty">Loading franchise…</div>;
  if (!fr) return <div className="empty">No franchise history found.</div>;

  const seasons = fr.seasons;
  const latest = seasons[seasons.length - 1];
  const all = seasons.reduce(
    (a, s) => ({ w: a.w + s.wins, l: a.l + s.losses, t: a.t + (s.ties || 0) }),
    { w: 0, l: 0, t: 0 });
  const games = all.w + all.l + all.t;
  const champYears = seasons.filter(s => s.finish === 1).map(s => s.season);
  const insight = insights?.teams[String(rid)] ?? null;

  const lastPlayed = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : "";
  /** a rookie class with no played season yet returns —, never 0.00 */
  const unplayed = (season: string) => !lastPlayed || season > lastPlayed;

  const rookiePicks = picks.filter(p => p.kind === "rookie");
  const bySeason = new Map<string, DraftPick[]>();
  for (const p of rookiePicks) {
    const arr = bySeason.get(p.season);
    if (arr) arr.push(p); else bySeason.set(p.season, [p]);
  }
  for (const arr of bySeason.values()) arr.sort((a, b) => a.pick_no - b.pick_no);
  const draftYears = draftSeasons.length ? draftSeasons
    : [...bySeason.keys()].sort((a, b) => b.localeCompare(a));
  const keptTotal = (arr: DraftPick[]) =>
    arr.reduce((s, p) => s + (p.traded ? 0 : p.war ?? 0), 0);
  const kept = (arr: DraftPick[]) => arr.filter(p => !p.traded).length;

  const waiverTxs = fr.tx.slice().sort((a, b) => b.ts - a.ts).filter(t => t.type !== "trade");
  const myTrades = (trades ?? []).slice().sort((a, b) => b.ts - a.ts)
    .map(t => ({
      ...t,
      sides: [...t.sides].sort((a, b) => Number(b.rid === rid) - Number(a.rid === rid)),
    }));

  const rosterCell = (r: RosterRow, slot: string, warMax: number) => (
    <>
      <td className="t fig quiet">{slot}</td>
      <td className="t name">
        <PlayerLink pid={r.id} name={r.nm} />
        {r.tag === "IR" && <span className="tag">IR</span>}
      </td>
      <td className="c"><PosBadge pos={r.pos} /></td>
      <td className="c fig quiet">{r.nfl || "—"}</td>
      <td className="n fig quiet">{r.age ?? "—"}</td>
      <td className="n fig">{r.ppg == null ? "—" : fmt(r.ppg, 1)}</td>
      <td className="n fig edge">{r.dvi == null ? "—" : fmt(r.dvi, 1)}</td>
      <td className="n fig">{r.cvi == null ? "—" : fmt(r.cvi, 1)}</td>
      <td className="n last edge">
        <div className="meter-row">
          <div className="meter"><i style={{ width: `${Math.round(Math.max(0, r.war) / warMax * 100)}%` }} /></div>
          <span className="fig">{fmt(r.war, 2)}</span>
        </div>
      </td>
    </>
  );

  const rosterHead = (
    <tr>
      <th className="t" style={{ width: "6%" }}>Slot</th>
      <th className="t" style={{ width: "24%" }}>Player</th>
      <th className="c" style={{ width: "7%" }}>Pos</th>
      <th className="c" style={{ width: "7%" }}>NFL</th>
      <th className="n" style={{ width: "6%" }}>Age</th>
      <th className="n" style={{ width: "8%" }}>PPG</th>
      <th className="n edge" style={{ width: "9%" }}>DVI</th>
      <th className="n" style={{ width: "9%" }}>CVI</th>
      <th className="n key edge" style={{ width: "24%" }}>Proj WAR</th>
    </tr>
  );

  const grpband = (label: string, note: string | null, tot: string | null) => (
    <tr className="grpband">
      <th colSpan={9}>
        <div>
          <span>{label}</span>
          {note && <span className="note">{note}</span>}
          {tot != null && <span className="tot">{tot}</span>}
        </div>
      </th>
    </tr>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Franchise</span>
        <QuickJump />
      </div>
      <div className="board" style={{ marginTop: 0 }}>
        <div className="split">
          <div className="rail">
            <span className="rail-back" onClick={() => nav(lp("/teams"))}>← Teams</span>
            <div className="rail-name">{latest.name}</div>
            <div className="rail-sub">{latest.manager}</div>

            <div className="rail-h">Seasons</div>
            <div className="rail-ladder">
              {seasons.slice().reverse().map(s => (
                <div key={s.season}
                  className={`rail-season${s.finish === 1 || s.season === rosterSeason ? " mark" : ""}`}>
                  <div className="l1">
                    <span className="yr">{s.season}</span>
                    <span className="fin" style={s.finish === 1 ? { color: "var(--acc)" } : undefined}>
                      {s.finish === 1 ? "CHAMP" : s.finish != null ? ord(s.finish) : s.season === rosterSeason ? "live" : "—"}
                    </span>
                    <span className="rec">{s.wins}-{s.losses}{s.ties ? `-${s.ties}` : ""}</span>
                  </div>
                  <div className="tname">{s.name}</div>
                </div>
              ))}
            </div>

            <div className="rail-h">On this page</div>
            <div className="rail-nav">
              {SECTIONS.map(([k, label]) => (
                <button key={k} onClick={() => goto(k)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="main">
            <div className="figstrip">
              <div className="figcell">
                <div className="figkey">All-time record</div>
                <div className="figval">{all.w}-{all.l}{all.t ? `-${all.t}` : ""}</div>
                <div className="figsub">{games ? `${fmt((all.w + all.t / 2) / games * 100, 1)}% · ${seasons.length} seasons` : "no games"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Titles</div>
                <div className="figval">{champYears.length}</div>
                <div className="figsub">{champYears.length ? champYears.join(" · ") : "none yet"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">{rosterSeason} lineup WAR</div>
                <div className="figval">{roster ? fmt(roster.startTot, 2) : "—"}</div>
                <div className="figsub">projected, best legal lineup</div>
              </div>
              <div className="figcell">
                <div className="figkey">Starters DVI</div>
                <div className="figval">{indexTotals?.dvi ? fmt(indexTotals.dvi.s, 0) : "—"}</div>
                <div className="figsub">{indexTotals?.dvi ? `Roster DVI ${fmt(indexTotals.dvi.t, 0)}` : "no index"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Starters CVI</div>
                <div className="figval">{indexTotals?.cvi ? fmt(indexTotals.cvi.s, 0) : "—"}</div>
                <div className="figsub">{indexTotals?.cvi ? `Roster CVI ${fmt(indexTotals.cvi.t, 0)}` : "no index"}</div>
              </div>
            </div>

            {insight && (
              <div className="verdict">
                <div className="k">{insights?.meta.season} outlook</div>
                <div className="meta">{insight.head} · written {insights?.meta.generated}</div>
                <div className="body">{insight.text}</div>
              </div>
            )}

            {/* ---- roster ---- */}
            <div ref={el => { refs.current.roster = el; }}>
              <div className="band">
                <span className="band-label">Roster · {rosterSeason}</span>
                <span className="band-note">Best legal lineup by projected WAR, not the lineup as set</span>
              </div>
              {!roster ? <div className="empty">Loading roster…</div> : (
                <table style={{ tableLayout: "fixed" }}>
                  <thead>{rosterHead}</thead>
                  <tbody>
                    {grpband("Starting lineup", "best legal lineup by projected WAR", fmt(roster.startTot, 2))}
                    {roster.slots.map((s, i) => (
                      <tr key={`${s.slot}-${i}`} className={i % 2 ? "zebra" : ""}>
                        {s.player
                          ? rosterCell(s.player as RosterRow, SLOT_LABEL[s.slot] ?? s.slot, roster.warMax)
                          : <td colSpan={9} className="t fig quiet">{SLOT_LABEL[s.slot] ?? s.slot} — empty</td>}
                      </tr>
                    ))}
                    {grpband("Bench", null,
                      fmt(roster.bench.reduce((s, r) => s + r.war, 0), 2))}
                    {roster.bench.map((r, i) => (
                      <tr key={r.id} className={i % 2 ? "zebra" : ""}>{rosterCell(r, "BN", roster.warMax)}</tr>
                    ))}
                    {roster.taxi.length > 0 && grpband("Taxi squad", null,
                      fmt(roster.taxi.reduce((s, r) => s + r.war, 0), 2))}
                    {roster.taxi.map((r, i) => (
                      <tr key={r.id} className={i % 2 ? "zebra" : ""}>{rosterCell(r, "TAXI", roster.warMax)}</tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ---- strengths ---- */}
            <div ref={el => { refs.current.strengths = el; }}>
              <div className="band">
                <span className="band-label">Strengths</span>
                <span className="band-note">Each seat ranked against the same seat on the other eleven rosters</span>
              </div>
              <div style={{ padding: "6px 22px 16px" }}>
                <TeamStrengths rid={rid} />
              </div>
            </div>

            {/* ---- year by year ---- */}
            <div ref={el => { refs.current.years = el; }}>
              <div className="band">
                <span className="band-label">Year by year</span>
                <span className="band-note">Lineup WAR sums each week's actual starters against the league-wide optimal pool</span>
              </div>
              <table style={{ tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    <th className="t" style={{ width: "7%" }}>Season</th>
                    <th className="t" style={{ width: "21%" }}>Team</th>
                    <th className="n" style={{ width: "8%" }}>Record</th>
                    <th className="n hm" style={{ width: "6%" }}>Seed</th>
                    <th className="n" style={{ width: "9%" }}>Finish</th>
                    <th className="n" style={{ width: "7%" }}>PPG</th>
                    <th className="n edge" style={{ width: "10%" }}>Lineup WAR</th>
                    <th className="t hm" style={{ width: "16%" }}>Top WAR</th>
                    <th className="t hm" style={{ width: "16%" }}>Low starter</th>
                  </tr>
                </thead>
                <tbody>
                  {seasons.slice().reverse().map((s, i) => {
                    // a season with no games yet has no record, seed, PPG or
                    // WAR to report — em dashes, never zeros
                    const played = s.wins + s.losses + (s.ties || 0) > 0;
                    return (
                    <tr key={s.season} className={i % 2 ? "zebra" : ""}>
                      <td className="t fig strong">{s.season}</td>
                      <td className="t sub">{s.name}
                        {s.manager !== latest.manager && <> · {s.manager}</>}</td>
                      <td className="n fig">{played ? <>{s.wins}-{s.losses}{s.ties ? `-${s.ties}` : ""}</> : "—"}</td>
                      <td className="n fig quiet hm">{played ? s.seed ?? "—" : "—"}</td>
                      <td className="n fig">
                        {s.finish === 1
                          ? <span className="tag" style={{ background: "var(--acc)", marginLeft: 0 }}>CHAMP</span>
                          : s.finish != null ? ord(s.finish) : "—"}
                      </td>
                      <td className="n fig">{played ? fmt(s.ppg, 1) : "—"}</td>
                      <td className={`n edge ${played ? clsOf(s.war) : "fig quiet"}`}>{played ? fmt(s.war, 2) : "—"}</td>
                      <td className="t sub hm">{s.top
                        ? <><PlayerLink pid={s.top.pid} name={pInfo(players, s.top.pid)[0]} />{" "}
                          <span className={clsOf(s.top.war)}>{fmt(s.top.war, 2)}</span></> : "—"}</td>
                      <td className="t sub hm last">{s.low
                        ? <><PlayerLink pid={s.low.pid} name={pInfo(players, s.low.pid)[0]} />{" "}
                          <span className={clsOf(s.low.war)}>{fmt(s.low.war, 2)}</span></> : "—"}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ---- draft history ---- */}
            <div ref={el => { refs.current.draft = el; }}>
              <div className="band">
                <span className="band-label">Draft history</span>
                <span className="band-note">Rookie drafts only · vs = realized minus expected WAR for the slot, over the same seasons</span>
              </div>
              {!draftYears.length ? <div className="empty">No drafts yet.</div> : (
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th className="t" style={{ width: "8%" }}>Pick</th>
                      <th className="t" style={{ width: "24%" }}>Player</th>
                      <th className="c" style={{ width: "7%" }}>Pos</th>
                      <th className="n" style={{ width: "9%" }}>WAR</th>
                      <th className="n hm" style={{ width: "10%" }}>On roster</th>
                      <th className="n hm" style={{ width: "10%" }}>Expected</th>
                      <th className="n" style={{ width: "8%" }}>Vs</th>
                      <th className="t hm" style={{ width: "24%" }}>Better available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftYears.map(season => {
                      const rows = bySeason.get(season) ?? [];
                      const np = unplayed(season);
                      return (
                        <Fragment key={season}>
                          <tr className="grpband">
                            <th colSpan={8}>
                              <div>
                                <span>{season} rookie draft</span>
                                <span className="note">
                                  {kept(rows)} pick{kept(rows) === 1 ? "" : "s"}
                                  {rows.length - kept(rows) > 0 && ` · ${rows.length - kept(rows)} traded away`}
                                </span>
                                <span className="tot">
                                  {np ? "not yet played" : `${fmt(keptTotal(rows), 2)} WAR returned`}
                                </span>
                              </div>
                            </th>
                          </tr>
                          {rows.length === 0 && (
                            <tr><td colSpan={8} className="t fig quiet">no picks — traded away</td></tr>
                          )}
                          {rows.map((p, i) => (
                            <tr key={`${p.season}-${p.pick_no}-${p.traded ? "t" : "m"}`}
                              className={i % 2 ? "zebra" : ""}
                              style={p.traded ? { opacity: 0.55 } : undefined}>
                              <td className="t fig strong">{p.slot}</td>
                              <td className="t name">
                                <PlayerLink pid={p.pid} name={p.name} />
                                {p.traded && <span className="tag">traded</span>}
                              </td>
                              <td className="c"><PosBadge pos={p.pos} /></td>
                              <td className={`n ${np || p.traded ? "fig quiet" : clsOf(p.war)}`}>
                                {np ? "—" : fmt(p.war, 2)}</td>
                              <td className={`n hm ${np || p.traded ? "fig quiet" : clsOf(p.war_roster ?? 0)}`}>
                                {np || p.traded ? "—" : fmt(p.war_roster ?? 0, 2)}</td>
                              <td className="n hm fig quiet">{p.expected == null ? "—" : fmt(p.expected, 2)}</td>
                              <td className={`n ${np || p.diff == null ? "fig quiet" : clsOf(p.diff)}`}>
                                {np || p.diff == null ? "—" : sgn(p.diff, 2)}</td>
                              <td className="t sub hm last"
                                title={p.alts.map(a => `${a.name} (pick ${a.pick_no}) ${a.war.toFixed(2)}`).join(" · ")}>
                                {np || p.alts.length === 0 ? "—"
                                  : p.alts.slice(0, 2).map(a => `${a.name} ${a.war.toFixed(2)}`).join(", ")}
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* ---- trades ---- */}
            <div ref={el => { refs.current.trades = el; }}>
              <div className="band">
                <span className="band-label">Trades</span>
                <span className="band-note">Each side scored on the WAR its return produced after the trade · both sides in the same neutral ink</span>
              </div>
              <div className="ledger" style={{ paddingTop: 14 }}>
                {!trades ? <div className="empty">Loading trades…</div>
                  : !myTrades.length ? <div className="empty">No trades yet.</div>
                    : myTrades.map((t, i) => (
                      <div key={`${t.ts}-${i}`} className="trade">
                        <div className="trade-head">
                          <span className="trade-wk">{t.season} · WEEK {t.week}</span>
                          <span style={{ font: "400 12px/1 var(--sans)", color: "var(--dim)" }}>{tradeWhen(t.ts)}</span>
                        </div>
                        <div className="trade-sides">
                          {t.sides.map(s => (
                            <div key={s.rid} className="trade-side">
                              <div className="hd">
                                <div>
                                  <div className="k">Received</div>
                                  <div className="team">{s.team}</div>
                                </div>
                                <div style={{ textAlign: "right" }}>
                                  <div className="k">Realized · to come</div>
                                  <div className="total">
                                    {fmt(s.war, 2)}
                                    <span style={{ font: "400 14px/1 var(--cond)", color: "var(--dim)" }}> · {sgn(s.future ?? 0, 2)}</span>
                                  </div>
                                </div>
                              </div>
                              {s.got.map((a, k) => {
                                const isPick = a.kind !== "player";
                                const pos = !isPick && a.pid ? pInfo(players, a.pid)[1] : "PICK";
                                const [head, tail] = a.label.split(" → ");
                                return (
                                  <div key={k} className="trade-asset">
                                    <span className={`pos sm ${isPick ? "PICK" : pos}`}>{isPick ? "PK" : pos}</span>
                                    <span className={`nm ${isPick && !tail ? "pick" : ""}`}>
                                      {isPick && tail && <span style={{ color: "var(--dim)" }}>{head} → </span>}
                                      {a.pid ? <PlayerLink pid={a.pid} name={tail ?? head} /> : (tail ?? head)}
                                    </span>
                                    <span className="war" style={{ color: "var(--txt2)" }}>
                                      {a.kind === "player" || tail ? fmt(a.war, 2) : "—"}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
              </div>
            </div>

            {/* ---- waivers ---- */}
            <div ref={el => { refs.current.waivers = el; }}>
              <div className="band">
                <span className="band-label">Waivers &amp; free agents</span>
                <span className="band-note">Trades live in their own section</span>
              </div>
              {!waiverTxs.length ? <div className="empty">No moves yet.</div> : (
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th className="t" style={{ width: "10%" }}>When</th>
                      <th className="t" style={{ width: "9%" }}>Type</th>
                      <th className="t" style={{ width: "40%" }}>Added</th>
                      <th className="t" style={{ width: "41%" }}>Dropped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waiverTxs.map((t, i) => (
                      <tr key={`${t.ts}-${i}`} className={i % 2 ? "zebra" : ""}>
                        <td className="t fig quiet">{t.season} W{t.week}</td>
                        <td className="t fig quiet">{t.type === "waiver" ? "WAIVER" : "FA"}</td>
                        <td className="t sub" style={{ whiteSpace: "normal", color: "var(--good)" }}>
                          {t.adds?.length ? t.adds.join(", ") : "—"}</td>
                        <td className="t sub last" style={{ whiteSpace: "normal", color: "var(--drop)" }}>
                          {t.drops?.length ? t.drops.join(", ") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
