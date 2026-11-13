import { useCallback, useMemo, type Ref } from "react";
import type { Franchises, Trade as TradeT, TradeAsset, TradeSide, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { pInfo } from "../../lib/league";
import { marketNow } from "../../lib/values";
import { useSeasonPhase } from "../model";
import { fmtWar, NUL, sgnWar } from "../ui";

/**
 * ONE TRADE AS A GRID, shared by the ledger and the trade page (Max,
 * 2026-10-27).
 *
 * Sides across, measures down: what each side got, the WAR it has returned,
 * the WAR still projected, and its market then → now. The old ledger card was
 * a box per side holding a k/v line per measure, so every label printed once
 * per side and a two-team deal ran a phone screen tall. As a grid the labels
 * print once, the two sides' figures sit on one line where the eye compares
 * them, and a trade is half the height.
 *
 * The at-trade read, the realized-WAR rules and today's market port moved
 * here from `Trade.tsx` unchanged, because both screens now render this and
 * neither should import the other.
 */

/* ========================================================================
   FORMATTERS
   ======================================================================== */

/** an unsigned market figure — thousands separated, no decimals */
const mkt = (v: number) => Math.round(v).toLocaleString();

/** A SIGNED market figure carrying the thousands separator the unsigned totals
 *  above it already have. `sgn` is a WAR/index formatter and drops it, which
 *  once put "6,388" and "−4351" in the same column. */
export const sgnMkt = (v: number) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.round(Math.abs(v)).toLocaleString()}`;

/* ========================================================================
   THE FROZEN AT-TRADE READ — one derivation, two readers
   ======================================================================== */

/**
 * `data/leagues/<key>/trade_snapshots.json`, keyed `"<ts>:<rid-rid…>"`.
 *
 * The first nightly run that sees a trade FREEZES what each side's haul was
 * worth on the day and never overwrites it (`scripts/trade_analysis.py`). `mkt`
 * is that side's KTC: players by pid and PICKS BY THEIR MID-TIER LADDER KEY
 * (since 2026-08-21 — a pick is a market asset until draft night), FAAB
 * skipped. It is null only where the writer could not price every asset on the
 * side, or where the committed value history does not reach back to the trade
 * — and entries frozen before picks were priced are backfilled from that
 * history rather than left as permanent em dashes.
 */
export interface SnapSide { exp: number | null; mkt: number | null; fc?: number | null }
export interface Snap { taken: string; kind: string; sides: Record<string, SnapSide> }
export type Snaps = Record<string, Snap>;

/** the snapshot key, built exactly the way the writer builds it: the timestamp,
 *  then the trade's roster ids in ascending numeric order. Doubles as the row
 *  key, because it is unique even for two trades Sleeper stamped in one batch
 *  with the same `ts` — which a bare `ts` was not, and two ledger cards used to
 *  swap contents on any re-render because of it. */
export const snapKey = (t: TradeT) =>
  `${t.ts}:${t.sides.map(s => s.rid).sort((x, y) => x - y).join("-")}`;

export interface AtTrade {
  /** the frozen figures for one side of this trade */
  side: (rid: number) => SnapSide;
  /** THE VALUE COLUMN: the largest at-trade KTC any side of the deal carried.
   *  Null when no side could be priced — never zero, which would read as a
   *  trade of nothing rather than as one the market history cannot reach. */
  value: number | null;
}

/**
 * ONE derivation of the at-trade figures, read by the Value column AND by the
 * drawer.
 *
 * That is the whole point of the hook. The classic ledger derived the column's
 * figure on the card and the drawer's in a second closure over a second source,
 * which is a guarantee that the two disagree the moment either moves. Here the
 * column IS `value` and the drawer IS `side(rid)`, off one record.
 *
 * The fallback is the same figure by another road, not a second opinion:
 * `trade_analysis.py` stamps the snapshot onto each side of trades.json as
 * `mktThen` / `fcThen` / `expThen` in the same pass that writes the snapshot
 * file, so a deploy shipping trades.json without trade_snapshots.json still
 * prices the ledger — from figures frozen on the same day by the same code.
 */
export function useAtTrade(): (t: TradeT) => AtTrade {
  const snaps = useJson<Snaps>("trade_snapshots.json").data;
  return useCallback((t: TradeT): AtTrade => {
    const sn = snaps?.[snapKey(t)];
    const frozen = new Map<number, SnapSide>();
    let value: number | null = null;
    for (const s of t.sides) {
      const rec = sn?.sides[String(s.rid)]
        ?? { exp: s.expThen ?? null, mkt: s.mktThen ?? null, fc: s.fcThen ?? null };
      frozen.set(s.rid, rec);
      if (rec.mkt != null) value = value == null ? rec.mkt : Math.max(value, rec.mkt);
    }
    return { side: rid => frozen.get(rid) ?? { exp: null, mkt: null, fc: null }, value };
  }, [snaps]);
}

/* ========================================================================
   REALIZED WAR
   ======================================================================== */

/** "2024 1st → Marvin Harrison": a pick that CONVERTED carries the player it
 *  became, and only a converted pick has a return anybody can judge. */
const converted = (a: TradeAsset) => a.label.split(" → ")[1];
const isRealized = (a: TradeAsset) => a.kind === "player" || !!converted(a);

/** A side's realized WAR: what the assets it can be judged on returned. Null —
 *  not zero — when nothing it received has converted yet, because "nothing yet"
 *  and "nothing" are different facts and only one of them is an em dash.
 *
 *  Written out again rather than imported from `components/TradeCard.tsx`: that
 *  module is the classic ledger's card, this screen exists to retire it, and
 *  importing a doomed component into its replacement inverts the dependency.
 *  Both copies belong in `lib/trades.ts` the day the classic view goes. */
export const sideRealized = (s: TradeSide): number | null =>
  s.got.some(isRealized) ? s.war : null;

/** Does this trade still hold a pick nobody has drafted with? The ledger
 *  judges a side as soon as any of it has converted; a reader who wants the
 *  whole deal settled first (the Partner analyzer, Max 2026-11-13) asks this. */
export const hasUnmadePick = (t: TradeT): boolean =>
  t.sides.some(s => s.got.some(a => a.kind === "pick" && !converted(a)));

/**
 * A trade's sides in a STABLE order — roster id ascending.
 *
 * `trade_analysis.py` sorts each trade's sides by realized WAR descending, so
 * rendering them in file order would put the franchise that came out ahead in
 * the left column on every row of the ledger. That is a verdict expressed as a
 * layout, and picking a winner is the one thing this table refuses to do.
 * Roster id carries no claim, and it is the order the snapshot key already
 * uses, so the columns line up with the record behind them.
 */
export const ordered = (t: TradeT) => t.sides.slice().sort((a, b) => a.rid - b.rid);

/**
 * THE WAR EDGE, WITH ITS OWNER.
 *
 * A magnitude and the franchise it belongs to, or an em dash and the reason it
 * has none. Never a bare signed number: a margin with no owner is the one thing
 * this column must not be.
 *
 * Four ways it declines, and they are four different facts:
 *   - a three-team deal has no two sides to difference
 *   - no football has been played since the deal (`played`)
 *   - a side received only picks that have not converted, so it has no return
 *   - the two returns are equal, which is a result rather than a refusal
 */
export function warEdge(sides: TradeSide[], played: boolean):
  { v: number | null; owner: string | null; rid?: number; note: string | null } {
  if (sides.length > 2) return { v: null, owner: null, note: "3-team deal" };
  if (!played) return { v: null, owner: null, note: "not yet played" };
  const aw = sideRealized(sides[0]), bw = sideRealized(sides[1]);
  if (aw == null || bw == null) return { v: null, owner: null, note: "picks unconverted" };
  const d = aw - bw;
  if (Math.abs(d) < 0.0005) return { v: 0, owner: null, note: "even" };
  const lead = d > 0 ? sides[0] : sides[1];
  return { v: Math.abs(d), owner: lead.team, rid: lead.rid, note: null };
}

/* ========================================================================
   THE GRID
   ======================================================================== */

/** who a side is: the manager — the handle a reader knows across renames —
 *  and the franchise's name as it stood in that trade */
export interface Who { manager: string | null; team: string }

/** a manager off franchises.json: that season's record for the slot, else the
 *  slot's latest */
export function useWho(): (rid: number, season: string, team: string) => Who {
  const fr = useJson<Franchises>("franchises.json").data;
  return useCallback((rid: number, season: string, team: string) => {
    const ss = fr?.[String(rid)]?.seasons ?? [];
    const rec = ss.find(s => s.season === season) ?? ss[ss.length - 1];
    return { manager: rec?.manager ?? null, team: team.trim() };
  }, [fr]);
}

/** what the grid prices against, built ONCE by the screen — never per card:
 *  a 150-trade ledger building the pick ladder per card allocated ~300 maps
 *  per render before (see the note in History). */
export interface GridCtx {
  at: (t: TradeT) => AtTrade;
  vals: Values | null;
  pickKtc: Map<string, number>;
  tep?: string;
}
export function useGridCtx(): GridCtx {
  const at = useAtTrade();
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const pickKtc = useMemo(() => new Map(vals?.picks?.ktc ?? []), [vals]);
  const { meta } = useLeague();
  return useMemo(() => ({ at, vals: vals ?? null, pickKtc, tep: meta.tep }),
    [at, vals, pickKtc, meta.tep]);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * One asset as two lines: the thing itself, then what kind of thing it is.
 *
 *  - a player: his name, then position · club
 *  - a pick that was MADE: the player it became, then the pick and its slot
 *    ("2025 2nd · 2.09") — the player is the asset now (Max, 2026-09-02)
 *  - a pick still to come: the pick, then whose it is and where it projects,
 *    with the tier's drift since the deal when it moved
 *  - an unused slot keeps its word; FAAB is its amount
 */
function AssetLine({ a, owner, playerTo, sub: withSub = true }: {
  a: TradeAsset;
  /** the manager whose pick it originally was */
  owner: (rid: number) => string;
  /** where a player name links, or nothing (the ledger card is one link) */
  playerTo?: (pid: string) => string;
  /** the second line. Off on a closed transaction card, where an asset is its
   *  name and nothing else; a pick that was made keeps its pick beside the
   *  name there, because "what was traded" was the pick. */
  sub?: boolean;
}) {
  const { players } = useLeague();
  const [head, tail] = a.label.split(" → ");
  const pick = head.replace(/ \((not yet drafted|unused)\)$/, "");
  if (a.kind === "faab") return <span className="trg-a"><span className="nm">{a.label}</span></span>;
  if (a.pid && (a.kind === "player" || tail)) {
    const [, pos, nfl] = pInfo(players, a.pid);
    const name = tail ?? head;
    const sub = a.kind === "pick"
      ? `${pick}${a.slot != null && a.rnd != null ? ` · ${a.rnd}.${pad2(a.slot)}` : ""}`
      : [pos, nfl].filter(Boolean).join(" · ");
    return (
      <span className="trg-a">
        <span className="nm">
          {playerTo ? <a href={`#${playerTo(a.pid)}`}>{name}</a> : name}
          {!withSub && a.kind === "pick" && <span className="pk"> {pick}</span>}
        </span>
        {withSub && sub && <span className="sb">{sub}</span>}
      </span>
    );
  }
  const undrafted = / \(not yet drafted\)$/.test(head);
  const tier = a.tier
    ? (a.tierThen && a.tierThen !== a.tier
      ? `${a.tierThen.toLowerCase()} → ${a.tier.toLowerCase()}`
      : a.tier.toLowerCase())
    : null;
  const sub = undrafted
    ? [a.orig != null ? `${owner(a.orig)}’s` : null, tier ? `proj. ${tier}` : null].filter(Boolean).join(" · ")
    : "slot unused";
  return (
    <span className="trg-a pick">
      <span className="nm">{pick}</span>
      {withSub && sub && <span className="sb">{sub}</span>}
    </span>
  );
}

