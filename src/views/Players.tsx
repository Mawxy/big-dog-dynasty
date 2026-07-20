import { useEffect, useMemo, useState } from "react";
import type { PlayersMin, ProjectionsFile, SeasonData, SleeperProjFile } from "../lib/types";
import { j } from "../lib/data";
import { fmt, clsOf } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import PosBadge from "../components/PosBadge";
import { PlayerLink } from "../components/PlayerLink";
import PlayerPanel from "../components/PlayerPanel";
import AllTimePanel from "../components/AllTimePanel";

interface Row {
  id: string; nm: string; pos: string; team: string;
  gp: number; pts: number; ppg: number; sdv: number;
  waa: number; war: number; waaG: number; warG: number; posRank: number;
  /** row built from projections (preseason): σ/WAA render as dashes */
  proj?: boolean;
  /** projection row with no Sleeper points projection: Pts/PPG dash too */
  noPts?: boolean;
}
type Key = keyof Row;
const COLS: { label: string; key: Key; hm?: boolean; noUpper?: boolean; w: string }[] = [
  { label: "Player", key: "nm", w: "20%" },
  { label: "Roster", key: "team", hm: true, w: "14%" },
  { label: "Pos", key: "pos", w: "7%" },
  { label: "GP", key: "gp", hm: true, w: "6%" },
  { label: "Pts", key: "pts", hm: true, w: "8%" },
  { label: "PPG", key: "ppg", w: "7%" },
  { label: "σ", key: "sdv", noUpper: true, w: "7%" },
  { label: "WAA", key: "waa", w: "8%" },
  { label: "WAA/G", key: "waaG", hm: true, w: "8%" },
  { label: "WAR", key: "war", w: "8%" },
  { label: "WAR/G", key: "warG", hm: true, w: "8%" },
];

interface Props { data: SeasonData; season: string; seasons: string[]; players: PlayersMin; defaultMinGp: number }

