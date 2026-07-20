import type { Trade, TradeAsset, TradesPayload } from "../lib/types";

/** Normalise either trades.json shape into { trades, delta }. */
export function readTrades(p: TradesPayload) {
  return Array.isArray(p)
    ? { trades: p, delta: null as number | null }
    : { trades: p.trades ?? [], delta: p.meta?.delta ?? null };
}
import { fmt, sgn, clsOf } from "../lib/stats";
import { PlayerLink } from "./PlayerLink";

const KIND: Record<string, string> = { player: "player", pick: "pick", faab: "FAAB" };

export const tradeWhen = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

function Asset({ a }: { a: TradeAsset }) {
  // "2022 2nd → CeeDee Lamb" resolves to a player; "2027 1st (not yet drafted)"
  // has no arrow, so the head IS the whole label — don't print it twice
  const [head, tail] = a.label.split(" → ");
  const name = tail ?? head;
  return (
    <tr style={{ cursor: "default" }}>
      <td style={{ textAlign: "left" }}>
        <span className="tag">{KIND[a.kind] ?? a.kind}</span>{" "}
        {a.kind === "pick" && tail && <span style={{ color: "var(--dim)" }}>{head} → </span>}
        {a.pid ? <PlayerLink pid={a.pid} name={name} /> : name}
      </td>
      <td className={clsOf(a.war)} style={{ textAlign: "right" }}>{fmt(a.war, 2)}</td>
      <td style={{ textAlign: "right", color: "var(--dim)" }}>
        {a.future ? `+${fmt(a.future, 2)}` : ""}</td>
    </tr>
  );
}

/**
 * One trade, as shown on the Trades page and on a franchise's Transactions
 * tab. `highlightRid` outlines the side belonging to the franchise being
 * viewed, so a team's own return reads first.
 */
export default function TradeCard({ t, open, onToggle, highlightRid }:
  { t: Trade; open: boolean; onToggle: () => void; highlightRid?: number }) {
  // the edge is judged on REALIZED WAR only — projection is promise, not return
  const mine = highlightRid === undefined ? undefined : t.sides.find(s => s.rid === highlightRid);
  const others = t.sides.filter(s => s !== mine);
  // On a franchise page the edge is SIGNED from that team's point of view —
  // negative when they lost the trade. League-wide it's just the spread.
  const edge = mine && others.length
    ? mine.war - Math.max(...others.map(s => s.war))
    : Math.max(...t.sides.map(s => s.war)) - Math.min(...t.sides.map(s => s.war));
  // the viewing franchise's side leads
  const sides = highlightRid === undefined ? t.sides
    : [...t.sides].sort((a, b) => Number(b.rid === highlightRid) - Number(a.rid === highlightRid));
  return (
    <div className="trade" onClick={onToggle}>
      <div className="tradehead">
        <span className="ownwk">{t.season} W{t.week}</span>
        <span style={{ color: "var(--dim)", fontSize: 12 }}>{tradeWhen(t.ts)}</span>
        <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 12 }}>
          {Math.abs(edge) < 0.001 ? "even" : `${sgn(edge, 2)} WAR edge`} · {open ? "hide" : "detail"}
        </span>
      </div>
      <div className="tradesides">
        {sides.map(s => (
          <div key={s.rid} className="tradeside">
            <div className="tradeteam">{s.team}</div>
            {/* realized and projected stay separate — summing them hides which
                side actually produced and which is still promise */}
            <div className="tradenum">
              <span className={"tradewar " + clsOf(s.war)}>{fmt(s.war, 2)}</span>
              <span className="tradelbl">real</span>
            </div>
            <div className="tradenum">
              <span className={"tradewar " + clsOf(s.future ?? 0)}>{fmt(s.future ?? 0, 2)}</span>
              <span className="tradelbl">proj</span>
            </div>
            {open
              ? <table style={{ width: "100%" }}>
                <tbody>{s.got.map((a, k) => <Asset key={k} a={a} />)}</tbody>
              </table>
              : <div className="tradeassets">
                {s.got.map(a => a.label.split(" → ").slice(-1)[0]).join(", ")}
              </div>}
          </div>
        ))}
      </div>
    </div>
  );
}
