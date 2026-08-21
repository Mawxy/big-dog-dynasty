import type { ReactNode } from "react";
import type { PlayersMin, Trade, TradeAsset, TradeSide } from "../lib/types";
import { pInfo } from "../lib/league";
import { fmtWar, sgnWar } from "../lib/stats";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

/**
 * One trade, as two baskets.
 *
 * Three screens drew this by hand — the ledger, the franchise page and a
 * draft's page — off the same `trade / trade-head / trade-sides / trade-side /
 * trade-asset` markup, and drifted apart in every seam that was not the
 * markup: WAR at three decimals here and two there, converted picks showing
 * their realized return on one screen and an em dash on another, player names
 * linked on one and inert on the other two.
 *
 * This component is now the truth on all of that. What stays per-screen is
 * only what each screen genuinely knows and the others do not: whether it can
 * name a winner, whether it has a date, which figure belongs in a side's
 * header, and whether one asset deserves emphasis.
 *
 * Both baskets render in the same neutral ink deliberately — colouring one
 * green and one amber implies a winner when the colour is really just whose
 * row it is (SKILL §5, two-basket comparison).
 */

/** which figure, if any, a side's header carries on the right */
export type SideFig = "none" | "return" | "realized" | "market";

export interface TradeCardProps {
  trade: Trade;
  players: PlayersMin;
  /** accent rail on the card: "" | "win" | "pick" */
  cls?: string;
  /** the trade's date, already formatted (tradeWhen); omitted renders none */
  when?: string;
  /** the ledger's read on who is ahead; omitted renders none */
  verdict?: string;
  verdictColor?: string;
  /** default "none" — no figure block in the side headers */
  sideFig?: SideFig;
  /** extra emphasis on an asset: the draft page lights up its own picks */
  emphasize?: (a: TradeAsset) => boolean;
  /** row-drawer support (SKILL §5): when set, the head grows a details
   *  control and `drawer` renders below the sides inside the card flow —
   *  never a modal, never a separate page */
  open?: boolean;
  onToggle?: () => void;
  drawer?: ReactNode;
}

/** "2024 1st → Marvin Harrison": the pick converted, so the label carries the
 *  player it became. Split once, here, so the asset row and the side total
 *  can't disagree about which assets have produced anything. */
const converted = (a: TradeAsset) => a.label.split(" → ")[1];

/** an asset with a realized return: a player, or a pick that became one */
export const isRealized = (a: TradeAsset) => a.kind === "player" || !!converted(a);

/** realized WAR of a side: what the assets it can be judged on returned. Null
 *  — not zero — when nothing it received has converted yet, because "nothing
 *  yet" and "nothing" are different facts and only one is an em dash. */
export const sideRealized = (s: TradeSide): number | null =>
  s.got.some(isRealized) ? s.war : null;

function Asset({ a, players, emph }: {
  a: TradeAsset; players: PlayersMin; emph: boolean;
}) {
  const isPick = a.kind !== "player";
  const [head, tail] = a.label.split(" → ");
  const real = isRealized(a);
  const pos = !isPick && a.pid ? pInfo(players, a.pid)[1] : "PICK";
  const name = tail ?? head;
  return (
    <div className="trade-asset">
      <PosBadge pos={isPick ? "PICK" : pos} size="sm" text={isPick ? "PK" : pos} />
      <span className={`nm ${!real && !emph ? "pick" : ""}`}
        style={emph ? { color: "var(--txt)" } : undefined}>
        {isPick && tail && <span style={{ color: "var(--dim)" }}>{head} → </span>}
        {a.pid ? <PlayerLink pid={a.pid} name={name} /> : name}
      </span>
      <span className="war" style={{ color: real ? "var(--txt2)" : "var(--dim3)" }}>
        {real ? fmtWar(a.war) : "—"}
      </span>
    </div>
  );
}

function SideHead({ s, fig }: { s: TradeSide; fig: SideFig }) {
  const realized = sideRealized(s);
  return (
    <div className="hd">
      <div>
        <div className="k">Received</div>
        <div className="team">{s.team}</div>
      </div>
      {fig === "return" && (
        <div style={{ display: "flex", gap: 18, textAlign: "right" }}>
          {/* the frozen at-trade expectation, beside what actually landed.
              Pre-snapshot trades read "—" (unknown, not zero); trades with
              only a market backfill show KTC points, labeled as such so the
              two currencies can't be misread as comparable. */}
          <div>
            <div className="k">{s.expThen == null && s.mktThen != null ? "Mkt then · KTC" : "Proj then"}</div>
            <div className="total"
              style={{ color: s.expThen == null && s.mktThen == null ? "var(--dim3)" : "var(--txt2)" }}>
              {s.expThen != null ? fmtWar(s.expThen)
                : s.mktThen != null ? s.mktThen.toLocaleString("en-US") : "—"}
            </div>
          </div>
          <div>
            <div className="k">Return</div>
            <div className="total"
              style={{ color: realized == null ? "var(--dim3)" : undefined }}>
              {realized == null ? "—" : fmtWar(realized)}
            </div>
          </div>
        </div>
      )}
      {fig === "market" && (
        /* the at-trade read, three currencies: what each market said the haul
           was worth when the deal was made, and what the model projected.
           All frozen figures — the change-since lives in the drawer. "—" is
           a side the snapshot can't price (picks, or pre-history). */
        <div style={{ display: "flex", gap: 16, textAlign: "right" }}>
          {([
            ["FC then", s.fcThen != null ? s.fcThen.toLocaleString("en-US") : null],
            ["KTC then", s.mktThen != null ? s.mktThen.toLocaleString("en-US") : null],
            ["Proj WAR", s.expThen != null ? fmtWar(s.expThen) : null],
          ] as const).map(([k, v]) => (
            <div key={k}>
              <div className="k">{k}</div>
              <div className="total" style={{
                fontSize: 20,
                color: v == null ? "var(--dim3)" : "var(--txt2)",
              }}>
                {v ?? "—"}
              </div>
            </div>
          ))}
        </div>
      )}
      {fig === "realized" && (
        <div style={{ textAlign: "right" }}>
          <div className="k">Realized · to come</div>
          <div className="total">
            {fmtWar(s.war)}
            <span style={{ font: "400 14px/1 var(--cond)", color: "var(--dim)" }}>
              {" "}· {sgnWar(s.future ?? 0)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TradeCard({
  trade, players, cls, when, verdict, verdictColor, sideFig = "none", emphasize,
  open, onToggle, drawer,
}: TradeCardProps) {
  return (
    <div className={cls ? `trade ${cls}` : "trade"}>
      {/* the season leads the label: the ledger spans every year, so a bare
          WEEK 3 named four different cards */}
      <div className="trade-head">
        <span className="trade-wk">{trade.season} · WEEK {trade.week}</span>
        {when && <span className="trade-when">{when}</span>}
        {verdict && (
          <span className="trade-verdict" style={{ color: verdictColor }}>{verdict}</span>
        )}
        {onToggle && (
          <button type="button" className="dlink trade-open" aria-expanded={open}
            onClick={onToggle}>
            {open ? "Close ▴" : "Details ▾"}
          </button>
        )}
      </div>
      <div className="trade-sides">
        {trade.sides.map(s => (
          <div key={s.rid} className="trade-side">
            <SideHead s={s} fig={sideFig} />
            {s.got.map((a, k) => (
              <Asset key={k} a={a} players={players} emph={!!emphasize?.(a)} />
            ))}
          </div>
        ))}
      </div>
      {open && drawer}
    </div>
  );
}
