import { useMemo, useState } from "react";
import type { Trade, TradesPayload } from "../lib/types";
import { useJson } from "../lib/useJson";
import { readTrades, tradeWhen } from "../lib/trades";
import { RouteLink } from "../components/RouteLink";
import { useActivity, useSeasonPhase, type ActMove } from "./model";
import { Band, fmtWar, useBetaPath } from "./ui";

/**
 * WHAT MOVED — the last seven days of trades and roster moves, as one module
 * two screens share (Max, 2026-09-08). League shows the whole league's; Team
 * shows one franchise's, filtered by identity. One computation and one
 * rendering, so a franchise's week is literally the league's week with the
 * other eleven teams taken out, never a lookalike.
 *
 * The band's LABEL changes with the season ("Since Sunday" in-season, "Last 7
 * days" otherwise); the window never does. A week, because that is the cadence
 * a reader checks a league on.
 *
 * Styles: `.lgx-*` in screens/league.css, which League imports eagerly with
 * the shell, so they are on the page before Team renders. Move them with this
 * file if League ever goes lazy.
 */

export const WINDOW_DAYS = 7;

/** An em dash OUTSIDE a table. ui.tsx's NUL rides `.nul`, which beta.css scopes
 *  to `.v3tbl td`; a basket figure is not a table cell. */
const DASH = <span className="lgx-nul">—</span>;

/**
 * The window's trades and moves, scored for size, optionally one franchise's.
 *
 * `rid` narrows both streams to deals that franchise was a side of and moves
 * it made. Trades match on the side's roster id; moves on the franchise KEY,
 * which in a dynasty league IS the roster id as a string — never on the team
 * name, which changes most seasons.
 */
export function useMoved(rid?: number | null) {
  const tradesFile = useJson<TradesPayload>("trades.json").data;
  /* The window is a span of TIME and useActivity's argument is a row count, so
     it is asked for far more rows than it will show and then filtered by
     timestamp. 400 covers seven days with years of slack — this league's whole
     transaction history is about 1,650 rows. */
  const acts = useActivity(400);
  /** the window's opening edge, fixed for the life of the mount so the memo
   *  below is not recomputed on every render by a moving `Date.now()` */
  const since = useMemo(() => Date.now() - WINDOW_DAYS * 86400000, []);
  const trades = useMemo<Trade[]>(
    () => (tradesFile ? readTrades(tradesFile).trades : []), [tradesFile]);

  const recent = useMemo(() => {
    const mine = (t: Trade) => rid == null || t.sides.some(s => s.rid === rid);
    const inWindow = trades.filter(t => t.ts >= since && t.sides.length >= 2 && mine(t));
    /* BIGGEST BY WHAT. trades.json prices a side three ways and all three are
       frozen at the trade: `expThen` (projected WAR), `mktThen` (KTC) and
       `fcThen`. Market points are the only one most sides carry and the only
       one whose magnitude compares across deals, so "biggest" is the largest
       side's at-trade market price.

       A MAX over sides rather than a sum, and the reason is no longer that a
       pick-only side is unpriced — the snapshot has priced picks at their
       mid-tier ladder key since 2026-08-21. It is that the two sides of a deal
       are two readings of ONE size, not two halves of it: summing them would
       rank a trade above an identical one where the picks went the other way,
       and one priced side is enough to size a deal where the other still
       carries an asset the history cannot reach. */
    const size = (t: Trade) => Math.max(0, ...t.sides.map(s => s.mktThen ?? 0));
    const biggest = inWindow.length
      ? inWindow.slice().sort((a, b) => size(b) - size(a) || b.ts - a.ts)[0]
      : null;
    const moves = (acts ?? [])
      .filter((a): a is ActMove => a.kind === "move" && a.ts >= since
        && (rid == null || a.key === String(rid)));
    return {
      trades: inWindow.length, biggest, moves, since,
      // whether the "biggest" claim is actually sized by anything, or whether
      // every side of every trade in the window is unpriced
      sized: biggest ? size(biggest) > 0 : false,
    };
  }, [trades, acts, since, rid]);

  return recent;
}

/**
 * The module: the band, the biggest (or only) trade as a card, the two counts
 * with their ways out, and the moves feed behind the second count.
 *
 * `rid` scopes it to one franchise. The trades count's "All →" then lands on
 * the ledger already filtered to that franchise (`?team=<rid>`), so the reader
 * sees the same population one tap later, not the whole league's.
 */
