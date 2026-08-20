import type { Values } from "./types";

/** one player row of data/values.json */
export type ValueRow = Values["players"][string];

/**
 * The KTC column that prices THIS league.
 *
 * KTC publishes four value ladders — no premium, TE+, TE++, TE+++ — and a
 * league belongs to exactly one of them (meta.tep, classified server-side by
 * crawl_schema.tep_class from scoring_settings + TE slots). Reading `row.ktc`
 * directly prices a TE-premium league's tight ends in the wrong market; every
 * KTC figure the site shows goes through here instead.
 *
 * Fallback walks DOWN the ladder (TE+++ → TE++ → TE+ → base) so a values.json
 * built before the premium columns existed degrades to base KTC everywhere
 * rather than to holes.
 */
const LADDER: Record<string, (keyof ValueRow)[]> = {
  tep: ["ktcTep", "ktc"],
  tepp: ["ktcTepp", "ktcTep", "ktc"],
  teppp: ["ktcTeppp", "ktcTepp", "ktcTep", "ktc"],
};

export function ktcOf(row: ValueRow | undefined, tep: string | undefined): number | null {
  if (!row) return null;
  for (const f of LADDER[tep ?? ""] ?? ["ktc" as const]) {
    const v = row[f];
    if (typeof v === "number" && v > 0) return v;
  }
  return row.ktc ?? null;
}
