import { useMemo } from "react";
import type { ProjectionsFile, Team } from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi } from "../lib/useIndices";
import { fmt, ord } from "../lib/stats";
import { useLeague } from "../lib/context";
import { lineupOf } from "../lib/league";
import { rosterShapes, type IndexEntry, type RankRow } from "../lib/rosterModel";
import TScroll from "./TScroll";

/** surnames only — the grid is ten columns wide and the full name is on hover */
const surname = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : name;
};

/** rank as figure + meter, with whoever holds the seat named underneath */
const Rank = ({ rank, n, who }: { rank: number; n: number; who: string }) => (
  <span className="cell">
    <span className={`fig${rank === 1 ? " top" : ""}`}>{ord(rank)}</span>
    <span className="track">
      <span className="fill" style={{ width: `${((n - rank + 1) / n) * 100}%` }} />
    </span>
    <span className="who">{who}</span>
  </span>
);


/** one grid: a caption, then a rank row per currency across the nine seats */
function Grid({ rows, n, caption }: { rows: RankRow[]; n: number; caption: string }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="rankcap">{caption}</div>
      <TScroll box="rankwrap" hint="The grid scrolls sideways — one column per lineup seat.">
        <table className="rankgrid">
          <thead><tr>
            <th scope="col" className="t" />
            {rows[0].cells.map((c, i) => <th key={i} scope="col">{c.label}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td className="t"><b>{r.label}</b><span>{r.note}</span></td>
                {r.cells.map((c, i) => (
                  <td key={i} title={c.pid
                    ? `${c.name} — ${fmt(c.value, 1)}`
                      + (c.posRank ? ` — ${c.pos}${c.posRank}` : "")
                    : "no player for this seat"}>
                    <Rank rank={c.rank} n={n} who={c.pid ? surname(c.name) : "—"} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TScroll>
    </>
  );
}

/**
 * Where this roster is strong and where it is thin: the optimal starting eight
 * and the bench behind it, every seat ranked against the same seat league-wide,
 * in both currencies. See rosterShapes.
 */
export default function TeamStrengths({ rid }: { rid: number }) {
  const { meta } = useLeague();
  const proj = useJson<ProjectionsFile>("projections.json").data;
  // the roster season comes out of the projections file, so this path is null
  // until that lands and the hook fetches it when it resolves
  const teams = useJson<Team[]>(proj ? `${proj.meta.roster_season}/teams.json` : null).data;
  // model-aware: these follow the masthead's projection-model control
  const dvi = useDvi();
  const cvi = useCvi();

  const shape = useMemo(() => {
    if (!proj || !teams || !dvi || !cvi) return null;
    // pos_rank comes from the index file itself, so it is the player's rank
    // among ALL QBs/RBs/… in that currency — not his rank among the twelve
    // players sitting in this seat, which is what the grid already shows.
    const flatDvi: Record<string, IndexEntry> = {};
    for (const [pid, r] of Object.entries(dvi.players))
      flatDvi[pid] = { value: r.dvi, posRank: r.pos_rank };
    const flatCvi: Record<string, IndexEntry> = {};
    for (const [pid, r] of Object.entries(cvi.players))
      flatCvi[pid] = { value: r.cvi, posRank: r.pos_rank };
    const lineup = lineupOf(meta);
    return rosterShapes(proj.players, teams,
      { cvi: flatCvi, dvi: flatDvi }, lineup).get(rid) ?? null;
  }, [proj, teams, dvi, cvi, meta, rid]);

  if (!shape || !teams) return null;
  const n = teams.length;

  // No box of its own: this renders inside the franchise page's "Strengths"
  // band, and a bordered card inside a bordered board is the one nesting the
  // system forbids — it also repeated the band's own heading a few pixels
  // below it. The two grids carry their own captions; the band above says
  // what they measure.
  return (
    <>
      <div className="rankcap" style={{ marginTop: 0 }}>
        Rank of {n} <span>· two currencies, each seat optimized separately</span>
      </div>

      <Grid rows={shape.ranks} n={n} caption="Starters" />
      <Grid rows={shape.benchRanks} n={n} caption="Bench" />

      <div className="tnote">
        Each seat ranked against the same seat league-wide. Rows are optimized
        separately, so a seat can hold different players. Superflex reads as QB2;
        the flex is left out — it holds a different position on every roster.
      </div>
    </>
  );
}
