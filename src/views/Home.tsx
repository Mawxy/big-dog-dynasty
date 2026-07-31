import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  CviFile, DviFile, Franchises, Matchups, ProjectionsFile, Team,
  Trade, TradesPayload, Values,
} from "../lib/types";
import { jDaily, jl, jlDaily } from "../lib/data";
import { fmt, sgn, mean, normCdf, normInv } from "../lib/stats";
import { DEFAULT_LINEUP, optimalLineup, pInfo } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { readTrades, tradeWhen } from "../lib/trades";
import { PlayerLink } from "../components/PlayerLink";
import PosBadge from "../components/PosBadge";

const MODULE_ROWS = 5;
const REG_WEEKS = 14;

/** pad a module list to a fixed row count so paired modules measure equal */
function padTo<T>(a: T[], n: number): (T | null)[] {
  return [...a.slice(0, n), ...Array(Math.max(0, n - a.length)).fill(null)];
}

/**
 * League front page (2B): champion + title race hero, power rankings by
 * starter DVI, then two module rows — value plays beside market movers,
 * recent waivers beside recent trades. Paired modules share row count and
 * cell line count so they measure equal.
 */
export default function Home() {
  const { meta, players, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [fr, setFr] = useState<Franchises | null>(null);
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [cvi, setCvi] = useState<CviFile | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [vals, setVals] = useState<Values | null>(null);

  const rosterSeason = league.rosterSeason && league.seasons.includes(league.rosterSeason)
    ? league.rosterSeason : league.seasons[league.seasons.length - 1];

  useEffect(() => {
    let live = true;
    const set = <T,>(f: (v: T) => void) => (v: T) => { if (live) f(v); };
    jl<Franchises>("franchises.json").then(set(setFr)).catch(() => {});
    jl<ProjectionsFile>("projections.json").then(set(setProj)).catch(() => {});
    jl<Team[]>(`${rosterSeason}/teams.json`).then(set(setTeams)).catch(() => {});
    jl<Matchups>(`${rosterSeason}/matchups.json`).then(set(setMw)).catch(() => {});
    jlDaily<DviFile>("dvi.json").then(set(setDvi)).catch(() => {});
    jlDaily<CviFile>("cvi.json").then(set(setCvi)).catch(() => {});
    jl<TradesPayload>("trades.json")
      .then(p => { if (live) setTrades(readTrades(p).trades); }).catch(() => {});
    jDaily<Values>("data/values.json").then(set(setVals)).catch(() => {});
    return () => { live = false; };
  }, [league, rosterSeason]);

  const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;

  /** the reigning champion's full season row */
  const champ = useMemo(() => {
    if (!fr || !league.latest) return null;
    for (const [rid, f] of Object.entries(fr)) {
      const sn = f.seasons.find(s => s.season === league.latest && s.finish === 1);
      if (sn) return { rid: +rid, s: sn };
    }
    return null;
  }, [fr, league]);

  /**
   * Per-franchise projected strength, record and starter age for the roster
   * season: optimal lineup on year-one composite WAR, win probabilities from
   * the published schedule via the same z-score conversion the standings
   * page uses (byes ignored — this is a front-page read, not the model).
   */
  const power = useMemo(() => {
    if (!teams || !proj) return null;
    const byPid = new Map(proj.players.map(p => [p.pid, p]));
    const built = teams.map(t => {
      const pool = t.players.map(p => byPid.get(p))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map(p => ({ id: p.pid, pos: p.pos, war: p.composite?.[0] ?? 0, age: p.age }));
      const { slots } = optimalLineup(pool, lineup);
      const starters = slots.flatMap(s => s.player ? [s.player] : []);
      const war = starters.reduce((a, p) => a + p.war, 0);
      const wsum = starters.reduce((a, p) => a + Math.max(p.war, 0.01), 0);
      const age = wsum ? starters.reduce((a, p) => a + p.age * Math.max(p.war, 0.01), 0) / wsum : null;
      return { rid: t.roster_id, war, age };
    });
    const meanWar = mean(built.map(b => b.war));
    const warOf = new Map(built.map(b => [b.rid, b.war]));
    const z = (w: number) => normInv(0.5 + Math.min(0.45, Math.max(-0.45, (w - meanWar) / 13)));
    const ps = mw?.playoff_start || 15;
    const games: Record<number, number[]> = {};
    for (const [wkS, pairs] of Object.entries(mw?.schedule ?? {})) {
      if (+wkS >= ps) continue;
      for (const [a, b] of pairs) {
        (games[a] ??= []).push(b);
        (games[b] ??= []).push(a);
      }
    }
    return new Map(built.map(b => {
      const opps = games[b.rid] ?? [];
      const wins = opps.length
        ? opps.reduce((a, o) => a + normCdf(z(b.war) - z(warOf.get(o) ?? meanWar)), 0)
        : Math.min(REG_WEEKS, Math.max(0, REG_WEEKS / 2 + (b.war - meanWar) * (REG_WEEKS / 13)));
      const n = opps.length || REG_WEEKS;
      return [b.rid, { ...b, wins, rec: `${fmt(wins, 1)}-${fmt(n - wins, 1)}` }];
    }));
  }, [teams, proj, mw, lineup]);

  /** starters totals per franchise in each index currency */
  const indexRows = useMemo(() => {
    if (!teams || !dvi || !cvi || !fr) return null;
    const price = (t: Team, idx: Record<string, { pos: string }>, of: (pid: string) => number) => {
      const pool = t.players.filter(p => idx[p])
        .map(p => ({ id: p, pos: idx[p].pos, war: of(p) }));
      return optimalLineup(pool, lineup).slots
        .reduce((a, sl) => a + (sl.player?.war ?? 0), 0);
    };
    return teams.map(t => {
      const f = fr[String(t.roster_id)];
      const cur = f?.seasons[f.seasons.length - 1];
      const lastSn = f?.seasons.find(s => s.season === league.latest);
      return {
        rid: t.roster_id,
        name: cur?.name ?? t.team, manager: cur?.manager ?? t.manager,
        sDvi: price(t, dvi.players, p => dvi.players[p].dvi),
        sCvi: price(t, cvi.players, p => cvi.players[p].cvi),
        lastRec: lastSn ? `${lastSn.wins}-${lastSn.losses}${lastSn.ties ? `-${lastSn.ties}` : ""}` : "—",
        lastFin: lastSn?.finish ?? null,
      };
    }).sort((a, b) => b.sDvi - a.sDvi);
  }, [teams, dvi, cvi, fr, league, lineup]);

  const titleRace = useMemo(() => {
    if (!indexRows) return null;
    return indexRows.slice().sort((a, b) => b.sCvi - a.sCvi).slice(0, 4);
  }, [indexRows]);

  /** rostered owner per pid, for movers and value plays */
  const ownerOfPid = useMemo(() => {
    const m = new Map<string, string>();
    if (teams) for (const t of teams) for (const p of t.players) m.set(p, t.team);
    return m;
  }, [teams]);

  /** largest DVI-minus-CVI disagreements among rostered players */
  const valuePlays = useMemo(() => {
    if (!dvi || !cvi) return null;
    const rows: { pid: string; pos: string; name: string; d: number; c: number; gap: number }[] = [];
    for (const [pid, dr] of Object.entries(dvi.players)) {
      const cr = cvi.players[pid];
      if (!cr || !ownerOfPid.has(pid)) continue;
      rows.push({ pid, pos: dr.pos, name: dr.name, d: dr.dvi, c: cr.cvi, gap: dr.dvi - cr.cvi });
    }
    rows.sort((a, b) => b.gap - a.gap);
    return {
      sell: rows.filter(r => r.gap > 0).slice(0, MODULE_ROWS),
      buy: rows.filter(r => r.gap < 0).reverse().slice(0, MODULE_ROWS),
    };
  }, [dvi, cvi, ownerOfPid]);

  /** KeepTradeCut 7-day movement, rostered players only */
  const movers = useMemo(() => {
    if (!vals) return null;
    const rows: { pid: string; val: number; d: number }[] = [];
    for (const [pid, v] of Object.entries(vals.players)) {
      if (!ownerOfPid.has(pid) || v.ktc == null) continue;
      const d = v.ktcT?.["7"];
      if (d == null || d === 0) continue;
      rows.push({ pid, val: v.ktc, d });
    }
    rows.sort((a, b) => b.d - a.d);
    return {
      up: rows.filter(r => r.d > 0).slice(0, MODULE_ROWS),
      down: rows.filter(r => r.d < 0).reverse().slice(0, MODULE_ROWS),
    };
  }, [vals, ownerOfPid]);

  const waivers = useMemo(() => {
    if (!fr) return [];
    return Object.entries(fr).flatMap(([rid, f]) => {
      const cur = f.seasons[f.seasons.length - 1];
      return f.tx.filter(t => t.type !== "trade").map(t => ({
        ...t, rid: +rid, team: cur?.name ?? "—", manager: cur?.manager ?? "",
      }));
    }).sort((a, b) => b.ts - a.ts).slice(0, MODULE_ROWS);
  }, [fr]);

  /** newest trades, deduplicated on timestamp — one record per trade */
  const recentTrades = useMemo(() => {
    const seen = new Set<number>();
    return trades.slice().sort((a, b) => b.ts - a.ts)
      .filter(t => !seen.has(t.ts) && !!seen.add(t.ts))
      .slice(0, MODULE_ROWS);
  }, [trades]);

  const nTeams = teams?.length ?? 12;
  const sf = meta.rosterPositions?.includes("SUPER_FLEX") ? "superflex" : "1QB";
  const phase = league.latest === rosterSeason ? "in season" : "offseason";
  const pricedAt = dvi?.generated?.slice(0, 10) ?? meta.updated;

  const lede = champ ? (() => {
    const s = champ.s;
    const top = s.top ? pInfo(players, s.top.pid)[0] : null;
    return `${s.name} took the ${s.season} title at ${s.wins}-${s.losses}`
      + `${s.ties ? `-${s.ties}` : ""}, scoring ${fmt(s.ppg, 1)} points a week on a lineup `
      + `worth ${fmt(s.war, 2)} WAR against the optimal pool`
      + (top && s.top ? `. ${top} carried the biggest share at ${fmt(s.top.war, 2)} WAR.` : ".");
  })() : null;

  const grpRow = (label: string, cols: number) => (
    <tr className="grp">
      <th colSpan={cols} className="t" style={{ textAlign: "left", padding: "6px 10px 5px", letterSpacing: ".16em", borderBottom: "1px solid var(--rule)" }}>
        {label}
      </th>
    </tr>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{league.name}</span>
        <span style={{ font: "400 14px/1 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)" }}>
          {nTeams} teams · {sf} · established {league.seasons[0]} · {phase}
        </span>
        <span className="screen-note">Priced {pricedAt}</span>
      </div>

      {/* ---- hero: champion + title race ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, padding: "2px var(--pad) 0" }}>
        <div className="panel" style={{ margin: 0 }}>
          <div className="chart-label">Reigning champion · {league.latest ?? "—"}</div>
          {!champ ? <div className="empty">No completed season yet.</div> : <>
            <div style={{ font: "700 40px/1.05 var(--cond)", letterSpacing: ".02em", textTransform: "uppercase", color: "var(--acc)", cursor: "pointer" }}
              onClick={() => nav(lp(`/franchise/${champ.rid}`))}>
              {champ.s.name}
            </div>
            <div style={{ font: "400 14px/1.4 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)", marginTop: 5 }}>
              {champ.s.manager} · {champ.s.wins}-{champ.s.losses}{champ.s.ties ? `-${champ.s.ties}` : ""} · {fmt(champ.s.ppg, 1)} ppg
            </div>
            <div style={{ display: "flex", marginTop: 14 }}>
              <div className="figcell">
                <div className="figkey">Lineup WAR</div>
                <div className="figval">{fmt(champ.s.war, 2)}</div>
                <div className="figsub">actual starters, {champ.s.season}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Top player</div>
                <div className="figval" style={{ fontSize: 20, lineHeight: 1.35 }}>
                  {champ.s.top
                    ? <PlayerLink pid={champ.s.top.pid} name={pInfo(players, champ.s.top.pid)[0]} />
                    : "—"}
                </div>
                <div className="figsub">{champ.s.top ? `${fmt(champ.s.top.war, 2)} WAR` : ""}</div>
              </div>
            </div>
            {lede && (
              <div style={{ borderTop: "1px solid var(--rule)", marginTop: 14, paddingTop: 10, font: "400 13.5px/1.6 var(--sans)", color: "var(--txt2)", textWrap: "pretty" }}>
                {lede}
              </div>
            )}
          </>}
        </div>

        <div className="panel" style={{ margin: 0, borderTopColor: "#2b3642" }}>
          <div className="chart-label">Title race · {rosterSeason} · top 4 by starter CVI</div>
          {!titleRace ? <div className="empty">Loading indices…</div> : titleRace.map((r, i) => (
            <div key={r.rid} onClick={() => nav(lp(`/franchise/${r.rid}`))}
              style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "9px 0", borderTop: i ? "1px solid var(--hair)" : "none", cursor: "pointer" }}>
              <span style={{ font: "600 17px/1 var(--cond)", color: "var(--dim)", flex: "0 0 16px" }}>{i + 1}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ font: "600 14px/1.35 var(--sans)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>{r.manager}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ font: "600 15px/1.3 var(--cond)", fontVariantNumeric: "tabular-nums" }}>
                  {power?.get(r.rid)?.rec ?? "—"}
                </div>
                <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>proj record</div>
              </div>
              <div style={{ textAlign: "right", flex: "0 0 58px" }}>
                <div className="head-fig sm">{fmt(r.sCvi, 0)}</div>
                <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>starter CVI</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---- power rankings ---- */}
      <div style={{ marginTop: 18 }}>
        <div className="band">
          <span className="band-label">Power rankings</span>
          <span className="band-note">Ranked by starters DVI — the roster season's best legal dynasty lineup, not last season's record</span>
          <button type="button" className="dlink" style={{ marginLeft: 12 }}
            onClick={() => nav(lp(`/teams/${league.latest ?? rosterSeason}`))}>
            Standings
          </button>
        </div>
        {!indexRows ? <div className="empty">Loading indices…</div> : (
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="c" style={{ width: "5%" }}>Rk</th>
                <th className="t" style={{ width: "23%" }}>Franchise</th>
                <th className="t hm" style={{ width: "13%" }}>Manager</th>
                <th className="n key edge" style={{ width: "11%" }}>Starters DVI</th>
                <th className="n" style={{ width: "11%" }}>Starters CVI</th>
                <th className="n edge" style={{ width: "12%" }}>{league.latest ?? "Last"}</th>
                <th className="n" style={{ width: "13%" }}>Proj {rosterSeason}</th>
                <th className="n hm" style={{ width: "12%" }}>Starter age</th>
              </tr>
            </thead>
            <tbody>
              {indexRows.map((r, i) => {
                const p = power?.get(r.rid);
                const age = p?.age ?? null;
                return (
                  <tr key={r.rid} className={`click ${i % 2 ? "zebra" : ""}`}
                    onClick={() => nav(lp(`/franchise/${r.rid}`))}>
                    <td className="spine-cell">
                      <span className="spine" style={{ background: i < 4 ? "var(--acc)" : "#2b3642" }} />
                      <span className={`rank${i < 4 ? " top" : ""}`}>{i + 1}</span>
                    </td>
                    <td className="t name">{r.name}</td>
                    <td className="t sub hm">{r.manager}</td>
                    <td className="n edge"><span className="head-fig sm">{fmt(r.sDvi, 0)}</span></td>
                    <td className="n"><span className="head-fig sm" style={{ color: "var(--txt2)" }}>{fmt(r.sCvi, 0)}</span></td>
                    {/* the champion's record goes gold — a figure, never a
                        pill inside a dense numeric row */}
                    <td className="n fig edge"
                      style={r.lastFin === 1 ? { color: "var(--acc)" } : undefined}
                      title={r.lastFin === 1 ? `${league.latest} champion` : undefined}>
                      {r.lastRec}
                    </td>
                    <td className="n fig">{p?.rec ?? "—"}</td>
                    <td className="n fig hm" style={{
                      color: age == null ? "var(--dim3)"
                        : age <= 25.5 ? "var(--good)" : age >= 27 ? "var(--warn)" : "var(--txt2)",
                    }}>
                      {age == null ? "—" : fmt(age, 1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- module row 1: value plays + market movers ---- */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Value plays</span>
            <span className="band-note">Largest DVI-minus-CVI gaps, rostered players · index points, not value</span>
          </div>
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="c" style={{ width: "14%" }}>Pos</th>
                <th className="t" style={{ width: "42%" }}>Player</th>
                <th className="n" style={{ width: "14%" }}>DVI</th>
                <th className="n" style={{ width: "14%" }}>CVI</th>
                <th className="n" style={{ width: "16%" }}>Gap</th>
              </tr>
            </thead>
            {([["Sell high · dynasty premium", valuePlays?.sell], ["Buy low · win-now premium", valuePlays?.buy]] as const)
              .map(([label, list]) => (
                <tbody key={label}>
                  {grpRow(label, 5)}
                  {padTo(list ?? [], MODULE_ROWS).map((r, i) => r ? (
                    <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
                      <td className="c"><PosBadge pos={r.pos} /></td>
                      <td className="t name"><PlayerLink pid={r.pid} name={r.name} /></td>
                      <td className="n fig">{fmt(r.d, 1)}</td>
                      <td className="n fig">{fmt(r.c, 1)}</td>
                      <td className="n fig strong last">{sgn(r.gap, 1)}</td>
                    </tr>
                  ) : (
                    <tr key={`e${label}${i}`} className={i % 2 ? "zebra" : ""}>
                      <td className="c fig quiet">—</td>
                      <td className="t fig quiet">—</td>
                      <td className="n fig quiet">—</td>
                      <td className="n fig quiet">—</td>
                      <td className="n fig quiet last">—</td>
                    </tr>
                  ))}
                </tbody>
              ))}
          </table>
        </div>

        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Market movers · 7 days</span>
            <span className="band-note">KeepTradeCut value change, rostered players</span>
          </div>
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="c" style={{ width: "14%" }}>Pos</th>
                <th className="t" style={{ width: "42%" }}>Player</th>
                <th className="n" style={{ width: "22%" }}>Value</th>
                <th className="n" style={{ width: "22%" }}>7d</th>
              </tr>
            </thead>
            {([["Rising", movers?.up], ["Falling", movers?.down]] as const).map(([label, list]) => (
              <tbody key={label}>
                {grpRow(label, 4)}
                {padTo(list ?? [], MODULE_ROWS).map((r, i) => r ? (
                  <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
                    <td className="c"><PosBadge pos={pInfo(players, r.pid)[1]} /></td>
                    <td className="t name"><PlayerLink pid={r.pid} name={pInfo(players, r.pid)[0]} /></td>
                    <td className="n fig">{r.val.toLocaleString("en-US")}</td>
                    <td className="n fig strong last" style={{ color: r.d > 0 ? "var(--good)" : "var(--bad)" }}>
                      {sgn(r.d, 0)}
                    </td>
                  </tr>
                ) : (
                  <tr key={`e${label}${i}`} className={i % 2 ? "zebra" : ""}>
                    <td className="c fig quiet">—</td>
                    <td className="t fig quiet">—</td>
                    <td className="n fig quiet">—</td>
                    <td className="n fig quiet last">—</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {!vals && (
            <div className="tnote" style={{ padding: "8px 10px 10px" }}>
              Waiting on the nightly market pull — values fill in when the KeepTradeCut feed lands.
            </div>
          )}
        </div>
      </div>

      {/* ---- module row 2: recent waivers + recent trades ---- */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Recent waivers</span>
            <span className="band-note">Adds and drops, league-wide</span>
          </div>
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="t" style={{ width: "13%" }}>Week</th>
                <th className="t" style={{ width: "27%" }}>Team</th>
                <th className="t" style={{ width: "30%" }}>Added</th>
                <th className="t" style={{ width: "30%" }}>Dropped</th>
              </tr>
            </thead>
            <tbody>
              {padTo(waivers, MODULE_ROWS).map((w, i) => w ? (
                <tr key={`${w.ts}${i}`} className={i % 2 ? "zebra" : ""}>
                  <td className="t">
                    <div className="two-line">
                      <span className="fig">{w.season.slice(2)} W{w.week}</span><br />
                      <span style={{ font: "600 10.5px/1.45 var(--cond)", letterSpacing: ".12em", color: "var(--dim3)" }}>
                        {w.type === "waiver" ? "WAIVER" : "FA"}
                      </span>
                    </div>
                  </td>
                  <td className="t">
                    <div className="two-line">
                      <span style={{ font: "600 13px/1.45 var(--sans)" }}>{w.team}</span><br />
                      <span style={{ font: "400 11.5px/1.45 var(--sans)", color: "var(--dim)" }}>{w.manager}</span>
                    </div>
                  </td>
                  <td className="t sub">
                    <div className="two-line" style={{ color: "var(--good)" }}>
                      {w.adds?.length ? w.adds.join(", ") : "—"}
                    </div>
                  </td>
                  <td className="t sub last">
                    <div className="two-line" style={{ color: "var(--drop)" }}>
                      {w.drops?.length ? w.drops.join(", ") : "—"}
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={`ew${i}`} className={i % 2 ? "zebra" : ""}>
                  {[0, 1, 2, 3].map(k => (
                    <td key={k} className={`t fig quiet${k === 3 ? " last" : ""}`}>
                      <div className="two-line">—</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Recent trades</span>
            <span className="band-note">What each side received, both in the same ink</span>
            <button type="button" className="dlink" style={{ marginLeft: 12 }}
              onClick={() => nav(lp("/ledger"))}>
              Ledger
            </button>
          </div>
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="t" style={{ width: "13%" }}>Week</th>
                <th className="t" style={{ width: "43%" }}>Gets</th>
                <th className="t" style={{ width: "44%" }}>Gets</th>
              </tr>
            </thead>
            <tbody>
              {padTo(recentTrades, MODULE_ROWS).map((t, i) => t ? (
                <tr key={t.ts} className={i % 2 ? "zebra" : ""}>
                  <td className="t">
                    <div className="two-line">
                      <span className="fig">{t.season.slice(2)} W{t.week}</span><br />
                      <span style={{ font: "600 10.5px/1.45 var(--cond)", letterSpacing: ".12em", color: "var(--dim3)" }}>
                        {tradeWhen(t.ts).replace(`, ${t.season}`, "").toUpperCase()}
                      </span>
                    </div>
                  </td>
                  {[0, 1].map(k => {
                    const sd = t.sides[k];
                    return (
                      <td key={k} className={`t${k === 1 ? " last" : ""}`}>
                        <div className="two-line">
                          <span style={{ font: "600 12px/1.45 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase" }}>
                            {sd?.team ?? "—"}
                          </span><br />
                          <span style={{ font: "400 12px/1.45 var(--sans)", color: "var(--txt2)" }}>
                            {sd?.got.map(a => a.label.split(" → ")[0]).join(" · ") || "—"}
                          </span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ) : (
                <tr key={`et${i}`} className={i % 2 ? "zebra" : ""}>
                  {[0, 1, 2].map(k => (
                    <td key={k} className={`t fig quiet${k === 2 ? " last" : ""}`}>
                      <div className="two-line">—</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="footnote">
        Starter indices price each roster's best legal lineup in that index · value plays and movers cover rostered players only
      </div>
    </>
  );
}
