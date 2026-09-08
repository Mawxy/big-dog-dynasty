import { useMemo } from "react";
import type { DynastyMovers, Team, Values } from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi } from "../lib/useIndices";
import { useLeague } from "../lib/context";
import { fmt, sgn } from "../lib/stats";
import { POS_COLOR } from "../lib/league";
import { ktcOf } from "../lib/values";
import { IdCell, NUL, Spine, TapRow, useBetaPath } from "./ui";

/**
 * THE THREE MOVER MODULES — win now vs dynasty, dynasty movers, market
 * movers — as data hooks and tables that two screens share (Max,
 * 2026-09-08). League shows the top five of each under a band with a "View
 * all"; the Movers screen shows the whole list. One computation and one
 * table per module, so the five on League are literally the head of the
 * list a reader lands on, never a lookalike.
 *
 * Every hook returns the FULL list, ordered; `limit` is the table's business.
 */

/** Which half of a two-sided module to render: the first group, the second,
 *  or both stacked (League's default). The Movers screen shows one at a
 *  time behind a lens strip, so the second half is a tap away rather than a
 *  scroll past the first (Max, 2026-09-08). */
export type Half = "a" | "b" | "both";
const halves = <T,>(a: T, b: T, half: Half): T[] =>
  half === "a" ? [a] : half === "b" ? [b] : [a, b];

/** how deep into the startable universe a value play may sit — the classic
 *  board's VALUE_PLAY_DEPTH, restated so the two shells qualify the same way */
export const VALUE_PLAY_DEPTH = 100;

/* ---- win now vs dynasty --------------------------------------------------- */

/** one win-now-vs-dynasty row: the two indices and the gap between them */
export interface GapRow {
  pid: string; name: string; pos: string; nfl: string;
  dvi: number; cvi: number; gap: number;
  dRank: number; cRank: number; ecr?: number;
}

/**
 * WHO IS A WIN-NOW PLAYER AND WHO IS A DYNASTY PLAYER (Max, 2026-09-02): the
 * largest disagreements between our two indices, among rostered players. CVI
 * prices the coming season and DVI the dynasty horizon, so a player far above
 * his DVI on CVI is worth more to a contender than a rebuilder, and the
 * reverse is a stash.
 *
 * The classic board's value-plays rules, restated so the two shells qualify
 * the same population: a WIN-NOW row needs a CVI rank inside the startable
 * top 100 (or the gap is only age); a DYNASTY row needs a DVI rank inside it
 * and a redraft ECR rank, so a player known to give nothing this year does
 * not read as a stash. Gap is CVI minus DVI, signed, in index points.
 */
export function useGapRows(teams: Team[] | null | undefined) {
  const { players } = useLeague();
  const dvi = useDvi();
  const cvi = useCvi();
  return useMemo(() => {
    if (!dvi || !cvi || !teams) return null;
    const owned = new Set(teams.flatMap(t => t.players));
    const rows: GapRow[] = [];
    for (const [pid, dr] of Object.entries(dvi.players)) {
      const cr = cvi.players[pid];
      const info = players[pid];
      if (!cr || !info || !owned.has(pid)) continue;
      rows.push({
        pid, name: info[0], pos: dr.pos, nfl: info[2],
        dvi: dr.dvi, cvi: cr.cvi, gap: cr.cvi - dr.dvi,
        dRank: dr.rank, cRank: cr.rank, ecr: cr.ecr,
      });
    }
    rows.sort((a, b) => b.gap - a.gap);
    return {
      now: rows.filter(r => r.gap > 0 && r.cRank <= VALUE_PLAY_DEPTH),
      later: rows.filter(r => r.gap < 0 && r.ecr != null && r.dRank <= VALUE_PLAY_DEPTH).reverse(),
    };
  }, [dvi, cvi, teams, players]);
}

