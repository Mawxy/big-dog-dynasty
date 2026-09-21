import { useMemo, useState } from "react";
import type { EcrFile, MatrixFile, ProjectionsFile, Team, Values } from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCviQuery, useDviQuery, useOutlook1 } from "../lib/useIndices";
import { outlookLabel, outlookNote } from "../lib/outlook";
import { useLeagueCaps } from "../lib/caps";
import { fmt, fmtWar } from "../lib/stats";
import { latestSeasonOf, ownerOf, rosterSeasonOf } from "../lib/league";
import { useLeague } from "../lib/context";
import { ktcOf } from "../lib/values";
import PlayerPanel from "../components/PlayerPanel";
import DataTable, { applySort, sortCol, useTableSort } from "../components/DataTable";
import { useMobile } from "../lib/useWidth";
import {
  BoardScope, blankRow, identityCols, idxCell, mobileCols, srcCell, TAIL_GRP,
  usePlayerFilters, type BoardCtx, type PlayerCol, type PlayerRow,
} from "../components/PlayerBoard";

/**
 * VALUE — what every player is worth right now, in one table.
 *
 * This absorbed the old Value now / Market lens pair. They were split because
 * six numeric columns plus five identity columns is eleven, one over the cap
 * that keeps a row on one line. Merging them means dropping a column, and the
 * one that goes is NFL team: on a board about price, the affiliation a reader
 * is scanning for is which roster in THIS league holds the player. The NFL
 * club is still on the player page and in the drawer.
 *
 * Reading left to right the row now answers one question in three currencies:
 * our own model (DVI, CVI, projected WAR), what the dynasty market pays (KTC,
 * FantasyCalc), and where the win-now consensus ranks him (ECR). They are
 * never blended — where they disagree is the point, and a merged table is what
 * makes the disagreement visible on a single line.
 */
const nul = <span className="fig quiet">—</span>;

const COLS: PlayerCol[] = [
  ...identityCols({ nfl: false }),
  {
    id: "dvi", label: "DVI", grp: 1, w: 9, align: "n", edge: true, keyCol: true,
    td: "n edge", sort: r => r.dvi, cell: r => idxCell(r.dvi),
  },
  {
    id: "cvi", label: "CVI", grp: 1, w: 9, align: "n", td: "n",
    sort: r => r.cvi, cell: r => idxCell(r.cvi),
  },
  {
    id: "war1", label: "Proj WAR", grp: 1, w: 10, align: "n", td: "fig n",
    sort: r => r.war1, cell: r => r.war1 == null ? nul : fmtWar(r.war1),
  },
  {
    id: "warK", label: "Analog", grp: 1, w: 10, align: "n", td: "fig n",
    sort: r => r.warK, cell: r => r.warK == null ? nul : fmtWar(r.warK),
  },
  {
    id: "ktc", label: "KTC", grp: 2, w: 9, align: "n", edge: true,
    td: "n edge", sort: r => r.ktc, cell: r => srcCell(r.ktc, r.ktc?.toLocaleString() ?? ""),
  },
  {
    id: "fc", label: "FantasyCalc", grp: 2, w: 11, align: "n", hm: true,
    td: "n hm", sort: r => r.fc, cell: r => srcCell(r.fc, r.fc?.toLocaleString() ?? ""),
  },
  // a RANK: lower is better, sorts ascending first, unranked falls last
  {
    id: "ecr", label: "ECR", grp: 3, w: 9, align: "n", edge: true, asc: true,
    td: "n edge", sort: r => r.ecr, cell: r => srcCell(r.ecr, String(r.ecr)),
  },
];

/* The model group carries the headline figure and takes the accent; the two
 * market groups are references it is read against, so they stay quiet. The
 * market groups are named for the HORIZON each prices, not for how it was
 * gathered: KTC and FantasyCalc are dynasty prices, ECR is a redraft rank.
 * "Consensus" described where the number came from, which is the one thing a
 * reader comparing it to a dynasty price does not need to know. */
const GROUPS = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Our model", cls: "edge value" },
  { id: 2, label: "Dynasty market", cls: "edge" },
  { id: 3, label: "Redraft", cls: "edge" },
];

