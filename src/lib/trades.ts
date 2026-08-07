import type { TradesPayload } from "./types";

/** Normalize either trades.json shape into { trades, delta }. */
export function readTrades(p: TradesPayload) {
  return Array.isArray(p)
    ? { trades: p, delta: null as number | null }
    : { trades: p.trades ?? [], delta: p.meta?.delta ?? null };
}

export const tradeWhen = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
