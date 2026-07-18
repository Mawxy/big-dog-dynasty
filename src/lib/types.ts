/** One row of data/<season>/summary.json:
 *  [player_id, pos, gp, pts, ppg, WAA, WAR, sigma?] */
export type SummaryRow = [string, string, number, number, number, number, number, number?];

export interface Meta {
  league: string; seasons: string[]; updated: string; latest?: string;
  /** league-wide all-time [min, max] single-week score — shared box plot scale */
  ptsRange?: [number, number];
}

/** player_id -> [name, position, NFL team] */
export type PlayersMin = Record<string, [string, string, string]>;

export interface Team {
  roster_id: number; team: string; manager: string;
  wins: number; losses: number; ties: number; fpts: number;
  players: string[]; starters: string[]; taxi: string[]; reserve: string[];
}

/** [week, pts, ptsAboveAvg, ptsAboveRepl, WAA, WAR] */
export type WeeklyRow = [number, number, number, number, number, number];
export type Weekly = Record<string, WeeklyRow[]>;

/** [week, pts, opp_roster_id, opp_pts, starters] */
export type MatchEntry = [number, number, number | null, number | null, string[]];
export interface Matchups { playoff_start: number; teams: Record<string, MatchEntry[]> }

/** [season, week, text] */
export type OwnEvent = [string, number, string];
export type Ownership = Record<string, OwnEvent[]>;

export interface SeasonData {
  summary: SummaryRow[];
  teams: Team[];
  /** present only in All-time mode: per-season raw data */
  allData: Record<string, { summary: SummaryRow[]; weekly: Weekly }> | null;
}

/** player_id -> { week -> "BYE" | "DNP" | "NR" } for missing regular-season weeks */
export type Absences = Record<string, Record<string, string>>;

export interface Values {
  fetched: string;
  sources: string[];
  picks?: { ktc?: [string, number][]; fc?: [string, number][] };
  players: Record<string, {
    ktc?: number; ktcRank?: number; ktcPosRank?: number; ktcT?: Record<string, number>;
    fc?: number; fcRank?: number; fcPosRank?: number; fcT?: Record<string, number>;
  }>;
}

/** data/pick_values.json — Bridge A: rookie pick -> realized WAR streams */
export interface PickBucket {
  bucket: string;
  /** dynasty-standard tier name, band rows only (e.g. "Early 2nd") */
  label?: string;
  /** overall-slot range, band rows only (e.g. "2.01–2.04") */
  slots?: string;
  /** year-since-draft -> sample size (JSON int keys arrive as strings) */
  n: Record<string, number>;
  raw: Record<string, number>;
  hit_rate: number | null;
  hit_n: number;
  /** sorted raw 3-yr WAR totals of matured picks (box-plot sample) */
  dist3: number[];
  /** year-since-draft -> sorted per-season WAR samples (box-plot / trajectory) */
  dist: Record<string, number[]>;
}
export interface PickValues {
  meta: {
    generated_for_season: number; classes: string; years_published: number[];
    min_classes_per_year: number; hit_threshold_war: number;
    picks_used: number; vets_excluded: number; unmatched: number; source: string;
  };
  /** every slot individually: 1.01 … 4.12 */
  picks: PickBucket[];
  /** Early/Mid/Late tiers per round (larger samples; box plots use these) */
  bands: PickBucket[];
}

/** data/projections.json — 3-year forward WAR per rostered player */
export interface Projection {
  pid: string; name: string; pos: string; team: string;
  age: number; pick: number; exp: number | null;
  war25: number; level: number;
  /** full-career WAR by season [season, war] (real league + NFL history) */
  career: [number, number][];
  proj: number[]; nat_low: number[]; nat_high: number[];      // Natural (if-healthy)
  composite: number[]; comp_low: number[]; comp_high: number[];
  expected: number[]; adj_low: number[]; adj_high: number[];  // Adjusted (injury)
  proj_ext: number | null;
  total: number; total_exp: number; total_comp: number;
}
export interface ProjectionsFile {
  meta: { seed_season: number; roster_season: number; horizon: number;
    years: number[]; players: number; model: string; generated: string };
  players: Projection[];
}
export interface SleeperProj { pos: string; pts13: number; ppg: number; raw_pts: number; }
export interface SleeperProjFile { meta: Record<string, unknown>; players: Record<string, SleeperProj>; }

/** data/franchises.json — per roster_id (stable franchise) history + transactions */
export interface FranchiseSeason {
  season: string; name: string; manager: string;
  wins: number; losses: number; ties: number;
  fpts: number; ppg: number; war: number;
  seed: number | null; finish: number | null;
}
export interface FranchiseTx {
  season: string; week: number; ts: number; type: string;
  with?: string[]; got?: string[]; gave?: string[]; adds?: string[]; drops?: string[];
}
export interface Franchise { seasons: FranchiseSeason[]; tx: FranchiseTx[]; }
export type Franchises = Record<string, Franchise>;
