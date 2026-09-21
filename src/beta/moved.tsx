import { useMemo, useState, type ReactNode } from "react";
import type { Franchises, Trade, TradesPayload } from "../lib/types";
import { useJson } from "../lib/useJson";
import { useLeagueCaps } from "../lib/caps";
import { ridOf, seasonRowOf } from "../lib/seasons";
import { readTrades, tradeWhen } from "../lib/trades";
import { RouteLink } from "../components/RouteLink";
import { MOVE_LABEL, useActivity, type ActMove } from "./model";
import { Band, fmtWar, useBetaPath } from "./ui";

/**
 * WHAT MOVED — the last seven days of trades and roster moves, as one module
 * two screens share (Max, 2026-09-08). League shows the whole league's; Team
 * shows one franchise's, filtered by identity. One computation and one
 * rendering, so a franchise's week is literally the league's week with the
 * other eleven teams taken out, never a lookalike.
 *
 * THE BAND SAYS WHAT THE WINDOW IS (2026-09-21). It read "Since Sunday" in
 * season and "Last 7 days" out of it, over one fixed rolling window of seven
 * days ending now — so for six days a week the label named a boundary the
 * figures underneath it did not use, and a Friday reader was told a Tuesday
 * waiver claim had happened "since Sunday" when the window in force reached
 * back to the Friday before. One label, and it is the true one. A week,
 * because that is the cadence a reader checks a league on.
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
 * A LEAGUE WITH NO PRICED LEDGER STILL MAKES TRADES.
 *
 * `trades.json` is `trade_analysis.py`'s output and that script runs for the
 * default league only, so in Pineapple Pizza it 404s — and this module used to
 * report a league that had never traded, over a transaction log holding 30 of
 * them. Sleeper's log is the fallback: each franchise records its own side of
 * a deal (`with` / `got` / `gave`), so the two rows sharing a timestamp ARE
 * the two sides, and a `Trade`-shaped object falls straight out of them.
 *
 * What it cannot carry is a PRICE — `expThen` / `mktThen` are the nightly
 * snapshot's, and there is no snapshot without the script. They stay absent,
 * the card prints em dashes for them, and the reader is told a deal happened
 * rather than being told none did.
 */
function txTrades(fr: Franchises | null | undefined, since: number): Trade[] {
  if (!fr) return [];
  const byTs = new Map<number, Trade>();
  for (const [key, f] of Object.entries(fr)) {
    for (const tx of f.tx) {
      if (tx.type !== "trade" || tx.ts < since) continue;
      const row = seasonRowOf(f, tx.season);
      const deal: Trade = byTs.get(tx.ts)
        ?? { ts: tx.ts, season: tx.season, week: tx.week, sides: [] };
      deal.sides.push({
        rid: ridOf(key, row),
        team: row?.name ?? f.seasons[f.seasons.length - 1]?.name ?? "—",
        /* The log names assets in PROSE — "Ja'Marr Chase", never a pid — so
           they are labels and nothing more: no pid to link, no WAR to claim.
           Zero is the only honest realized figure for a deal made this week
           and it is what trades.json carries for one too. */
        got: (tx.got ?? []).map(label => ({
          kind: "player" as const, pid: null, label, war: 0, future: 0,
        })),
        war: 0, future: 0, total: 0,
      });
      byTs.set(tx.ts, deal);
    }
  }
  return [...byTs.values()];
}

/**
 * The window's trades and moves, scored for size, optionally one franchise's.
 *
 * `rid` and `fkey` narrow both streams to deals that franchise was a side of
 * and moves it made. Trades match on the side's ROSTER ID, which is what
 * trades.json is keyed by; moves match on the FRANCHISE KEY, which is the
 * roster id as a string in a dynasty league and the owner's 18-digit Sleeper
 * user_id in a redraft one — so comparing a move's key against `String(rid)`
 * matched nothing at all in Pineapple Pizza, and every franchise there read as
 * having made no moves. Never the team name, which changes most seasons.
 */
