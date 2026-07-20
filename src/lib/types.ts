/** One row of data/<season>/summary.json:
 *  [player_id, pos, gp, pts, ppg, WAA, WAR, sigma?] */
export type SummaryRow = [string, string, number, number, number, number, number, number?];

export interface Meta {
  league: string; seasons: string[]; updated: string; latest?: string;
  /** starting-lineup shape, e.g. ["QB","RB","RB",...,"FLEX","SUPER_FLEX"].
   *  Absent in site data built before this field existed. */
  rosterPositions?: string[];
  /** taxi-squad size from league settings */
  taxiSlots?: number;
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
export interface Matchups {
  playoff_start: number; teams: Record<string, MatchEntry[]>;
  /** future-week pairings from Sleeper (preseason): week -> [[ridA, ridB], ...] */
  schedule?: Record<string, [number, number][]>;
}

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
    /** precomputed by value_bridge.py so the page renders in one fetch */
    impWar?: { ktc?: number; fc?: number };  // market-implied 3-yr WAR
    modelWar?: number;                       // our projected 3-yr composite WAR
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
    min_obs_by_round: Record<string, number>; hit_threshold_war: number;
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
  /** PPG implied by the year-1 composite WAR rate (inverted pts_to_war fit) */
  ppg?: number | null;
  /** NFL bye week in the roster season (null: no team / byes unpublished) */
  bye?: number | null;
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

/** data/player/<pid>.json — one player's slice of projections.json +
 *  proj_sleeper.json, written by scripts/shard_players.py so a player page
 *  fetches ~2 KB instead of the ~600 KB of both full files. A 404 (player has
 *  no projection) is expected and falls back to the plain WAR trend. */
export interface PlayerShard {
  years: number[];
  proj: Projection | null;
  sproj: SleeperProj | null;
}

/** data/value_bridge.json — Bridge B: market value -> WAR. Isotonic-fit knots
 *  [[value, war], ...] ascending; predict by linear interpolation, clamped. */
export type BridgeKnots = [number, number][];
export interface BridgeFits {
  /** THE bridge: value -> projected 3-yr composite WAR (per-year + total) */
  proj: { y1: BridgeKnots; y2: BridgeKnots; y3: BridgeKnots; total: BridgeKnots };
  /** sanity fit only: value -> last season's realized WAR */
  war25: BridgeKnots;
}
export interface ValueBridge {
  meta: { values_fetched: string; seed_season: number; sources: Record<string, unknown> };
  fits: { ktc?: BridgeFits; fc?: BridgeFits };
  /** per source: [label, market value, implied 3-yr WAR, [y1, y2, y3]] */
  picks: Record<string, [string, number, number, number[]][]>;
}

/** data/franchises.json — per roster_id (stable franchise) history + transactions */
export interface FranchiseSeason {
  season: string; name: string; manager: string;
  wins: number; losses: number; ties: number;
  fpts: number; ppg: number; war: number;
  seed: number | null; finish: number | null;
  top?: { pid: string; war: number } | null;                 // best WAR contributor
  low?: { pid: string; war: number; starts: number } | null; // weakest regular starter (>6 starts)
}
export interface FranchiseTx {
  season: string; week: number; ts: number; type: string;
  with?: string[]; got?: string[]; gave?: string[]; adds?: string[]; drops?: string[];
}
export interface Franchise { seasons: FranchiseSeason[]; tx: FranchiseTx[]; }
export type Franchises = Record<string, Franchise>;

/** data/trades.json — every trade, with each side's return scored in WAR */
export interface TradeAsset {
  kind: "player" | "pick" | "faab";
  /** null for FAAB or an unused pick; picks carry the drafted player's id */
  pid: string | null;
  /** "Josh Allen" | "2024 1st → Marvin Harrison" | "$15 FAAB" */
  label: string;
  war: number;
  /** discounted expected WAR still ahead of this asset (0 once it's gone) */
  future: number;
}
export interface TradeSide {
  rid: number; team: string; got: TradeAsset[];
  /** realized WAR while starting for this team */
  war: number;
  /** discounted expected WAR still to come, for assets this team still holds */
  future: number;
  /** war + future */
  total: number;
}
export interface Trade { season: string; week: number; ts: number; sides: TradeSide[]; }
export interface TradesFile {
  meta: { delta: number; proj_season: number; note: string };
  trades: Trade[];
}
/** trades.json was a bare array before mark-to-market; accept either shape so
 *  the site keeps working against data generated by an older script. */
export type TradesPayload = Trade[] | TradesFile;

/** data/drafts.json — per roster_id draft picks with hit/miss vs slot expectation */
export interface DraftAlt { pid: string; name: string; pick_no: number; war: number; }
export interface DraftPick {
  season: string; kind: string; round: number; pick_no: number; slot: string;
  pid: string; name: string; pos: string;
  war: number; war_roster: number | null;
  expected: number | null; years: number; diff: number | null;
  alts: DraftAlt[];
  /** Originally owned by this franchise but traded away before the draft.
   *  Informational only: never scored, never in season subtotals. */
  traded: boolean;
  /** roster_id of the franchise that actually made the selection. */
  drafted_by?: number;
}
export type Drafts = Record<string, DraftPick[]>;
