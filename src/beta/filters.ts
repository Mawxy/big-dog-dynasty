import type { CareerSeason } from "../lib/honors";

/**
 * ADVANCED SEARCH (Max, 2026-09-16) — "every player under 25 with a KTC over
 * 2500 and a season above 8 PPG". A list of numeric criteria the Players
 * board applies on top of its position chips and its search box, in either
 * tense: the fields come from the whole site's files, not the board in front
 * of the reader, so an age cut works on the Stats board and a best-season
 * PPG cut works on the price board.
 *
 * THE FILTER LIVES IN THE URL (`?f=age<25,ktc>2500,ppg_best>8`) for the same
 * reason the scope does (beta/Scope.tsx): a board someone shows you should be
 * the board they were looking at, and Back should undo a criterion. `>` and
 * `<` are read as at-least and at-most — the pair a reader means, and the
 * only one that survives a URL without escaping.
 *
 * Every field is a FACT about a player the index below can answer — one
 * number per player, however many boards show him. Season fields are
 * "best season" or "last season" rather than "this season", because the
 * criterion has to mean the same thing on the price board, where there is no
 * season, and in all-time.
 */
export type FilterField =
  | "age" | "ktc" | "fc" | "dvi" | "cvi" | "pwar" | "ecr"
  | "ppg_best" | "ppg_last" | "war_best" | "war_career" | "gp_career" | "seasons";
export type FilterOp = ">" | "<";
export interface Filter { field: FilterField; op: FilterOp; value: number }

export interface FilterFieldDef {
  label: string;
  /** which group of the sheet the field sits in */
  group: "now" | "seasons";
  /** how the value is written back into a chip */
  fmt: (v: number) => string;
  /** the input's step */
  step: number;
  def: string;
}

export const FILTER_FIELDS: Record<FilterField, FilterFieldDef> = {
  age: { label: "Age", group: "now", step: 1, fmt: v => String(v),
    def: "Age on September 1 of the roster season." },
  ktc: { label: "KTC", group: "now", step: 100, fmt: v => v.toLocaleString(),
    def: "KeepTradeCut dynasty value, on this league's TE ladder." },
  fc: { label: "FantasyCalc", group: "now", step: 100, fmt: v => v.toLocaleString(),
    def: "FantasyCalc dynasty value." },
  dvi: { label: "DVI", group: "now", step: 1, fmt: v => String(v),
    def: "Dynasty Value Index, 0–100." },
  cvi: { label: "CVI", group: "now", step: 1, fmt: v => String(v),
    def: "Contender Value Index, 0–100." },
  pwar: { label: "Proj WAR", group: "now", step: 0.1, fmt: v => v.toFixed(2),
    def: "Projected WAR for the coming season, on the curve the board is read under." },
  ecr: { label: "ECR", group: "now", step: 1, fmt: v => String(v),
    def: "FantasyPros redraft consensus rank, 1 is best." },
  ppg_best: { label: "PPG, best season", group: "seasons", step: 0.5, fmt: v => v.toFixed(1),
    def: "His highest points per game in any league season." },
  ppg_last: { label: "PPG, last season", group: "seasons", step: 0.5, fmt: v => v.toFixed(1),
    def: "Points per game in the most recent season he was scored." },
  war_best: { label: "WAR, best season", group: "seasons", step: 0.1, fmt: v => v.toFixed(2),
    def: "His highest single-season WAR." },
  war_career: { label: "WAR, career", group: "seasons", step: 0.1, fmt: v => v.toFixed(2),
    def: "WAR summed over every league season." },
  gp_career: { label: "Games, career", group: "seasons", step: 1, fmt: v => String(v),
    def: "League games with a score, all seasons." },
  seasons: { label: "Seasons scored", group: "seasons", step: 1, fmt: v => String(v),
    def: "How many league seasons he has a stat line in." },
};

export const FILTER_ORDER = Object.keys(FILTER_FIELDS) as FilterField[];

/* ---- the URL form ---------------------------------------------------------
   `age<25,ktc>2500` — field, one of > or <, a number. Anything that does not
   parse is dropped rather than guessed. */
export function parseFilters(s: string | null | undefined): Filter[] {
  if (!s) return [];
  const out: Filter[] = [];
  for (const part of s.split(",")) {
    const m = /^([a-z_]+)([<>])(-?\d+(?:\.\d+)?)$/.exec(part.trim());
    if (!m || !(m[1] in FILTER_FIELDS)) continue;
    out.push({ field: m[1] as FilterField, op: m[2] as FilterOp, value: Number(m[3]) });
  }
  return out;
}
export function serializeFilters(fs: Filter[]): string {
  return fs.map(f => `${f.field}${f.op}${f.value}`).join(",");
}

/** the chip text: "Age ≤ 25", "KTC ≥ 2,500" */
export function filterLabel(f: Filter): string {
  const d = FILTER_FIELDS[f.field];
  return `${d.label} ${f.op === ">" ? "≥" : "≤"} ${d.fmt(f.value)}`;
}

/* ---- the facts index ------------------------------------------------------
   One row per player, every field the filters can ask about. Built by the
   board from the files it already has (dvi/cvi, the matrix, values, ECR) plus
   the career index, which is loaded the first time a season field is used. */
export type Facts = Partial<Record<FilterField, number>>;
export type FactsIndex = Record<string, Facts>;

/** the season fields, from the career index — every league season he scored */
export function seasonFacts(rows: CareerSeason[] | undefined): Facts {
  if (!rows?.length) return {};
  // `career` rows are newest first
  const sorted = rows.slice().sort((a, b) => b.season.localeCompare(a.season));
  const best = (k: "ppg" | "war") => Math.max(...sorted.map(r => r[k]));
  return {
    ppg_best: best("ppg"),
    ppg_last: sorted[0].ppg,
    war_best: best("war"),
    war_career: sorted.reduce((a, r) => a + r.war, 0),
    gp_career: sorted.reduce((a, r) => a + r.gp, 0),
    seasons: sorted.length,
  };
}

/** does a player pass every criterion? A fact the index does not have for
 *  him FAILS the criterion — "under 25" cannot admit a player with no age. */
export function passes(facts: Facts | undefined, fs: Filter[]): boolean {
  for (const f of fs) {
    const v = facts?.[f.field];
    if (v == null) return false;
    if (f.op === ">" ? v < f.value : v > f.value) return false;
  }
  return true;
}

/** which sources a set of filters needs, so the board fetches only those */
export function filterNeeds(fs: Filter[]) {
  const fields = new Set(fs.map(f => f.field));
  return {
    market: fields.has("ktc") || fields.has("fc"),
    matrix: fields.has("age") || fields.has("pwar"),
    ecr: fields.has("ecr"),
    index: fields.has("dvi") || fields.has("cvi"),
    career: [...fields].some(f => FILTER_FIELDS[f].group === "seasons"),
  };
}