export default function Value() {
  const { meta, players, league } = useLeague();
  const caps = useLeagueCaps();

  const latest = latestSeasonOf(meta);
  const rosterSeason = rosterSeasonOf(league);

  // Seven sources, each optional: a failure costs the board that file's columns
  // and nothing else, which is what the merge below already assumes. The board
  // paints once the SIX that carry it have settled — a partial merge would rank
  // the population on whichever half arrived first and then re-rank under the
  // reader.
  const projsQ = useJson<ProjectionsFile>(caps.projections ? "projections.json" : null);
  // model-aware: these follow the masthead's projection-model control,
  // and keep the query shape because `ready` below gates on .loading
  const dviQ = useDviQuery();
  const cviQ = useCviQuery();
  // global files: the market and the consensus price a format, not a league.
  // Both are DYNASTY/redraft prices for a dynasty asset — `caps.market` (see
  // lib/caps) is what says whether they describe this league at all.
  const valsQ = useJson<Values>(caps.market ? "data/values.json" : null, "globalDaily");
  const ecrQ = useJson<EcrFile>(caps.market ? "data/ecr.json" : null, "globalDaily");
  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);
  /** year-one projected WAR under the picked curve — off the matrix, not
   *  `projections.json`'s `composite[0]`: that is the scalar composite and only
   *  it, so the Proj WAR column sat still while DVI and CVI on the same row
   *  repriced under the masthead control.
   *
   *  `useOutlook1` rather than `useProjWar1` because this column states a
   *  SEASON figure, and in week 4 of the roster season four of its weeks are
   *  already settled (lib/outlook). Out of season, and against data that
   *  carries no `inseason` block, `outlook` IS the full-season projection and
   *  the column is the one it has always been. */
  const ol = useOutlook1();
  // THE ANALOG COLUMN OFF THE MATRIX, not off projections_knn_hybrid.json.
  // That file is 788 KB — by far the largest on the board — and was fetched
  // whole to fill ONE column with one number per row. The matrix carries the
  // same figure as `analog_natural[0]` with `has_analog` beside it to say
  // whether it is the analog's own read or the scalar fallback, it is 228 KB,
  // and `useOutlook1` above already downloads it: the column now costs nothing.
  //
  // It still must not GATE the first paint (it is not in `ready`): the merge
  // tolerates its absence by construction, so the column fills in when the
  // fetch settles. The re-sort that follows is harmless — the board rests on
  // DVI, and a reader sorting on Analog is by definition looking at a column
  // that has landed.
  const mxQ = useJson<MatrixFile>(caps.projections ? "projections_matrix.json" : null);
  const projs = projsQ.data, dvi = dviQ.data, cvi = cviQ.data;
  const vals = valsQ.data, ecr = ecrQ.data, curTeams = teamsQ.data, mx = mxQ.data;
  const ready = ![projsQ, dviQ, cviQ, valsQ, ecrQ, teamsQ].some(q => q.loading);

  const { sortId, dir, onSort } = useTableSort("dvi");
  const [openPid, setOpenPid] = useState<string | null>(null);
  // roster select for the shared bar — the Value board's rows carry current
  // ownership in `team`, so the options come from the same teams.json
  const fantasyTeams = useMemo(
    () => curTeams ? [...new Set(curTeams.map(t => t.team))].sort((a, b) => a.localeCompare(b)) : undefined,
    [curTeams]);
  const { bar, apply } = usePlayerFilters(() => setOpenPid(null), { teams: fantasyTeams });

  // MOBILE.md M4 — pan the board, on a six-column budget: the three model
  // figures then Roster. The market columns are on the player page.
  const mobile = useMobile();
  /** the column set this league can actually fill. KTC, FantasyCalc and ECR
   *  price a DYNASTY asset; in a redraft league they are three columns of
   *  dashes with two group bands over them, so they come off the board
   *  entirely rather than being drawn empty. */
  /** THE HEADER FOLLOWS THE FIGURE. While the roster season is being played
   *  the cell under "Proj WAR" is no longer a full-season projection, so the
   *  header stops claiming it is — the band note beside it says how much is
   *  banked. Out of season the label never changes. */
  const base = useMemo(() => {
    const live = caps.market ? COLS : COLS.filter(c => !["ktc", "fc", "ecr"].includes(c.id));
    return ol.inseason
      ? live.map(c => (c.id === "war1" ? { ...c, label: "WAR outlook" } : c))
      : live;
  }, [caps.market, ol.inseason]);
  const cols = useMemo(
    () => mobile ? mobileCols(base, ["dvi", "cvi", "war1"]) : base, [mobile, base]);
  const liveGroups = caps.market ? GROUPS : GROUPS.filter(g => g.id < 2);
  const groups = mobile ? [...liveGroups, TAIL_GRP] : liveGroups;

  // The expensive half — merge six sources, sort the whole population, rank
  // within position off that order. Keyed on the DATA and the SORT only: the
  // query lives in `apply`, and while it was a dep of this memo every
  // keystroke re-merged ~800 rows, re-sorted them and re-ranked them to show
  // a list of seven. The filter is its own memo below.
  const { population, ctx } = useMemo(() => {
    // union, not intersection: DVI scores players with no projection, and
    // dropping either side would make the board disagree with its source
    const byId = new Map<string, PlayerRow>();
    const owners = curTeams ? ownerOf(curTeams) : {};
    for (const p of projs?.players ?? []) {
      byId.set(p.pid, {
        ...blankRow(p.pid, p.name, p.pos, ""),
        // the DISPLAYED figure, so the column sorts by what it shows
        war1: ol.rows[p.pid]?.outlook ?? null,
      });
    }
    for (const [pid, r] of Object.entries(dvi?.players ?? {})) {
      const row = byId.get(pid) ?? blankRow(pid, r.name, r.pos, "");
      row.dvi = r.dvi;
      byId.set(pid, row);
    }
    for (const [pid, r] of Object.entries(cvi?.players ?? {})) {
      const row = byId.get(pid) ?? blankRow(pid, r.name, r.pos, "");
      row.cvi = r.cvi;
      byId.set(pid, row);
    }
    // Prices CREATE rows now, deliberately: the board's population is "anyone
    // with a value", not "anyone we project" — a market feed row is exactly
    // how a waiver-wire or rookie name gets on the board at all. A player
    // below the projection floor shows KTC/FC/ECR with WAR as "—" (N/A, not
    // zero — settled with Max, 2026-08-31). Only players players_min can name
    // enter; an id the map doesn't know would render "#12345 · ?".
    for (const [pid, r] of Object.entries(vals?.players ?? {})) {
      let row = byId.get(pid);
      if (!row) {
        const info = players[pid];
        if (!info) continue;
        row = blankRow(pid, info[0], info[1], "");
        byId.set(pid, row);
      }
      row.ktc = ktcOf(r, meta.tep);
      row.fc = r.fc ?? null;
    }
    // analog projection: attaches to known players only, same as prices.
    // `has_analog` is the gate — without a cohort the matrix carries the
    // SCALAR pair under the analog heading, and printing that here would show
    // agreement between two columns that was never measured.
    for (const r of mx?.players ?? []) {
      const row = byId.get(r.pid);
      if (row) row.warK = r.has_analog ? r.analog_natural?.[0] ?? null : null;
    }
    // consensus creates rows too, same rules as prices above
    const slug = Object.keys(ecr?.formats ?? {})[0];
    if (slug) for (const [pid, byFmt] of Object.entries(ecr?.players ?? {})) {
      const e = byFmt[slug];
      if (!e?.ecr) continue;
      let row = byId.get(pid);
      if (!row) {
        const info = players[pid];
        if (!info) continue;
        row = blankRow(pid, info[0], info[1], "");
        byId.set(pid, row);
      }
      row.ecr = e.ecr;
    }
    const all = [...byId.values()];
    all.forEach(r => { r.team = owners[r.id] || "—"; });

    const ctx: BoardCtx = { warMax: 0.01 };
    // sort the FULL population first, then assign position rank from that
    // order, then filter — so RB4 stays RB4 inside the RB-only view
    const sorted = applySort(all, sortCol(base, sortId, "dvi"), dir);
    const counters: Record<string, number> = {};
    sorted.forEach(r => {
      counters[r.pos] = (counters[r.pos] ?? 0) + 1;
      r.posRank = counters[r.pos];
    });
    return { population: sorted, ctx };
    // `players` was listed here and read nowhere in the body — every row's name
    // and position come from projections/dvi/cvi. It only forced re-runs.
  }, [projs, dvi, cvi, vals, ecr, curTeams, mx, ol, sortId, dir, meta, base]);

  // …and the cheap half: the position chips and the name box, over a list that
  // is already built, sorted and ranked. Ranks are read off the row objects, so
  // filtering cannot change them — RB4 is still RB4 in the RB-only view.
  const rows = useMemo(() => apply(population), [population, apply]);
  const count = rows.length;

  const priced = [dvi?.generated && `Priced ${dvi.generated}`,
  vals?.fetched && `market ${vals.fetched}`].filter(Boolean).join(" · ");

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Players</span>
        <BoardScope on="value" />
        <span className="screen-note">
          {priced && `${priced} · `}<b>{count}</b> shown
        </span>
      </div>
      {bar}

      <div className="band">
        <span className="band-label">Price · {rosterSeason} rosters</span>
        <span className="band-note">
          Three horizons side by side, never blended — where they disagree is the point
          {ol.inseason && <>
            {" · "}
            <span title={outlookNote(ol.inseason)}>{outlookLabel(ol.inseason)}</span>
          </>}
        </span>
      </div>

      {/* THE CAPS GATE BEFORE THE LOADING BRANCH (lib/caps): with no
          projections, no indices and no market this board has no currency to
          price anyone in, every fetch 404s, and `!ready` was a permanent
          "Loading…" for a league whose pipeline never writes any of them. */}
      {!caps.indices && !caps.projections && !caps.market ? (
        <div className="empty">
          No price board for this league — DVI, CVI, projections and market prices
          aren't published for it. What every player actually did is on Stats.
        </div>
      ) : !ready ? <div className="empty">Loading…</div> : (
        <DataTable cols={cols} groups={groups} rows={rows} ctx={ctx} rowKey={r => r.id}
          label={`Player value · ${rosterSeason} rosters`}
          sortId={sortId} dir={dir} onSort={onSort} homeCol="rk" openKey={openPid}
          onRowClick={r => setOpenPid(openPid === r.id ? null : r.id)}
          renderDrawer={r => (
            <PlayerPanel pid={r.id} season={latest} teams={curTeams ?? []} players={players} />
          )} />
      )}

      <div className="tnote screen">
        DVI prices the dynasty horizon and CVI the coming season — both 0–100 indices,
        bare figures by design. {ol.inseason
          ? <><b>WAR outlook</b> is what the {ol.inseason.season} season is tracking to
            finish at: the WAR he has already banked plus the rest of the model's
            full-season composite, prorated to the weeks still to be played. The indices,
            the Analog column and every trade figure on the site stay on the full-season
            rate — banked WAR has no trade value.</>
          : "Proj WAR is the model's composite for the coming season;"}
        <b> Analog</b> is the experimental comparables model beside it — the median of what
        the k most similar historical player-seasons actually returned, so it reads low
        for anyone whose comparables mostly did nothing. Where the two disagree is the
        point of showing both.
        {caps.market && <>
          {" "}KTC and FantasyCalc are dynasty market prices in their own currencies; ECR is the
          FantasyPros expert consensus rank for redraft, where 1 is best, so it prices the
          coming season alone and a rookie will sit below his dynasty price. None of the
          three are blended, since where they disagree is the point. A DVI with no market behind it
          is still scored on whatever signals remain, so a low figure can mean "cheap" or
          "barely measured".
        </>}
        {" "}The position badge carries rank within position for the
        active sort. What a player actually did in a given year is on Stats.
      </div>
    </>
  );
}
