import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { useMobile } from "../../lib/useWidth";
import ScopeControl, { useScope } from "../Scope";
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
 *   HISTORY  one settled season's production — GP, Points, PPG, WAR
 *
 * ONE TENSE PER VIEW, all the way down. There is no market price anywhere in
 * the History board and no per-season production anywhere in the Current one,
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
type Key = "dvi" | "cvi" | "war" | "ktc" | "fc" | "ecr" | "gp" | "pts" | "ppg";

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

const HIST_COLS: Col[] = [
  { id: "gp", label: "GP", width: "7%", edge: true },
  { id: "pts", label: "Points", short: "PTS", width: "10%" },
  { id: "ppg", label: "PPG", width: "9%" },
  { id: "war", label: "WAR", width: "16%", edge: true },
];
const HIST_GRPS = [
  { label: "Production", span: 3 },
  { label: "Wins added", span: 1 },
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
const HIST_STRIP: Key[] = ["war", "ppg", "pts"];

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
};

/** a figure, or the em dash. NEVER a zero: a player the market has never priced
 *  and a player priced at nothing are different facts. */
const figOf = (id: Key, v: number | null): ReactNode => v == null ? NUL : FMT[id](v);

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
type Row = CurRow | HistRow;

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

  /** SETTLED seasons, newest first. `latest` is the newest season with games
   *  played, so the roster season is never offered as a history year — it is a
   *  tense the data cannot fill, and an empty 2026 column would read as a
   *  league that scored nothing. */
  const played = useMemo(
    () => meta.seasons.filter(y => y <= latest).slice().reverse(),
    [meta.seasons, latest]);
  const [scope, setScope] = useScope(played);
  const hist = scope.scope === "history";
  const season = hist ? scope.season : null;
  /* No champion/record note on the picker rows. It would be the right thing to
     show there and it costs a 217 KB franchises.json fetch this screen makes
     for nothing else; the League screen already holds that file and is where
     the note earns itself. */
  const seasons = useMemo(() => played.map(id => ({ id })), [played]);

  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

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
  const tense = hist ? `h:${season}` : "c";
  useEffect(() => { setOpen(null); }, [tense]);

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

  /* ---- HISTORY: one settled season ------------------------------------- */

  const sumQ = useJson<SummaryRow[]>(season ? `${season}/summary.json` : null);
  const hTeamQ = useJson<Team[]>(season ? `${season}/teams.json` : null);
  const mwQ = useJson<Matchups>(season ? `${season}/matchups.json` : null);
  /* weekly.json is 140 KB and answers exactly one figure in the drawer, so it
     is fetched when a drawer is open and not before. Opening a second row keeps
     the same path, so the file is fetched once per season, not once per tap. */
  const wkQ = useJson<Weekly>(season && open ? `${season}/weekly.json` : null);

  const histPop = useMemo<Row[] | null>(() => {
    const sum = sumQ.data;
    if (!sum || !hTeamQ.data || !mwQ.data) return null;
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
      return {
        kind: "hist",
        pid, name: pInfo(players, pid)[0], pos: p,
        affil: st?.team ?? null,
        sdv: typeof sdv === "number" ? sdv : null,
        warG: gp ? war / gp : null,
        finish: finish.get(pid) ?? 0,
        started: st,
        f: { gp, pts, ppg, war },
      };
    });
    /* Floor the tiny samples out of the leaderboard: a two-game cameo at 22 PPG
       is not a season, and left in it outranks everyone who played one. The
       same 45% rule the classic Stats board applies, said out loud in the band
       note rather than silently shortening the list. */
    const gpMax = all.reduce((m, r) => Math.max(m, r.f.gp ?? 0), 0);
    const floor = Math.round(gpMax * 0.45);
    return all.filter(r => (r.f.gp ?? 0) >= floor);
  }, [sumQ.data, hTeamQ.data, mwQ.data, players]);

  /* ---- order, rank, filter --------------------------------------------- */

  const population = hist ? histPop : curPop;
  const cols = hist ? HIST_COLS : CUR_COLS;
  const grps = hist ? HIST_GRPS : CUR_GRPS;
  const strip = hist ? HIST_STRIP : CUR_STRIP;

  /* Sort the whole population, assign rank within position off that order, THEN
     filter — so RB4 is still RB4 inside the RB-only view. The ranks live in a
     map rather than on the row objects: a memo that mutates its input is a memo
     whose output depends on how many times it ran. */
  const ordered = useMemo(() => {
    if (!population) return null;
    const sorted = sortBy(population, r => r.f[s.sort] ?? null, s.dir);
    const seen: Record<string, number> = {};
    const posRank = new Map<string, number>();
    for (const r of sorted) {
      seen[r.pos] = (seen[r.pos] ?? 0) + 1;
      posRank.set(r.pid, seen[r.pos]);
    }
    return { sorted, posRank };
  }, [population, s.sort, s.dir]);

  const rows = useMemo(() => {
    if (!ordered) return null;
    const needle = q.trim().toLowerCase();
    return ordered.sorted.filter(r =>
      (pos === "ALL" || r.pos === pos) &&
      (!needle || r.name.toLowerCase().includes(needle)));
  }, [ordered, pos, q]);

  /* ---- the phone row's demoted keys ------------------------------------ */

  /* The strip keys the reader did NOT pick, capped at three. A sort set from a
     desktop header (ECR, FantasyCalc) is not on the strip at all, which is the
     case the cap exists for: nothing is displaced, so the first three keys ride
     the micro line and the lead figure is still the column the board is ordered
     by. GP joins the History line because it is the sample size behind every
     other figure on that row and is never a phone sort key, so it can never
     compete with the picked one. */
  const micro = useMemo(() => {
    const other = strip.filter(k => k !== s.sort).slice(0, 3);
    if (hist && s.sort !== "gp" && other.length < 3) other.push("gp");
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
    ? [sumQ, hTeamQ, mwQ]
    : [dviQ, cviQ, mxQ, valsQ, ecrQ, rosQ];
  const failed = rows == null
    && !queries.some(x => x.loading) && queries.some(x => x.error);

  /* Two identity columns plus the figure columns on desktop; spine, identity
     and the one figure cell on a phone. The drawer spans whatever that is. */
  const span = mobile ? 3 : 2 + cols.length;
  const colOf = (id: Key) => cols.find(c => c.id === id)!;

  return (
    <>
      <div className="v3-head">
        <h1>Players</h1>
        <span className="sub">
          {hist ? `what they did in ${season}` : "what they're worth now"}
          {rows ? ` · ${rows.length} shown` : ""}
        </span>
      </div>

      <ScopeControl value={scope} onChange={setScope} seasons={seasons} />

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
            onChange={k => { if (k !== s.sort) s.onSort(k, colOf(k).asc); }}
            options={strip.map(k => {
              const c = colOf(k);
              return { id: k, label: c.short ?? c.label };
            })} />
        </div>
      )}

      <Band
        label={hist ? `Regular season · ${season}` : `Price · ${rosterSeason} rosters`}
        note={hist
          ? "WAR vs the best player left out of the league's 108 startable slots · under 45% of the season's max games filtered out"
          : "Three horizons side by side, never blended — where they disagree is the point"} />

      {failed ? <DataError what="The board didn't load" />
        : !ready || !rows ? <div className="empty">Loading…</div> : (
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
                  {/* NO LINK ON THE NAME. Everywhere else on the beta shell a
                      row navigates and the name is the same destination; here
                      the row opens a drawer, and the drawer's button is the one
                      control that leaves the screen. A linked name would be a
                      second exit sitting under the thumb that was reaching for
                      the row. */}
                  <IdCell name={r.name} thumb={r.pid}
                    sub={[r.affil, `${r.pos}${ordered!.posRank.get(r.pid)}`]
                      .filter(Boolean).join(" · ")} />
                  {mobile ? (
                    <td className="n plx-lead">
                      {/* THE PICKED KEY IS THE LEAD FIGURE. No meter beside it
                          (Max, 2026-09-02): the WAR bar read as a gauge, not a
                          statistic, and the headline weight already says which
                          column the board is sorted by. */}
                      <span className="f hd">{figOf(s.sort, r.f[s.sort] ?? null)}</span>
                      {micro.length > 0 && (
                        <div className="plx-micro">
                          {micro.map(k => (
                            <span key={k} className="o">
                              {(colOf(k).short ?? colOf(k).label).toUpperCase()}
                              <b>{figOf(k, r.f[k] ?? null)}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  ) : cols.map(c => (
                    <td key={c.id} className={`n${c.edge ? " plx-edge" : ""}`}>
                      <span className={`f${c.id === s.sort ? " hd" : ""}`}>
                        {figOf(c.id, r.f[c.id] ?? null)}
                      </span>
                    </td>
                  ))}
                </TapRow>
                {open === r.pid && (
                  <tr className="plx-drawrow">
                    <td colSpan={span}>
                      {r.kind === "cur"
                        ? <CurDrawer r={r} season={rosterSeason} to={betaPath(`/player/${r.pid}`)} />
                        : <HistDrawer r={r} season={season!} to={betaPath(`/player/${r.pid}`)}
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
        {hist ? (
          <>
            WAR = wins over the best player left out of the league's 108 startable slots,
            regular season only. Volatility is the weekly σ of fantasy points, so lower is
            steadier. The franchise on each row is who STARTED him most that season, which is
            not always who was holding him in January. Nothing on this board is a price:
            what a player is worth today is under Current.
          </>
        ) : (
          <>
            DVI prices the dynasty horizon and CVI the coming season, both 0–100. Proj WAR
            is the model's projection for the coming season. KTC and FantasyCalc are dynasty market prices in their own
            currencies; ECR is the FantasyPros redraft consensus, where 1 is best, so a rookie
            sits below his dynasty price by design. None of them are blended. The position
            badge carries rank within position for the active sort. What a player actually did
            in a given year is under History.
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
      {/* No market price in here, in any tense. What he cost in 2026 says
          nothing about what he returned in this season, and a row that carried
          both would leave the reader unable to say which one it was ordered by. */}
      <DrawerGo to={to} />
    </div>
  );
}
