import type { WeeklyRow } from "../lib/types";
import { fmt, sgnWar, clsOf } from "../lib/stats";
import { REG_WEEKS } from "../lib/league";

/**
 * The fixed season strip — one cell per regular-season week, 7 per row: week
 * + points on the top line, a
 * points meter, then the week's WAR colored by sign. Cells are built
 * positionally (every regular-season week, never from the rows that happen to
 * exist), so any
 * two players' seasons compare cell for cell.
 *
 * A bye and a missing week are different facts: a week absent because
 * `absent[wk]` is BYE reads `BYE` at 75% opacity; any other missing week —
 * DNP, not rostered, not yet played — reads `—` at 40%.
 */
export default function WeekGrid({ weeks, absent = {} }: {
  weeks: WeeklyRow[]; absent?: Record<string, string>;
}) {
  const byWk = new Map(weeks.map(w => [w[0], w]));
  const max = Math.max(1, ...weeks.map(w => w[1]));
  return (
    <div className="weekgrid">
      {Array.from({ length: REG_WEEKS }, (_, i) => {
        const wk = i + 1;
        const w = byWk.get(wk);
        if (!w) {
          const bye = absent[String(wk)] === "BYE";
          return (
            <div key={wk} className={`weekcell ${bye ? "bye" : "miss"}`}>
              <div className="top">
                <span className="wk">W{wk}</span>
                <span className="pts">{bye ? "BYE" : "—"}</span>
              </div>
              <div className="bar" />
              <div className="war">{" "}</div>
            </div>
          );
        }
        return (
          <div key={wk} className="weekcell">
            <div className="top">
              <span className="wk">W{wk}</span>
              <span className="pts">{fmt(w[1], 1)}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round(Math.max(0, w[1]) / max * 100)}%` }} />
            </div>
            <div className={`war ${clsOf(w[5])}`}>{sgnWar(w[5])}</div>
          </div>
        );
      })}
    </div>
  );
}
