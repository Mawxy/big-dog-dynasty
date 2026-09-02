/** One row of data/<season>/summary.json:
 *  [player_id, pos, gp, pts, ppg, WAA, WAR, sigma?, VoWP?]
 *  VoWP (value over waiver player) is null for seasons pulled before the
 *  full-NFL stats feed existed (pre-2022 / dumps without allstats). */
export type SummaryRow = [string, string, number, number, number, number, number, number?, (number | null)?];

/** data/leagues.json — the league registry.
 *
 *  A league is keyed by its FOUNDING league_id, permanently: Sleeper mints a new
 *  id every season and chains them backward, so the founder is the only id that
 *  never moves. `alias` is a hand-assigned URL name and is never load-bearing —
 *  the key always resolves on its own. */
export interface LeagueEntry {
  /** founding league_id — the permanent key */
  key: string;
  /** URL alias, e.g. "big-dog". May collide across leagues; the key never does */
  alias: string;
  name: string;
  /** dynasty | keeper | redraft, from Sleeper settings.type — gates market
   *  display and franchise keying. Absent in data built before this field. */
  kind?: "dynasty" | "keeper" | "redraft";
  seasons: string[];
  /** newest season with games played */
  latest: string | null;
  /** whose rosters are live — differs from `latest` all offseason */
  rosterSeason: string;
  /** this season's Sleeper league_id (changes annually) */
  currentLeagueId: string;
  /** season -> that season's league_id */
  chain: Record<string, string>;
  commissioners: { user_id: string; name: string }[];
  /** every member's user_id — the anchors rollover discovery uses */
  members: string[];
}
export interface Leagues { default: string; leagues: LeagueEntry[] }

export interface Meta {
  league: string; seasons: string[]; updated: string;
  /** dynasty | keeper | redraft — mirrors LeagueEntry.kind for pages that
   *  only hold meta. Absent in data built before this field existed. */
  kind?: "dynasty" | "keeper" | "redraft";
  /** newest season with games played — what the stats views default to */
  latest?: string;
  /** whose rosters are live right now. Differs from `latest` all offseason:
   *  use this for anything about who owns whom, `latest` for anything about
   *  what happened. Absent in site data built before this field existed. */
  rosterSeason?: string;
  /** starting-lineup shape, e.g. ["QB","RB","RB",...,"FLEX","SUPER_FLEX"].
   *  Absent in site data built before this field existed. */
  rosterPositions?: string[];
  /** taxi-squad size from league settings */
  taxiSlots?: number;
  /** TE-premium class on KTC's ladder: "" none, "tep" TE+, "tepp" TE++,
   *  "teppp" TE+++. Written by build_site_data from scoring_settings; read
   *  through lib/values.ktcOf so every KTC figure on the site is priced in
   *  this league's column. Absent = no premium. */
  tep?: string;
  /** league-wide all-time [min, max] single-week score — shared box plot scale */
  ptsRange?: [number, number];
}

/** player_id -> [name, position, NFL team, espn_id?]
 *  The optional fourth slot is the ESPN player id, which is the key to a
 *  transparent-background headshot (a.espncdn.com); Sleeper's own CDN only
 *  serves JPGs on white. Absent for anyone the Sleeper map has no ESPN id
 *  for, and for rows built before 2026-09-02. */
export type PlayersMin = Record<string, [string, string, string, number?]>;

export interface Team {
  roster_id: number; team: string; manager: string;
  /** the franchise this roster belongs to THIS season — what /franchise/<key>
   *  links must carry. roster_id as a string for dynasty, owner user_id for
   *  redraft/keeper. Absent in data built before it; fall back to roster_id. */
  fkey?: string;
  wins: number; losses: number; ties: number; fpts: number;
  players: string[]; starters: string[]; taxi: string[]; reserve: string[];
}

/** [week, pts, ptsAboveAvg, ptsAboveRepl, WAA, WAR] */
export type WeeklyRow = [number, number, number, number, number, number];
export type Weekly = Record<string, WeeklyRow[]>;

