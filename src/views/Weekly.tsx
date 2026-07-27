import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";
import type { Matchups, PlayersMin, SeasonData, Weekly as WeeklyT } from "../lib/types";
import { jl } from "../lib/data";
import { fmt, sgn, clsOf } from "../lib/stats";
import { pInfo, ownerOf, weekIndex, seasonSeg } from "../lib/league";
import PosBadge from "../components/PosBadge";
import { PlayerLink } from "../components/PlayerLink";
import PlayerPanel from "../components/PlayerPanel";

interface Entry { pid: string; pts: number; war: number; pos: string }
const POS: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };

interface Props { data: SeasonData; season: string; players: PlayersMin; week: number | null }

export default function Weekly({ data, season, players, week }: Props) {
  const [weekly, setWeekly] = useState<WeeklyT | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [expWeek, setExpWeek] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);
  const nav = useNavigate();
  const lp = useLeaguePath();

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    setErr(false);
    Promise.all([
      jl<WeeklyT>(`${season}/weekly.json`),
      jl<Matchups>(`${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [season, reload]);

  const byWeek = useMemo(() => {
    const bw: Record<number, Entry[]> = {};
    if (weekly) for (const [pid, rows] of Object.entries(weekly))
      for (const [wk, pts, , , , war] of rows)
        (bw[wk] ??= []).push({ pid, pts, war, pos: pInfo(players, pid)[1] });
    return bw;
  }, [weekly, players]);

  const scores = useMemo(() => {
    // per-week high & median of the twelve team scores
    const out: Record<number, { high: number; median: number }> = {};
    if (mw) {
      const byWk: Record<number, number[]> = {};
      for (const list of Object.values(mw.teams))
        for (const e of list) (byWk[e[0]] ??= []).push(e[1]);
      for (const [wk, pts] of Object.entries(byWk)) {
        const v = pts.slice().sort((a, b) => a - b), n = v.length;
        out[+wk] = { high: v[n - 1], median: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2 };
      }
    }
    return out;
  }, [mw]);

  const startedBy = useMemo(() => {
    const sb: Record<number, Set<string>> = {};
    if (mw) for (const list of Object.values(mw.teams))
      for (const e of list) for (const p of e[4] || []) (sb[e[0]] ??= new Set()).add(p);
    return sb;
  }, [mw]);

  if (season === "ALL") return <div className="empty">Weekly is a per-season view — pick a year from the dropdown.</div>;
  if (err) return <div className="empty">Couldn't load weekly data.{" "}
    <button className="retry" onClick={() => setReload(n => n + 1)}>Retry</button></div>;
  if (!weekly || !mw) return <div className="empty">Loading weekly data…</div>;
  const wks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  if (!wks.length) return <div className="empty">No scored weeks yet for this season.</div>;
  if (week !== null)
    return <div className="legacy"><WeekDetail wk={week} season={season} data={data} weekly={weekly} mw={mw} players={players} back={() => nav(lp(`/weekly/${seasonSeg(season)}`))} /></div>;

  const ps = mw.playoff_start || 15;
  const owners = ownerOf(data.teams);
  const twMax = Math.max(0.01, ...wks.map(w => Math.max(...byWeek[w].map(e => e.war))));
  const openW = expWeek != null && byWeek[expWeek] ? expWeek : null;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Week by week</span>
        <span className="screen-note">Click a week for the top three at each position</span>
      </div>

      <table>
        <colgroup>
          <col style={{ width: 74 }} /><col style={{ width: 110 }} /><col style={{ width: 100 }} />
          <col /><col style={{ width: 150 }} />
          <col className="hm" /><col className="hm" style={{ width: 120 }} />
        </colgroup>
        <thead>
          <tr className="grp">
            <th colSpan={3}>League scoring</th>
            <th className="edge value" colSpan={2}>Biggest win added</th>
            <th className="edge hm" colSpan={2}>Worst started</th>
          </tr>
          <tr>
            <th className="t">Week</th>
            <th className="n">High score</th>
            <th className="n">Median</th>
            <th className="t edge">Player</th>
            <th className="n key">WAR</th>
            <th className="t edge hm">Player</th>
            <th className="n hm">WAR</th>
          </tr>
        </thead>
        <tbody>
          {wks.map((w, i) => {
            const a = byWeek[w];
            const top = a.reduce((m, e) => e.war > m.war ? e : m);
            const started = a.filter(e => startedBy[w]?.has(e.pid));
            const low = (started.length ? started : a).reduce((m, e) => e.war < m.war ? e : m);
            const sc = scores[w];
            return (
              <tr key={w} className={`click ${openW === w ? "open" : i % 2 ? "zebra" : ""}`}
                onClick={() => setExpWeek(openW === w ? null : w)}>
                <td className="t">
                  <span className="tlink" style={{ font: "700 21px/1 var(--cond)", letterSpacing: ".02em" }}
                    onClick={e => { e.stopPropagation(); nav(lp(`/weekly/${seasonSeg(season)}/${w}`)); }}>W{w}</span>
                  {w >= ps && <span className="tag">PO</span>}
                </td>
                <td className="fig strong n">{sc ? fmt(sc.high, 1) : "—"}</td>
                <td className="fig quiet n">{sc ? fmt(sc.median, 1) : "—"}</td>
                <td className="edge" style={{ whiteSpace: "nowrap" }}>
                  <span className="pos sm" style={{ background: POS[top.pos], marginRight: 8 }}>{top.pos}</span>
                  <span style={{ font: "600 14px/1 var(--sans)" }}>{pInfo(players, top.pid)[0]}</span>
                  <span className="sub" style={{ marginLeft: 8, display: "inline" }}>{fmt(top.pts, 1)} pts · {owners[top.pid] || "—"}</span>
                </td>
                <td className="n" style={{ padding: "6px 10px" }}>
                  <div className="meter">
                    <div className="track week"><div className="fill" style={{ width: Math.round(top.war / twMax * 100) + "%" }} /></div>
                    <span className="val head-fig" style={{ fontSize: 22 }}>{fmt(top.war, 3)}</span>
                  </div>
                </td>
                <td className="edge hm" style={{ whiteSpace: "nowrap" }}>
                  <span className="pos sm" style={{ background: POS[low.pos], marginRight: 8 }}>{low.pos}</span>
                  <span className="quiet" style={{ font: "600 13.5px/1 var(--sans)", color: "var(--txt2)" }}>{pInfo(players, low.pid)[0]}</span>
                  <span className="sub" style={{ marginLeft: 8, display: "inline" }}>{fmt(low.pts, 1)} pts · {owners[low.pid] || "—"}</span>
                </td>
                <td className="hm last n" style={{ font: "700 20px/1 var(--cond)", color: "var(--bad)" }}>{fmt(low.war, 3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openW != null && <WeekDrawer wk={openW} arr={byWeek[openW]} players={players} />}

      <div className="footnote">
        A fixed margin is worth more wins in a low-scoring week — each week's conversion uses that week's
        own <span className="sigma">σ</span> of the twelve team scores
      </div>
    </>
  );
}

/** Top three by WAR at each position, in four columns. */
function WeekDrawer({ wk, arr, players }: { wk: number; arr: Entry[]; players: PlayersMin }) {
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">Week {wk} — top three by position</span>
      </div>
      <div className="pos-cols">
        {["QB", "RB", "WR", "TE"].map(p => {
          const top = arr.filter(e => e.pos === p).sort((a, b) => b.war - a.war).slice(0, 3);
          return (
            <div key={p} className="pos-col" style={{ borderTopColor: POS[p] }}>
              <div className="hd" style={{ color: POS[p] }}>{p}</div>
              {top.map((e, j) => (
                <div key={e.pid} className="row">
                  <span className="n">{j + 1}</span>
                  <span className="nm">{pInfo(players, e.pid)[0]}</span>
                  <span className="pts">{fmt(e.pts, 1)}</span>
                  <span className="war">{fmt(e.war, 3)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Full week page (matchups + top 50 performers), v1 presentation behind `.legacy`. */
function WeekDetail({ wk, season, data, weekly, mw, players, back }: {
  wk: number; season: string; data: SeasonData; weekly: WeeklyT; mw: Matchups; players: PlayersMin; back: () => void;
}) {
  const ps = mw.playoff_start || 15;
  const wkIdx = weekIndex(weekly);
  const tnames: Record<number, string> = {};
  data.teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const ent: Record<string, [number, number, number | null, number | null, string[]]> = {};
  for (const [rid, list] of Object.entries(mw.teams)) {
    const e = list.find(x => x[0] === wk);
    if (e) ent[rid] = e;
  }
  const seen = new Set<number>();
  const pairs: [number, number, number | null, number | null][] = [];
  for (const [rid, e] of Object.entries(ent)) {
    const a = +rid, b = e[2];
    if (seen.has(a)) continue;
    seen.add(a); if (b) seen.add(b);
    pairs.push([a, e[1], b, e[3]]);
  }
  const lineupWar = (rid: number) => {
    const e = ent[String(rid)];
    if (!e) return 0;
    let w = 0;
    for (const p of e[4]) { const v = wkIdx[p]?.[wk]; if (v) w += v[1]; }
    return w;
  };
  const [openPid, setOpenPid] = useState<string | null>(null);
  const owners = ownerOf(data.teams);
  const performers = Object.entries(weekly).flatMap(([pid, rows]) => {
    const w = rows.find(x => x[0] === wk);
    return w ? [{ pid, pts: w[1], paa: w[2], par: w[3], waa: w[4], war: w[5], pos: pInfo(players, pid)[1] }] : [];
  }).sort((a, b) => b.war - a.war);
  return (
    <>
      <span className="back" onClick={back}>← all weeks</span>
      <h2 style={{ margin: "6px 0 12px" }}>Week {wk}{wk >= ps ? " (playoffs)" : ""} — {season}</h2>
      <b style={{ color: "var(--txt)" }}>Matchups</b>
      <table style={{ marginTop: 8 }}>
        <thead><tr>
          <th style={{ textAlign: "left" }}>Team</th><th>Pts</th><th className="hm">Lineup WAR</th>
          <th style={{ textAlign: "left" }}>Team</th><th>Pts</th><th className="hm">Lineup WAR</th>
        </tr></thead>
        <tbody>
          {pairs.map(([a, ap, b, bp]) => {
            const aw = bp != null && ap > bp, bw = bp != null && bp > ap;
            return (
              <tr key={a} style={{ cursor: "default" }}>
                <td style={{ textAlign: "left", ...(aw ? { color: "var(--acc)" } : {}) }}>{tnames[a] || "?"}</td>
                <td className={aw ? "num good" : ""}>{fmt(ap, 1)}</td>
                <td className="hm">{wk < ps ? sgn(lineupWar(a)) : "—"}</td>
                <td style={{ textAlign: "left", ...(bw ? { color: "var(--acc)" } : {}) }}>{b ? tnames[b] : "—"}</td>
                <td className={bw ? "num good" : ""}>{bp == null ? "—" : fmt(bp, 1)}</td>
                <td className="hm">{b && wk < ps ? sgn(lineupWar(b)) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 20 }}>
        <b style={{ color: "var(--txt)" }}>Top 50 performers</b>
        <table style={{ marginTop: 8 }}>
          <thead><tr>
            <th style={{ textAlign: "left" }}>Player</th><th style={{ textAlign: "left" }} className="hm">Roster</th><th>Pos</th>
            <th>Pts</th><th className="hm">vs Avg</th><th className="hm">vs Repl</th><th>WAA</th><th>WAR</th>
          </tr></thead>
          <tbody>
            {performers.slice(0, 50).map(e => (
              <PerfRow key={e.pid} e={e} owner={owners[e.pid]} open={openPid === e.pid}
                onToggle={() => setOpenPid(openPid === e.pid ? null : e.pid)}
                panel={<PlayerPanel pid={e.pid} season={season} teams={data.teams} players={players} />}
                name={pInfo(players, e.pid)[0]} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PerfRow({ e, owner, name, open, onToggle, panel }: {
  e: { pid: string; pts: number; paa: number; par: number; waa: number; war: number; pos: string };
  owner: string | undefined; name: string; open: boolean; onToggle: () => void; panel: React.ReactNode;
}) {
  return (
    <>
      <tr onClick={onToggle}>
        <td style={{ textAlign: "left" }}><PlayerLink pid={e.pid} name={name} /></td>
        <td className="hm roster" style={{ textAlign: "left" }}>{owner || "—"}</td>
        <td><PosBadge pos={e.pos} /></td>
        <td>{fmt(e.pts, 1)}</td>
        <td className={`hm ${clsOf(e.paa)}`}>{sgn(e.paa, 1)}</td>
        <td className={`hm ${clsOf(e.par)}`}>{sgn(e.par, 1)}</td>
        <td className={clsOf(e.waa)}>{fmt(e.waa, 3)}</td>
        <td className={clsOf(e.war)}>{fmt(e.war, 3)}</td>
      </tr>
      {open && <tr className="wkbox"><td colSpan={8}>{panel}</td></tr>}
    </>
  );
}
