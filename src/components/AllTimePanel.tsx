import { useEffect, useState } from "react";
import type { Ownership, PlayersMin, SeasonData, Team, Weekly } from "../lib/types";
import { jl } from "../lib/data";
import { useJson } from "../lib/useJson";
import { fmt, fmtWar, clsOf, sd, mean } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import PosBadge from "./PosBadge";
import BoxPlot from "./BoxPlot";
import OwnershipHistory from "./OwnershipHistory";
import { PlayerLink } from "./PlayerLink";

interface Props { pid: string; data: SeasonData; seasons: string[]; teams: Team[]; players: PlayersMin }

const NO_OWNERSHIP: Ownership = {};

/** Quick-look dropdown panel in All-time mode (per-season rows). */
export default function AllTimePanel({ pid, data, seasons, teams, players }: Props) {
  const own = useJson<Ownership>("ownership.json").data ?? NO_OWNERSHIP;
  // every season's weekly.json, on the drawer's own open: the board behind it
  // doesn't need them. jl caches, so the next row's drawer costs nothing.
  const [weeks, setWeeks] = useState<Weekly[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all(seasons.map(s => jl<Weekly>(`${s}/weekly.json`).catch(() => ({} as Weekly))))
      .then(w => { if (live) setWeeks(w); });
    return () => { live = false; };
  }, [seasons]);
  const [nm, pos] = pInfo(players, pid);
  const owner = ownerOf(teams)[pid];
  const rows: [string, number, number, number, number, number][] = [];
  const ptsAll: number[] = [];
  for (const s of seasons) {
    const sd_ = data.allData?.[s];
    if (!sd_) continue;
    const r = sd_.summary.find(x => x[0] === pid);
    if (r) rows.push([s, r[2], r[3], r[4], r[5], r[6]]);
  }
  for (const wk of weeks) for (const w of wk[pid] || []) ptsAll.push(w[1]);
  return (
    <>
      <div className="wkhead">
        <b><PlayerLink pid={pid} name={nm} /></b> <PosBadge pos={pos} />
        {" · "}{owner ? <>currently owned by <span className="own">{owner}</span></> : "free agent"}
        {ptsAll.length > 0 && <> · {ptsAll.length} games, {fmt(mean(ptsAll), 1)} ppg, σ {fmt(sd(ptsAll), 1)}</>}
      </div>
      <div className="wkflex">
        <div>
          {rows.length ? (
            <div className="wkwrap">
              <table className="wktbl">
                <thead><tr><th scope="col">Season</th><th scope="col">GP</th><th scope="col">Pts</th><th scope="col">PPG</th><th scope="col">WAA</th><th scope="col">WAR</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r[0]}>
                      <td>{r[0]}</td><td>{r[1]}</td><td>{fmt(r[2], 1)}</td><td>{fmt(r[3])}</td>
                      <td className={clsOf(r[4])}>{fmtWar(r[4])}</td>
                      <td className={clsOf(r[5])}>{fmtWar(r[5])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: "var(--dim)" }}>no data</div>}
        </div>
        <div className="wkright">
          <BoxPlot values={ptsAll} label="Weekly points spread (all seasons)" />
          <OwnershipHistory events={own[pid] || []} />
        </div>
      </div>
    </>
  );
}
