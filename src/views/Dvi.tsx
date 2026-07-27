import { useEffect, useMemo, useState } from "react";
import type { Team } from "../lib/types";
import { j, jDaily } from "../lib/data";
import { ownerOf, rosterSeasonOf } from "../lib/league";
import { useLeague } from "../lib/context";
import { PlayerLink } from "../components/PlayerLink";

interface DviRow { name: string; pos: string; dvi: number; rank: number; pos_rank: number }
interface DviFile { generated: string; players: Record<string, DviRow> }

const POS_C: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
const CHIPS = ["ALL", "QB", "RB", "WR", "TE"];

/** Dynasty Value Index leaderboard. One 0–100 value per player, no breakdown. */
export default function Dvi() {
  const { meta } = useLeague();
  const [data, setData] = useState<DviFile | null>(null);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [err, setErr] = useState(false);
  const [pos, setPos] = useState("ALL");

  useEffect(() => {
    jDaily<DviFile>("data/dvi.json").then(setData).catch(() => setErr(true));
    j<Team[]>(`data/${rosterSeasonOf(meta)}/teams.json`).then(t => setOwners(ownerOf(t))).catch(() => setOwners({}));
  }, [meta]);

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
      <div className="screen-head">
        <span className="screen-title">Dynasty Value Index</span>
        <span className="screen-note" style={{ marginLeft: 4 }}>Generated {data.generated}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {CHIPS.map(p => (
            <button key={p} className={`chip ${pos === p ? "on" : ""}`} onClick={() => setPos(p)}>
              {p === "ALL" ? "All" : p}
            </button>
          ))}
        </span>
      </div>

      <table>
        <colgroup>
          <col style={{ width: 56 }} /><col /><col style={{ width: 70 }} />
          <col style={{ width: 230 }} /><col style={{ width: 320 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="c">Rk</th>
            <th className="t">Player</th>
            <th className="c">Pos</th>
            <th className="t">Roster</th>
            <th className="n key">Index</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
              <td className="rank">
                <span className="spine" style={{ background: POS_C[r.pos] || "var(--rule)" }} />
                <span className="fig">{i + 1}</span>
              </td>
              <td className="name"><PlayerLink pid={r.pid} name={r.name} /></td>
              <td className="c">
                <span className="pos wide" style={{ background: POS_C[r.pos] || "var(--rule)" }}>{r.pos}{r.pos_rank}</span>
              </td>
              <td className="sub">{owners[r.pid] || "—"}</td>
              <td className="n last">
                <div className="meter">
                  <div className="track grow"><div className="fill" style={{ width: Math.round(r.dvi) + "%" }} /></div>
                  <span className="val head-fig md">{r.dvi.toFixed(1)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footnote">
        A single 0–100 dynasty value per player — deliberately no component breakdown
      </div>
    </>
  );
}