/** [week, pts, opp_roster_id, opp_pts, starters, bench?]
 *  `bench` is who was rostered that week and not started — absent in site data
 *  built before it was carried. teams.json can't stand in for it: that's the
 *  end-of-season roster, not the roster as it was in week N. */
export type MatchEntry =
  [number, number, number | null, number | null, string[], string[]?];
export interface Matchups {
  playoff_start: number; teams: Record<string, MatchEntry[]>;
  /** future-week pairings from Sleeper (preseason): week -> [[ridA, ridB], ...] */
  schedule?: Record<string, [number, number][]>;
  /** the LIVE week's lineups as managers actually set them (rid -> starters,
   *  "0" = empty slot). Its projection prices this lineup; future weeks stay
   *  best-projected. Absent out of season / in data built before it. */
  set?: { week: number; starters: Record<string, string[]> };
}

/** data/<season>/odds.json — the pregame line for every matchup, played or
 *  upcoming. Built from weeks 1..W-1 only (no lookahead) by the same normal
 *  model the bracket uses. `proj` marks a line built from projections
 *  because the week hasn't been played. See scripts/week_odds.py */
export interface WeekOdds {
  meta: { playoff_start: number; model: string; played: number[]; projected: number[] };
  weeks: Record<string, Record<string, {
    mu: number; sd: number; opp: number | null; wp?: number; proj?: boolean;
  }>>;
}

/** [season, week, text] */
export type OwnEvent = [string, number, string];
export type Ownership = Record<string, OwnEvent[]>;

export interface SeasonData {
  summary: SummaryRow[];
  teams: Team[];
  /** pid -> NFL club AT THE TIME (modal played-week team; <season>/nfl_teams.json).
   *  All-time mode merges seasons oldest-first, so a player's last played club
   *  wins. Absent for seasons whose dumps predate teams in the played files —
   *  callers fall back to the current club from players_min. */
  nflTeams?: Record<string, string>;
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
    /** KTC TE-premium columns (fetch_values.py): TE+ / TE++ / TE+++ */
    ktcTep?: number; ktcTepp?: number; ktcTeppp?: number;
    fc?: number; fcRank?: number; fcPosRank?: number; fcT?: Record<string, number>;
    /** precomputed by value_bridge.py so the page renders in one fetch */
    impWar?: { ktc?: number; fc?: number };  // market-implied 3-yr WAR
    modelWar?: number;                       // our projected 3-yr composite WAR
  }>;
}

/** data/dynasty_movers.json — cross-league over/underpays, dynasty_movers.py */
export interface DynastyMovers {
  meta: {
    generated: string; as_of: string; window_days: number; min_n: number;
    attribution: string; max_assets?: number; unit: string;
    leagues?: number; trades_in_window: number; trades_scored: number;
    players_qualified: number;
  };
  overpaid: DynastyMoverRow[];
  underpaid: DynastyMoverRow[];
}
export interface DynastyMoverRow {
  pid: string; name: string; pos: string | null; team: string | null;
  /** qualifying trades in the window (centerpiece appearances) */
  n: number;
  /** blended FC+KTC market value */
  value: number;
  /** average package received for him, market points */
  avg_paid: number;
  avg_delta: number;
  /** avg_delta as a % of value; null when the value is 0 */
  avg_pct: number | null;
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
  /** year-since-draft -> share of observations that are out-of-league zeros
   *  (no trace in a season whose history exists — busted, not "played, ~0") */
  out_rate?: Record<string, number>;
  hit_rate: number | null;
  hit_n: number;
  /** share of matured picks at this slot that became a FRANCHISE PLAYER at
   *  their position — 3 seasons clearing that position's bar. Replaces
   *  out_rate on the Draft page: "did it become a long-term starter" is the
   *  dynasty question, where out_rate only said "did he disappear". */
  fran_rate?: number | null;
  fran_n?: number;
  /** year-since-draft -> sorted per-season WAR samples (box-plot / trajectory) */
  dist: Record<string, number[]>;
}
export interface PickValues {
  meta: {
    generated_for_season: number; classes: string; years_published: number[];
    min_obs_by_round: Record<string, number>; hit_threshold_war: number;
    /** picks_analyzed counts drafting decisions (coverage — the headline, by
     *  Max's call, always labeled "analyzed"); picks_distinct is the honest
     *  evidence count named beside it; picks_used the weighted reps — see the
     *  meta comment in pick_value.py */
    picks_used: number; picks_analyzed?: number; picks_distinct?: number;
    vets_excluded: number; unmatched: number; source: string;
  };
  /** every slot individually: 1.01 … 4.12 */
  picks: PickBucket[];
  /** Early/Mid/Late tiers per round (larger samples; box plots use these) */
  bands: PickBucket[];
}

