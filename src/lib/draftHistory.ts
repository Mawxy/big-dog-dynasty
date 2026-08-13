import type { DraftPick, Drafts, Franchises } from "./types";
import { LEAGUE_TEAMS } from "./league";

/**
 * The draft-history data model shared by the Draft tab's boards and the
 * per-draft pages. drafts.json lists a traded pick under BOTH franchises —
 * the traded:false entry belongs to the selector, the traded:true one to the
 * original owner, which is exactly the "via" note.
 */

export interface HistRow {
  slot: string; round: number; pickNo: number;
  pid: string; name: string; pos: string; kind: string;
  drafter: string; via: string | null;
  /**
   * The same two as MANAGER handles rather than franchise names, resolved for
   * the same season. Both are carried because the two surfaces want different
   * ones: a table row has the width for "Cam Skattebo Fan Club", a draft-board
   * column is 116px and "HomieGSlicer" fits on one line where the team name
   * clamps to two. A franchise can be renamed mid-dynasty and often is; the
   * handle behind it is the more stable label of the same thing.
   */
  drafterMgr: string; viaMgr: string | null;
  /** career WAR since drafted / expectation / diff, straight from drafts.json */
  war: number; years: number; expected: number | null; diff: number | null;
}
export interface History {
  rowsBy: Record<string, HistRow[]>; seasons: string[]; kindOf: Record<string, string>;
}

export function buildHistory(drafts: Drafts, fr: Franchises | null): History {
  /** the franchise's row for a season, falling back to its most recent one */
  const rowOf = (rid: string, season: string) => {
    const f = fr?.[rid];
    if (!f?.seasons.length) return null;
    return f.seasons.find(s => s.season === season) ?? f.seasons[f.seasons.length - 1];
  };
  const nameOf = (rid: string, season: string): string =>
    rowOf(rid, season)?.name ?? `Roster ${rid}`;
  // falls back to the team name, not to "Roster N": an empty manager field is a
  // data gap, and the franchise is still the more useful thing to print
  const mgrOf = (rid: string, season: string): string => {
    const r = rowOf(rid, season);
    return r?.manager?.trim() || r?.name || `Roster ${rid}`;
  };
  const sel = new Map<string, { p: DraftPick; rid: string }>();
  const orig = new Map<string, string>();
  for (const [rid, picks] of Object.entries(drafts))
    for (const p of picks) {
      const k = `${p.season}|${p.slot}|${p.pid}`;
      if (p.traded) orig.set(k, rid);
      else sel.set(k, { p, rid });
    }
  const rowsBy: Record<string, HistRow[]> = {};
  for (const [k, { p, rid }] of sel) {
    const selector = p.drafted_by != null ? String(p.drafted_by) : rid;
    const via = orig.get(k);
    (rowsBy[p.season] ??= []).push({
      slot: p.slot, round: p.round, pickNo: p.pick_no,
      pid: p.pid, name: p.name, pos: p.pos, kind: p.kind,
      drafter: nameOf(selector, p.season),
      via: via != null && via !== selector ? nameOf(via, p.season) : null,
      drafterMgr: mgrOf(selector, p.season),
      viaMgr: via != null && via !== selector ? mgrOf(via, p.season) : null,
      war: p.war, years: p.years, expected: p.expected, diff: p.diff,
    });
  }
  for (const rs of Object.values(rowsBy)) rs.sort((a, b) => a.pickNo - b.pickNo);
  const seasons = Object.keys(rowsBy).sort().reverse();
  const kindOf: Record<string, string> = {};
  for (const s of seasons) kindOf[s] = rowsBy[s][0].kind;
  return { rowsBy, seasons, kindOf };
}

/**
 * The startup snaked, and its `slot` field is Sleeper's draft-slot (the
 * COLUMN), so even rounds read 2.12 -> 2.01 in pick order. The label people
 * mean by "2.01" is pick-in-round, so derive it from pick_no; for linear
 * rookie drafts the two coincide. Grid placement stays on `slot`, which is
 * what draws the snake weaving back — that part is right.
 */
export const pickLabel = (r: HistRow) =>
  `${r.round}.${String(((r.pickNo - 1) % LEAGUE_TEAMS) + 1).padStart(2, "0")}`;

/** first name / rest, so every board cell is the same two-line shape */
export const nameSplit = (name: string): [string, string] => {
  const sp = name.indexOf(" ");
  return sp < 0 ? [name, " "] : [name.slice(0, sp), name.slice(sp + 1)];
};
