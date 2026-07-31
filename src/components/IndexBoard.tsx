import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Team } from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { ownerOf, rosterSeasonOf, POS_COLOR, POS_CHIPS } from "../lib/league";
import { useLeague } from "../lib/context";
import { PlayerLink } from "./PlayerLink";

/**
 * A 0–100 index leaderboard: rank, player, position, roster, one meter.
 *
 * DVI and CVI render the same board with a different file and field — they
 * were two byte-identical views before this. `pick` names the value field in
 * the file's player records ("dvi" in dvi.json, "cvi" in cvi.json).
 */
interface IndexFile {
  generated: string;
  players: Record<string, { name: string; pos: string; pos_rank: number }
    & Partial<Record<"dvi" | "cvi", number>>>;
}

export default function IndexBoard({ file, pick, title, footnote }: {
  file: string; pick: "dvi" | "cvi"; title: string; footnote: ReactNode;
}) {
  const { league } = useLeague();
  const [data, setData] = useState<IndexFile | null>(null);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [err, setErr] = useState(false);
  const [pos, setPos] = useState("ALL");

  useEffect(() => {
    jlDaily<IndexFile>(file).then(setData).catch(() => setErr(true));
    jl<Team[]>(`${rosterSeasonOf(league)}/teams.json`).then(t => setOwners(ownerOf(t))).catch(() => setOwners({}));
  }, [league, file]);

  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.players)
      .map(([pid, r]) => ({ pid, ...r, value: r[pick] ?? 0 }))
      .filter(r => pos === "ALL" || r.pos === pos)
      .sort((a, b) => b.value - a.value);
  }, [data, pos, pick]);

  if (err) return <div className="empty">No {pick.toUpperCase()} data yet.</div>;
  if (!data) return <div className="empty">Loading {pick.toUpperCase()}…</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{title}</span>
        <span className="screen-note" style={{ marginLeft: 4 }}>Generated {data.generated}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {POS_CHIPS.map(p => (
            <button key={p} className={`chip ${pos === p ? "on" : ""}`} onClick={() => setPos(p)}>
              {p === "ALL" ? "All" : p}
            </button>
          ))}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th className="c" style={{ width: "5%" }}>Rk</th>
            <th className="t">Player</th>
            <th className="c" style={{ width: "7%" }}>Pos</th>
            <th className="t" style={{ width: "22%" }}>Roster</th>
            <th className="n key" style={{ width: "28%" }}>Index</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
              <td className="rank">
                <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule)" }} />
                <span className="fig">{i + 1}</span>
              </td>
              <td className="name"><PlayerLink pid={r.pid} name={r.name} /></td>
              <td className="c">
                <span className="pos wide" style={{ background: POS_COLOR[r.pos] || "var(--rule)" }}>{r.pos}{r.pos_rank}</span>
              </td>
              <td className="sub">{owners[r.pid] || "—"}</td>
              {/* a bare figure, no meter: the index is a clamped 0–100 score,
                  and a bar would restate the number (SKILL §3) */}
              <td className="n last">
                <span className="head-fig md">{r.value.toFixed(1)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footnote">{footnote}</div>
    </>
  );
}