/** data/projections.json — 3-year forward WAR per rostered player */
export interface Projection {
  pid: string; name: string; pos: string; team: string;
  /** age on Sep 1 of meta.roster_season — the FIRST projected year, so the
   *  player page's per-year column is `age + i`, not `age + 1 + i` */
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
  /** projected positional finish per projected year (composite, e.g. WR6) */
  posFin?: number[];
  /** year-1 WAR implied by Sleeper's projected points alone (pts_to_war fit) */
  proj_ext: number | null;
  total: number; total_exp: number; total_comp: number;
}
export interface ProjectionsFile {
  meta: { seed_season: number; roster_season: number; horizon: number;
    years: number[]; players: number; model: string; generated: string };
  players: Projection[];
}
/** data/<league>/projections_knn_*.json — the EXPERIMENTAL analog projection.
 *  Runs alongside projections.json, never replaces it: instead of collapsing a
 *  career into one scalar and aging it, it matches a player to his k nearest
 *  historical comparables and reports what those players actually did. */
export interface KnnProjection {
  /** Sleeper id, joined via project_war.py's matcher. Null when the corpus
   *  name could not be resolved — a rookie with no NFL season has no entry
   *  at all, which is different from being unjoined. */
  pid: string | null;
  gsis: string; name: string; pos: string;
  age: number | null; exp: number | null;
  /** what the model saw: seasonal points/100 and games, most recent first.
   *  null is a season that does not exist, not a season of zero — same
   *  convention as KnnNeighbour.seen */
  seen: (number | null)[]; gps: (number | null)[];
  /** cohort size, and how many of it were scored per horizon year (an analog
   *  hurt that year is skipped, not zeroed — see METHODOLOGY on absence) */
  n: number; n_scored?: number[];
  /** how alike the cohort actually is. d_med 0.3 is a real neighbourhood, 1.8
   *  is a shrug; `padded` means it had to reach past the cutoff to fill. */
  d_med?: number; d_max?: number; padded?: boolean; eff_n?: number;
  /** d_med on the readable 0-100 match scale — see KnnNeighbour.sim */
  sim_med?: number;
  /** cohort MEDIAN per year, in league WAR */
  proj: number[]; proj_mean: number[];
  low: number[]; high: number[];
  /** share of the cohort that cleared 0.5 WAR — the breakout rate */
  share_useful: number[];
  total: number;
  /** the three closest comparables, named. Empty for a corpus player with no
   *  Sleeper id, since nothing on the site can link to him.
   *
   *  The player's OWN earlier windows are excluded from this list and from
   *  nothing else. A career contributes one window per season, so Josh Allen's
   *  two nearest neighbours are Josh Allen 2024 and 2023 — right for the median,
   *  which is a statement about how rare the pattern is, and useless as an
   *  answer to "who does he look like". */
  near?: KnnNeighbour[];
}
export interface KnnNeighbour {
  name: string | null;
  /** the season he was entering — his `seen` is the three years before it */
  season: number;
  age: number | null;
  /** distance, in standard deviations of the position's own features */
  d: number;
  /** the same thing on a 0-100 scale, gaussian, width set so the cohort
   *  membership cutoff lands exactly on 50 — at or above 50 he was inside the
   *  neighbourhood, below it he was reached for. Comparable across players,
   *  unlike the model's own per-player kernel. */
  sim: number;
  /** what he had done going in: seasonal points/100 and games, most recent
   *  first. null is a season that does not exist, not a season of zero. */
  seen: (number | null)[];
  gps: (number | null)[];
  /** what he ACTUALLY returned over the next three years, in league WAR.
   *  null = hurt or inactive, skipped rather than scored; a real 0.0 means he
   *  left the league. Different facts, different renderings. */
  then: (number | null)[];
  then_gp: number[];
}
export interface KnnFile {
  meta: { model: string; space: string; k: number; horizon: number;
    corpus_seasons: number[]; corpus_rows: number; seed_season: number;
    absent: string };
  players: KnnProjection[];
}

