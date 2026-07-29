import { useEffect, useMemo, useState } from "react";
import type { CviFile, DviFile, ProjectionsFile, Team } from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { fmt } from "../lib/stats";
import { useLeague } from "../lib/context";
import { DEFAULT_LINEUP } from "../lib/league";
import { rosterShapes, type IndexEntry, type RankRow } from "../lib/rosterModel";

const ordinal = (v: number) => {
  const s = ["th", "st", "nd", "rd"], m = v % 100;
  return v + (s[(m - 20) % 10] || s[m] || s[0]);
};

/** surnames only — the grid is ten columns wide and the full name is on hover */
const surname = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : name;
};

/** rank as figure + meter, with whoever holds the seat named underneath */
const Rank = ({ rank, n, who }: { rank: number; n: number; who: string }) => (
  <span className="cell">
    <span className={`fig${rank === 1 ? " top" : ""}`}>{ordinal(rank)}</span>
    <span className="track">
      <span className="fill" style={{ width: `${((n - rank + 1) / n) * 100}%` }} />
    </span>
    <span className="who">{who}</span>
  </span>
);


/** one grid: a caption, then a rank row per currency across the nine seats */
function Grid({ rows, n, caption, note }: {
  rows: RankRow[]; n: number; caption: string; note?: string;
}) {
  if (!rows.length) return null;
  return (
    <>
      <div className="rankcap">
        {caption}{note && <span> — {note}</span>}
      </div>
      <div className="rankwrap">
        <table className="rankgrid">
          <thead><tr>
            <th className="t" />
            {rows[0].cells.map((c, i) => <th key={i}>{c.label}</th>)}
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
      </div>
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
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [cvi, setCvi] = useState<CviFile | null>(null);

  useEffect(() => {
    let live = true;
    jl<ProjectionsFile>("projections.json").then(p => {
      if (!live) return;
      setProj(p);
      jl<Team[]>(`${p.meta.roster_season}/teams.json`)
        .then(t => { if (live) setTeams(t); }).catch(() => {});
    }).catch(() => {});
    jlDaily<DviFile>("dvi.json").then(x => { if (live) setDvi(x); }).catch(() => {});
    jlDaily<CviFile>("cvi.json").then(x => { if (live) setCvi(x); }).catch(() => {});
    return () => { live = false; };
  }, []);

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
    const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;
    return rosterShapes(proj.players, teams,
      { cvi: flatCvi, dvi: flatDvi }, lineup).get(rid) ?? null;
  }, [proj, teams, dvi, cvi, meta, rid]);

  if (!shape || !teams) return null;
  const n = teams.length;

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 16px", margin: "12px 0 4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b style={{ color: "var(--txt)", fontSize: 13.5 }}>Strengths &amp; weaknesses</b>
        <span style={{ color: "var(--dim)", fontSize: 12 }}>rank of {n}, two currencies</span>
      </div>

      <Grid rows={shape.ranks} n={n} caption="Starters" />
      <Grid rows={shape.benchRanks} n={n} caption="Bench" />

      <div style={{ color: "var(--dim)", fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
        Each seat ranked against the same seat league-wide. Rows are optimised
        separately, so a seat can hold different players. Superflex reads as QB2;
        the flex is left out — it holds a different position on every roster.
      </div>
    </div>
  );
}