export default function Players({ data, season, seasons, players, defaultMinGp }: Props) {
  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [minGp, setMinGp] = useState<number | null>(null);
  const [sortCol, setSortCol] = useState(9);
  const [dir, setDir] = useState(-1);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [projs, setProjs] = useState<ProjectionsFile | null>(null);
  const [sprojs, setSprojs] = useState<SleeperProjFile | null>(null);
  const gpFloor = minGp ?? defaultMinGp;

  // preseason: no scored weeks yet — fall back to the projection model
  useEffect(() => {
    if (data.summary.length) return;
    let live = true;
    j<ProjectionsFile>("data/projections.json").then(p => { if (live) setProjs(p); }).catch(() => {});
    j<SleeperProjFile>("data/proj_sleeper.json").then(p => { if (live) setSprojs(p); }).catch(() => {});
    return () => { live = false; };
  }, [data]);
  const isProj = !data.summary.length && projs != null
    && String(projs.meta.roster_season) === season;

  const rows = useMemo(() => {
    const owners = ownerOf(data.teams);
    let rs: Row[] = isProj && projs
      ? projs.players.map(p => {
        // same columns as a played season, projected. Composite stream (full
        // healthy 13-game season, no injury discount) — matches Bridge B and
        // the player-page verdict line, so leaderboard and market agree.
        const gp = 13;
        const war = p.composite[0] ?? 0;
        const s = sprojs?.players[p.pid];
        return {
          id: p.pid, nm: pInfo(players, p.pid)[0], pos: p.pos,
          team: owners[p.pid] || "—",
          gp, pts: (s?.ppg ?? 0) * gp, ppg: s?.ppg ?? 0, sdv: 0,
          waa: 0, war, waaG: 0, warG: war / gp,
          posRank: 0, proj: true, noPts: !s,
        };
      })
      : data.summary.map(r => {
        const [id, p, gp, pts, ppg, waa, war, sdv] = r;
        return {
          id, nm: pInfo(players, id)[0], pos: p, team: owners[id] || "—",
          gp, pts, ppg, sdv: sdv || 0, waa, war,
          waaG: gp ? waa / gp : 0, warG: gp ? war / gp : 0, posRank: 0,
        };
      });
    // positional rank by WAR over all players at each position (pre-filter)
    const byPos: Record<string, Row[]> = {};
    rs.forEach(r => (byPos[r.pos] ??= []).push(r));
    Object.values(byPos).forEach(list => {
      list.sort((a, b) => b.war - a.war);
      list.forEach((r, i) => { r.posRank = i + 1; });
    });
    if (gpFloor) rs = rs.filter(r => r.gp >= gpFloor);
    if (pos !== "ALL") rs = rs.filter(r => r.pos === pos);
    if (q) rs = rs.filter(r => r.nm.toLowerCase().includes(q.toLowerCase()));
    const k = COLS[sortCol].key;
    rs.sort((a, b) => typeof a[k] === "string"
      ? (a[k] as string).localeCompare(b[k] as string) * dir
      : ((a[k] as number) - (b[k] as number)) * dir);
    return rs;
  }, [data, players, pos, q, gpFloor, sortCol, dir, isProj, projs, sprojs]);

  const clickCol = (i: number) => {
    if (sortCol === i) setDir(-dir);
    else { setSortCol(i); setDir(i < 3 ? 1 : -1); }
  };

  if (!data.summary.length && !isProj) return <div className="empty">No scored weeks yet for this season — check back after week 1.</div>;
  return (
    <>
      {isProj && (
        <div style={{ color: "var(--dim)", fontSize: 12.5, margin: "0 0 10px" }}>
          No scored weeks yet — showing <b style={{ color: "var(--txt)" }}>projections</b>
          for a full healthy 13-game season: Pts/PPG from Sleeper, WAR = year-1
          composite (no injury discount). σ and WAA are not projected.
        </div>
      )}
      <div className="bar">
        {["ALL", "QB", "RB", "WR", "TE"].map(p => (
          <span key={p} className={`chip ${pos === p ? "on" : ""}`} onClick={() => setPos(p)}>{p === "ALL" ? "All" : p}</span>
        ))}
        <input type="search" placeholder="Search player…" value={q} onChange={e => setQ(e.target.value)} />
        <label style={{ color: "var(--dim)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>min GP
          <input type="number" min={0} max={80} value={gpFloor}
            onChange={e => setMinGp(Math.max(0, +e.target.value || 0))}
            style={{ width: 60, background: "var(--card)", border: "1px solid var(--line)", color: "var(--txt)", padding: "6px 8px", borderRadius: 8 }} />
        </label>
      </div>
      {rows.length === 0
        ? <div className="empty">No players match — try lowering the min-GP filter.</div>
        : (
          <table className="lb">
            <colgroup>
              {COLS.map(c => <col key={c.label} className={c.hm ? "hm" : undefined} style={{ width: c.w }} />)}
            </colgroup>
            <thead>
              <tr>{COLS.map((c, i) => (
                <th key={c.label} className={`${c.hm ? "hm " : ""}${sortCol === i ? "sorted" : ""}`} onClick={() => clickCol(i)}>
                  {c.noUpper ? <span style={{ textTransform: "none" }}>{c.label}</span> : c.label}
                  {sortCol === i ? (dir < 0 ? " ▼" : " ▲") : ""}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <PlayerRow key={r.id} r={r} open={openPid === r.id} showRank={season !== "ALL"}
                  onToggle={() => setOpenPid(openPid === r.id ? null : r.id)}
                  panel={season === "ALL"
                    ? <AllTimePanel pid={r.id} data={data} seasons={seasons} teams={data.teams} players={players} />
                    : <PlayerPanel pid={r.id} season={season} teams={data.teams} players={players} />} />
              ))}
            </tbody>
          </table>
        )}
    </>
  );
}

function PlayerRow({ r, open, onToggle, panel, showRank }: { r: Row; open: boolean; onToggle: () => void; panel: React.ReactNode; showRank: boolean }) {
  return (
    <>
      <tr onClick={onToggle}>
        <td><PlayerLink pid={r.id} name={r.nm} /></td>
        <td className="hm roster" title={r.team}>{r.team}</td>
        <td><PosBadge pos={r.pos} rank={showRank ? r.posRank : undefined} /></td>
        <td className="hm">{r.gp}</td>
        <td className="hm">{r.noPts ? "—" : fmt(r.pts, 1)}</td>
        <td>{r.noPts ? "—" : fmt(r.ppg)}</td>
        <td>{r.proj ? "—" : fmt(r.sdv, 1)}</td>
        <td className={r.proj ? undefined : clsOf(r.waa)}>{r.proj ? "—" : fmt(r.waa, 3)}</td>
        <td className={`hm ${r.proj ? "" : clsOf(r.waaG)}`}>{r.proj ? "—" : fmt(r.waaG, 3)}</td>
        <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
        <td className={`hm ${clsOf(r.warG)}`}>{fmt(r.warG, 3)}</td>
      </tr>
      {open && <tr className="wkbox"><td colSpan={COLS.length}>{panel}</td></tr>}
    </>
  );
}
