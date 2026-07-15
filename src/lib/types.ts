/** One row of data/<season>/summary.json:
 *  [player_id, pos, gp, pts, ppg, WAA, WAR, sigma?] */
export type SummaryRow = [string, string, number, number, number, number, number, number?];

export interface Meta { league: string; seasons: string[]; updated: string }

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
