import { useEffect, useState } from "react";
import type { Ownership, PlayersMin, SeasonData, Team } from "../lib/types";
import { j } from "../lib/data";
import { fmt, clsOf, sd, mean } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import PosBadge from "./PosBadge";
import BoxPlot from "./BoxPlot";
import OwnershipHistory from "./OwnershipHistory";

interface Props { pid: string; data: SeasonData; seasons: string[]; teams: Team[]; players: PlayersMin }

export default function AllTimePanel({ pid, data, seasons, teams, players }: Props) {
  const [own, setOwn] = useState<Ownership>({});
  useEffect(() => {
    j<Ownership>("data/ownership.json").catch(() => ({} as Ownership)).then(setOwn);
  }, []);
  const [nm, pos] = pInfo(players, pid);
  const owner = ownerOf(teams)[pid];
  const rows: [string, number, number, number, number, number][] = [];
  const ptsAll: number[] = [];
  for (const s of seasons) {
    const sd_ = data.allData?.[s];
    if (!sd_) continue;
    const r = sd_.summary.find(x => x[0] === pid);
    if (r) rows.push([s, r[2], r[3], r[4], r[5], r[6]]);
    for (const w of sd_.weekly[pid] || []) ptsAll.push(w[1]);
  }
  return (
    <>
      <div className="wkhead">
        <b>{nm}</b> <PosBadge pos={pos} />
        {" · "}{owner ? <>currently owned by <span className="own">{owner}</span></> : "free agent"}
        {ptsAll.length > 0 && <> · {ptsAll.length} games, {fmt(mean(ptsAll), 1)} ppg, σ {fmt(sd(ptsAll), 1)}</>}
      </div>
      <div className="wkflex">
        <div>
          {rows.length ? (
            <div className="wkwrap">
              <table className="wktbl">
                <thead><tr><th>Season</th><th>GP</th><th>Pts</th><th>PPG</th><th>WAA</th><th>WAR</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r[0]}>
                      <td>{r[0]}</td><td>{r[1]}</td><td>{fmt(r[2], 1)}</td><td>{fmt(r[3])}</td>
                      <td className={clsOf(r[4])}>{fmt(r[4], 3)}</td>
                      <td className={clsOf(r[5])}>{fmt(r[5], 3)}</td>
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
