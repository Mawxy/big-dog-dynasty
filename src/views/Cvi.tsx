import { useEffect, useMemo, useState } from "react";
import type { Team } from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { ownerOf, rosterSeasonOf } from "../lib/league";
import { useLeague } from "../lib/context";
import { PlayerLink } from "../components/PlayerLink";

interface CviRow { name: string; pos: string; cvi: number; rank: number; pos_rank: number }
interface CviFile { generated: string; format?: string; ecrRanked?: number; players: Record<string, CviRow> }

const POS_C: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
const CHIPS = ["ALL", "QB", "RB", "WR", "TE"];

/**
 * Contender Value Index leaderboard — DVI's one-year sibling, same shape.
 *
 * Half FantasyPros redraft consensus, half the non-market signals (projected
 * WAR, roster%, start%). No market input, so no age channel: a 32-year-old who
 * produces this season reads like one.
 */
export default function Cvi() {
  const { league } = useLeague();
  const [data, setData] = useState<CviFile | null>(null);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [err, setErr] = useState(false);
  const [pos, setPos] = useState("ALL");

  useEffect(() => {
    jlDaily<CviFile>("cvi.json").then(setData).catch(() => setErr(true));
    jl<Team[]>(`${rosterSeasonOf(league)}/teams.json`).then(t => setOwners(ownerOf(t))).catch(() => setOwners({}));
  }, [league]);

  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.players)
      .map(([pid, r]) => ({ pid, ...r }))
      .filter(r => pos === "ALL" || r.pos === pos)
      .sort((a, b) => b.cvi - a.cvi);
  }, [data, pos]);

  if (err) return <div className="empty">No CVI data yet.</div>;
  if (!data) return <div className="empty">Loading CVI…</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Contender Value Index</span>
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
                  <div className="track grow"><div className="fill" style={{ width: Math.round(r.cvi) + "%" }} /></div>
                  <span className="val head-fig md">{r.cvi.toFixed(1)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footnote">
        A single 0–100 value for THIS SEASON only — half expert consensus, half production
        and usage · unlike DVI it cannot see age, so it never discounts a producer for getting older
      </div>
    </>
  );
}
