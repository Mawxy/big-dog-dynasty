import { useContext, useMemo, useState } from "react";
import type { PlayersMin, SeasonData } from "../lib/types";
import { fmt, clsOf } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import PosBadge from "../components/PosBadge";
import { OpenPlayerContext } from "../components/PlayerLink";

interface Row {
  id: string; nm: string; pos: string; team: string;
  gp: number; pts: number; ppg: number; sdv: number;
  waa: number; war: number; waaG: number; warG: number;
}
type Key = keyof Row;
const COLS: { label: string; key: Key; hm?: boolean; noUpper?: boolean }[] = [
  { label: "Player", key: "nm" },
  { label: "Roster", key: "team", hm: true },
  { label: "Pos", key: "pos" },
  { label: "GP", key: "gp", hm: true },
  { label: "Pts", key: "pts", hm: true },
  { label: "PPG", key: "ppg" },
  { label: "σ", key: "sdv", noUpper: true },
  { label: "WAA", key: "waa" },
  { label: "WAA/G", key: "waaG", hm: true },
  { label: "WAR", key: "war" },
  { label: "WAR/G", key: "warG", hm: true },
];

interface Props { data: SeasonData; players: PlayersMin; defaultMinGp: number }

export default function Players({ data, players, defaultMinGp }: Props) {
  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [minGp, setMinGp] = useState<number | null>(null);
  const [sortCol, setSortCol] = useState(9);
  const [dir, setDir] = useState(-1);
  const openPlayer = useContext(OpenPlayerContext);
  const gpFloor = minGp ?? defaultMinGp;

  const rows = useMemo(() => {
    const owners = ownerOf(data.teams);
    let rs: Row[] = data.summary.map(r => {
      const [id, p, gp, pts, ppg, waa, war, sdv] = r;
      return {
        id, nm: pInfo(players, id)[0], pos: p, team: owners[id] || "—",
        gp, pts, ppg, sdv: sdv || 0, waa, war,
        waaG: gp ? waa / gp : 0, warG: gp ? war / gp : 0,
      };
    });
    if (gpFloor) rs = rs.filter(r => r.gp >= gpFloor);
    if (pos !== "ALL") rs = rs.filter(r => r.pos === pos);
    if (q) rs = rs.filter(r => r.nm.toLowerCase().includes(q.toLowerCase()));
    const k = COLS[sortCol].key;
    rs.sort((a, b) => typeof a[k] === "string"
      ? (a[k] as string).localeCompare(b[k] as string) * dir
      : ((a[k] as number) - (b[k] as number)) * dir);
    return rs;
  }, [data, players, pos, q, gpFloor, sortCol, dir]);

  const clickCol = (i: number) => {
    if (sortCol === i) setDir(-dir);
    else { setSortCol(i); setDir(i < 3 ? 1 : -1); }
  };

  if (!data.summary.length) return <div className="empty">No scored weeks yet for this season — check back after week 1.</div>;
  return (
    <>
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
          <table>
            <thead>
              <tr>{COLS.map((c, i) => (
                <th key={c.label} className={`${c.hm ? "hm " : ""}${sortCol === i ? "sorted" : ""}`} onClick={() => clickCol(i)}>
                  {c.noUpper ? <span style={{ textTransform: "none" }}>{c.label}</span> : c.label}
                  {sortCol === i ? (dir < 0 ? " ▼" : " ▲") : ""}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map(r => <PlayerRow key={r.id} r={r} onClick={() => openPlayer(r.id)} />)}
            </tbody>
          </table>
        )}
    </>
  );
}

function PlayerRow({ r, onClick }: { r: Row; onClick: () => void }) {
  return (
    <>
      <tr onClick={onClick}>
        <td>{r.nm}</td>
        <td className="hm roster" title={r.team}>{r.team}</td>
        <td><PosBadge pos={r.pos} /></td>
        <td className="hm">{r.gp}</td>
        <td className="hm">{fmt(r.pts, 1)}</td>
        <td>{fmt(r.ppg)}</td>
        <td>{fmt(r.sdv, 1)}</td>
        <td className={clsOf(r.waa)}>{fmt(r.waa, 3)}</td>
        <td className={`hm ${clsOf(r.waaG)}`}>{fmt(r.waaG, 3)}</td>
        <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
        <td className={`hm ${clsOf(r.warG)}`}>{fmt(r.warG, 3)}</td>
      </tr>
    </>
  );
}