/** data/<league>/projections_matrix.json — the six curves, written by
 *  scripts/project_matrix.py. Two models (scalar, analog) plus their blend,
 *  each with and without Sleeper's depth-chart read folded in.
 *
 *  The analog composite is the odd one out and deliberately so: its Sleeper
 *  weight scales with `trust` rather than sitting at the scalar model's flat
 *  0.9. At a flat 0.9 the scalar and analog composites agree to a mean of
 *  0.020 WAR — the same curve twice, not two curves. */
export const MATRIX_CURVES = [
  "scalar_natural", "scalar_composite",
  "analog_natural", "analog_composite",
  "blend_natural", "blend_composite",
] as const;
export type MatrixCurve = typeof MATRIX_CURVES[number];
export type MatrixModel = "scalar" | "analog" | "blend";

export type MatrixRow = {
  pid: string; name: string; pos: string; team: string | null;
  age: number | null;
  /** whether a curve is its own model's read or a fallback. No analog cohort
   *  means the analog and blend curves ARE the scalar curve; no Sleeper above
   *  the pts13 floor means every composite is its own natural. Both have to be
   *  said out loud or the table shows agreement that was never measured. */
  has_analog: boolean; has_sleeper: boolean;
  sleeper_war: number | null;
  pts13: number;
  /** how much the analog's cohort is worth, in [0,1] — drives both the blend
   *  of the two naturals and the analog composite's Sleeper weight */
  trust: number | null;
  w_sleeper: number | null;
  d_med: number | null; padded: boolean | null;
  totals: Record<MatrixCurve, number>;
} & Record<MatrixCurve, number[]>;

export interface MatrixFile {
  meta: {
    curves: MatrixCurve[]; horizon: number; blend_w: number[];
    trust_p: number; pad_penalty: number; w_min: number; w_max: number;
    pts13_floor: number; d_ref: Record<string, number>;
    players: number; with_analog: number; with_sleeper: number;
    note: string;
  };
  players: MatrixRow[];
}

export interface SleeperProj {
  pos: string; pts13: number; ppg: number; raw_pts: number;
  /** week -> that week's own projected line (league-scored). Absent week =
   *  bye/absence — a fact, not missing data. Absent map = season-only row. */
  wk?: Record<string, number>;
}
export interface SleeperProjFile { meta: Record<string, unknown>; players: Record<string, SleeperProj>; }

/** The analog read as a player page draws it — his cohort's band, its size and
 *  match, and the three named comparables. A SUBSET of KnnProjection on purpose:
 *  the rest of that row is the model's own diagnostics and the fitted/expected
 *  paths, and `near` is most of why projections_knn_hybrid.json is 788 KB. */
export type KnnShard = Pick<KnnProjection, "n" | "sim_med" | "low" | "high" | "near">;

