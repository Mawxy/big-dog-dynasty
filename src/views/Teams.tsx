import { useContext, useEffect, useMemo, useState } from "react";
import type { Matchups, MatchEntry, PlayersMin, SeasonData, Team, Weekly } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean } from "../lib/stats";
import { pInfo, weekIndex } from "../lib/league";
import PosBadge from "../components/PosBadge";
import { OpenPlayerContext, PlayerLink } from "../components/PlayerLink";

type WkIdx = Record<string, Record<number, [number, number]>>;
interface Row {
  rid: number; seed: number; team: string; manager: string; wins: number; fpts: number;
  rec: string; med: string; medw: number; ppg: number; sdv: number; waa: number; war: number;
  ent: MatchEntry[];
}
type Key = keyof Row;
const COLS: { label: string; key: Key; hm?: boolean; noUpper?: boolean; w?: number | string }[] = [
  { label: "Seed", key: "seed", w: 44 },
  { label: "Team", key: "team" },
  { label: "Manager", key: "manager", hm: true, w: 170 },
  { label: "Record", key: "wins", w: 88 },
  { label: "vs Median", key: "medw", hm: true, w: 96 },
  { label: "PPG", key: "ppg", w: 80 },
  { label: "σ", key: "sdv", noUpper: true, w: 70 },
  { label: "WAA", key: "waa", w: 92 },
  { label: "WAR", key: "war", w: 92 },
];

interface Props { data: SeasonData; season: string; players: PlayersMin }