export function GapTable({ rows, limit, half = "both" }: {
  rows: NonNullable<ReturnType<typeof useGapRows>>; limit?: number; half?: Half;
}) {
  const betaPath = useBetaPath();
  return (
    <table className="v3tbl lgx-grid">
      {/* THE GROUP LABEL IS THE HEADER ROW (Max, 2026-09-02): each group opens
          with one row that is both the label and the column headers, and the
          first group's row carries the width hints the fixed layout reads. */}
      {halves(["Win now", rows.now] as const, ["Dynasty", rows.later] as const, half).map(([label, list]) => (
        <tbody key={label}>
          <tr className="lgx-cols">
            <th className="c sp">#</th>
            <th className="t"><span className="k">{label}</span></th>
            <th className="n" style={{ width: "18%" }}>DVI</th>
            <th className="n" style={{ width: "18%" }}>CVI</th>
            <th className="n" style={{ width: "20%" }}>Gap</th>
          </tr>
          {(limit ? list.slice(0, limit) : list).map((r, i) => (
            <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)} className={i % 2 ? "zebra" : ""}>
              <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
              <IdCell name={r.name}
                sub={[r.nfl || null, r.pos].filter(Boolean).join(" · ")}
                to={betaPath(`/player/${r.pid}`)} />
              <td className="n"><span className="f">{fmt(r.dvi, 1)}</span></td>
              <td className="n"><span className="f">{fmt(r.cvi, 1)}</span></td>
              {/* the sign is the whole claim; `.f.up` / `.f.down` are legal
                  here and nowhere near a trade ledger — a gap is a direction
                  of travel, not a verdict about who won */}
              <td className="n">
                <span className={`f hd ${r.gap > 0 ? "up" : "down"}`}>{sgn(r.gap, 1)}</span>
              </td>
            </TapRow>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/* ---- dynasty movers ------------------------------------------------------ */

export function useDynMovers() {
  return useJson<DynastyMovers>("data/dynasty_movers.json", "globalDaily").data;
}

export const dynNote = (dyn: DynastyMovers | null | undefined) => dyn
  ? `Last ${dyn.meta.window_days} days, ${dyn.meta.leagues?.toLocaleString() ?? "—"} leagues`
  : undefined;

export function DynTable({ dyn, limit, half = "both" }: {
  dyn: DynastyMovers; limit?: number; half?: Half;
}) {
  const betaPath = useBetaPath();
  return (
    <table className="v3tbl lgx-grid">
      {halves(["Going over value", dyn.overpaid] as const, ["Going under value", dyn.underpaid] as const, half)
        .map(([label, list]) => (
        <tbody key={label}>
          <tr className="lgx-cols">
            <th className="c sp">#</th>
            <th className="t"><span className="k">{label}</span></th>
            <th className="n" style={{ width: "18%" }}>Value</th>
            <th className="n" style={{ width: "18%" }}>Paid</th>
            <th className="n" style={{ width: "20%" }}>Δ</th>
          </tr>
          {(limit ? list.slice(0, limit) : list).map((r, i) => (
            <TapRow key={`${label}${r.pid}`} to={betaPath(`/player/${r.pid}`)}
              className={i % 2 ? "zebra" : ""}>
              <Spine rank={i + 1} color={r.pos ? POS_COLOR[r.pos] : undefined} />
              <IdCell name={r.name}
                sub={[r.team, r.pos, `${r.n} trades`].filter(Boolean).join(" · ")}
                to={betaPath(`/player/${r.pid}`)} />
              {/* Value and Paid on the same ramp: the Δ column is the
                  headline; these two are its inputs */}
              <td className="n"><span className="f">{r.value.toLocaleString()}</span></td>
              <td className="n"><span className="f">{r.avg_paid.toLocaleString()}</span></td>
              <td className="n">
                <span className={`f hd ${r.avg_delta > 0 ? "up" : "down"}`}>
                  {r.avg_pct == null ? NUL : `${sgn(r.avg_pct, 0)}%`}
                </span>
              </td>
            </TapRow>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/* ---- market movers ------------------------------------------------------- */

/** one market-mover row */
export interface MoverRow {
  pid: string; name: string; pos: string; nfl: string; price: number; d: number;
}

export type MarketSource = "ktc" | "fc";
export type MarketWindow = 7 | 14 | 30;
export const MARKET_WINDOWS: readonly MarketWindow[] = [7, 14, 30];
export const SOURCE_NAME: Record<MarketSource, string> = { ktc: "KeepTradeCut", fc: "FantasyCalc" };

/**
 * A market's change over a window (Max, 2026-09-08: source and window are
 * both the reader's to pick on the Movers screen; League reads KTC over 7).
 *
 * KTC's VALUE is priced in this league's TE-premium column through `ktcOf`;
 * its TREND stays the base feed's, because KTC publishes no per-tier trends
 * — direction and magnitude read the same either way. FantasyCalc has one
 * column. Every trend is our own, off the daily snapshots in
 * values_history.json (fetch_values.py), so the three windows are measured
 * the same way for both sources.
 */
export function useMarketMovers(
  vals: Values | null | undefined, source: MarketSource = "ktc", window: MarketWindow = 7,
) {
  const { players, meta } = useLeague();
  return useMemo(() => {
    if (!vals) return null;
    const rows: MoverRow[] = [];
    for (const [pid, v] of Object.entries(vals.players)) {
      const info = players[pid];
      const price = source === "ktc" ? ktcOf(v, meta.tep) : v.fc ?? null;
      const d = (source === "ktc" ? v.ktcT : v.fcT)?.[String(window)];
      if (!info || price == null || d == null || d === 0) continue;
      rows.push({ pid, name: info[0], pos: info[1], nfl: info[2], price, d });
    }
    rows.sort((a, b) => b.d - a.d);
    // WHEN THE SOURCE LAST ANSWERED. A missed scrape no longer blanks the
    // module: the feed carries each player's trend as of the last day the
    // source quoted him and stamps `<src>AsOf`. The stamp is PER PLAYER —
    // on a fresh day a few dozen the source stopped listing still carry one
    // — so the band only says "as of" when NOBODY with a trend is fresh, and
    // then says the newest date. A fresh day reads as fresh.
    const stamped = Object.values(vals.players)
      .filter(v => (source === "ktc" ? v.ktcT : v.fcT)?.[String(window)] != null)
      .map(v => (source === "ktc" ? v.ktcAsOf : v.fcAsOf) ?? null);
    const asOf = stamped.length && stamped.every(d => d != null)
      ? (stamped as string[]).sort().pop() ?? null : null;
    return {
      up: rows.filter(r => r.d > 0),
      down: rows.filter(r => r.d < 0).reverse(),
      asOf, source, window,
    };
  }, [vals, players, meta.tep, source, window]);
}

export const marketNote = (m: { asOf: string | null; source?: MarketSource; window?: MarketWindow } | null | undefined) =>
  `${SOURCE_NAME[m?.source ?? "ktc"]}, ${m?.window ?? 7}-day change in points${m?.asOf
    ? ` · as of ${new Date(m.asOf + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : ""}`;

/** THE MODULE'S FLOOR (Max, 2026-09-08): the League head-of-list shows no
 *  one priced under this. A 900-point scrub moving 300 is trivia; the five
 *  rows under a band are for players people actually trade. The full Movers
 *  screen has no floor — the whole point of it is the whole list. */
export const MODULE_MIN_VALUE = 2000;

export function MarketTable({ movers, limit, minValue, half = "both" }: {
  movers: NonNullable<ReturnType<typeof useMarketMovers>>; limit?: number;
  /** drop rows priced under this before taking `limit` */
  minValue?: number;
  half?: Half;
}) {
  const betaPath = useBetaPath();
  const floor = (list: MoverRow[]) => (minValue ? list.filter(r => r.price >= minValue) : list);
  return (
    <table className="v3tbl lgx-grid">
      {halves(["Rising", floor(movers.up)] as const, ["Falling", floor(movers.down)] as const, half)
        .map(([label, list]) => (
        <tbody key={label}>
          <tr className="lgx-cols">
            <th className="c sp">#</th>
            <th className="t"><span className="k">{label}</span></th>
            <th className="n" style={{ width: "18%" }}>Value</th>
            <th className="n" style={{ width: "20%" }}>{movers.window}d</th>
          </tr>
          {(limit ? list.slice(0, limit) : list).map((r, i) => (
            <TapRow key={`${label}${r.pid}`} to={betaPath(`/player/${r.pid}`)}
              className={i % 2 ? "zebra" : ""}>
              <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
              <IdCell name={r.name}
                sub={[r.nfl || null, r.pos].filter(Boolean).join(" · ")}
                to={betaPath(`/player/${r.pid}`)} />
              <td className="n"><span className="f">{r.price.toLocaleString()}</span></td>
              <td className="n">
                <span className={`f hd ${r.d > 0 ? "up" : "down"}`}>{sgn(r.d, 0)}</span>
              </td>
            </TapRow>
          ))}
        </tbody>
      ))}
    </table>
  );
}