/** data/player/<pid>.json — one player's slice of projections.json,
 *  proj_sleeper.json, projections_matrix.json and projections_knn_hybrid.json,
 *  written by scripts/shard_players.py so a player page fetches ~2 KB instead
 *  of the ~1.6 MB of all four full files. A 404 (player in none of them) is
 *  expected and falls back to the plain WAR trend.
 *
 *  The four fields below `sproj` are OPTIONAL because a shard built before the
 *  enrichment does not carry them, and ABSENT rather than null when the player
 *  has no row in that source — the page reads `shard?.mx ?? null` either way,
 *  and the distinction keeps the shards that carry only an analog read small. */
export interface PlayerShard {
  years: number[];
  proj: Projection | null;
  sproj: SleeperProj | null;
  /** his row from projections_matrix.json. Absent = the matrix does not price
   *  him, and the page falls back to the three-stream projection table. */
  mx?: MatrixRow | null;
  /** projections_matrix.json's meta.blend_w — the flat scalar/blend Sleeper
   *  weight, and the only figure the player page reads out of that file's
   *  header. Written only alongside `mx`, since nothing else reads it. */
  blend_w?: number[] | null;
  knn?: KnnShard | null;
}

/** data/insights.json — written per-franchise outlooks, keyed by roster_id */
export interface Insights {
  meta: { generated: string; season: number; note: string };
  teams: Record<string, { head: string; text: string }>;
}

/** data/dvi.json — Dynasty Value Index, one 0-100 figure per player.
 *  `components` = how many signals fed the figure (absent in older data);
 *  a rating built from one signal is a weaker claim than one built from five. */
export interface DviRow { name: string; pos: string; dvi: number; rank: number; pos_rank: number; components?: number }
export interface DviFile { generated: string; players: Record<string, DviRow> }

/**
 * data/ecr.json — FantasyPros expert consensus, GLOBAL because a consensus
 * ranking is a property of the FORMAT (PPR, superflex), not of any one league.
 *
 * `ecr` is a RANK: 1 is best and lower is better, the opposite direction from
 * every index on the site. Players are keyed by Sleeper id, then by format
 * slug — the file can hold more than one, so read the slug from `formats`
 * rather than hardcoding it.
 */
export interface EcrRow {
  ecr: number; posRank: string; best: string; worst: string;
  avg: string; std: string; tier: number | null; delta: number | null;
}
export interface EcrFile {
  fetched: string;
  source: string;
  formats: Record<string, {
    scoring: string; year: string; week: string; type: string;
    experts: number; updated: string; ranked: number; matched: number;
  }>;
  players: Record<string, Record<string, EcrRow>>;
}

/** data/cvi.json — Contender Value Index, DVI's one-season sibling.
 *  `components` mirrors dvi.json (absent in older data). `ecr` is the raw
 *  FantasyPros consensus rank; absent means unranked, which for a redraft
 *  consensus reads as "known to give you nothing this year" (season-ending
 *  injury, deep stash) — Home's value plays use that to filter sell-highs. */
export interface CviRow { name: string; pos: string; cvi: number; rank: number; pos_rank: number; components?: number; ecr?: number }
export interface CviFile {
  generated: string; format?: string; ecrRanked?: number;
  players: Record<string, CviRow>;
}

/**
 * data/<league>/index_models.json — DVI and CVI under every projection curve,
 * written by scripts/index_models.py.
 *
 * dvi.json and cvi.json still ship and still hold the DEFAULT curve; this file
 * is what lets the masthead's model control reprice the whole site without a
 * fetch per flip. Identity is stored once per player and each curve carries
 * only `[value, rank, pos_rank]`, which is what keeps it near one dvi.json
 * rather than twelve.
 *
 * has_analog / has_sleeper are claims about the PROJECTION, not about the
 * figure. False means his analog and blend projections are the scalar one, or
 * every composite is its own natural — NOT that his index is model-independent.
 * Both indices clamp on percentiles of the whole field, so changing the model
 * reprices everyone and drags him with it: of the 65 players with no analog
 * cohort, all 65 had identical WAR across curves and only 4 an identical DVI.
 * Copy that says "this number won't move" is wrong and will be caught out.
 */
