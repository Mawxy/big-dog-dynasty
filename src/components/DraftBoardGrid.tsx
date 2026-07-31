import { useNavigate } from "react-router-dom";
import { POS_COLOR } from "../lib/league";
import { useLeaguePath } from "../lib/context";
import { nameSplit, pickLabel, type HistRow } from "../lib/draftHistory";

/**
 * One draft as a Sleeper-style board: rows are rounds, columns the draft
 * slots, each cell tinted by the player's position. The one screen where a
 * position tint is allowed as a background — the board IS the position map,
 * there are no figures on it to misread, and the tint is 16% over --bg so
 * names hold contrast. The 3px position spine stays as the primary encoding.
 */
export default function DraftBoardGrid({ rows }: { rows: HistRow[] }) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const rounds = [...new Set(rows.map(r => r.round))].sort((a, b) => a - b);
  const bySlot = new Map(rows.map(r => [r.slot, r]));
  return (
    <div className="dscroll">
      <div className="dboard">
        {/* whose slot each column is: the ORIGINAL holder of the round-1
            pick at that position (via, if it was traded) */}
        {Array.from({ length: 12 }, (_, j) => {
          const r1 = bySlot.get(`1.${String(j + 1).padStart(2, "0")}`);
          const own = r1 ? r1.via ?? r1.drafter : "";
          return <div key={`o${j}`} className="ownlbl" title={own}>{own}</div>;
        })}
        {rounds.map(rd => [
          ...Array.from({ length: 12 }, (_, j) => {
            const slot = `${rd}.${String(j + 1).padStart(2, "0")}`;
            const r = bySlot.get(slot);
            if (!r) return <div key={slot} className="dcell empty" />;
            const c = POS_COLOR[r.pos];
            return (
              <div key={slot} className="dcell"
                title={r.via ? `${pickLabel(r)} ${r.name} — ${r.drafter}, via ${r.via}` : undefined}
                style={{
                  borderLeftColor: c ?? "var(--rule)",
                  background: c ? `color-mix(in srgb, ${c} 16%, var(--bg))` : "var(--zebra)",
                }}>
                <div className="pk"><span>{pickLabel(r)}</span><span>{r.pos}</span></div>
                <div className="nm tlink"
                  onClick={e => { e.stopPropagation(); nav(lp(`/player/${r.pid}`)); }}>
                  {nameSplit(r.name).map((part, i) => <span key={i}>{part}</span>)}
                </div>
                <div className="by">{r.drafter}</div>
                {r.via && <div className="via">via {r.via}</div>}
              </div>
            );
          }),
        ])}
      </div>
    </div>
  );
}
