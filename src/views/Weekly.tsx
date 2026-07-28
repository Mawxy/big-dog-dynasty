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
import MatchupDetail from "../components/MatchupDetail";

/** One team's best starter that week; starred when he led the whole league. */
function Mvp({ e, best, players }: {
  e?: { pid: string; pts: number; war: number }; best?: string; players: PlayersMin;
}) {
  if (!e) return null;
  const star = e.pid === best;
  return (
    <div className={`mvp${star ? " top" : ""}`}>
      {star && <span className="star">★</span>}
      <span className="pos sm" style={{ background: `var(--${pInfo(players, e.pid)[1].toLowerCase()})` }}>
        {pInfo(players, e.pid)[1]}
      </span>
      <span className="who">{pInfo(players, e.pid)[0]}</span>
      <span className="fig">{fmt(e.pts, 1)}</span>
      <span className="war">{sgn(e.war, 2)}</span>
    </div>
  );
}

interface Entry { pid: string; pts: number; war: number; pos: string }

interface Props {
  data: SeasonData; season: string; players: PlayersMin;
  week: number | null;
  /** one side's roster_id — renders that single matchup instead of the week */
  matchupRid: number | null;
}

export default function Weekly({ data, season, players, week, matchupRid }: Props) {
  const [weekly, setWeekly] = useState<WeeklyT | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
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

  /**
   * Best STARTER per team per week, plus the best in the league that week.
   *
   * Ranked by WAR rather than raw points: WAR is measured against a per-position
   * replacement baseline, so a 15-point TE can outrank a 20-point WR, which is
   * the whole reason the site computes it. Only starters count — a monster week
   * on someone's bench won anybody nothing.
   */
  const mvps = useMemo(() => {
    // pid -> week -> [points, WAR]
    const idx: Record<string, Record<number, [number, number]>> = {};
    if (!weekly || !mw) return { per: new Map<number, Map<number, { pid: string; pts: number; war: number }>>(), best: new Map<number, string>() };
    for (const [pid, rows] of Object.entries(weekly))
      for (const r of rows) (idx[pid] ??= {})[r[0]] = [r[1], r[5]];

    const per = new Map<number, Map<number, { pid: string; pts: number; war: number }>>();
    for (const [rid, list] of Object.entries(mw.teams)) {
      for (const e of list) {
        const wk = e[0];
        if (!e[1]) continue;                       // unplayed: no MVP to name
        let top: { pid: string; pts: number; war: number } | null = null;
        for (const pid of e[4]) {
          const v = idx[pid]?.[wk];
          if (v && (!top || v[1] > top.war)) top = { pid, pts: v[0], war: v[1] };
        }
        if (!top) continue;
        if (!per.has(wk)) per.set(wk, new Map());
        per.get(wk)!.set(+rid, top);
      }
    }
    // the league's best starter that week is the best of the team MVPs
    const best = new Map<number, string>();
    for (const [wk, m] of per) {
      let pid = "", war = -Infinity;
      for (const v of m.values()) if (v.war > war) { war = v.war; pid = v.pid; }
      best.set(wk, pid);
    }
    return { per, best };
  }, [weekly, mw]);



  if (season === "ALL") return <div className="empty">Weekly is a per-season view — pick a year from the dropdown.</div>;
  if (err) return <div className="empty">Couldn't load weekly data.{" "}
    <button className="retry" onClick={() => setReload(n => n + 1)}>Retry</button></div>;
  if (!weekly || !mw) return <div className="empty">Loading weekly data…</div>;
  const wks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  if (!wks.length) return <div className="empty">No scored weeks yet for this season.</div>;
  if (week !== null && matchupRid !== null)
    return <MatchupDetail season={season} wk={week} rid={matchupRid} data={data}
      weekly={weekly} mw={mw} players={players}
      back={() => nav(lp(`/weekly/${seasonSeg(season)}/${week}`))} />;
  if (week !== null)
    return <div className="legacy"><WeekDetail wk={week} season={season} data={data} weekly={weekly} mw={mw} players={players} back={() => nav(lp(`/weekly/${seasonSeg(season)}`))} /></div>;

  const ps = mw.playoff_start || 15;


  const tname = (rid: number) =>
    data.teams.find(t => t.roster_id === rid)?.team ?? `Roster ${rid}`;

  // Every week the season has, played or scheduled — the index is a fixture
  // list, so a week with no result yet still belongs on it.
  const allWeeks = [...new Set([
    ...wks,
    ...Object.keys(mw.schedule ?? {}).map(Number),
  ])].sort((x, y) => x - y);

  /** the pairings for a week: from played entries when they exist, otherwise
   *  from the published schedule */
  const pairsOf = (w: number): [number, number | null, number, number | null][] => {
    const seen = new Set<number>();
    const out: [number, number | null, number, number | null][] = [];
    for (const [rid, list] of Object.entries(mw.teams)) {
      const e = list.find(x => x[0] === w);
      if (!e || seen.has(+rid)) continue;
      seen.add(+rid); if (e[2]) seen.add(e[2]);
      out.push([+rid, e[2], e[1], e[3]]);
    }
    if (out.length) return out;
    return (mw.schedule?.[String(w)] ?? []).map(([x, y]) => [x, y, 0, null]);
  };

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Week by week</span>
        <span className="screen-note">
          Click a matchup for both lineups · ★ is the week's best starter
        </span>
      </div>

      {allWeeks.map(w => {
        const pairs = pairsOf(w);
        const scored = pairs.some(pr => pr[3] != null);
        return (
          <div className="dwrap" key={w} style={{ paddingBottom: 14 }}>
            <div className="dhead">
              <div className="chart-label" style={{ marginBottom: 0 }}>
                Week {w}{w >= ps ? " · playoffs" : ""}{scored ? "" : " · upcoming"}
              </div>
              <button type="button" className="dtoggle"
                onClick={() => nav(lp(`/weekly/${seasonSeg(season)}/${w}`))}>
                Week detail
              </button>
            </div>
            <div className="dscroll">
              <table className="wide homeboard">
                <tbody>
                  {pairs.map(([x, y, xp, yp]) => {
                    const xw = yp != null && xp > yp, yw = yp != null && yp > xp;
                    return (
                      <tr key={x} className="click"
                        onClick={() => nav(lp(`/weekly/${seasonSeg(season)}/${w}/${x}`))}>
                        <td className="t">
                          <div className={xw ? "nm" : ""}>{tname(x)}</div>
                          <Mvp e={mvps.per.get(w)?.get(x)} best={mvps.best.get(w)} players={players} />
                        </td>
                        <td className="n"><b className={xw ? "good" : ""}>
                          {yp == null && !xp ? "—" : fmt(xp, 1)}</b></td>
                        <td className="c sub" style={{ width: 34 }}>{scored ? "–" : "vs"}</td>
                        <td className="n"><b className={yw ? "good" : ""}>
                          {yp == null ? "—" : fmt(yp, 1)}</b></td>
                        <td className="t">
                          <div className={yw ? "nm" : ""}>{y ? tname(y) : "bye"}</div>
                          {y != null &&
                            <Mvp e={mvps.per.get(w)?.get(y)} best={mvps.best.get(w)} players={players} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}


      <div className="footnote">
        A fixed margin is worth more wins in a low-scoring week — each week's conversion uses that week's
        own <span className="sigma">σ</span> of the twelve team scores
      </div>
    </>
  );
}

/** Top three by WAR at each position, in four columns. */

/** Full week page (matchups + top 50 performers), v1 presentation behind `.legacy`. */
function WeekDetail({ wk, season, data, weekly, mw, players, back }: {
  wk: number; season: string; data: SeasonData; weekly: WeeklyT; mw: Matchups; players: PlayersMin; back: () => void;
}) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const goMatchup = (rid: number) => nav(lp(`/weekly/${seasonSeg(season)}/${wk}/${rid}`));
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
  // A week with no played entries is a FUTURE week — Sleeper publishes the
  // pairings well before kickoff, so the schedule is the only source of the
  // matchup list and every row is a projection rather than a result.
  if (!pairs.length) {
    for (const [x, y] of mw.schedule?.[String(wk)] ?? []) pairs.push([x, 0, y, null]);
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
              <tr key={a} className="click" onClick={() => goMatchup(a)}>
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