export default function Moved({ rid, teamName }: {
  rid?: number | null;
  /** the franchise's name, for the quiet band when its week was empty */
  teamName?: string;
}) {
  const betaPath = useBetaPath();
  const phase = useSeasonPhase();
  const recent = useMoved(rid);
  const [openMoves, setOpenMoves] = useState(false);
  const windowFrom = new Date(recent.since)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const who = rid == null ? "" : teamName ? `${teamName} ` : "This franchise ";

  return (
    <>
      <Band label={phase.offseason ? `Last ${WINDOW_DAYS} days` : "Since Sunday"}
        note={`${rid == null ? "Trades and roster moves" : "This franchise's trades and roster moves"} since ${windowFrom}`} />
      {recent.biggest ? <BigTrade trade={recent.biggest} sized={recent.sized} only={recent.trades === 1} /> : (
        /* A QUIET BAND, not an empty table. A week with no trades in it is a
           fact about the league, and a header over twelve pixels of nothing is
           the wrong way to state it. */
        <div className="lgx-quiet">
          {rid == null ? "No trades" : `${who}made no trades`} in the last {WINDOW_DAYS} days.{" "}
          {recent.moves.length
            ? `${recent.moves.length} roster move${recent.moves.length === 1 ? "" : "s"} went through — the count below opens them.`
            : rid == null
              ? "Nothing went through at all, which is a fact about the league rather than a gap in the data."
              : "No roster moves either."}
        </div>
      )}
      <div className="lgx-counts">
        <div className="lgx-count">
          <span className="k">Trades</span>
          <span className="v">{recent.trades}</span>
          {/* the league ledger: every trade this league has ever made, scored —
              filtered to the franchise when this module is */}
          <RouteLink className="go"
            to={betaPath(`/trade?scope=history${rid == null ? "" : `&team=${rid}`}`)}>
            All →
          </RouteLink>
        </div>
        <div className="lgx-count">
          <span className="k">Roster moves</span>
          <span className="v">{recent.moves.length}</span>
          {/* Opens IN PLACE rather than linking out. Waivers and free agents
              have no destination of their own in this shell — the League screen
              is where they have always been shown — and a link to a page that
              does not exist is worse than a disclosure that does. */}
          {recent.moves.length > 0 && (
            <button type="button" className="go" aria-expanded={openMoves}
              onClick={() => setOpenMoves(v => !v)}>
              {openMoves ? "Close ▴" : "All ▾"}
            </button>
          )}
        </div>
      </div>
      {openMoves && (
        <div className="v3-feed">
          {recent.moves.map(a => (
            /* the ACTIVITY'S OWN ID, not ts+team. Sleeper batch-processes
               waivers, so a whole Wednesday's claims share one timestamp to the
               millisecond and one franchise can hold several of them — the old
               key collided and React silently dropped every row after the first
               of each collision, which read as moves that never happened. */
            <div className="v3-act" key={a.id}>
              <div className="when">
                <span>{tradeWhen(a.ts)}</span>
                <span>{a.waiver ? "Waiver" : "Free agent"}</span>
              </div>
              <div className="v3-wv">
                <span className="add"><span className="k">Add</span>{a.adds.join(", ") || "—"}</span>
                <span className="drop"><span className="k">Drop</span>{a.drops.join(", ") || "—"}</span>
              </div>
              {/* whose move — redundant on a franchise's own screen */}
              {rid == null && <div className="idc-s lgx-who">{a.team}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One trade, two neutral baskets.
 *
 * BOTH SIDES ARE NAMED and each lists what it GETS — the two-basket comparison
 * (SKILL §5) — and both take the same ink. Coloring one side would declare a
 * winner, which is exactly what the ledger refuses to declare.
 *
 * WHAT THE FIGURES ARE, AND WHY THEY ARE NOT INDICES. The plan asked for a
 * per-side DVI/CVI swing and the pipeline does not publish one: trades.json
 * carries `war`, `future`, `total`, plus the frozen-at-the-trade `expThen`
 * (projected WAR), `mktThen` (KTC) and `fcThen`, and no index at any level.
 * Summing today's DVI over a side would be worse than absent — a pick has a
 * price and a WAR stream but NO index, so a package containing one silently
 * values it at zero, and the side of the most recent trade here took two 2027
 * picks and would have read 0.0. So the card shows the two frozen figures the
 * file does publish, labeled "then" so they cannot be read as today's price.
 */
export function BigTrade({ trade, sized, only }: {
  trade: Trade; sized: boolean;
  /** the window's one trade — "Biggest" would claim a comparison that never happened */
  only?: boolean;
}) {
  const betaPath = useBetaPath();
  return (
    <a className="v3-act lgx-trade" href={`#${betaPath(`/trade?load=${trade.ts}`)}`}>
      <div className="when">
        {/* the DATE, not "season · week": in the offseason every trade carries
            week 1, and a card headed "2026 · WK 1" in August names a week that
            has not happened */}
        <span>{tradeWhen(trade.ts)}</span>
        <span>{only ? "The trade" : sized ? "Biggest trade" : "Latest trade"}</span>
        {/* `?load=<ts>` opens this deal's own row in the ledger — the Trade
            screen consumes the param, flips itself to the history scope and
            drops it. It is NOT the builder any more: the builder draws from
            current rosters, so the label says where the tap lands. */}
        <span className="go">Ledger →</span>
      </div>
      <div className="v3-baskets">
        {trade.sides.map(s => (
          <div className="bk" key={s.rid}>
            <div className="who">{s.team} gets</div>
            {s.got.map((g, j) => (
              <div className={`it${g.kind !== "player" ? " pick" : ""}`} key={j}>{g.label}</div>
            ))}
            <div className="lgx-bkfig">
              <span className="k">Proj WAR then</span>
              <span className="v">{s.expThen != null ? fmtWar(s.expThen) : DASH}</span>
            </div>
            <div className="lgx-bkfig">
              <span className="k">KTC then</span>
              <span className="v">{s.mktThen != null ? s.mktThen.toLocaleString() : DASH}</span>
            </div>
          </div>
        ))}
      </div>
    </a>
  );
}
