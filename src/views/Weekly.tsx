import { useEffect, useMemo, useState } from "react";
import type { Matchups, PlayersMin, SeasonData, Weekly as WeeklyT } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf } from "../lib/stats";
import { pInfo, ownerOf, weekIndex } from "../lib/league";
import PosBadge from "../components/PosBadge";

interface Entry { pid: string; pts: number; waa: number; war: number; pos: string }

interface Props { data: SeasonData; season: string; players: PlayersMin }

export default function Weekly({ data, season, players }: Props) {
  const [weekly, setWeekly] = useState<WeeklyT | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [openWeek, setOpenWeek] = useState<number | null>(null);
  const [expWeek, setExpWeek] = useState<number | null>(null);

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    Promise.all([
      j<WeeklyT>(`data/${season}/weekly.json`),
      j<Matchups>(`data/${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } });
    return () => { live = false; };
  }, [season]);

  const byWeek = useMemo(() => {
    const bw: Record<number, Entry[]> = {};
    if (weekly) for (const [pid, rows] of Object.entries(weekly))
      for (const [wk, pts, , , waa, war] of rows)
        (bw[wk] ??= []).push({ pid, pts, waa, war, pos: pInfo(players, pid)[1] });
    return bw;
  }, [weekly, players]);

  const startedBy = useMemo(() => {
    const sb: Record<number, Set<string>> = {};
    if (mw) for (const list of Object.values(mw.teams))
      for (const e of list) for (const p of e[4] || []) (sb[e[0]] ??= new Set()).add(p);
    return sb;
  }, [mw]);

  if (season === "ALL") return <div className="empty">Weekly is a per-season view — pick a year from the dropdown.</div>;
  if (!weekly || !mw) return <div className="empty">Loading weekly data…</div>;
  const wks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  if (!wks.length) return <div className="empty">No scored weeks yet for this season.</div>;
  if (openWeek !== null) {
    return <WeekDetail wk={openWeek} season={season} data={data} weekly={weekly} mw={mw} players={players} back={() => setOpenWeek(null)} />;
  }

  const line = (e: Entry) => (
    <>{pInfo(players, e.pid)[0]} <PosBadge pos={e.pos} /> <span style={{ color: "var(--dim)" }}>{fmt(e.pts, 1)} pts</span></>
  );
  return (
    <>
      <table>
        <thead><tr>
          <th>Week</th><th style={{ textAlign: "left" }}>Biggest WAR</th><th>WAR</th>
          <th style={{ textAlign: "left" }} className="hm">Lowest WAR (started)</th><th className="hm">WAR</th>
        </tr></thead>
        <tbody>
          {wks.map(w => {
            const a = byWeek[w];
            const topWar = a.reduce((m, e) => e.war > m.war ? e : m);
            const started = a.filter(e => startedBy[w]?.has(e.pid));
            const lowWar = (started.length ? started : a).reduce((m, e) => e.war < m.war ? e : m);
            return (
              <WeekRow key={w} w={w} open={expWeek === w} arr={a} players={players}
                onToggle={() => setExpWeek(expWeek === w ? null : w)}
                onOpen={() => setOpenWeek(w)}
                cells={
                  <>
                    <td style={{ textAlign: "left" }}>{line(topWar)}</td>
                    <td className={clsOf(topWar.war)}>{fmt(topWar.war, 3)}</td>
                    <td style={{ textAlign: "left" }} className="hm">{line(lowWar)}</td>
                    <td className={`hm ${clsOf(lowWar.war)}`}>{fmt(lowWar.war, 3)}</td>
                  </>
                } />
            );
          })}
        </tbody>
      </table>
      <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 8 }}>
        Click a row for the top 5 at each position · click the week number for full matchups &amp; leaders.
      </div>
    </>
  );
}

function WeekRow({ w, open, arr, players, onToggle, onOpen, cells }: {
  w: number; open: boolean; arr: Entry[]; players: PlayersMin;
  onToggle: () => void; onOpen: () => void; cells: React.ReactNode;
}) {
  const col = (pos: string) => {
    const top = arr.filter(e => e.pos === pos).sort((a, b) => b.war - a.war).slice(0, 5);
    return (
      <div style={{ minWidth: 200 }} key={pos}>
        <PosBadge pos={pos} />
        {top.map((e, i) => (
          <div key={e.pid}>{i + 1}. {pInfo(players, e.pid)[0]}{" "}
            <span style={{ color: "var(--dim)" }}>{fmt(e.pts, 1)}</span>{" "}
            <span className={clsOf(e.war)}>{fmt(e.war, 3)}</span></div>
        ))}
      </div>
    );
  };
  return (
    <>
      <tr onClick={onToggle}>
        <td style={{ textAlign: "left" }}><span className="tlink" onClick={e => { e.stopPropagation(); onOpen(); }}>W{w}</span></td>
        {cells}
      </tr>
      {open && (
        <tr className="wkbox"><td colSpan={5}>
          <div style={{ color: "var(--dim)", fontSize: 11, marginBottom: 4 }}>top 5 by WAR — points · WAR</div>
          <div className="wkflex" style={{ fontSize: 12.5, lineHeight: 1.9, gap: 32 }}>
            {["QB", "RB", "WR", "TE"].map(col)}
          </div>
        </td></tr>
      )}
    </>
  );
}

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
            const aw = ap > (bp ?? -1), bw = bp != null && bp > ap;
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
              <tr key={e.pid} style={{ cursor: "default" }}>
                <td style={{ textAlign: "left" }}>{pInfo(players, e.pid)[0]}</td>
                <td className="hm roster" style={{ textAlign: "left" }}>{owners[e.pid] || "—"}</td>
                <td><PosBadge pos={e.pos} /></td>
                <td>{fmt(e.pts, 1)}</td>
                <td className={`hm ${clsOf(e.paa)}`}>{sgn(e.paa, 1)}</td>
                <td className={`hm ${clsOf(e.par)}`}>{sgn(e.par, 1)}</td>
                <td className={clsOf(e.waa)}>{fmt(e.waa, 3)}</td>
                <td className={clsOf(e.war)}>{fmt(e.war, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