export type IndexTriple = [value: number, rank: number, posRank: number];
export interface IndexModelsRow {
  name: string; pos: string;
  has_analog: boolean; has_sleeper: boolean;
  /** raw ECR rank — curve-independent identity, absent = unranked (see CviRow.ecr) */
  ecr?: number;
  dvi: Record<MatrixCurve, IndexTriple>;
  cvi: Record<MatrixCurve, IndexTriple>;
}
export interface IndexModelsFile {
  generated: string; curves: MatrixCurve[]; default: MatrixCurve;
  format?: string; note?: string;
  players: Record<string, IndexModelsRow>;
}

/** data/picks_owned.json — who holds which future draft picks right now */
export interface PicksOwned {
  meta: { seasons: number[]; as_of: string };
  /** holder roster_id -> picks (orig = the roster whose finish sets the slot) */
  owned: Record<string, { season: number; round: number; orig: number }[]>;
}

/** data/franchises.json — per roster_id (stable franchise) history + transactions */
export interface FranchiseSeason {
  season: string; name: string; manager: string;
  /** the roster slot this franchise held THAT season — the join key for
   *  matchups/drafts/trades. Constant for dynasty (franchise = slot); varies
   *  for redraft (franchise = owner). Absent in data built before this. */
  rid?: number;
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
/** keyed by FRANCHISE KEY: the roster_id for dynasty leagues, the owner's
 *  user_id for redraft/keeper (an inherited roster slot is a new franchise —
 *  see build_site_data.py). Keys are strings either way. */
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
  /** picks only: the pick's season and round, for market pricing by the
   *  canonical mid-tier key */
  ps?: number;
  rnd?: number;
  /** converted picks only: the pick's mid-tier market price ON DRAFT DAY —
   *  the splice point where the asset stops being a pick and becomes the
   *  player. Delta vs the player's current value = what the slot bought. */
  mktDraft?: number;
  fcDraft?: number;
}
export interface TradeSide {
  rid: number; team: string; got: TradeAsset[];
  /** realized WAR while starting for this team */
  war: number;
  /** discounted expected WAR still to come, for assets this team still holds */
  future: number;
  /** war + future */
  total: number;
  /** FROZEN at-trade expectation (WAR), captured by the first daily run that
   *  saw the trade and never overwritten. Absent/null = the trade predates
   *  the snapshot store and can't be re-projected honestly. */
  expThen?: number | null;
  /** frozen at-trade market price (KTC points, players-only sides); the
   *  backfilled fallback where only values_history reaches */
  mktThen?: number | null;
  /** frozen at-trade FantasyCalc price, same rules as mktThen */
  fcThen?: number | null;
}
export interface Trade { season: string; week: number; ts: number; sides: TradeSide[]; }
export interface TradesFile {
  meta: { delta: number; proj_season: number; note: string };
  trades: Trade[];
}
/** trades.json was a bare array before mark-to-market; accept either shape so
 *  the site keeps working against data generated by an older script. */
export type TradesPayload = Trade[] | TradesFile;

/** data/<season>/bracket.json — the playoff bracket, self-contained:
 *  seeds + names ride along so the Playoffs pages need no second fetch */
