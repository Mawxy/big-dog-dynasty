import { LEAGUE_TEAMS, POS_COLOR } from "../lib/league";
import { useLeaguePath } from "../lib/context";
import { nameSplit, pickLabel, type HistRow } from "../lib/draftHistory";
import { RouteLink } from "./RouteLink";
import TScroll from "./TScroll";

/**
 * One draft as a Sleeper-style board: rows are rounds, columns the draft
 * slots, each cell tinted by the player's position. The one screen where a
 * position tint is allowed as a background — the board IS the position map,
 * there are no figures on it to misread, and the tint is 16% over --bg so
 * names hold contrast.
 *
 * It is also the one screen with NO 3px position spine. Everywhere else the
 * spine is how a row states its position against a neutral background; here the
 * cell is already that colour, so the spine said it twice and read as a bar
 * that stops partway for no reason. Position stays literal on the pick row.
 */
export default function DraftBoardGrid({ rows }: { rows: HistRow[] }) {
  const lp = useLeaguePath();
  // The NFL club briefly lived on the pick row, read off players_min[pid][2].
  // It came back out to pay for 90px columns — it was the widest thing on that
  // row and the board fitting a laptop without sideways scroll was worth more.
  // To restore it: `{players[r.pid]?.[2]}` beside {r.pos}, plus a flex wrapper
  // with min-width:0. Note players_min carries the CURRENT club, not the
  // draft-day one, which nothing in the repo stores.
  const rounds = [...new Set(rows.map(r => r.round))].sort((a, b) => a - b);
  const bySlot = new Map(rows.map(r => [r.slot, r]));
  /**
   * Whose column this is: the ORIGINAL holder of its round-1 pick (`via` if
   * that pick was traded, otherwise whoever used it).
   *
   * Computed once and read by BOTH the header and the cells, because the two
   * only mean something together. Every pick in a column carries the same
   * `via` — it is that column's original owner by definition — so printing the
   * franchise on each cell made every cell repeat its own header. The header
   * states the column's owner once; a cell then only has to speak up when
   * SOMEBODY ELSE made the selection, which is 20 of 48 picks in a rookie
   * draft and 8 of 336 in the startup.
   *
   * MANAGER HANDLES, not franchise names. A column is 116px and the team names
   * in this league run to "Baby Billys Bible Bonkers", which clamped to two
   * lines and truncated anyway; the handles are one short word and fit on one.
   * They are also the more stable label — a franchise gets renamed most
   * offseasons, and a board spanning five drafts renamed the same team five
   * times. The full franchise name is still on every cell's tooltip and is
   * what the tables below the board use.
   */
  const ownerOf = (j: number) => {
    const r1 = bySlot.get(`1.${String(j + 1).padStart(2, "0")}`);
    return r1 ? r1.viaMgr ?? r1.drafterMgr : "";
  };
  return (
    <TScroll box="dscroll" hint="The board scrolls sideways — twelve draft slots, one column each.">
      <div className="dboard">
        {Array.from({ length: LEAGUE_TEAMS }, (_, j) => {
          const r1 = bySlot.get(`1.${String(j + 1).padStart(2, "0")}`);
          // the handle is what shows; the franchise name it belongs to is the
          // thing worth putting behind it, since that is what the tables below
          // the board and the rest of the site call this team
          const team = r1 ? r1.via ?? r1.drafter : "";
          return (
            <div key={`o${j}`} className="ownlbl" title={team}>{ownerOf(j)}</div>
          );
        })}
        {rounds.map(rd => [
          ...Array.from({ length: LEAGUE_TEAMS }, (_, j) => {
            const slot = `${rd}.${String(j + 1).padStart(2, "0")}`;
            const r = bySlot.get(slot);
            if (!r) return <div key={slot} className="dcell empty" />;
            const c = POS_COLOR[r.pos];
            const to = lp(`/player/${r.pid}`);
            // the amber line is the EXCEPTION, so it renders only when the
            // drafter is not the column's owner. No label in front of it: the
            // header directly above says whose column this is, and the same
            // uppercase condensed treatment marks this as the other franchise.
            // "via" would be actively wrong now — it named the original owner,
            // which is the thing that moved up into the header.
            const took = r.drafterMgr === ownerOf(j) ? null : r.drafterMgr;
            return (
              <div key={slot} className="dcell"
                // the full sentence lives here, since the cell no longer spells
                // out the drafter and the header truncates at two lines
                title={r.via ? `${pickLabel(r)} ${r.name} — ${r.drafter}, via ${r.via}`
                  : `${pickLabel(r)} ${r.name} — ${r.drafter}`}
                style={{
                  background: c ? `color-mix(in srgb, ${c} 16%, var(--bg))` : "var(--zebra)",
                }}>
                <div className="pk"><span>{pickLabel(r)}</span><span>{r.pos}</span></div>
                <RouteLink to={to} className="nm tlink">
                  {nameSplit(r.name).map((part, i) => <span key={i}>{part}</span>)}
                </RouteLink>
                {took && <div className="via">{took}</div>}
              </div>
            );
          }),
        ])}
      </div>
    </TScroll>
  );
}
