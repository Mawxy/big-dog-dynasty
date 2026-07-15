import { useEffect, useState } from "react";
import type { Ownership, PlayersMin, Team, Weekly, WeeklyRow } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import PosBadge from "./PosBadge";
import BoxPlot from "./BoxPlot";
import OwnershipHistory from "./OwnershipHistory";
import { PlayerLink } from "./PlayerLink";

interface Props { pid: string; season: string; teams: Team[]; players: PlayersMin }

/** Quick-look dropdown panel for one season (row expansion). */
export default function PlayerPanel({ pid, season, teams, players }: Props) {
  const [wks, setWks] = useState<WeeklyRow[] | null>(null);
  const [own, setOwn] = useState<Ownership>({});
  useEffect(() => {
    let live = true;
    (async () => {
      const [weekly, ownership] = await Promise.all([
        j<Weekly>(`data/${season}/weekly.json`),
        j<Ownership>("data/ownership.json").catch(() => ({} as Ownership)),
      ]);
      if (!live) return;
      setWks((weekly[pid] || []).slice().sort((a, b) => a[0] - b[0]));
      setOwn(ownership);
    })();
    return () => { live = false; };
  }, [pid, season]);

  if (!wks) return <div style={{ color: "var(--dim)" }}>loading…</div>;
  const [nm, pos] = pInfo(players, pid);
  const owner = ownerOf(teams)[pid];
  const pts = wks.map(w => w[1]);
  return (
    <>
      <div className="wkhead">
        <b><PlayerLink pid={pid} name={nm} /></b> <PosBadge pos={pos} />
        {" · "}{owner ? <>owned by <span className="own">{owner}</span></> : "free agent"}
        {pts.length > 0 && <> · {pts.length} games, {fmt(mean(pts), 1)} ppg, σ {fmt(sd(pts), 1)}</>}
      </div>
      <div className="wkflex">
        <div>
          {wks.length ? (
            <div className="wkwrap">
              <table className="wktbl">
                <thead><tr><th>Week</th><th>Pts</th><th>vs Avg</th><th>vs Repl</th><th>WAA</th><th>WAR</th></tr></thead>
                <tbody>
                  {wks.map(w => (
                    <tr key={w[0]}>
                      <td>W{w[0]}</td><td><b>{fmt(w[1], 1)}</b></td>
                      <td className={clsOf(w[2])}>{sgn(w[2], 1)}</td>
                      <td className={clsOf(w[3])}>{sgn(w[3], 1)}</td>
                      <td className={clsOf(w[4])}>{sgn(w[4])}</td>
                      <td className={clsOf(w[5])}>{sgn(w[5])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: "var(--dim)" }}>no weekly data</div>}
        </div>
        <div className="wkright">
          <BoxPlot values={pts} label="Weekly points spread" />
          <OwnershipHistory events={own[pid] || []} />
        </div>
      </div>
    </>
  );
}
