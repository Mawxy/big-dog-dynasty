import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Team } from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { ownerOf, rosterSeasonOf, POS_COLOR } from "../lib/league";
import { useLeague } from "../lib/context";
import { PlayerLink } from "./PlayerLink";
import { usePlayerFilters } from "./PlayerBoard";

/**
 * A 0–100 index leaderboard: rank, player, position, roster, one figure.
 *
 * DVI and CVI render the same board with a different file and field — they
 * were two byte-identical views before this. `pick` names the value field in
 * the file's player records ("dvi" in dvi.json, "cvi" in cvi.json).
 *
 * Structurally this is the Players hub's board with one measure instead of
 * six: same screen header, same filter bar, same identity columns, same rank
 * spine. It used to hang its position chips off the right edge of the title
 * row and drop the alignment classes, so the two index pages were the only
 * leaderboards on the site that didn't read like the rest of them.
 */
interface IndexFile {
  generated: string;
  players: Record<string, { name: string; pos: string; pos_rank: number }
    & Partial<Record<"dvi" | "cvi", number>>>;
}

/** what the shared filter bar needs, plus what this board draws */
interface IdxRow {
  pid: string; nm: string; pos: string; posRank: number; value: number;
}

export default function IndexBoard({ file, pick, title, note, footnote }: {
  file: string; pick: "dvi" | "cvi"; title: string;
  /** the band's methodology line — what this index is measured against */
  note: string;
  footnote: ReactNode;
}) {
  const { league } = useLeague();
  const [data, setData] = useState<IndexFile | null>(null);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [err, setErr] = useState(false);
  const { bar, apply } = usePlayerFilters<IdxRow>();

  useEffect(() => {
    // DVI and CVI are the same component on two routes, so without this guard
    // a switch between them could land the slow fetch after the fast one and
    // print the other index's numbers under this one's title
    let live = true;
    setData(null);
    setErr(false);
    jlDaily<IndexFile>(file)
      .then(d => { if (live) setData(d); })
      .catch(() => { if (live) setErr(true); });
    jl<Team[]>(`${rosterSeasonOf(league)}/teams.json`)
      .then(t => { if (live) setOwners(ownerOf(t)); })
      .catch(() => { if (live) setOwners({}); });
    return () => { live = false; };
  }, [league, file]);

  /** sorted on the full population, then filtered — so a position view keeps
   *  the ranks the whole board gave it */
  const rows = useMemo(() => {
    if (!data) return [];
    const all: IdxRow[] = Object.entries(data.players)
      .map(([pid, r]) => ({
        pid, nm: r.name, pos: r.pos, posRank: r.pos_rank, value: r[pick] ?? 0,
      }))
      .sort((a, b) => b.value - a.value);
    return apply(all);
  }, [data, pick, apply]);

  const label = pick.toUpperCase();
  if (err) return <div className="empty">No {label} data yet.</div>;
  if (!data) return <div className="empty">Loading {label}…</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{title}</span>
        <span className="screen-note">
          Generated {data.generated} · <b>{rows.length}</b> shown
        </span>
      </div>
      {bar}

      <div className="band">
        <span className="band-label">{label} · every scored player</span>
        <span className="band-note">{note}</span>
      </div>

      <table style={{ tableLayout: "fixed" }}>
        <thead>
          <tr>
            <th className="c" style={{ width: "5%" }}>Rk</th>
            <th className="t">Player</th>
            <th className="c" style={{ width: "8%" }}>Pos</th>
            <th className="t hm" style={{ width: "22%" }}>Roster</th>
            <th className="n key" style={{ width: "28%" }}>Index</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
              <td className="spine-cell">
                <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }} />
                <span className="rank">{i + 1}</span>
              </td>
              <td className="t name"><PlayerLink pid={r.pid} name={r.nm} /></td>
              <td className="c">
                <span className="pos wide" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }}>
                  {r.pos}{r.posRank}
                </span>
              </td>
              <td className="t sub hm">{owners[r.pid] || "—"}</td>
              {/* a bare figure, no meter: the index is a clamped 0–100 score,
                  and a bar would restate the number (SKILL §3) */}
              <td className="n last">
                <span className="head-fig md">{r.value.toFixed(1)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="tnote screen">{footnote}</div>
    </>
  );
}
