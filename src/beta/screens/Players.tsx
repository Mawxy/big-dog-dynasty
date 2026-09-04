import {
  Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import type {
  EcrFile, Matchups, MatrixFile, MatrixRow, SummaryRow, Team, Values, Weekly, WeeklyRow,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useCviQuery, useDviQuery, useProjWar1 } from "../../lib/useIndices";
import { fmt } from "../../lib/stats";
import { ktcOf } from "../../lib/values";
import {
  latestSeasonOf, ownerOf, pInfo, POS_CHIPS, POS_COLOR, rosterSeasonOf,
} from "../../lib/league";
import {
  HONOR_LABEL, honorTotals, loadCareer, loadHonors, playerHonors,
  type CareerSeason, type HonorIndex, type HonorKey,
} from "../../lib/honors";
import {
  loadRecords, recordsOf, wlByLosses, wlByWins, wlGames, wlText,
  type RecordIndex, type WL,
} from "../../lib/records";
import {
  loadPostseason, postseasonOf, type PostSeasonIndex,
} from "../../lib/postseason";
import { loadWinShare, winShareOf, type WinShareIndex } from "../../lib/winshare";
import HonorMarks, { HonorSprite } from "../../components/HonorMarks";
import { useMobile } from "../../lib/useWidth";
import ScopeControl, { ALL_SEASONS, useScope } from "../Scope";
import {
  Band, DataError, fmtWar, IdCell, LensStrip, NUL, Spine, sortBy, TapRow, Th,
  useBetaPath, useSort,
} from "../ui";
import "./players.css";

/**
 * PLAYERS — every player, in one board, in one tense at a time.
 *
 * This replaces the Rankings screen's player half and merges the classic
 * board's two player tables, Value and Stats. Those were split because eleven
 * columns is one row over the budget that keeps a row on one line; the split
 * cost was that "what is he worth" and "what did he do" looked like two
 * populations. They are one population measured in two tenses, so the tense is
 * a control and not a screen:
 *
 *   CURRENT  a price — DVI, CVI, Proj WAR, KTC, FantasyCalc, ECR
 *   STATS    production — GP, Points, PPG, the two won-lost records, WAR,
 *            scoped to one settled season or to every season at once
 *
 * THE RIGHT SEGMENT IS "STATS", NOT "HISTORY" (Max, 2026-09-03). The two words
 * describe different things and the control was named for the wrong one: the
 * segment does not select a PERIOD, it selects a KIND OF FIGURE — what a player
 * produced rather than what he costs — and All-time is one of the things that
 * kind can be scoped to. Under the old name "All-time history" was the phrase
 * the picker was reaching for, which is a period inside a period.
 *
 * ONE TENSE PER VIEW, all the way down. There is no market price anywhere in
 * the Stats board and no per-season production anywhere in the Current one,
 * including in the drawer: a 2023 season priced against a 2026 market is two
 * claims stapled together, and the reader would have no way to tell which half
 * the row was ordered by.
 *
 * The columns and the sort strip are the same board at two widths, not two
 * boards. On a phone the header row collapses into the sort strip and the
 * picked key becomes the row's lead figure, with the keys it displaced demoted
 * to a micro line underneath. On desktop those are columns again and the
 * headers sort. Nothing about what a row SAYS changes across the breakpoint.
 */

/* ========================================================================
   COLUMNS
   ======================================================================== */

/** every figure either tense measures. One union so the sort state, the column
 *  descriptors and the strip all speak the same key. */
type Key =
  | "dvi" | "cvi" | "war" | "ktc" | "fc" | "ecr"
  | "gp" | "pts" | "ppg" | "ws"
  /** the two won-lost records — see lib/records. They print as "12-2", which is
   *  why every figure on this board reaches the cell through `cellOf` rather
   *  than FMT alone, and they sort two ways: by wins, then by losses. */
  | "wls" | "wlr";

/** the keys whose header cycles WINS -> LOSSES rather than flipping direction */
const RECORD_KEYS = new Set<Key>(["wls", "wlr"]);

interface Col {
  id: Key;
  label: string;
  /** the label on the sort strip and the micro line, where "FantasyCalc" has
   *  no room to be itself */
  short?: string;
  /** percentage width, declared on the header cell — never pixels, which break
   *  under viewport squish, and never a <colgroup>, which the runtime strips */
  width: string;
  /** first column of a group: takes the group divider */
  edge?: boolean;
  /** a RANK — 1 is best, so the first click sorts ascending */
  asc?: boolean;
}

/* Reading left to right, a Current row answers one question in three
 * currencies: our own model, what the dynasty market pays, and where the
 * win-now consensus ranks him. They are never blended — where they disagree is
 * the point, and one line is what makes the disagreement visible. */
const CUR_COLS: Col[] = [
  { id: "dvi", label: "DVI", width: "9%", edge: true },
  { id: "cvi", label: "CVI", width: "9%" },
  { id: "war", label: "Proj WAR", short: "WAR", width: "14%" },
  { id: "ktc", label: "KTC", width: "9%", edge: true },
  { id: "fc", label: "FantasyCalc", short: "FC", width: "11%" },
  { id: "ecr", label: "ECR", width: "8%", edge: true, asc: true },
];
const CUR_GRPS = [
  { label: "Our model", span: 3 },
  { label: "Dynasty market", span: 2 },
  { label: "Redraft", span: 1 },
];

/* THE RECORD COLUMNS SIT BETWEEN PRODUCTION AND WAR, and the order is the
   argument: what he scored, then what happened in the weeks he was there, then
   what he was worth. The two records are their own group because neither of
   them is production — a record is a fact about the roster around him, and
   grouping them under "Production" would have claimed otherwise. */
const HIST_COLS: Col[] = [
  { id: "gp", label: "GP", width: "6%", edge: true },
  { id: "pts", label: "Points", short: "PTS", width: "9%" },
  { id: "ppg", label: "PPG", width: "8%" },
  { id: "wls", label: "Started", short: "W-L S", width: "10%", edge: true },
  { id: "wlr", label: "Rostered", short: "W-L R", width: "10%" },
  { id: "war", label: "WAR", width: "10%", edge: true },
  // "WS", not "Win share" (Max, 2026-09-03). The long form does not fit a 10%
  // column at any weight the rest of the header row uses, and shrinking one
  // label to fit makes the header row two sizes. The Key above the table is
  // where the word lives.
  { id: "ws", label: "WS", width: "10%" },
];
/* MAXALYTICS (Max, 2026-09-03) — the group that was "Wins added", now holding
   both of this board's own inventions. They are a pair by construction: WAR
   asks what a player was worth against a replacement-level body, win share asks
   how much of the winning was actually his, and neither is a number any other
   fantasy site would give you. Everything to the left of them is arithmetic on
   a box score. */
const HIST_GRPS = [
  { label: "Production", span: 3 },
  { label: "Won-lost", span: 2 },
  { label: "Maxalytics", span: 2 },
];

/**
 * THE PHONE SORT STRIP'S KEYS — four is the ceiling at 390px.
 *
 * Not every column is here, and that is the constraint rather than an
 * oversight: five segments at that width are 66px each, which is narrower than
 * the word they carry. Current keeps the three model figures and the one market
 * price a dynasty reader actually quotes; FantasyCalc and ECR stay in the
 * drawer and on the desktop header, where there is room to sort by them.
 */
const CUR_STRIP: Key[] = ["dvi", "cvi", "war", "ktc"];
const HIST_STRIP: Key[] = ["war", "ws", "ppg", "wls"];

/** One formatter per key, so a figure carries the same precision in a column,
 *  on the micro line and in the drawer. WAR is 2dp everywhere on the beta
 *  board (ui.tsx WAR_DP_BETA); the indices are 0–100 and take one place. */
const FMT: Record<Key, (v: number) => string> = {
  dvi: v => fmt(v, 1), cvi: v => fmt(v, 1),
  war: fmtWar,
  ktc: v => Math.round(v).toLocaleString(),
  fc: v => Math.round(v).toLocaleString(),
  ecr: v => String(Math.round(v)),
  gp: v => String(v),
  pts: v => fmt(v, 1),
  ppg: v => fmt(v, 2),
  // in WINS, at WAR's precision, because the two sit in the same group and a
  // reader compares them down the row
  ws: v => fmt(v, 2),
  // never reached — a record always arrives through `text`, and its numeric
  // value is a sort key, not a figure — but the map is total over Key so that
  // adding a column cannot silently skip a formatter
  wls: v => String(v), wlr: v => String(v),
};

/* ========================================================================
   THE KEY

   Every column, defined, behind one press above the table.

   A HEADER IS AN ABBREVIATION AND THE KEY IS WHERE IT IS SPELLED OUT (Max,
   2026-09-03). "WS" cannot fit its own name in a 10% column and neither can
   DVI, CVI, ECR or PPG; widening one to hold a word would set the whole header
   row to the width of its longest label. So the labels stay short and the
   definitions live in one place a reader can open — and, because it is one
   place, the two tenses and the two phases can each define the same header
   differently without a footnote arguing with a header.

   It replaces nothing: the closing note under the table still carries the
   argument — what the figures are FOR, where they disagree — while this
   answers "what does that column say".
   ======================================================================== */

const DEF: Record<Key, string> = {
  dvi: "Dynasty Value Index, 0–100. What a player is worth in a dynasty trade: "
    + "half market, half projected WAR, roster share and start share.",
  cvi: "Contender Value Index, 0–100. What he is worth for this season alone. No "
    + "age channel — that is DVI's job.",
  war: "Wins above replacement, on this league's own scoring. His margin over the "
    + "best unrostered player at his position, each week, converted to a "
    + "win-probability shift at that week's spread of team scores.",
  ktc: "KeepTradeCut's dynasty superflex value, on this league's TE-premium ladder.",
  fc: "FantasyCalc's dynasty superflex value. A second market in its own currency, "
    + "never blended with the first.",
  ecr: "FantasyPros redraft expert consensus rank, where 1 is best — so a rookie "
    + "sits below his dynasty price by design.",
  gp: "Games played.",
  pts: "Fantasy points scored.",
  ppg: "Points per game. The one figure a short sample flatters — read it beside GP.",
  ws: "Win share, in wins. Every game a team wins hands out exactly 1.0 among the "
    + "nine who started it, half by each starter's Shapley win-probability "
    + "contribution and half by his points over positional replacement. The "
    + "league's shares sum to the games it actually won, so a total reads "
    + "literally: 3.2 of his team's 9 wins. WAR is what he was worth; this is how "
    + "much of the winning was his.",
  wls: "Won-lost as a STARTER — the weeks a manager put him in the lineup, and how "
    + "that lineup finished. Sorts by wins on the first press and by losses on the "
    + "second, both most-first.",
  wlr: "Won-lost as a ROSTERED player — every week he was owned, started or "
    + "benched. The gap between this and Started is how often he was owned and "
    + "left out.",
};

/** where the postseason means something different by the same name */
const DEF_POST: Partial<Record<Key, string>> = {
  war: "Playoff WAR. Points above the week's positional replacement, converted to "
    + "wins and credited win or lose — the one figure here that does not depend on "
    + "the result.",
  gp: "Elimination games started, plus a first-round bye where one was carried.",
  pts: "Fantasy points in those games. A bye week carries his own playoff average "
    + "rather than a real score — only the team total for it is on the site.",
  ws: "Win share, in wins. Each elimination game hands out exactly 1.0 among its "
    + "nine starters, half by Shapley win-probability contribution and half by "
    + "points over positional replacement, so a champion's lineup sums to 3.0. The "
    + "same figure, from the same code, as the regular-season column.",
  wls: "Won-lost as a STARTER in the bracket. A FIRST-ROUND BYE IS A WIN: the top "
    + "two seeds advance without playing, and a record that ignored that would rank "
    + "finishing first below finishing third.",
  wlr: "Won-lost as a ROSTERED player in the bracket, started or benched — byes "
    + "included.",
};

/** a figure, or the em dash. NEVER a zero: a player the market has never priced
 *  and a player priced at nothing are different facts. */
const figOf = (id: Key, v: number | null): ReactNode => v == null ? NUL : FMT[id](v);

/**
 * The cell, for a key that may print as something other than its sort value.
 *
 * A won-lost record sorts on WINS — a count, biggest first, the way every other
 * column on the board behaves — and prints as "12-2". Sorting on win PERCENTAGE
 * instead would put a one-week 1-0 waiver stash above a 12-2 season, which is
 * the same mistake the games floor exists downstream to prevent.
 */
const cellOf = (r: Row, id: Key): ReactNode =>
  r.text?.[id] ?? figOf(id, r.f[id] ?? null);

/* ========================================================================
   ROWS
   ======================================================================== */

/**
 * One row, in whichever tense is in force.
 *
 * `f` holds every figure the columns and the strip read, keyed by column id, so
 * sorting, the lead figure and the micro line are one code path across both
 * tenses. `kind` narrows the rest — the drawer's contents are the one place the
 * two tenses genuinely differ in shape.
 */
interface RowBase {
  pid: string;
  name: string;
  pos: string;
  /** line 2 of the identity cell, before the position rank. Current: the
   *  franchise that holds him. History: the franchise he STARTED for — the same
   *  fact the drawer states, derived once. */
  affil: string | null;
  f: Partial<Record<Key, number | null>>;
  /** what a key PRINTS, where that is not its sort value — the two records */
  text?: Partial<Record<Key, string>>;
  /** a key's SECOND sort value, for a column that sorts two ways. The record
   *  columns' `f` is their by-wins key and this is their by-losses one. */
  alt?: Partial<Record<Key, number | null>>;
  /** the honor marks this row's scope earned, in rarity order with counts. One
   *  season's marks in a season scope; the career's totals in all-time. */
  marks?: [HonorKey, number][];
}
interface CurRow extends RowBase {
  kind: "cur";
  nfl: string;
  owner: string | null;
  age: number | null;
  /** the ANALOG curve's three-year total. Null when the model found no cohort
   *  for him, in which case the analog curve IS the scalar curve and printing
   *  it would show agreement that was never measured. */
  analog: number | null;
}
interface HistRow extends RowBase {
  kind: "hist";
  /** weekly σ of fantasy points; absent in seasons pulled before the full-NFL
   *  stats feed existed, and absent is not zero */
  sdv: number | null;
  warG: number | null;
  /** rank within position by that season's POINTS — the finish, not this
   *  board's current ordering */
  finish: number;
  started: { team: string; starts: number } | null;
}
/** the postseason, one year or pooled — the Playoffs phase's row */
interface PostRow extends RowBase {
  kind: "post";
  /** seasons that contributed, so a pooled row states its sample */
  seasons: number;
  /** first-round byes he was on the roster for, each of which is a win */
  byes: number;
  wl: { start: WL; roster: WL };
}
/** every settled season at once — the all-time scope's row */
interface AllRow extends RowBase {
  kind: "all";
  /** seasons with a scored game, which is the sample behind every total */
  seasons: number;
  /** the best single season by WAR, and which one it was */
  best: { season: string; war: number } | null;
  /** the best rank within position he ever finished, by that season's WAR */
  peak: number | null;
  /** the two records, kept whole for the drawer */
  wl: { start: WL; roster: WL };
}
type Row = CurRow | HistRow | AllRow | PostRow;

/**
 * Which franchise STARTED a player, and how often, in a settled season.
 *
 * Ownership at season's end is a different fact and the easy one — teams.json
 * states it — but "who did he play for" is answered by the lineups, not by who
 * happened to be holding him in January. matchups.json carries each week's
 * starters, so this counts regular-season starts per roster and takes the
 * plurality: a player traded in week 8 started for two franchises and is
 * credited to the one that started him more, which is the honest single answer
 * a one-line sub-line can hold.
 *
 * A player who was rostered all year and never started returns nothing, not a
 * franchise with zero starts — the row's sub-line and the drawer both render
 * the em dash for him, and they render the same one because they read this.
 */
function startsBy(mw: Matchups, teams: Team[]) {
  const ps = mw.playoff_start || 15;
  const name = new Map<number, string>(teams.map(t => [t.roster_id, t.team]));
  const per = new Map<string, Map<number, number>>();
  for (const [rid, list] of Object.entries(mw.teams)) {
    const r = Number(rid);
    for (const e of list) {
      if (e[0] >= ps) continue;                       // regular season only
      for (const pid of e[4] ?? []) {
        // Sleeper writes "0" into a lineup slot nobody filled
        if (!pid || pid === "0") continue;
        const m = per.get(pid) ?? new Map<number, number>();
        m.set(r, (m.get(r) ?? 0) + 1);
        per.set(pid, m);
      }
    }
  }
  const out = new Map<string, { team: string; starts: number }>();
  for (const [pid, m] of per) {
    let best = -1, n = 0;
    for (const [r, c] of m) if (c > n) { n = c; best = r; }
    if (best >= 0) out.set(pid, { team: name.get(best) ?? `#${best}`, starts: n });
  }
  return out;
}

/* ========================================================================
   THE SCREEN
   ======================================================================== */

export default function Players() {
  const { meta, players, league } = useLeague();
  const betaPath = useBetaPath();
  const rosterSeason = rosterSeasonOf(league);
  const latest = latestSeasonOf(meta);

  /**
   * EVERY SEASON, NEWEST FIRST — INCLUDING THE ONE BEING PLAYED (Max,
   * 2026-09-03).
   *
   * The roster season used to be withheld here, on the argument that an empty
   * column reads as a league that scored nothing. It does in the offseason and
   * it stops the moment week one is settled: the nightly build writes
   * summary.json, weekly.json and matchups.json for the current year as the
   * games happen, so the scope fills in behind the reader. Withholding it means
   * the board has nothing to say about the season everyone is actually
   * watching, all the way to January.
   *
   * `latest` still marks the newest SETTLED season and is what the sub-line and
   * the empty state read; the picker offers the whole list.
   */
  const played = useMemo(
    () => meta.seasons.slice().reverse(), [meta.seasons]);
  /* `allowAll` puts an All-time row at the top of the season picker without
     making it the default: the segment still opens on the newest settled
     season, which is what a reader almost always wants, and all-time is one tap
     further rather than a tense of its own. */
  const [scope, setScope] = useScope(played, { allowAll: true });
  const hist = scope.scope === "history";
  const season = hist ? scope.season : null;
  /** every settled season pooled into one row per player */
  const allTime = season === ALL_SEASONS;
  /** the single season a per-season query should read, or null in all-time */
  const oneSeason = hist && !allTime ? season : null;
  /* No champion/record note on the picker rows. It would be the right thing to
     show there and it costs a 217 KB franchises.json fetch this screen makes
     for nothing else; the League screen already holds that file and is where
     the note earns itself. */
  const seasons = useMemo(() => played.map(id => ({ id })), [played]);

  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  /* WHICH HALF OF THE SEASON. A filter rather than a scope segment: the tense
     control already says WHICH YEARS, and stacking "when in the year" onto it
     would give one control two jobs and four segments. Regular season is the
     default because it is fourteen weeks against three and because it is the
     only phase in which the board's own WAR is defined league-wide. */
  const [phase, setPhase] = useState<"reg" | "post">("reg");
  const [keyOpen, setKeyOpen] = useState(false);

  /* 900px, not style.css's 640px: the beta shell's own desktop breakpoint is
     where the nav bar becomes a rail and the tables gain their padding, and a
     board that grew columns at a different width than the shell changed shape
     would be two layouts crossing over in the middle. */
  const mobile = useMobile("(max-width: 899px)");

  /* One sort state per tense rather than one shared. The two column sets share
     only `war`, and a reader who ordered the price board by KTC has not said
     anything about how they want 2023 ordered — carrying it across would either
     drop to a default silently or apply a key the other tense does not have. */
  const cur = useSort<Key>("dvi");
  const hst = useSort<Key>("war");
  const s = hist ? hst : cur;

  // The tense changing re-states every figure in the row, so an open drawer
  // would be answering the previous question. Sorting and filtering deliberately
  // do NOT close it: those re-order and narrow the same rows, and a drawer that
  // shut on every keystroke would make the search box unusable next to it.
  const tense = hist ? `h:${season}:${phase}` : "c";
  useEffect(() => { setOpen(null); }, [tense]);

  /* ---- the three whole-league indexes the Stats board needs ---------------

     These are promise loaders rather than `useJson` hooks because each one
     reads EVERY season's files and folds them together — a shape `useJson`,
     which fetches one path, has no way to express. All three cache at module
     level, so a reader switching between 2023, 2025 and All-time pays for them
     once per page load.

     They are fetched only in the Stats tense. On the price board they would be
     four season-files of pure cost. */
  const [honors, setHonors] = useState<HonorIndex | null>(null);
  const [recs, setRecs] = useState<RecordIndex | null>(null);
  const [career, setCareer] = useState<Record<string, CareerSeason[]> | null>(null);
  /* THE ALL-TIME BOARD HAS NO `useJson` TO REPORT A DROPPED FETCH, so the
     loader's own rejection is the only signal that the population is never
     coming. Without this the screen says Loading… for the life of the page. The
     two indexes the season board also uses are NOT fatal: a season still has
     its summary.json, and a missing record index costs two columns, not a
     board. */
  const [careerErr, setCareerErr] = useState(false);
  const [post, setPost] = useState<PostSeasonIndex | null>(null);
  const [postErr, setPostErr] = useState(false);

  const [wins, setWins] = useState<WinShareIndex | null>(null);

  useEffect(() => {
    if (!hist || !played.length) return;
    let live = true;
    loadHonors(played).then(h => { if (live) setHonors(h); }).catch(() => {});
    loadRecords(played).then(r => { if (live) setRecs(r); }).catch(() => {});
    /* NOT FATAL IF IT DROPS. winshare.json is newer than the seasons around it
       and a deploy can be missing one; the column reads the em dash for that
       season and the rest of the board stands. */
    loadWinShare(played).then(w => { if (live) setWins(w); }).catch(() => {});
    return () => { live = false; };
  }, [hist, played]);

  useEffect(() => {
    if (phase !== "post" || !hist || !played.length) return;
    let live = true;
    setPostErr(false);
    loadPostseason(played)
      .then(p => { if (live) setPost(p); })
      .catch(() => { if (live) setPostErr(true); });
    return () => { live = false; };
  }, [phase, hist, played]);

  useEffect(() => {
    if (!allTime || !played.length) return;
    let live = true;
    setCareerErr(false);
    loadCareer(played)
      .then(c => { if (live) setCareer(c); })
      .catch(() => { if (live) setCareerErr(true); });
    return () => { live = false; };
  }, [allTime, played]);

  /* ---- CURRENT: the price board's sources ------------------------------- */

  const dviQ = useDviQuery();
  const cviQ = useCviQuery();
  // YEAR-1 projected WAR, not the 3-year total: on a board beside PPG and
  // CVI, "Proj WAR" reads as next season (settled with Max, 2026-08-31).
  const projWar = useProjWar1();
  /* projections_matrix.json is already in flight for `projWar`; reading it
     directly costs one more `.then` on the same cached promise and is what
     supplies age and the analog curve, neither of which the index files carry.
     The three model files are NOT gated on the tense the way the market files
     below are: useDvi/useCvi/useProjWar1 have no "don't fetch" form, and forking
     the projection-model logic into this screen to get one would put a second
     publisher on the number the masthead control drives. */
  const mxQ = useJson<MatrixFile>(hist ? null : "projections_matrix.json");
  const valsQ = useJson<Values>(hist ? null : "data/values.json", "globalDaily");
  const ecrQ = useJson<EcrFile>(hist ? null : "data/ecr.json", "globalDaily");
  const rosQ = useJson<Team[]>(hist ? null : `${rosterSeason}/teams.json`);

  const curPop = useMemo<Row[] | null>(() => {
    const dvi = dviQ.data, cvi = cviQ.data;
    if (hist || !dvi || !cvi) return null;
    // the file can hold more than one format, so the slug is read rather than
    // hardcoded
    const slug = Object.keys(ecrQ.data?.formats ?? {})[0];
    const owners = rosQ.data ? ownerOf(rosQ.data) : {};
    const mx = new Map<string, MatrixRow>(
      (mxQ.data?.players ?? []).map(p => [p.pid, p]));
    // the population is the INDEX's, not the roster's: DVI prices every player
    // the model covers, and a board that only listed the rostered ones could
    // not answer "is there anything on waivers"
    return Object.entries(dvi.players).map(([pid, d]): Row => {
      const v = valsQ.data?.players?.[pid];
      const m = mx.get(pid);
      return {
        kind: "cur",
        pid, name: d.name, pos: d.pos,
        affil: owners[pid] ?? null,
        nfl: players[pid]?.[2] ?? "",
        owner: owners[pid] ?? null,
        age: m?.age ?? null,
        analog: m?.has_analog ? m.totals?.analog_composite ?? null : null,
        f: {
          dvi: d.dvi,
          cvi: cvi.players[pid]?.cvi ?? null,
          war: projWar?.[pid] ?? null,
          // through ktcOf, never row.ktc: KTC publishes four ladders and this
          // league sits on one of them (meta.tep). Reading the base column
          // prices a TE-premium league's tight ends in the wrong market.
          ktc: ktcOf(v, meta.tep),
          fc: v?.fc ?? null,
          ecr: slug ? ecrQ.data?.players?.[pid]?.[slug]?.ecr ?? null : null,
        },
      };
    });
  }, [hist, dviQ.data, cviQ.data, ecrQ.data, valsQ.data, rosQ.data, mxQ.data,
    projWar, players, meta.tep]);

  /* ---- STATS: one settled season ---------------------------------------- */

  const sumQ = useJson<SummaryRow[]>(oneSeason ? `${oneSeason}/summary.json` : null);
  const hTeamQ = useJson<Team[]>(oneSeason ? `${oneSeason}/teams.json` : null);
  const mwQ = useJson<Matchups>(oneSeason ? `${oneSeason}/matchups.json` : null);
  /* weekly.json is 140 KB and answers exactly one figure in the drawer, so it
     is fetched when a drawer is open and not before. Opening a second row keeps
     the same path, so the file is fetched once per season, not once per tap. */
  const wkQ = useJson<Weekly>(oneSeason && open ? `${oneSeason}/weekly.json` : null);

  const histPop = useMemo<Row[] | null>(() => {
    const sum = sumQ.data;
    // `oneSeason` in the guard, not just the files: on the tap that switches to
    // all-time the season queries still hold the previous season's data for a
    // render, and building rows against a null season would key the record and
    // honor lookups on nothing.
    if (!sum || !oneSeason || !hTeamQ.data || !mwQ.data) return null;
    /* POSITION FINISH — rank within position by that season's POINTS, over
       every row in the file. Computed before the games floor below, because a
       finish is a fact about the season and not about this board's inclusion
       rule, and by points rather than by the active sort, because "WR6" means
       the sixth-best scoring receiver to everyone who has ever played fantasy
       football. The badge on the row means the other thing, which is why the
       drawer labels this one. */
    const finish = new Map<string, number>();
    const seen: Record<string, number> = {};
    for (const r of sum.slice().sort((a, b) => b[3] - a[3])) {
      seen[r[1]] = (seen[r[1]] ?? 0) + 1;
      finish.set(r[0], seen[r[1]]);
    }
    const started = startsBy(mwQ.data, hTeamQ.data);
    // WAR is optional in the row tuple and a row missing it arithmetics into
    // NaN, which sorts unpredictably. Drop the row rather than zeroing it.
    const all = sum.filter(r => typeof r[6] === "number").map((r): Row => {
      const [pid, p, gp, pts, ppg, , war, sdv] = r;
      const st = started.get(pid) ?? null;
      /* The two records for THIS season. `recs` is still null on the first
         render after a scope change, which is why both columns are nullable
         figures rather than a zeroed record: "not read yet" and "never won a
         week" must not print the same thing. */
      const wl = recordsOf(recs, pid, [oneSeason!]);
      return {
        kind: "hist",
        pid, name: pInfo(players, pid)[0], pos: p,
        affil: st?.team ?? null,
        sdv: typeof sdv === "number" ? sdv : null,
        warG: gp ? war / gp : null,
        finish: finish.get(pid) ?? 0,
        started: st,
        f: {
          gp, pts, ppg, war,
          ws: winShareOf(wins, pid, [oneSeason]),
          wls: wlByWins(wl.start),
          wlr: wlByWins(wl.roster),
        },
        alt: { wls: wlByLosses(wl.start), wlr: wlByLosses(wl.roster) },
        text: {
          wls: wlText(wl.start) ?? undefined,
          wlr: wlText(wl.roster) ?? undefined,
        },
        marks: honors?.byPlayer[pid]?.[oneSeason!]?.length
          ? honorTotals([{ season: oneSeason!, keys: honors.byPlayer[pid][oneSeason!] }])
          : undefined,
      };
    });
    /* NO GAMES FLOOR (Max, 2026-09-03). The classic board drops anyone under
       45% of the season's maximum games, on the argument that a two-game cameo
       at 22 PPG outranks everyone who played a full year. That is true of PPG
       and of nothing else on this board — GP is a column, the records state
       their own sample, and WAR and win share are totals that a short season
       cannot inflate. Every player the season scored is listed; the reader can
       see the sample and decide. */
    return all;
  }, [sumQ.data, hTeamQ.data, mwQ.data, players, recs, honors, wins, oneSeason]);

  /* ---- STATS: every settled season at once ------------------------------
     One row per player, totals rather than a season. `loadCareer` has already
     folded every summary.json into per-player season rows with the position
     rank and the honors attached, so this is arithmetic over that rather than
     a second pass at the files. */

  const allPop = useMemo<Row[] | null>(() => {
    if (!allTime || !career) return null;
    /* NO GAMES FLOOR here either — same call as the season board above. GP is
       a column and the records carry their own samples, so a one-week career
       is visible as one rather than hidden. */
    const out: Row[] = [];
    for (const [pid, rows] of Object.entries(career)) {
      if (!rows.length) continue;
      const gp = rows.reduce((a, r) => a + r.gp, 0);
      const pts = rows.reduce((a, r) => a + r.pts, 0);
      const war = rows.reduce((a, r) => a + r.war, 0);
      const wl = recordsOf(recs, pid, played);
      /* THE MOST RECENT SEASON'S POSITION. `career` rows are newest first, and
         a player who moved (a tight end lined up at wide receiver, a Sleeper
         reclassification) is listed where the league last had him — the same
         answer the Current board gives. */
      const pos = rows[0].pos;
      const best = rows.reduce<{ season: string; war: number } | null>(
        (b, r) => (b == null || r.war > b.war ? { season: r.season, war: r.war } : b), null);
      const peak = rows.reduce<number | null>(
        (b, r) => (r.posRank != null && (b == null || r.posRank < b) ? r.posRank : b), null);
      const marks = honorTotals(playerHonors(honors, pid));
      out.push({
        kind: "all",
        pid, name: pInfo(players, pid)[0], pos,
        // A career has no one franchise, and naming the last one would read as
        // "his team". The seasons count goes here instead.
        affil: `${rows.length} season${rows.length === 1 ? "" : "s"}`,
        seasons: rows.length,
        best, peak, wl,
        f: {
          gp, pts, ppg: gp ? pts / gp : null, war,
          ws: winShareOf(wins, pid, played),
          wls: wlByWins(wl.start),
          wlr: wlByWins(wl.roster),
        },
        alt: { wls: wlByLosses(wl.start), wlr: wlByLosses(wl.roster) },
        text: {
          wls: wlText(wl.start) ?? undefined,
          wlr: wlText(wl.roster) ?? undefined,
        },
        marks: marks.length ? marks : undefined,
      });
    }
    return out;
  }, [allTime, career, recs, honors, wins, players, played]);

  /* ---- STATS · PLAYOFFS -------------------------------------------------
     One row per player who took the field in the winners bracket, over one
     season or every one. The population is far smaller than the regular
     season's by construction — six rosters, three weeks — so there is no games
     floor here: a one-game sample IS the postseason, and filtering it out
     would leave nothing. The reader's floor is the start filter instead. */

  const postSeasons = useMemo(
    () => (allTime ? played : oneSeason ? [oneSeason] : []),
    [allTime, played, oneSeason]);

  const postPop = useMemo<Row[] | null>(() => {
    if (phase !== "post" || !hist || !post) return null;
    const out: Row[] = [];
    for (const pid of Object.keys(post.byPlayer)) {
      const p = postseasonOf(post, pid, postSeasons);
      if (!p) continue;
      const seasons = postSeasons.filter(s => post.byPlayer[pid]?.[s]).length;
      out.push({
        kind: "post",
        pid, name: pInfo(players, pid)[0],
        pos: dviQ.data?.players[pid]?.pos ?? players[pid]?.[1] ?? "?",
        // one season names the franchise he played it for; a pooled row cannot,
        // so it states how many postseasons it is summing
        affil: allTime
          ? `${seasons} postseason${seasons === 1 ? "" : "s"}`
          : p.team,
        seasons, byes: p.byes,
        wl: { start: p.start, roster: p.roster },
        f: {
          // a player who only ever sat a bye has a record and no game — never
          // a zero, which would read as "played and scored nothing"
          gp: p.gp || null,
          pts: p.gp ? p.pts : null,
          ppg: p.gp ? p.pts / p.gp : null,
          war: p.war,
          ws: p.ws,
          wls: wlByWins(p.start),
          wlr: wlByWins(p.roster),
        },
        alt: { wls: wlByLosses(p.start), wlr: wlByLosses(p.roster) },
        text: {
          wls: wlText(p.start) ?? undefined,
          wlr: wlText(p.roster) ?? undefined,
        },
        marks: allTime
          ? (honorTotals(playerHonors(honors, pid)).length
            ? honorTotals(playerHonors(honors, pid)) : undefined)
          : (oneSeason && honors?.byPlayer[pid]?.[oneSeason]?.length
            ? honorTotals([{ season: oneSeason, keys: honors.byPlayer[pid][oneSeason] }])
            : undefined),
      });
    }
    return out;
  }, [phase, hist, post, postSeasons, allTime, oneSeason, honors, players, dviQ.data]);

  /* ---- order, rank, filter --------------------------------------------- */

  const population = hist
    ? (phase === "post" ? postPop : allTime ? allPop : histPop)
    : curPop;
  const cols = hist ? HIST_COLS : CUR_COLS;
  const grps = hist ? HIST_GRPS : CUR_GRPS;
  const strip = hist ? HIST_STRIP : CUR_STRIP;

  /* Sort the whole population, assign rank within position off that order, THEN
     filter — so RB4 is still RB4 inside the RB-only view. The ranks live in a
     map rather than on the row objects: a memo that mutates its input is a memo
     whose output depends on how many times it ran. */
  /* A RECORD COLUMN'S SECOND CLICK CHANGES THE KEY, NOT THE DIRECTION. `useSort`
     only knows about a direction, so this is where the flag on it is read as
     "the other quantity": both record keys are read descending, and `dir === 1`
     picks the by-losses one out of `alt`. Every other column keeps the ordinary
     flip. */
  const byLosses = RECORD_KEYS.has(s.sort) && s.dir === 1;

  const ordered = useMemo(() => {
    if (!population) return null;
    const sorted = byLosses
      ? sortBy(population, r => r.alt?.[s.sort] ?? null, -1)
      : sortBy(population, r => r.f[s.sort] ?? null, s.dir);
    const seen: Record<string, number> = {};
    const posRank = new Map<string, number>();
    for (const r of sorted) {
      seen[r.pos] = (seen[r.pos] ?? 0) + 1;
      posRank.set(r.pid, seen[r.pos]);
    }
    return { sorted, posRank };
  }, [population, s.sort, s.dir, byLosses]);

  /* NO MINIMUM-STARTS FILTER (Max, 2026-09-03). The question one would have
     answered — who starts a lot and still loses — is the record columns' second
     sort key: click Started twice and the board orders by losses, most first,
     so 21-16 leads 30-15 and nobody has to pick a threshold. A filter would
     have needed a scope-aware set of steps and a rule for resetting them, to do
     worse. */
  const rows = useMemo(() => {
    if (!ordered) return null;
    const needle = q.trim().toLowerCase();
    return ordered.sorted.filter(r =>
      (pos === "ALL" || r.pos === pos) &&
      (!needle || r.name.toLowerCase().includes(needle)));
  }, [ordered, pos, q]);

  /* ---- the phone row's demoted keys ------------------------------------ */

  /* The strip keys the reader did NOT pick, CAPPED AT TWO (Max, 2026-09-03).
     Three of them — "WS 5.20 PPG 23.52 W-L S 25-27" — ran to half the row's
     width, and everything that line takes comes out of the name beside it. Two
     pairs leave the identity cell enough to render a full name, which is the
     thing a reader is actually looking for; the third value is one tap away in
     the drawer and is a column on the desktop board.

     GP fills the last slot when there is one — it is the sample size behind
     every other figure on the Stats row and is never a phone sort key, so it
     can never compete with the picked one. */
  const micro = useMemo(() => {
    const other = strip.filter(k => k !== s.sort).slice(0, 2);
    if (hist && s.sort !== "gp" && other.length < 2) other.push("gp");
    return other;
  }, [strip, s.sort, hist]);

  const ready = hist
    ? rows != null
    : rows != null && ![dviQ, cviQ, mxQ, valsQ, ecrQ, rosQ].some(x => x.loading);

  /* A FAILED FETCH IS NOT A SLOW ONE. Without this the board says Loading…
     for the life of the page whenever one of its files drops.

     Stated as "everything settled and there is still no population" rather than
     as "some query errored", because an error is not always fatal here:
     `useDviQuery` reports the missing index_models.json that sent it to the
     dvi.json fallback, and that fallback usually lands. The population is the
     honest test of whether the board can be drawn. */
  const queries = hist
    ? (allTime || phase === "post" ? [] : [sumQ, hTeamQ, mwQ])
    : [dviQ, cviQ, mxQ, valsQ, ecrQ, rosQ];
  const failed = rows == null
    && ((phase === "post" && postErr)
      || (allTime && phase !== "post" && careerErr)
      || (!queries.some(x => x.loading) && queries.some(x => x.error)));

  /* Two identity columns plus the figure columns on desktop; spine, identity
     and the one figure cell on a phone. The drawer spans whatever that is. */
  const span = mobile ? 3 : 2 + cols.length;
  const colOf = (id: Key) => cols.find(c => c.id === id)!;

  return (
    <>
      {/* THE MARK SPRITE, mounted once. Every <HonorMark> on the board is a
          <use> against these symbols, so the shapes exist a single time on the
          page however many rows carry them. */}
      <HonorSprite />

      <div className="v3-head">
        <h1>Players</h1>
        <span className="sub">
          {hist
            ? (allTime ? "what they did, every season" : `what they did in ${season}`)
            : "what they're worth now"}
          {rows ? ` · ${rows.length} shown` : ""}
        </span>
      </div>

      <ScopeControl value={scope} onChange={setScope} seasons={seasons}
        historyLabel="Stats" allTime />

      {/* WHICH HALF OF THE SEASON, on its own row and only in the Stats tense.
          It narrows the POPULATION the way the position chips do — it does not
          re-order anything — so it reads as chips and takes the same `--sel`
          fill, and the accent stays where it has always been, on the sort. Its
          own row rather than two more chips appended to the one below: on a
          375px scroller the position filter is the one every reader uses, and
          it should not start off-screen. */}
      {hist && (
        <div className="v3-filters plx-filters plx-filters2">
          <span className="plx-fk">Phase</span>
          {([["reg", "Regular season"], ["post", "Playoffs"]] as const).map(([id, label]) => (
            <button key={id} type="button" className={`chip${phase === id ? " on" : ""}`}
              onClick={() => setPhase(id)}>{label}</button>
          ))}
        </div>
      )}

      <div className="v3-filters plx-filters">
        {POS_CHIPS.map(p => (
          <button key={p} type="button" className={`chip${pos === p ? " on" : ""}`}
            onClick={() => setPos(p)}>{p}</button>
        ))}
        <input type="search" value={q} placeholder="Search players"
          onChange={e => setQ(e.target.value)} />
      </div>

      {mobile && (
        <div className="plx-sort">
          <span className="k">Sort</span>
          {/* Picking a key sets the direction from the column's own default
              (descending, except a rank) rather than toggling: the strip is a
              key picker, and a mis-tap on the segment that is already lit
              silently reversing the whole board is not a control anyone can
              read. Re-tapping the lit segment is a no-op. */}
          <LensStrip label="Sort" value={s.sort}
            onChange={k => {
              if (k !== s.sort) s.onSort(k, colOf(k).asc);
              /* THE ONE RE-TAP THAT DOES SOMETHING. Re-tapping the lit segment
                 is a no-op everywhere else on this strip, deliberately — a
                 mis-tap silently reversing the whole board is not a control
                 anyone can read. A record column is the exception because its
                 second key has no other way in on a phone: there is no header
                 row here to click twice. */
              else if (RECORD_KEYS.has(k)) s.onSort(k);
            }}
            options={strip.map(k => {
              const c = colOf(k);
              const lbl = c.short ?? c.label;
              return {
                id: k,
                label: k === s.sort && byLosses ? `${lbl} · L` : lbl,
              };
            })} />
        </div>
      )}

      <Band
        label={hist
          ? `${phase === "post" ? "Playoffs" : "Regular season"} · ${
            allTime ? `all-time · ${played[played.length - 1]}–${played[0]}` : season}`
          : `Price · ${rosterSeason} rosters`}
        right={
          /* THE BAND CARRIES BOTH, and the note comes first: it is the thing a
             reader needs without asking, and the Key is the thing they go
             looking for. `Band` renders `right` INSTEAD of `note`, so the note
             is composed in here rather than passed alongside — the prop above
             is left in place because it is what the band means, and this is
             only how it is laid out next to a control. */
          /* NO METHODOLOGY BLURB ON THE STATS BAND (Max, 2026-09-03). Three
             of them lived here — what WAR is measured against, what a career
             total pools, what the bracket counts — and every one is now a
             definition in the Key, where it has room to be a sentence instead
             of a clause and where a reader goes when they want it. A band note
             that repeats the Key is a second copy to keep in step. The price
             board keeps its note: it has no Key habit yet and the one line it
             carries is an argument about the columns, not a definition of
             them. */
          <span className="plx-bandr">
            {!hist && (
              <span className="band-note">
                Three horizons side by side, never blended — where they disagree is the point
              </span>
            )}
            <button type="button" className={`plx-keybtn${keyOpen ? " on" : ""}`}
              aria-expanded={keyOpen} onClick={() => setKeyOpen(v => !v)}>
              {keyOpen ? "Close" : "Key"}
            </button>
          </span>
        } />

      {/* EVERY COLUMN, DEFINED — in the order the columns appear, so a reader
          who is looking at one can count across to it. The phase changes what
          some of them mean, so the list is built from the tense in force
          rather than written out twice. */}
      {keyOpen && (
        <dl className="plx-keylist">
          {cols.map(c => (
            <Fragment key={c.id}>
              <dt>{c.label}{c.short ? ` · ${c.short}` : ""}</dt>
              <dd>{(hist && phase === "post" ? DEF_POST[c.id] : undefined) ?? DEF[c.id]}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      {failed ? <DataError what="The board didn't load" />
        : !ready || !rows ? <div className="empty">Loading…</div>
        /* A SEASON WITH NOTHING IN IT YET is not a broken board. The picker now
           offers the season being played, so an empty scope is the normal state
           of it until week one settles — and it has to say which of the two
           things it is, because "no rows" also happens when the chips and the
           search box have narrowed the list to nothing. */
        : rows.length === 0 ? (
          <div className="empty">
            {hist && oneSeason && oneSeason > latest
              ? `No scored games in ${oneSeason} yet — this fills in as the season is played.`
              : hist && phase === "post" && oneSeason && oneSeason > latest
                ? `${oneSeason} has no bracket yet.`
                : "Nothing matches those filters."}
          </div>
        ) : (
        <table className={`v3tbl plx-tbl ${hist ? "plx-hist" : "plx-cur"}`}>
          {!mobile && (
            <thead>
              <tr className="plx-grp">
                <th className="sp" />
                <th className="t" />
                {grps.map(g => (
                  <th key={g.label} className="plx-edge" colSpan={g.span}>{g.label}</th>
                ))}
              </tr>
              <tr className="plx-cols">
                <th className="c sp">#</th>
                <th className="t">Player</th>
                {/* NO MARKER ON THE SECOND KEY (Max, 2026-09-03). A record
                    header could carry a "by L" to say which of its two
                    orderings is in force, and it did briefly; the board is
                    legible without it, because the reader who clicked twice can
                    see what the column did. A qualifier every reader has to
                    parse to serve the one who forgot is the wrong trade. */}
                {cols.map(c => (
                  <Th key={c.id} id={c.id} label={c.label} align="n" width={c.width}
                    asc={c.asc} sort={s.sort} onSort={s.onSort} />
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.slice(0, 300).map((r, i) => (
              /* KEYED BY PID, and the drawer keyed with it. Sorting reorders
                 these nodes in place rather than remounting the list, which is
                 what keeps the reader's scroll position where they left it. */
              <Fragment key={r.pid}>
                <TapRow className={`${i % 2 ? "zebra" : ""}${open === r.pid ? " plx-on" : ""}`}
                  onTap={() => setOpen(open === r.pid ? null : r.pid)}>
                  {/* Position colour on the spine, never on the name: a
                      coloured name is a link affordance everywhere else on this
                      board. No accent on the leaders' ordinals either — "top 3
                      by whatever you last sorted by" is not a threshold, and
                      this screen spends its accent on the sort. */}
                  <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                  {/* THE NAME IS THE LINK, THE ROW IS THE DRAWER (Max,
                      2026-09-02) — the classic board's split, restored. The
                      name goes straight to the player page; anywhere else on
                      the row opens the drawer in place. IdCell stops the
                      click at the anchor so a name tap never also toggles the
                      drawer. The earlier "no second exit under the thumb"
                      rule lost to a reader who knows which he wants. */}
                  {/* THE HONOR MARKS ARE A DESKTOP AFFORDANCE (Max,
                      2026-09-03). They sat beside the name until a phone showed
                      what that costs — four tiers and three ×N counts rendered
                      Christian McCaffrey as "C." — then moved to the sub-line,
                      capped at two, which was better and still bought a
                      decoration with width the affiliation wanted.

                      On a phone they are in the DRAWER instead, whole and
                      labelled. A tap is already how a reader asks a row for
                      more, the drawer has room for all five tiers with their
                      counts, and the row gets its identity cell back. On
                      desktop they stay on the sub-line, where the column is
                      wide enough that they cost nothing.

                      Never on the price board in either place: an honor is a
                      settled fact about a played season and has nothing to say
                      about a price.

                      `--pos-mark` tints the crown and the gem to the player's
                      position — the same variable the classic player rail sets,
                      set per row because a table has no per-position container
                      to hang it on. */}
                  <IdCell name={r.name} to={betaPath(`/player/${r.pid}`)}
                    sub={<>
                      {[r.affil, `${r.pos}${ordered!.posRank.get(r.pid)}`]
                        .filter(Boolean).join(" · ")}
                      {!mobile && r.marks?.length ? (
                        <span className="plx-marks"
                          style={{ "--pos-mark": POS_COLOR[r.pos] } as CSSProperties}>
                          <HonorMarks marks={r.marks} size={12} showCounts={allTime} />
                        </span>
                      ) : null}
                    </>} />
                  {mobile ? (
                    <td className="n plx-lead">
                      {/* THE PICKED KEY IS THE LEAD FIGURE. No meter beside it
                          (Max, 2026-09-02): the WAR bar read as a gauge, not a
                          statistic, and the headline weight already says which
                          column the board is sorted by. */}
                      <span className="f hd">{cellOf(r, s.sort)}</span>
                      {micro.length > 0 && (
                        <div className="plx-micro">
                          {micro.map(k => (
                            <span key={k} className="o">
                              {(colOf(k).short ?? colOf(k).label).toUpperCase()}
                              <b>{cellOf(r, k)}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  ) : cols.map(c => (
                    <td key={c.id} className={`n${c.edge ? " plx-edge" : ""}`}>
                      <span className={`f${c.id === s.sort ? " hd" : ""}`}>
                        {cellOf(r, c.id)}
                      </span>
                    </td>
                  ))}
                </TapRow>
                {open === r.pid && (
                  <tr className="plx-drawrow">
                    <td colSpan={span}>
                      {r.kind === "cur"
                        ? <CurDrawer r={r} season={rosterSeason} to={betaPath(`/player/${r.pid}`)} />
                        : r.kind === "post"
                        ? <PostDrawer r={r} season={allTime ? null : oneSeason}
                          to={betaPath(`/player/${r.pid}`)} />
                        : r.kind === "all"
                          ? <AllDrawer r={r} to={betaPath(`/player/${r.pid}`)} />
                          : <HistDrawer r={r} season={oneSeason!} to={betaPath(`/player/${r.pid}`)}
                            weekly={wkQ.data?.[r.pid] ?? null} loading={wkQ.loading}
                            playoffStart={mwQ.data?.playoff_start ?? 15} />}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {rows && rows.length > 300 && (
        <div className="tnote screen">
          Showing the top 300 of {rows.length}. Narrow with the position chips or the search
          box — this is a phone, and a 900-row table is a scroll, not a ranking.
        </div>
      )}

      <div className="tnote screen">
        {hist && phase === "post" ? (
          <>
            The winners bracket, elimination games only — the championship counts, the
            third- and fifth-place games do not, and the consolation bracket does not at all.
            Playoff WAR is points above the week's positional replacement converted to wins,
            credited win or lose. Win share divides each won game's 1.0 among its nine
            starters, half by Shapley win-probability contribution and half by points over
            replacement, so a champion's lineup sums to 3.0 and a total reads as "he
            accounted for 1.4 of his team's 3 playoff wins". A FIRST-ROUND BYE IS A WIN: the top two seeds advance
            without playing, and a record that ignored that would rank finishing first below
            finishing third. The bye's points are the player's own playoff average rather
            than a real score — the lineup did score that week, but only the team total for
            it is on the site, so the week is carried at his average, which moves games and
            points and leaves PPG where it was. A player with no elimination game has no
            average to carry and takes the win alone. Everything else on this board is
            measured.
          </>
        ) : hist ? (
          <>
            WAR = wins over the best player left out of the league's 108 startable slots,
            regular season only. Win share is the other half of Maxalytics and answers the
            other question: every game a team wins hands out exactly 1.0 among the nine who
            started it, half by Shapley win-probability contribution and half by points over
            replacement, so the league's shares sum to the 84 games it actually won and a
            total reads as "he accounted for 3.2 of his team's 9 wins". WAR is what he was
            worth; win share is how much of the winning was his. The two records are the
            weeks he was there, not what he did:
            STARTED counts the weeks a manager put him in the lineup and how that lineup
            finished; ROSTERED counts every week he was owned, started or benched. Both are
            partly a fact about the roster around him — a back on the best team in the league
            wins games he had nothing to do with — which is why they sit beside WAR rather
            than instead of it. A record column sorts twice: the first click orders it by
            WINS, the second by LOSSES — both most-first. Two keys rather than two
            directions, because reversing "most wins" is
            "fewest wins", which floats a player who barely started above the one who
            started all year and lost. The marks beside a name are that
            {allTime ? " career's" : " season's"} honors.{" "}
            {allTime
              ? "Career totals over every settled season."
              : "Volatility is the weekly σ of fantasy points, so lower is steadier. The franchise on each row is who STARTED him most that season, which is not always who was holding him in January."}
            {" "}There is no games floor: every player the scope scored is listed, GP is a
            column and each record states its own sample, so a short season is visible as a
            short season rather than hidden. Only PPG rewards a tiny one — read it next to GP.
            {" "}Nothing on this board is a price: what a player is worth today is under Current.
          </>
        ) : (
          <>
            DVI prices the dynasty horizon and CVI the coming season, both 0–100. Proj WAR
            is the model's projection for the coming season. KTC and FantasyCalc are dynasty market prices in their own
            currencies; ECR is the FantasyPros redraft consensus, where 1 is best, so a rookie
            sits below his dynasty price by design. None of them are blended. The position
            badge carries rank within position for the active sort. What a player actually did
            — in a given year or across every season — is under Stats.
          </>
        )}
      </div>
    </>
  );
}

/* ========================================================================
   THE DRAWERS

   Below the row, inside the table flow, with the accent top rule — never a
   modal and never appended after the table, which on a phone would open the
   detail 260 rows below the row that was tapped.

   Each carries six figures and exactly one control, and that control is the
   only thing on this screen that leaves it. The drawer answers "is there
   anything else about him", not "everything about him": the full reference
   table, the week grid and the ownership history are the player page's, and
   duplicating them here would make the page the thing you never need to open.
   ======================================================================== */

function Fig({ k, v, sub, word }: {
  k: string; v: ReactNode; sub?: ReactNode;
  /** a club or a franchise — a word in a figure slot, not a numeral */
  word?: boolean;
}) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className={word ? "v w" : "v"}>{v}</div>
      {sub != null && <div className="s">{sub}</div>}
    </div>
  );
}

/**
 * THE HONORS BLOCK — every mark the row's scope earned, with its counts.
 *
 * On a phone this is the ONLY place they appear: the row's identity cell has
 * no width to spare and the drawer is already where a reader goes for the rest
 * of a row. On desktop it repeats what the sub-line shows, deliberately — the
 * sub-line's glyphs are unlabelled, and this is where the reader finds out that
 * the crown means positional king.
 *
 * Renders nothing when there are none: an empty honors block on 600 of 684
 * rows would say "this player has no honors" in a space the drawer needs for
 * figures, and the absence already says it.
 */
function Honors({ marks, pos }: { marks?: [HonorKey, number][]; pos: string }) {
  if (!marks?.length) return null;
  return (
    <div className="plx-honors" style={{ "--pos-mark": POS_COLOR[pos] } as CSSProperties}>
      <span className="k">Honors</span>
      <HonorMarks marks={marks} size={17} />
      <span className="lb">
        {marks.map(([k, n]) => `${HONOR_LABEL[k]}${n > 1 ? ` ×${n}` : ""}`).join(" · ")}
      </span>
    </div>
  );
}

function DrawerGo({ to }: { to: string }) {
  const nav = useNavigate();
  return (
    <a className="plx-go" href={`#${to}`}
      onClick={e => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); nav(to);
      }}>Player page</a>
  );
}

function CurDrawer({ r, season, to }: { r: CurRow; season: string; to: string }) {
  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.name}</span>
        <span className="mt">{r.pos}{r.nfl ? ` · ${r.nfl}` : ""} · {season} price</span>
      </div>
      <div className="plx-figs">
        <Fig k="Age" v={r.age == null ? NUL : r.age} sub={`at ${season} kickoff`} />
        <Fig k="NFL" v={r.nfl || NUL} word sub={r.nfl ? "club" : "no club listed"} />
        {/* ANALOG — the comparables arm of the projection, beside the scalar
            one the Proj WAR column carries. Where the two disagree is the point
            of showing both; where the model found no cohort it is the em dash,
            because in that case the analog curve is literally the scalar curve
            and a matching figure would read as two models agreeing. */}
        <Fig k="Analog" v={r.analog == null ? NUL : fmtWar(r.analog)}
          sub={r.analog == null ? "no cohort" : "3-yr, analog curve"} />
        <Fig k="FantasyCalc" v={figOf("fc", r.f.fc ?? null)} sub="dynasty market" />
        <Fig k="ECR" v={figOf("ecr", r.f.ecr ?? null)} sub="redraft, 1 is best" />
        {/* OWNERSHIP is a fact, and "free agent" is a fact too — not a missing
            figure, so it is a word rather than the null glyph. */}
        <Fig k="Roster" v={r.owner ?? "Free agent"} word sub={`${season} rosters`} />
      </div>
      <div className="plx-note">
        Analog is the comparables arm's own three-year curve from the projection matrix,
        not the raw cohort median the classic Value board prints — the same model, one
        step further down it.
      </div>
      <DrawerGo to={to} />
    </div>
  );
}

/**
 * THE CAREER DRAWER.
 *
 * Six cells like the other two, and every one of them answers something a row
 * of totals cannot: totals reward longevity, so the questions worth asking of
 * them are how long, how high, and how good at his best.
 *
 * No week grid and no volatility. A fourteen-cell grid is a fact about one
 * season; across four it would need a season axis, which is the player page.
 */
/**
 * THE POSTSEASON DRAWER.
 *
 * The one drawer whose job is to qualify its own row: three weeks is a sample
 * small enough that every figure above it needs its denominator said out loud,
 * and the bye — the one figure on this board that is imputed rather than
 * measured — has to be visible from the row that carries it.
 */
function PostDrawer({ r, season, to }: { r: PostRow; season: string | null; to: string }) {
  const gp = r.f.gp ?? 0;
  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.name}</span>
        <span className="mt">
          {r.pos} · {season ? `${season} playoffs` : "playoffs, all-time"}
        </span>
      </div>
      <div className="plx-figs">
        <Fig k="Games" v={gp || NUL}
          sub={gp ? "elimination games started" : "never started one"} />
        <Fig k="Started" v={wlText(r.wl.start) ?? NUL}
          sub={`${wlGames(r.wl.start)} week${wlGames(r.wl.start) === 1 ? "" : "s"} in a lineup`} />
        <Fig k="Rostered" v={wlText(r.wl.roster) ?? NUL}
          sub={`${wlGames(r.wl.roster)} week${wlGames(r.wl.roster) === 1 ? "" : "s"} owned`} />
        {/* THE IMPUTED WEEK, NAMED. Every other figure on this board is
            measured; this is the one that is carried, and a reader is entitled
            to know how much of the row it is. */}
        <Fig k="Byes" v={r.byes || NUL}
          sub={r.byes ? "counted as wins, at his own average" : "no first-round bye"} />
        <Fig k="Points" v={r.f.pts == null ? NUL : fmt(r.f.pts, 1)}
          sub={gp ? `over ${gp} game${gp === 1 ? "" : "s"}` : "no scored game"} />
        <Fig k="Postseasons" v={r.seasons} sub={season ? "this one" : "with a bracket game"} />
      </div>
      <Honors marks={r.marks} pos={r.pos} />
      <div className="plx-note">
        Winners bracket, elimination games only — the championship counts, the third- and
        fifth-place games do not, and neither does the consolation bracket. That is the same
        scope the playoff WAR column is built on, so the two never count different games.
      </div>
      <DrawerGo to={to} />
    </div>
  );
}

function AllDrawer({ r, to }: { r: AllRow; to: string }) {
  const gp = r.f.gp ?? 0;
  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.name}</span>
        <span className="mt">{r.pos} · career, regular season</span>
      </div>
      <div className="plx-figs">
        <Fig k="Seasons" v={r.seasons} sub={`${gp} game${gp === 1 ? "" : "s"}`} />
        {/* The best year, which is what a career total hides: four steady
            seasons and one enormous one add to the same number. */}
        <Fig k="Best season" v={r.best?.season ?? NUL} word
          sub={r.best ? `${fmtWar(r.best.war)} WAR` : "no scored season"} />
        <Fig k="Peak finish" v={r.peak == null ? NUL : `${r.pos}${r.peak}`}
          sub="best rank at the position, by WAR" />
        <Fig k="WAR per season" v={r.seasons ? fmtWar((r.f.war ?? 0) / r.seasons) : NUL}
          sub="the total, spread evenly" />
        {/* The two records again, whole — the columns print them, and this is
            where the sample behind each one is stated. */}
        <Fig k="Started" v={wlText(r.wl.start) ?? NUL}
          sub={`${wlGames(r.wl.start)} week${wlGames(r.wl.start) === 1 ? "" : "s"} in a lineup`} />
        <Fig k="Rostered" v={wlText(r.wl.roster) ?? NUL}
          sub={`${wlGames(r.wl.roster)} week${wlGames(r.wl.roster) === 1 ? "" : "s"} owned`} />
      </div>
      <Honors marks={r.marks} pos={r.pos} />
      {/* NO NOTE HERE (Max, 2026-09-03). It read "a record is the roster's, not
          the player's" — a definition, and definitions are the Key's job now.
          A drawer is opened to see MORE OF THIS ROW; a paragraph that says the
          same thing under every row is not more of the row, and at this width
          it was the largest thing in the drawer. */}
      <DrawerGo to={to} />
    </div>
  );
}

function HistDrawer({ r, season, to, weekly, loading, playoffStart }: {
  r: HistRow; season: string; to: string;
  weekly: WeeklyRow[] | null;
  loading: boolean;
  playoffStart: number;
}) {
  // best REGULAR-SEASON week: the board's whole tense is the regular season, and
  // a playoff explosion under a "regular season" band would be the wrong week.
  const best = useMemo(() => {
    if (!weekly) return null;
    let bw = 0, bp = -Infinity;
    for (const w of weekly) {
      if (w[0] >= playoffStart) continue;
      if (w[1] > bp) { bp = w[1]; bw = w[0]; }
    }
    return bw ? { week: bw, pts: bp } : null;
  }, [weekly, playoffStart]);

  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.name}</span>
        <span className="mt">{r.pos} · {season} regular season</span>
      </div>
      <div className="plx-figs">
        <Fig k="GP" v={figOf("gp", r.f.gp ?? null)} sub="regular season" />
        <Fig k="Volatility" v={r.sdv == null ? NUL : fmt(r.sdv, 1)}
          sub={r.sdv == null ? "not published for this season" : "weekly σ, lower is steadier"} />
        <Fig k="WAR/G" v={r.warG == null ? NUL : fmtWar(r.warG)} sub="per game played" />
        {/* The badge on the row ranks him by whatever the board is sorted by;
            this is the finish, which is by points and does not move. Two
            numbers of the same shape, so this one names its ruler. */}
        <Fig k="Pos finish" v={r.finish ? `${r.pos}${r.finish}` : NUL} sub="by points" />
        {/* the week scores arrive on their own file, opened with the drawer —
            so "still reading" and "he never scored" are different sub-labels,
            and neither of them is a zero */}
        <Fig k="Best week"
          v={loading ? <span className="nul">…</span> : best == null ? NUL : fmt(best.pts, 1)}
          sub={loading ? "reading the week scores"
            : best == null ? "no scored week" : `week ${best.week}`} />
        {/* THE SAME FACT the row's sub-line carries, from the same derivation —
            most regular-season starts, not end-of-season ownership. */}
        <Fig k="Started for" v={r.started?.team ?? NUL} word
          sub={r.started ? `${r.started.starts} start${r.started.starts === 1 ? "" : "s"}` : "never started"} />
      </div>
      <Honors marks={r.marks} pos={r.pos} />
      {/* No market price in here, in any tense. What he cost in 2026 says
          nothing about what he returned in this season, and a row that carried
          both would leave the reader unable to say which one it was ordered by. */}
      <DrawerGo to={to} />
    </div>
  );
}