/**
 * THE GRID. Columns are the sides in roster-id order (never by who is ahead:
 * a winner in the left column is a verdict expressed as a layout), headed by
 * manager over franchise. NOTHING IS INKED: the same row prints both sides of
 * one deal, so a green figure on one and a red on the other declares a winner
 * in CSS. Signs carry direction; that is the whole claim.
 */
export function TradeGrid({ t, ctx, who, owner, playerTo }: {
  t: TradeT; ctx: GridCtx;
  who: (rid: number, season: string, team: string) => Who;
  owner: (rid: number) => string;
  playerTo?: (pid: string) => string;
}) {
  const sides = ordered(t);
  const at = ctx.at(t);
  // a three-team deal shares the width three ways; the label column holds
  const w = sides.length > 2 ? 26 : 39;
  const kw = 100 - w * sides.length;
  return (
    <table className="v3tbl trg">
      <thead>
        <tr>
          <th className="t trg-k" style={{ width: `${kw}%` }} />
          {sides.map(s => {
            const x = who(s.rid, t.season, s.team);
            return (
              <th className="t trg-h" key={s.rid} style={{ width: `${w}%` }}>
                <span className="mgr">{x.manager ?? x.team}</span>
                {x.manager && <span className="tm">{x.team}</span>}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        <tr className="trg-got">
          <th className="t trg-k" scope="row">Got</th>
          {sides.map(s => (
            <td className="t" key={s.rid}>
              {s.got.map((a, i) => <AssetLine key={i} a={a} owner={owner} playerTo={playerTo} />)}
            </td>
          ))}
        </tr>
        <tr>
          <th className="t trg-k" scope="row">WAR</th>
          {sides.map(s => {
            const r = sideRealized(s);
            return <td className="t" key={s.rid}><span className="f">{r == null ? NUL : fmtWar(r)}</span></td>;
          })}
        </tr>
        <tr>
          <th className="t trg-k" scope="row">Proj</th>
          {sides.map(s => (
            <td className="t" key={s.rid}>
              <span className="f">{s.future == null ? NUL : sgnWar(s.future)}</span>
            </td>
          ))}
        </tr>
        <tr>
          <th className="t trg-k" scope="row">KTC</th>
          {sides.map(s => {
            const then = at.side(s.rid).mkt;
            const now = marketNow(s, ctx.vals, ctx.pickKtc, ctx.tep);
            return (
              <td className="t" key={s.rid}>
                {/* nothing either end: one dash, not "— → —" */}
                {then == null && now == null ? NUL
                  : <span className="f">{then == null ? NUL : mkt(then)} → {now == null ? NUL : mkt(now)}</span>}
                {then != null && now != null && <span className="d">{sgnMkt(now - then)} since</span>}
              </td>
            );
          })}
        </tr>
      </tbody>
    </table>
  );
}

/* ========================================================================
   WHETHER ANY FOOTBALL HAS BEEN PLAYED SINCE A TRADE
   ======================================================================== */

/**
 * AT THE WEEK, NOT THE SEASON. Moved here from the ledger so the Transactions
 * page and the Partner analyzer ask the same question the same way.
 *
 * A trade with no scored week behind it has no realized WAR, and 0.00 in
 * that column reads as "returned nothing" rather than as "has not happened".
 * The test was `Number(t.season) <= Number(latest)`, which is true of every
 * trade made this season including one made this morning.
 *
 * `useSeasonPhase` reads the roster season's matchups file and states which
 * week is in progress. The last SCORED week is the one before it; in the
 * playoffs every regular week is scored, and in the offseason none of the
 * roster season's are. A season older than the newest one with results is
 * played outright, and a season newer than it is not; only the current one
 * needs the week.
 */
export function usePlayed(): (t: TradeT) => boolean {
  const phase = useSeasonPhase();
  const lastScored = phase.offseason ? 0
    : phase.playoffs ? phase.playoffStart - 1
      : (phase.week ?? 1) - 1;
  const { latest, loading, rosterSeason } = phase;
  return useCallback((t: TradeT) => {
    const s = Number(t.season), newest = Number(latest);
    if (s !== newest) return s < newest;
    // the week test only speaks for the season the phase was read from; while
    // the file is in flight, or if the two disagree, the season answer stands
    if (loading || rosterSeason !== latest) return true;
    return Number(t.week) <= lastScored;
  }, [latest, loading, rosterSeason, lastScored]);
}

/* ========================================================================
   THE CARD — one trade on the Transactions page (Max, 2026-11-12)
   ======================================================================== */

/** the date without its year or week: the week band above the card carries those */
const whenShort = (ts: number) => ts
  ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  : "—";

/**
 * ONE TRADE, CLOSED BY DEFAULT.
 *
 * The ledger printed every trade as an open grid, so a phone showed two deals
 * a screen and a 158-trade history could not be scanned. A closed card is
 * what moved and who got it, and nothing else. Tapping it opens the figures
 * under the same two columns: realized WAR, projected WAR and KTC then → now,
 * then the WAR edge with its owner and the way to the trade's own page.
 *
 * The top of the card is a real button (the disclosure); the link to the
 * trade page lives in the opened part, because a link inside a button is
 * neither. Sides are in roster-id order and nothing is inked, as on the grid.
 */
export function TradeCard({ t, ctx, who, owner, played, open, onToggle, marked, to, cardRef }: {
  t: TradeT; ctx: GridCtx;
  who: (rid: number, season: string, team: string) => Who;
  owner: (rid: number) => string;
  /** has a scored week passed since the deal */
  played: boolean;
  open: boolean; onToggle: () => void;
  /** the card a `?load=` link named: the view's one accent */
  marked?: boolean;
  /** the trade's own page */
  to: string;
  cardRef?: Ref<HTMLElement>;
}) {
  const sides = ordered(t);
  const at = ctx.at(t);
  const edge = warEdge(sides, played);
  const edgeOwner = edge.rid != null
    ? who(edge.rid, t.season, edge.owner ?? "").manager ?? edge.owner
    : edge.owner;
  return (
    <article ref={cardRef}
      className={`txc${sides.length > 2 ? " n3" : ""}${open ? " open" : ""}${marked ? " on" : ""}`}>
      <button type="button" className="txc-top" aria-expanded={open} onClick={onToggle}>
        <span className="txc-hd">
          <span className="when">
            {whenShort(t.ts)}
            {sides.length > 2 && <b> · 3-team</b>}
          </span>
          <span className="cue">
            {open ? "Hide figures" : "Figures"}<span className="caret">{open ? "▴" : "▾"}</span>
          </span>
        </span>
        <span className="txc-sides">
          {sides.map(s => {
            const x = who(s.rid, t.season, s.team);
            return (
              <span className="txc-side" key={s.rid}>
                <span className="who" title={x.team}>{x.manager ?? x.team} got</span>
                {s.got.map((a, i) => <AssetLine key={i} a={a} owner={owner} sub={open} />)}
              </span>
            );
          })}
        </span>
      </button>
      {open && (
        <div className="txc-more">
          <div className="txc-sides">
            {sides.map(s => {
              const r = sideRealized(s);
              const then = at.side(s.rid).mkt;
              const now = marketNow(s, ctx.vals, ctx.pickKtc, ctx.tep);
              return (
                <dl className="txc-figs" key={s.rid}>
                  <dt>WAR</dt>
                  <dd>{r == null ? NUL : fmtWar(r)}</dd>
                  <dt>Proj</dt>
                  <dd>{s.future == null ? NUL : sgnWar(s.future)}</dd>
                  <dt>KTC</dt>
                  <dd>
                    {/* nothing either end: one dash, not "— → —". The two ends
                        are each unbreakable, so a narrow column wraps between
                        them rather than through a number. */}
                    {then == null && now == null ? NUL : (
                      <>
                        <span className="nw">{then == null ? NUL : mkt(then)} →</span>{" "}
                        <span className="nw">{now == null ? NUL : mkt(now)}</span>
                      </>
                    )}
                    {then != null && now != null && <span className="d">{sgnMkt(now - then)} since</span>}
                  </dd>
                </dl>
              );
            })}
          </div>
          <div className="txc-foot">
            {/* THE MARGIN NAMES ITS OWNER, or says why it has none. Never a
                bare signed figure, and never inked: a record, not a verdict. */}
            <span className="edge">
              WAR edge
              {edge.v == null
                ? <> · {edge.note}</>
                : <><b>{edge.v === 0 ? fmtWar(0) : `+${fmtWar(edge.v)}`}</b>{edgeOwner}</>}
            </span>
            <a className="go" href={`#${to}`}>Where it went ›</a>
          </div>
        </div>
      )}
    </article>
  );
}

/** the caption both screens print under the grid */
export const GRID_NOTE =
  "WAR is what each side's assets produced while starting for the team that got them; a side " +
  "holding only unmade picks has none yet (—). Proj is the discounted WAR still ahead of what it " +
  "still holds. KTC is the side's market on the day of the deal, frozen by the first nightly run " +
  "that saw it, against today's; a pick prices at its tier. A record, not a verdict: no side is inked.";

/* A side's market today moved to `lib/values#marketNow`, shared with the
   classic ledger's drawer. */
