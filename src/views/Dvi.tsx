import { useEffect, useMemo, useState } from "react";
import { jDaily } from "../lib/data";
import { PlayerLink } from "../components/PlayerLink";
import PosBadge from "../components/PosBadge";

interface DviRow { name: string; pos: string; dvi: number; rank: number }
interface DviFile { generated: string; players: Record<string, DviRow> }

const POS = ["ALL", "QB", "RB", "WR", "TE"];

/** Dynasty Value Index leaderboard. Deliberately shows only the value — no
 *  methodology / component breakdown. */
export default function Dvi() {
  const [data, setData] = useState<DviFile | null>(null);
  const [err, setErr] = useState(false);
  const [pos, setPos] = useState("ALL");

  useEffect(() => {
    jDaily<DviFile>("data/dvi.json").then(setData).catch(() => setErr(true));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.players)
      .map(([pid, r]) => ({ pid, ...r }))
      .filter(r => pos === "ALL" || r.pos === pos)
      .sort((a, b) => b.dvi - a.dvi);
  }, [data, pos]);

  if (err) return <div className="empty">No DVI data yet.</div>;
  if (!data) return <div className="empty">Loading DVI…</div>;

  return (
    <>
      <div className="bar">
        <b style={{ color: "var(--txt)" }}>Dynasty Value Index</b>
        <span style={{ color: "var(--dim)", fontSize: 13, marginLeft: 8 }}>updated {data.generated}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {POS.map(p => (
            <button key={p} onClick={() => setPos(p)}
              style={{
                font: "inherit", fontSize: 12, padding: "2px 9px", borderRadius: 5, cursor: "pointer",
                border: "1px solid var(--line)",
                background: pos === p ? "var(--accent, #4a9)" : "transparent",
                color: pos === p ? "#0b0f14" : "var(--dim)",
              }}>{p}</button>
          ))}
        </span>
      </div>

      <div className="rcard">
        <table>
          <thead>
            <tr>
              <th style={{ width: 46 }}>#</th>
              <th style={{ textAlign: "left" }} className="pcol">Player</th>
              <th style={{ width: 58 }}>Pos</th>
              <th style={{ width: 84 }}>DVI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.pid}>
                <td>{i + 1}</td>
                <td style={{ textAlign: "left" }} className="pcol"><PlayerLink pid={r.pid} name={r.name} /></td>
                <td><PosBadge pos={r.pos} /></td>
                <td><b>{r.dvi.toFixed(1)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