export interface BracketGame {
  r: number; week: number;
  /** placement the game decides (1 = championship, 3, 5, …); absent = elimination round */
  p?: number | null;
  t1: number | null; t2: number | null;
  w: number | null; l: number | null;
  t1_pts: number | null; t2_pts: number | null;
}
export interface BracketFile {
  playoff_start: number;
  seeds: Record<string, number | null>;
  names: Record<string, string>;
  winners: BracketGame[]; losers: BracketGame[];
  /** pid -> fantasy points per winners-bracket week while STARTING; points,
   *  not WAR, because WAR is only scored for the regular season */
  stars?: Record<string, { rid: number; wk: Record<string, number> }>;
  /** pid -> win probability added (Shapley, per matchup). `tot` and `wk` are
   *  RAW win probability — the measured quantity, so the weeks sum to the
   *  total. `wtot` applies the round weights and `mvp` puts that on a 0-100
   *  scale anchored to the best postseason on record across ALL seasons, so
   *  scores compare across years. Elimination games only — placement games
   *  are excluded. See scripts/playoff_wpa.py */
  wpa?: Record<string, {
    rid: number;
    /** raw WPA, and the round-weighted version */
    tot: number; wtot: number;
    /** win share, IN WINS: each elimination game hands out exactly 1.0 to the
     *  winning side, so a champion's nine starters sum to 3.0. `wsw` is the
     *  round-weighted version the MVP score is built from. */
    ws?: number; wsw?: number;
    /** the season scale: 100 = that year's best run, so the year's winner is
     *  always 100 and the week columns are points out of a shared 100 */
    mvp?: number;
    /** the historical index, OPS+ style: 100 = the average MVP-winning run,
     *  so 122 beats a typical champion's best player and 72 is a thin year */
    mvpp?: number;
    /** week -> MVP points on the SEASON scale. These sum EXACTLY to `mvp`,
     *  which is computed as their sum. */
    mvpwk?: Record<string, number>;
    /** week -> raw WPA */
    wk: Record<string, number>;
  }>;
  /** per elimination game: the pregame line it turned on */
  wp?: Record<string, {
    week: number; r: number; weight: number;
    t1: number; t2: number; pre_t1: number; mu_t1: number; mu_t2: number;
  }>;
  /** pid -> playoff WAR: points above positional replacement converted to
   *  wins, credited WIN OR LOSE. The one figure here that isn't conditioned
   *  on the result — see scripts/playoff_war.py */
  war?: Record<string, {
    rid: number; war: number; pts: number; par: number; gp: number;
    wk: Record<string, number>;
  }>;
  war_meta?: { sigma: number; sigma_source: string; scope: string; note: string };
  wpa_meta?: {
    round_weight: Record<string, number>;
    prior_n: number; min_sd: number; scope: string;
    /** MVP's 100: this season's best run */
    season_anchor?: number; season_anchor_name?: string;
    /** MVP+'s 100: the average MVP-winning run, and the seasons behind it */
    mvp_avg?: number; mvp_avg_seasons?: string[];
  };
}

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

/** data/benchmarks.json — cross-league championship benchmarks, merged from the
 *  outcomes crawl by scripts/benchmarks.py. Every rate arrives with the sample
 *  it was built on; `v` is null when that sample is below meta.min_n, so a null
 *  means "not enough data yet", never zero. */
export interface BenchFig { v: number | null; n: number; of?: number }
export interface Benchmarks {
  meta: {
    generated: string; shards: number; league_seasons: number;
    champions: number; rosters: number; horizon: number; min_n: number;
    note: string;
  };
  /** `field` throughout is the REST OF THE BRACKET that season — the playoff
   *  teams the champion had to beat, excluding the champion itself. It is not
   *  the whole league, and it is not the league-including-the-champion. */
  slots: { slot: string; champ: BenchFig; field: BenchFig }[];
  construction: Record<string, { champ: BenchFig; field: BenchFig }>;
  picks: {
    kept_own_1st: BenchFig; traded_own_1st: BenchFig;
    r1_held: { champ: BenchFig; field: BenchFig };
    net_picks: BenchFig; bought: BenchFig; sold: BenchFig;
  };
  by_league_year: {
    year: number; league_seasons: number; champ: BenchFig; field: BenchFig;
  }[];
  playoffs: {
    stayed: BenchFig; climbed: BenchFig;
    climber_homegrown: BenchFig; stuck_homegrown: BenchFig;
  };
  turnaround: {
    bottom_finishes: number; no_room: number;
    within: { years: number; title: BenchFig; top_third: BenchFig }[];
    avg_place_move: BenchFig;
  };
}