export function useMoved(rid?: number | null, fkey?: string | null) {
  const caps = useLeagueCaps();
  // requested only where the pipeline writes one — see `txTrades` for what
  // stands in where it does not
  const tradesFile = useJson<TradesPayload>(caps.trades ? "trades.json" : null).data;
  const fr = useJson<Franchises>("franchises.json").data;
  /* The window is a span of TIME and useActivity's argument is a row count, so
     it is asked for far more rows than it will show and then filtered by
     timestamp. 400 covers seven days with years of slack — this league's whole
     transaction history is about 1,650 rows. */
  const acts = useActivity(400);
  /** the window's opening edge, fixed for the life of the mount so the memo
   *  below is not recomputed on every render by a moving `Date.now()` */
  const since = useMemo(() => Date.now() - WINDOW_DAYS * 86400000, []);
  const trades = useMemo<Trade[]>(
    () => (caps.trades
      ? (tradesFile ? readTrades(tradesFile).trades : [])
      : txTrades(fr, since)),
    [caps.trades, tradesFile, fr, since]);

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
    /* THE FRANCHISE KEY, not `String(rid)`. See the docstring: the two agree
       in a dynasty league and never in a redraft one. `fkey` falls back to the
       rid so a caller that only has one still filters correctly where that is
       the key. */
    const mineKey = fkey ?? (rid == null ? null : String(rid));
    const moves = (acts ?? [])
      .filter((a): a is ActMove => a.kind === "move" && a.ts >= since
        && (mineKey == null || a.key === mineKey));
    return {
      trades: inWindow.length, biggest, moves, since,
      // whether the "biggest" claim is actually sized by anything, or whether
      // every side of every trade in the window is unpriced
      sized: biggest ? size(biggest) > 0 : false,
      /** whether the league has a priced ledger at all — the "All →" link has
       *  nowhere to land without one */
      priced: caps.trades,
    };
  }, [trades, acts, since, rid, fkey, caps.trades]);

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
export default function Moved({ rid, fkey, teamName }: {
  rid?: number | null;
  /** the franchise KEY — what the transaction log is keyed by. See `useMoved`. */
  fkey?: string | null;
  /** the franchise's name, for the quiet band when its week was empty */
  teamName?: string;
}) {
  const betaPath = useBetaPath();
  const recent = useMoved(rid, fkey);
  const [openMoves, setOpenMoves] = useState(false);
  const windowFrom = new Date(recent.since)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const who = rid == null ? "" : teamName ? `${teamName} ` : "This franchise ";

  return (
    <>
      <Band label={`Last ${WINDOW_DAYS} days`}
        note={`${rid == null ? "Trades and roster moves" : "This franchise's trades and roster moves"} since ${windowFrom}`} />
      {recent.biggest ? <BigTrade trade={recent.biggest} sized={recent.sized}
        only={recent.trades === 1} priced={recent.priced} /> : (
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
              filtered to the franchise when this module is. A league the
              pipeline never scores has no ledger to open, so the row states
              the count off the transaction log and stops there rather than
              pointing at an empty screen. */}
          {recent.priced && (
            <RouteLink className="go"
              to={betaPath(`/trade?scope=history${rid == null ? "" : `&team=${rid}`}`)}>
              All →
            </RouteLink>
          )}
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
              {/* THE MOVE'S OWN TYPE. "Waiver or else free agent" put the
                  label "Free agent" on every commissioner move in both
                  leagues — a row where nobody claimed anybody, which is the
                  one thing that line exists to say. */}
              <div className="when">
                <span>{tradeWhen(a.ts)}</span>
                <span>{MOVE_LABEL(a.type)}</span>
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
export function BigTrade({ trade, sized, only, priced = true }: {
  trade: Trade; sized: boolean;
  /** the window's one trade — "Biggest" would claim a comparison that never happened */
  only?: boolean;
  /** whether this league HAS a scored ledger. Without one the card is a
   *  record, not a link: the deal came off the transaction log, the ledger
   *  screen has no row for it, and its frozen figures read as em dashes. */
  priced?: boolean;
}) {
  const betaPath = useBetaPath();
  const head = (
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
      {priced && <span className="go">Ledger →</span>}
    </div>
  );
  const body: ReactNode = (
    <>
      {head}
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
    </>
  );
  return priced
    ? <a className="v3-act lgx-trade" href={`#${betaPath(`/trade?load=${trade.ts}`)}`}>{body}</a>
    : <div className="v3-act lgx-trade">{body}</div>;
}
