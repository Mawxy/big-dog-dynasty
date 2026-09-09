import { Fragment } from "react";
import type { PlayersMin, RecentAsset, RecentPlayer, RecentTrade, RecentTrades } from "../lib/types";
import { pInfo } from "../lib/league";

/**
 * THE RECENT-TRADES VOCABULARY, shared (Max, 2026-09-09): the four-figure
 * strip and the trade rows that the player page shows three of and the
 * player's Trades page shows all of. One renderer, so the preview is
 * literally the head of the full list.
 */

/** KTC's own ladder of TE-premium classes, as the crawl records them */
export const TEP_LABEL: Record<string, string> = { tep: "TE+", tepp: "TE++", teppp: "TE+++" };
/** the day, without its year — a 7-day window never crosses one that matters */
export const whenDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const num = (n: number) => n.toLocaleString("en-US");

/** an asset's name: the bucket's own name map first (it covers every body
 *  traded in 46k leagues), this league's players_min second */
export function assetNamer(file: RecentTrades | null | undefined, players: PlayersMin) {
  return (a: RecentAsset) => {
    if (a[0] !== "p") return a[1];
    const n = file?.names[a[1]]?.[0];
    if (n && !n.startsWith("#")) return n;
    return pInfo(players, a[1])[0];
  };
}

export function RecentFigs({ recent }: { recent: RecentPlayer }) {
  const diff = recent.paid != null && recent.value != null ? recent.paid - recent.value : null;
  return (
    <div className="rtx-figs">
      <div className="fg">
        <div className="k">Trades</div>
        <div className="v">{recent.n}</div>
        <div className="s">{recent.cp} as centerpiece</div>
      </div>
      <div className="fg">
        <div className="k">Going for</div>
        <div className="v">{recent.paid == null ? "—" : num(recent.paid)}</div>
        <div className="s">{recent.paid == null ? "throw-in only" : `avg of ${recent.cp}`}</div>
      </div>
      <div className="fg">
        <div className="k">KTC value</div>
        <div className="v">{recent.value == null ? "—" : num(recent.value)}</div>
        <div className="s">face, TE-premium matched</div>
      </div>
      <div className="fg">
        <div className="k">Difference</div>
        <div className="v">
          {diff == null ? "—" : `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${num(Math.abs(diff))}`}
        </div>
        <div className="s">
          {diff == null || !recent.value ? "market points"
            : `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(Math.round(100 * diff / recent.value))}% of value`}
        </div>
      </div>
    </div>
  );
}

export function RecentRows({ pid, trades, file, players }: {
  pid: string; trades: RecentTrade[]; file: RecentTrades | null | undefined; players: PlayersMin;
}) {
  const assetName = assetNamer(file, players);
  return (
    <div className="rtx-list">
      {trades.map((tr, i) => {
        const mine = tr.s === 0 ? tr.a : tr.b;
        const theirs = tr.s === 0 ? tr.b : tr.a;
        // him first, then whatever rode along with him
        const pkg = [...mine.filter(x => x[0] === "p" && x[1] === pid),
          ...mine.filter(x => !(x[0] === "p" && x[1] === pid))];
        return (
          <div className={`rtx${i % 2 ? " zebra" : ""}`} key={`${tr.t}-${i}`}>
            <div className="rtx-when">
              {whenDay(tr.t)}
              {tr.c && TEP_LABEL[tr.c] && <span className="tep">{TEP_LABEL[tr.c]}</span>}
            </div>
            <div className="rtx-sides">
              <div className="rtx-side">
                {pkg.map((x, k) => (
                  <Fragment key={k}>
                    {k > 0 && <span className="sep"> · </span>}
                    <span className={x[0] === "p" && x[1] === pid ? "him" : x[0] === "p" ? "" : "pick"}>
                      {assetName(x)}
                    </span>
                  </Fragment>
                ))}
              </div>
              <div className="rtx-side">
                <span className="for">for </span>
                {theirs.map((x, k) => (
                  <Fragment key={k}>
                    {k > 0 && <span className="sep"> · </span>}
                    <span className={x[0] === "p" ? "" : "pick"}>{assetName(x)}</span>
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="rtx-paid">
              <span className="v">{tr.paid == null ? "—" : num(tr.paid)}</span>
              <span className="k">{tr.paid == null ? "in package" : "paid"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const RECENT_NOTE =
  "Paid is the other side's package, net of anything that rode along with him, in KTC points on that " +
  "league's TE-premium ladder; a lesser asset in a package counts at the share of weeks a thing of its " +
  "value starts, so two 4,500s do not sum to a 9,000. A trade he was not the centerpiece of lists what " +
  "moved and carries no price. Every league is not this league: a superflex TE-premium market and a 1QB " +
  "one price the same player differently, and both are in here.";
