import { Fragment, useEffect, useState, type CSSProperties } from "react";
import type { DraftPick, Drafts, Franchise, Franchises, Insights, PlayersMin, ProjectionsFile, SleeperProjFile, SummaryRow, Team, Trade, TradesPayload } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf } from "../lib/stats";
import { DEFAULT_LINEUP, optimalLineup, pInfo, posRanks } from "../lib/league";
import { useLeague } from "../lib/context";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";
import TradeCard, { readTrades } from "./TradeCard";
import QuickJump from "./QuickJump";
import SuggestedTrades from "./SuggestedTrades";

function ord(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
const finishLabel = (f: number | null) =>
  f == null ? "—" : f === 1 ? "🏆 Champion" : f === 2 ? "Runner-up" : ord(f);

const TXF: [string, string][] = [["all", "All"], ["add", "Adds"], ["drop", "Drops"]];
const selStyle: CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", color: "var(--txt)", padding: "4px 8px", borderRadius: 8, fontSize: 13 };
const lblStyle: CSSProperties = { color: "var(--dim)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 };

const TABS = [["overview", "Overview"], ["draft", "Draft"],
  ["trades", "Trades"], ["waivers", "Waivers"]] as const;
type TabKey = typeof TABS[number][0];

export default function FranchisePage({ rid, players, tab, onTab, back }:
  { rid: number; players: PlayersMin; tab?: string; onTab: (t: TabKey) => void; back: () => void }) {
  const cur: TabKey = (TABS.find(t => t[0] === tab)?.[0]) ?? "overview";
  const { meta } = useLeague();
  const [fr, setFr] = useState<Franchise | null | undefined>(undefined);
  const [txFilter, setTxFilter] = useState("all");
  const [txSeason, setTxSeason] = useState("all");
  const [picks, setPicks] = useState<DraftPick[]>([]);
  // Every rookie-draft year the league has held, so a franchise that traded
  // away a whole class still shows that year rather than skipping it.
  const [draftSeasons, setDraftSeasons] = useState<string[]>([]);
  const [draftSeason, setDraftSeason] = useState("all");
  const [trades, setTrades] = useState<Trade[] | null>(null);
  // trades render expanded; this tracks the ones collapsed by the user
  const [closedTrades, setClosedTrades] = useState<Set<number>>(new Set());
  const toggleTrade = (i: number) => setClosedTrades(prev => {
    const next = new Set(prev);
    if (!next.delete(i)) next.add(i);
    return next;
  });
  const [rosterSeason, setRosterSeason] = useState<string | null>(null);
  const [roster, setRoster] = useState<
    { team: Team; sum: Map<string, SummaryRow>; rank: Map<string, number> } | null>(null);
  // projected WAR — only exists for the projection's roster season (the
  // upcoming year); historical seasons show what actually happened instead.
  const [proj, setProj] = useState<{
    season: string; war: Map<string, number>;
    ppg: Map<string, number>; pts: Map<string, number>; rank: Map<string, number>;
  } | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const insight = insights?.teams[String(rid)] ?? null;

  useEffect(() => {
    let live = true;
    j<Insights>("data/insights.json").then(x => { if (live) setInsights(x); }).catch(() => {});
    j<Franchises>("data/franchises.json").then(f => {
      if (!live) return;
      const rec = f[String(rid)] ?? null;
      setFr(rec);
      if (rec?.seasons.length) setRosterSeason(rec.seasons[rec.seasons.length - 1].season);
    }).catch(() => { if (live) setFr(null); });
    j<Drafts>("data/drafts.json").then(d => {
      if (!live) return;
      setPicks(d[String(rid)] || []);
      const all = new Set<string>();
      for (const list of Object.values(d))
        for (const p of list) if (p.kind === "rookie") all.add(p.season);
      const yrs = [...all].sort((a, b) => b.localeCompare(a));
      setDraftSeasons(yrs);
      if (yrs.length) setDraftSeason(yrs[0]);   // newest draft by default
    }).catch(() => {});
    return () => { live = false; };
  }, [rid]);

  useEffect(() => {
    if (!rosterSeason) return;
    let live = true;
    Promise.all([
      j<Team[]>(`data/${rosterSeason}/teams.json`),
      j<SummaryRow[]>(`data/${rosterSeason}/summary.json`).catch(() => [] as SummaryRow[]),
    ]).then(([teams, sum]) => {
      if (!live) return;
      const team = teams.find(t => t.roster_id === rid) || null;
      setRoster(team ? {
        team, sum: new Map(sum.map(s => [s[0], s])),
        // actual positional finish that season, by total points
        rank: posRanks(sum, s => s[0], s => s[1], s => s[3]),
      } : null);
    });
    return () => { live = false; };
  }, [rosterSeason, rid]);

  // this franchise's trades, as scored cards — only when the tab is shown
  useEffect(() => {
    if (cur !== "trades" || trades) return;
    let live = true;
    j<TradesPayload>("data/trades.json")
      .then(p => {
        if (live) setTrades(readTrades(p).trades.filter(t => t.sides.some(s => s.rid === rid)));
      })
      .catch(() => { if (live) setTrades([]); });
    return () => { live = false; };
  }, [cur, trades, rid]);

  // fetched once, only when Overview is actually shown
  useEffect(() => {
    if (cur !== "overview" || proj) return;
    let live = true;
    Promise.all([
      j<ProjectionsFile>("data/projections.json"),
      j<SleeperProjFile>("data/proj_sleeper.json").catch(() => ({ players: {} } as SleeperProjFile)),
    ]).then(([p, sp]) => {
      if (!live) return;
      const ext = Object.entries(sp.players ?? {});
      setProj({
        season: String(p.meta.roster_season),
        war: new Map(p.players.map(r => [r.pid, r.composite?.[0] ?? 0])),
        ppg: new Map(ext.map(([pid, v]) => [pid, v.ppg])),
        pts: new Map(ext.map(([pid, v]) => [pid, v.pts13])),
        // finish is ranked across every projected NFL player, not just this
        // roster, so "RB5" means what it does everywhere else
        rank: posRanks(ext, e => e[0], e => e[1].pos, e => e[1].pts13),
      });
    }).catch(() => {
      if (live) setProj({ season: "", war: new Map(), ppg: new Map(), pts: new Map(), rank: new Map() });
    });
    return () => { live = false; };
  }, [cur, proj]);

  if (fr === undefined) return <div className="empty">Loading franchise…</div>;
  if (!fr) return <div className="empty">No franchise history found.</div>;

  const seasons = fr.seasons;
  const latest = seasons[seasons.length - 1];
  const former = [...new Set(seasons.map(s => s.name))].filter(n => n !== latest.name);
  const txSeasons = [...new Set(fr.tx.map(t => t.season))].sort().reverse();
  // trades live on their own tab as scored cards, so the waiver list is
  // strictly adds and drops
  const txs = fr.tx.slice().sort((a, b) => b.ts - a.ts).filter(t =>
    t.type !== "trade"
    && (txSeason === "all" || t.season === txSeason) && (
      txFilter === "all" ? true
        : txFilter === "add" ? !!t.adds?.length
          : !!t.drops?.length));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="back" onClick={back} style={{ display: "inline-block" }}>← all teams</span>
        <QuickJump />
      </div>
      <div id="teamDetail">
        <h2>{latest.name}</h2>
        <div className="mgr">
          {latest.manager}
          {former.length > 0 && <span style={{ color: "var(--dim)" }}> · formerly {former.join(", ")}</span>}
        </div>

        <div className="tabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={cur === k ? "on" : ""} onClick={() => onTab(k)}>{label}</button>
          ))}
        </div>

        {cur === "overview" && <>
        {insight && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 16px", margin: "16px 0 4px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <b style={{ color: "var(--txt)", fontSize: 13.5 }}>{insights?.meta.season} outlook</b>
              <span style={{ color: "var(--dim)", fontSize: 12 }}>{insight.head}</span>
            </div>
            <div style={{ color: "var(--txt)", fontSize: 13.5, lineHeight: 1.65, marginTop: 6 }}>{insight.text}</div>
            <div style={{ color: "var(--dim)", fontSize: 11.5, marginTop: 6 }}>
              written {insights?.meta.generated} — {insights?.meta.note}
            </div>
          </div>
        )}
        <SuggestedTrades rid={rid} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "18px 0 8px" }}>
          <h3 style={{ margin: 0 }}>Roster</h3>
          <select value={rosterSeason ?? ""} onChange={e => setRosterSeason(e.target.value)} style={selStyle}>
            {seasons.slice().reverse().map(s => <option key={s.season} value={s.season}>{s.season}</option>)}
          </select>
          {proj && rosterSeason === proj.season && (
            <span style={{ color: "var(--dim)", fontSize: 12 }}>
              projected WAR — composite (model blended with Sleeper), {proj.season}
            </span>
          )}
        </div>
        {roster ? <RosterTable team={roster.team} sum={roster.sum} players={players}
            lineup={meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP}
            proj={proj && rosterSeason === proj.season ? proj.war : null}
            projPpg={proj?.ppg} projPts={proj?.pts} taxiSlots={meta.taxiSlots ?? 0}
            rank={proj && rosterSeason === proj.season ? proj.rank : roster.rank} />
          : <div style={{ color: "var(--dim)" }}>no roster for this season</div>}

        <h3 style={{ margin: "22px 0 6px" }}>Year by year</h3>
        <div className="tscroll">
        <table className="wide">
          <thead><tr>
            <th>Season</th><th style={{ textAlign: "left" }}>Team</th><th>Record</th>
            <th className="hm">Seed</th><th>Finish</th><th className="hm">PPG</th><th>WAR</th>
            <th className="hm" style={{ textAlign: "left" }}>Top WAR</th>
            <th className="hm" style={{ textAlign: "left" }}>Low starter</th>
          </tr></thead>
          <tbody>
            {seasons.slice().reverse().map(s => (
              <tr key={s.season} style={{ cursor: "default" }}>
                <td>{s.season}</td>
                <td style={{ textAlign: "left" }}>{s.name}
                  {s.manager !== latest.manager && <span style={{ color: "var(--dim)" }}> · {s.manager}</span>}</td>
                <td>{s.wins}-{s.losses}{s.ties ? `-${s.ties}` : ""}</td>
                <td style={{ color: "var(--dim)" }}>{s.seed ?? "—"}</td>
                <td>{finishLabel(s.finish)}</td>
                <td>{fmt(s.ppg, 1)}</td>
                <td className={clsOf(s.war)}>{fmt(s.war, 2)}</td>
                <td style={{ textAlign: "left" }}>{s.top
                  ? <><PlayerLink pid={s.top.pid} name={pInfo(players, s.top.pid)[0]} />{" "}
                    <span className={clsOf(s.top.war)}>{fmt(s.top.war, 2)}</span></> : "—"}</td>
                <td style={{ textAlign: "left" }}>{s.low
                  ? <><PlayerLink pid={s.low.pid} name={pInfo(players, s.low.pid)[0]} />{" "}
                    <span className={clsOf(s.low.war)}>{fmt(s.low.war, 2)}</span></> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </>}

        {cur === "draft" && <>
        <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "18px 0 10px", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Draft picks</h3>
          <label style={lblStyle}>Year
            <select value={draftSeason} onChange={e => setDraftSeason(e.target.value)} style={selStyle}>
              {draftSeasons.map(s => <option key={s} value={s}>{s}</option>)}
              <option value="all">All-time</option>
            </select>
          </label>
          <span style={{ color: "var(--dim)", fontSize: 12 }}>
            vs = actual minus expected WAR for that slot, over the same seasons
          </span>
        </div>
        {(() => {
          // Rookie drafts only — the startup draft prices veterans, not slots,
          // so it isn't comparable to the Bridge A expectations shown here.
          const rookie = picks.filter(p => p.kind === "rookie");

          // Group by season, rounds 1 -> 4 within each.
          const bySeason = new Map<string, DraftPick[]>();
          for (const p of rookie) {
            const arr = bySeason.get(p.season);
            if (arr) arr.push(p); else bySeason.set(p.season, [p]);
          }
          for (const arr of bySeason.values()) arr.sort((a, b) => a.pick_no - b.pick_no);

          // Every league draft year, newest first — including years this
          // franchise made no picks at all (traded the whole class away).
          const all = draftSeasons.length ? draftSeasons
            : [...bySeason.keys()].sort((a, b) => b.localeCompare(a));
          if (!all.length) return <div style={{ color: "var(--dim)" }}>no picks</div>;
          // One year at a time by default; "All-time" falls back to every year.
          const seasons = draftSeason === "all" ? all
            : all.filter(s => s === draftSeason);

          // Traded-away picks are informational only — never in the subtotal.
          const total = (arr: DraftPick[], k: "war" | "war_roster") =>
            arr.reduce((s, p) => s + (p.traded ? 0 : p[k] ?? 0), 0);
          const kept = (arr: DraftPick[]) => arr.filter(p => !p.traded).length;

          return (
            <div className="tscroll">
            <table className="wide">
              <thead><tr>
                <th>Pick</th><th style={{ textAlign: "left" }}>Player</th><th>Pos</th>
                <th>WAR</th><th className="hm">On roster</th><th className="hm">Expected</th><th>vs</th>
                <th className="hm" style={{ textAlign: "left" }}>Better available</th>
              </tr></thead>
              <tbody>
                {seasons.map(season => {
                  const rows = bySeason.get(season) ?? [];
                  return (
                    <Fragment key={season}>
                      <tr style={{ cursor: "default" }}>
                        <td colSpan={3} style={{ textAlign: "left", fontWeight: 600,
                          paddingTop: 14, borderBottom: "1px solid var(--line)" }}>
                          {season} rookie draft
                          <span style={{ color: "var(--dim)", fontWeight: 400, marginLeft: 8 }}>
                            {kept(rows)} pick{kept(rows) === 1 ? "" : "s"}
                            {rows.length - kept(rows) > 0 &&
                              ` · ${rows.length - kept(rows)} traded away`}
                          </span>
                        </td>
                        <td className={clsOf(total(rows, "war"))}
                          style={{ paddingTop: 14, borderBottom: "1px solid var(--line)" }}>
                          {fmt(total(rows, "war"), 2)}</td>
                        <td className={clsOf(total(rows, "war_roster"))}
                          style={{ paddingTop: 14, borderBottom: "1px solid var(--line)" }}>
                          {fmt(total(rows, "war_roster"), 2)}</td>
                        <td colSpan={3} style={{ paddingTop: 14, borderBottom: "1px solid var(--line)" }} />
                      </tr>
                      {rows.length === 0 && (
                        <tr style={{ cursor: "default" }}>
                          <td colSpan={8} style={{ textAlign: "left", color: "var(--dim)" }}>
                            no picks — traded away
                          </td>
                        </tr>
                      )}
                      {rows.map(p => (
                        <tr key={`${p.season}-${p.pick_no}-${p.traded ? "t" : "m"}`}
                          style={{ cursor: "default", opacity: p.traded ? 0.55 : 1 }}>
                          <td>{p.slot}</td>
                          <td style={{ textAlign: "left" }}>
                            <PlayerLink pid={p.pid} name={p.name} />
                            {p.traded && <span style={{ color: "var(--dim)", marginLeft: 6 }}>(traded)</span>}
                          </td>
                          <td><PosBadge pos={p.pos} /></td>
                          <td className={p.traded ? "" : clsOf(p.war)}
                            style={p.traded ? { color: "var(--dim)" } : undefined}>{fmt(p.war, 2)}</td>
                          <td className={"hm " + (p.traded ? "" : clsOf(p.war_roster ?? 0))}
                            style={p.traded ? { color: "var(--dim)" } : undefined}>
                            {p.traded ? "—" : fmt(p.war_roster ?? 0, 2)}</td>
                          <td className="hm" style={{ color: "var(--dim)" }}>{p.expected == null ? "—" : fmt(p.expected, 2)}</td>
                          <td className={p.diff == null ? "" : clsOf(p.diff)}>
                            {p.diff == null ? "—" : sgn(p.diff, 2)}</td>
                          <td className="hm" style={{ textAlign: "left", color: "var(--dim)" }}
                            title={p.alts.map(a => `${a.name} (pick ${a.pick_no}) ${a.war.toFixed(2)}`).join(" · ")}>
                            {p.alts.length === 0 ? "—"
                              : p.alts.slice(0, 2).map(a => `${a.name} ${a.war.toFixed(2)}`).join(", ")}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
          );
        })()}
        </>}

        {cur === "trades" && (() => {
          const shown = (trades ?? []).filter(t => txSeason === "all" || t.season === txSeason);
          return <>
            <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "18px 0 10px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>Trades</h3>
              <label style={lblStyle}>Year
                <select value={txSeason} onChange={e => setTxSeason(e.target.value)} style={selStyle}>
                  <option value="all">All</option>
                  {txSeasons.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <span style={{ color: "var(--dim)", fontSize: 12 }}>
                {shown.length} trades · WAR = what each side's return produced while on their roster,
                from the trade forward
              </span>
            </div>
            {!trades ? <div style={{ color: "var(--dim)" }}>Loading trades…</div>
              : !shown.length ? <div style={{ color: "var(--dim)" }}>none</div>
                : shown.map((t, i) => (
                  <TradeCard key={`${t.ts}-${i}`} t={t} highlightRid={rid}
                    open={!closedTrades.has(i)} onToggle={() => toggleTrade(i)} />
                ))}
          </>;
        })()}

        {cur === "waivers" && <>
        <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "18px 0 10px", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Waivers &amp; free agents</h3>
          <label style={lblStyle}>Type
            <select value={txFilter} onChange={e => setTxFilter(e.target.value)} style={selStyle}>
              {TXF.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label style={lblStyle}>Year
            <select value={txSeason} onChange={e => setTxSeason(e.target.value)} style={selStyle}>
              <option value="all">All</option>
              {txSeasons.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <span style={{ color: "var(--dim)", fontSize: 12 }}>{txs.length} shown</span>
        </div>
        <div style={{ maxWidth: 720 }}>
          {txs.length === 0 ? <div style={{ color: "var(--dim)" }}>none</div> : txs.map((t, i) => (
            <div key={i} className="ownevt">
              <span className="ownwk">{t.season} W{t.week}</span>
              {t.adds?.length ? <>added {t.adds.join(", ")}</> : null}
              {t.adds?.length && t.drops?.length ? "; " : ""}
              {t.drops?.length ? <>dropped {t.drops.join(", ")}</> : null}
              {t.type === "waiver" && <span style={{ color: "var(--dim)" }}> · waiver</span>}
            </div>
          ))}
        </div>
        </>}
      </div>
    </>
  );
}

/** `proj` non-null => this is the upcoming season: show projected WAR instead
 *  of the games/points a season that hasn't been played can't have. */
function RosterTable({ team, sum, players, proj, projPpg, projPts, rank, lineup, taxiSlots }:
  { team: Team; sum: Map<string, SummaryRow>; players: PlayersMin;
    proj: Map<string, number> | null; projPpg?: Map<string, number>;
    projPts?: Map<string, number>; rank: Map<string, number>;
    lineup: string[]; taxiSlots: number }) {
  const benchSlots = lineup.filter(s => s === "BN").length;
  const rows = team.players.map(p => {
    const s = sum.get(p);
    const tag = team.taxi.includes(p) ? "TAXI" : team.reserve.includes(p) ? "IR"
      : team.starters.includes(p) ? "START" : "";
    return {
      id: p, nm: pInfo(players, p)[0], pos: pInfo(players, p)[1], tag,
      gp: s ? s[2] : 0,
      ppg: proj ? (projPpg?.get(p) ?? 0) : (s ? s[4] : 0),
      pts: proj ? (projPts?.get(p) ?? 0) : (s ? s[3] : 0),
      fin: rank.get(p) ?? 0,
      war: proj ? (proj.get(p) ?? 0) : (s ? s[6] : 0),
    };
  }).sort((a, b) => b.war - a.war);

  // Best lineup by WAR, not the lineup actually fielded. Taxi and IR players
  // can't start, so they're excluded from the pool and land on the bench.
  // For the upcoming season, taxi/IR players genuinely can't be started, so
  // they're out of the pool. For a finished season those flags are just an
  // end-of-year snapshot — a player on IR in December may have started in
  // September — so the ideal lineup is simply the best WAR at each slot.
  const eligible = proj ? rows.filter(r => r.tag !== "TAXI" && r.tag !== "IR") : rows;
  const { slots, starters: starterIds } = optimalLineup(eligible, lineup);
  // bench groups by position (lineup order), best first within each
  const POS_ORDER = ["QB", "RB", "WR", "TE"];
  const posIdx = (p: string) => { const i = POS_ORDER.indexOf(p); return i < 0 ? POS_ORDER.length : i; };
  const benched = rows.filter(r => !starterIds.has(r.id))
    .sort((a, b) => posIdx(a.pos) - posIdx(b.pos) || b.war - a.war);
  const benchPlayers = benched.filter(r => r.tag !== "TAXI");
  const taxiPlayers = benched.filter(r => r.tag === "TAXI");

  // Show every slot the league allows, filled or not. Unused bench slots sit
  // at the end of the bench — i.e. the bottom of the right column, just above
  // the taxi block — rather than leaving a ragged column.
  type Entry = { kind: "player"; r: typeof rows[number] } | { kind: "empty" } | { kind: "taxi" };
  const pad = (n: number): Entry[] => Array.from({ length: Math.max(0, n) }, () => ({ kind: "empty" }));
  const entries: Entry[] = [
    ...benchPlayers.map(r => ({ kind: "player", r } as Entry)),
    ...pad(benchSlots - benchPlayers.length),
    { kind: "taxi" },
    ...taxiPlayers.map(r => ({ kind: "player", r } as Entry)),
    ...pad(taxiSlots - taxiPlayers.length),
  ];
  // never end a column on the taxi heading — it'd orphan the label
  let half = Math.ceil(entries.length / 2);
  if (entries[half - 1]?.kind === "taxi") half -= 1;
  const sum_ = (a: typeof rows) => a.reduce((s, r) => s + r.war, 0);
  const startTotal = slots.reduce((s, x) => s + (x.player?.war ?? 0), 0);

  const head = (label: string, n: number, tot: number | null) => (
    <div className="rhead">
      <span>{label}</span>
      <span style={{ color: "var(--dim)", fontWeight: 400 }}>{n}</span>
      {tot !== null && <span className={clsOf(tot)} style={{ marginLeft: "auto" }}>{fmt(tot, 3)}</span>}
    </div>
  );
  const cells = (r: typeof rows[number]) => (<>
    <td className="pcol" style={{ textAlign: "left" }}><PlayerLink pid={r.id} name={r.nm} />
      {r.tag && r.tag !== "START" && <span className="tag"> {r.tag}</span>}</td>
    <td><PosBadge pos={r.pos} /></td>
    <td className="hm" style={{ color: "var(--dim)" }}>{r.fin ? `${r.pos}${r.fin}` : "—"}</td>
    {!proj && <td className="hm">{r.gp}</td>}
    <td className="hm">{r.ppg ? fmt(r.ppg, 1) : "—"}</td>
    <td className="hm">{r.pts ? fmt(r.pts, 1) : "—"}</td>
    <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
  </>);
  const cols = <thead><tr>
    <th className="pcol" style={{ textAlign: "left" }}>Player</th><th>Pos</th>
    <th className="hm">{proj ? "Proj fin" : "Finish"}</th>
    {!proj && <th className="hm">GP</th>}
    <th className="hm">{proj ? "Proj PPG" : "PPG"}</th>
    <th className="hm">{proj ? "Proj pts" : "Points"}</th>
    <th>{proj ? "Proj WAR" : "WAR"}</th>
  </tr></thead>;
  const span = proj ? 6 : 7;

  return (
    <div className="rostergrid">
      <div className="rcard">
        {head("Starters", slots.length, startTotal)}
        <table>
          {cols}
          <tbody>
            {/* Sleeper's lineup order (QB, RB, RB, WR... FLX, SFLX) — the slot
                each player fills is implied by position and order, so it isn't
                labelled */}
            {slots.map((s, i) => (
              <tr key={`${s.slot}-${i}`} style={{ cursor: "default" }}>
                {s.player ? cells(s.player) : (
                  <td colSpan={span} style={{ textAlign: "left", color: "var(--dim)" }}>empty</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rcard">
        {head("Bench", benchPlayers.length, null)}
        {/* two inner columns so a deep bench doesn't tower over the lineup */}
        <div className="benchsplit">
          {[entries.slice(0, half), entries.slice(half)]
            .filter(part => part.length > 0)
            .map((part, i) => (
              <table key={i}>
                {cols}
                <tbody>
                  {part.map((e, idx) => (
                    e.kind === "taxi" ? (
                      <tr key={`taxi-${idx}`} className="grouprow" style={{ cursor: "default" }}>
                        <td colSpan={span} style={{ textAlign: "left" }}>Taxi squad</td>
                      </tr>
                    ) : e.kind === "empty" ? (
                      <tr key={`empty-${i}-${idx}`} style={{ cursor: "default" }}>
                        <td className="pcol empty" style={{ textAlign: "left" }}>empty</td>
                        <td colSpan={span - 1} />
                      </tr>
                    ) : (
                      <tr key={e.r.id} style={{ cursor: "default" }}>{cells(e.r)}</tr>
                    )
                  ))}
                </tbody>
              </table>
            ))}
        </div>
      </div>
    </div>
  );
}
