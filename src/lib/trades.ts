import type { TradesPayload } from "./types";

/** Normalize either trades.json shape into { trades, delta }. */
export function readTrades(p: TradesPayload) {
  return Array.isArray(p)
    ? { trades: p, delta: null as number | null }
    : { trades: p.trades ?? [], delta: p.meta?.delta ?? null };
}

export const tradeWhen = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

/**
 * A non-trade move's kind, as words and as a dense-row tag. Sleeper's third
 * type is a `commissioner` move, a roster edit rather than a free-agent pickup,
 * and everything that wasn't a waiver used to print as one.
 */
export const txKind = (type: string) =>
  type === "waiver" ? "waiver" : type === "commissioner" ? "commissioner" : "free agent";
export const txTag = (type: string) =>
  type === "waiver" ? "WAIVER" : type === "commissioner" ? "COMM" : "FA";