export default function Teams({ data, season, players }: Props) {
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [sortCol, setSortCol] = useState(0);
  const [dir, setDir] = useState(1);
  const [openRid, setOpenRid] = useState<number | null>(null);
  const [detailRid, setDetailRid] = useState<number | null>(null);

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    Promise.all([
      j<Weekly>(`data/${season}/weekly.json`),
      j<Matchups>(`data/${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } });
    return () => { live = false; };
  }, [season]);

  const wkIdx: WkIdx = useMemo(() => weekly ? weekIndex(weekly) : {}, [weekly]);

  const rows = useMemo<Row[]>(() => {
    if (!mw) return [];
    const ps = mw.playoff_start || 15;
    const weekPts: Record<number, number[]> = {};
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[0] < ps) (weekPts[e[0]] ??= []).push(e[1]);
    const medians: Record<number, number> = {};
    for (const [wk, pts] of Object.entries(weekPts)) {
      const v = pts.slice().sort((a, b) => a - b), n = v.length;
      medians[+wk] = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
    const rs = data.teams.map(t => {
      const ent = mw.teams[String(t.roster_id)] || [];
      const reg = ent.filter(e => e[0] < ps);
      const pts = reg.map(e => e[1]);
      let waa = 0, war = 0;
      for (const e of reg) for (const p of e[4]) {
        const v = wkIdx[p]?.[e[0]];
        if (v) { waa += v[0]; war += v[1]; }
      }
      let mwin = 0, mloss = 0, mtie = 0;
      for (const e of reg) {
        const m = medians[e[0]];
        if (m == null) continue;
        e[1] > m ? mwin++ : e[1] < m ? mloss++ : mtie++;
      }
      const g = t.wins + t.losses + t.ties;
      return {
        rid: t.roster_id, seed: 0, team: t.team, manager: t.manager, wins: t.wins, fpts: t.fpts,
        rec: `${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}`,
        med: `${mwin}-${mloss}${mtie ? "-" + mtie : ""}`, medw: mwin,
        ppg: pts.length ? mean(pts) : (g ? t.fpts / g : 0),
        sdv: sd(pts), waa, war, ent,
      };
    });
    const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins || b.fpts - a.fpts);
    rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
    const k = COLS[sortCol].key;
    rs.sort((a, b) => typeof a[k] === "string"
      ? (a[k] as string).localeCompare(b[k] as string) * dir
      : ((a[k] as number) - (b[k] as number)) * dir);
    return rs;
  }, [data, mw, wkIdx, sortCol, dir]);

  if (season === "ALL") return <div className="empty">Teams are a per-season view — pick a year from the dropdown.</div>;
  if (!mw || !weekly) return <div className="empty">Loading…</div>;
  if (detailRid !== null) {
    const t = data.teams.find(x => x.roster_id === detailRid)!;
    return <TeamDetail t={t} data={data} players={players} back={() => setDetailRid(null)} />;
  }
  const ps = mw.playoff_start || 15;
  const clickCol = (i: number) => {
    if (sortCol === i) setDir(-dir);
    else { setSortCol(i); setDir(i <= 2 ? 1 : -1); }
  };
  return (
    <>
      <table>
        <thead>
          <tr>{COLS.map((c, i) => (
            <th key={c.label} style={{ width: c.w, ...(c.label === "Manager" ? { textAlign: "left" } : {}) }}
              className={`${c.hm ? "hm " : ""}${sortCol === i ? "sorted" : ""}`} onClick={() => clickCol(i)}>
              {c.noUpper ? <span style={{ textTransform: "none" }}>{c.label}</span> : c.label}
              {sortCol === i ? (dir < 0 ? " ▼" : " ▲") : ""}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <TeamRow key={r.rid} r={r} open={openRid === r.rid} ps={ps} wkIdx={wkIdx}
              teams={data.teams} players={players} bySum={data.summary}
              onToggle={() => setOpenRid(openRid === r.rid ? null : r.rid)}
              onOpenDetail={() => setDetailRid(r.rid)} />
          ))}
        </tbody>
      </table>
      <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 8 }}>
        WAA / WAR are summed from each week's actual starting lineup.
        Lineup WAA is measured against the league-wide <i>optimal</i> starter pool, so most teams land below zero — compare teams to each other, not to 0.
        Click a row for matchups &amp; roster highlights · click a team name for the full roster.
      </div>
    </>
  );
}

function TeamRow(props: {
  r: Row; open: boolean; ps: number; wkIdx: WkIdx; teams: Team[]; players: PlayersMin;
  bySum: SeasonData["summary"]; onToggle: () => void; onOpenDetail: () => void;
}) {
  const { r, open, ps, wkIdx, teams, players, bySum, onToggle, onOpenDetail } = props;
  return (
    <>
      <tr onClick={onToggle}>
        <td style={{ color: "var(--dim)" }}>{r.seed}</td>
        <td><span className="tlink" onClick={e => { e.stopPropagation(); onOpenDetail(); }}>{r.team}</span></td>
        <td className="hm" style={{ textAlign: "left", color: "var(--dim)" }}>{r.manager}</td>
        <td>{r.rec}</td>
        <td className="hm">{r.med}</td>
        <td>{fmt(r.ppg, 1)}</td>
        <td>{fmt(r.sdv, 1)}</td>
        <td className={clsOf(r.waa)}>{fmt(r.waa, 3)}</td>
        <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
      </tr>
      {open && (
        <tr className="wkbox"><td colSpan={COLS.length}>
          <TeamPanel r={r} ps={ps} wkIdx={wkIdx} teams={teams} players={players} bySum={bySum} />
        </td></tr>
      )}
    </>
  );
}

function TeamPanel({ r, ps, wkIdx, teams, players, bySum }: {
  r: Row; ps: number; wkIdx: WkIdx; teams: Team[]; players: PlayersMin; bySum: SeasonData["summary"];
}) {
  const tnames: Record<number, string> = {};
  teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const t = teams.find(x => x.roster_id === r.rid)!;
  const sumById = new Map(bySum.map(s => [s[0], s]));
  const ranked = t.players.map(p => sumById.get(p)).filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b[6] - a[6]);
  const five = (a: typeof ranked) => a.map((s, i) => (
    <div key={i}><PlayerLink pid={s[0]} name={pInfo(players, s[0])[0]} /> <PosBadge pos={s[1]} /> <span className={clsOf(s[6])}>{fmt(s[6], 3)}</span></div>
  ));
  return (
    <>
      <div className="wkhead"><b>{r.team}</b> — {r.manager} · {r.rec} · {fmt(r.ppg, 1)} ppg · σ {fmt(r.sdv, 1)}</div>
      <div className="wkflex">
        <div>
          {r.ent.length ? (
            <div className="wkwrap">
              <table className="wktbl">
                <thead><tr><th>Week</th><th>Pts</th><th>Opponent</th><th>Opp Pts</th><th>Res</th><th>Lineup WAR</th></tr></thead>
                <tbody>
                  {r.ent.map(e => {
                    const [wk, pts, opp, opts, starters] = e;
                    let war = 0;
                    for (const p of starters) { const v = wkIdx[p]?.[wk]; if (v) war += v[1]; }
                    const res = opts == null ? "—" : pts > opts ? "W" : pts < opts ? "L" : "T";
                    return (
                      <tr key={wk}>
                        <td>W{wk}{wk >= ps && <> <span className="tag">P</span></>}</td>
                        <td><b>{fmt(pts, 1)}</b></td>
                        <td style={{ textAlign: "left" }}>{opp ? tnames[opp] || "?" : "—"}</td>
                        <td>{opts == null ? "—" : fmt(opts, 1)}</td>
                        <td className={res === "W" ? "num good" : res === "L" ? "num bad" : ""}>{res}</td>
                        <td>{wk < ps ? sgn(war) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: "var(--dim)" }}>no games yet</div>}
        </div>
        <div className="wkright" style={{ fontSize: 12.5, lineHeight: 1.9 }}>
          {ranked.length > 0 && (
            <>
              <b style={{ color: "var(--txt)" }}>Top 5 by WAR</b>
              {five(ranked.slice(0, 5))}
              <div style={{ marginTop: 8 }}><b style={{ color: "var(--txt)" }}>Bottom 5 by WAR</b></div>
              {five(ranked.slice(-5).reverse())}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function TeamDetail({ t, data, players, back }: {
  t: Team; data: SeasonData; players: PlayersMin; back: () => void;
}) {
  const openPlayer = useContext(OpenPlayerContext);
  const sumById = new Map(data.summary.map(s => [s[0], s]));
  const rows = t.players.map(p => {
    const s = sumById.get(p);
    const tag = t.taxi.includes(p) ? "TAXI" : t.reserve.includes(p) ? "IR" : t.starters.includes(p) ? "START" : "";
    return { id: p, nm: pInfo(players, p)[0], pos: pInfo(players, p)[1], tag,
      gp: s ? s[2] : 0, pts: s ? s[3] : 0, ppg: s ? s[4] : 0, waa: s ? s[5] : 0, war: s ? s[6] : 0 };
  }).sort((a, b) => b.war - a.war);
  return (
    <>
      <span className="back" onClick={back}>← all teams</span>
      <div id="teamDetail">
        <h2>{t.team}</h2>
        <div className="mgr">{t.manager} · {t.wins}-{t.losses}{t.ties ? `-${t.ties}` : ""} · {fmt(t.fpts, 1)} pts</div>
        <table>
          <thead><tr><th>Player</th><th>Pos</th><th className="hm">GP</th><th className="hm">Pts</th><th>PPG</th><th>WAA</th><th>WAR</th></tr></thead>
          <tbody>
            {rows.map(r => <PlayerLine key={r.id} r={r} onClick={() => openPlayer(r.id)} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PlayerLine({ r, onClick }: {
  r: { id: string; nm: string; pos: string; tag: string; gp: number; pts: number; ppg: number; waa: number; war: number };
  onClick: () => void;
}) {
  return (
    <>
      <tr onClick={onClick}>
        <td>{r.nm}{r.tag && <span className="tag" style={r.tag === "START" ? { color: "var(--acc)", borderColor: "var(--acc)" } : {}}> {r.tag}</span>}</td>
        <td><PosBadge pos={r.pos} /></td>
        <td className="hm">{r.gp}</td>
        <td className="hm">{fmt(r.pts, 1)}</td>
        <td>{fmt(r.ppg)}</td>
        <td className={clsOf(r.waa)}>{fmt(r.waa, 3)}</td>
        <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
      </tr>
    </>
  );
}
