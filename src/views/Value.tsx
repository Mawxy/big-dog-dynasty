import { useMemo, useState } from "react";
import type { EcrFile, KnnFile, ProjectionsFile, Team, Values } from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCviQuery, useDviQuery } from "../lib/useIndices";
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

  const latest = latestSeasonOf(meta);
  const rosterSeason = rosterSeasonOf(league);

  // Seven sources, each optional: a failure costs the board that file's columns
  // and nothing else, which is what the merge below already assumes. The board
  // paints once they have all settled — a partial merge would rank the
  // population on whichever half arrived first and then re-rank under the
  // reader.
  const projsQ = useJson<ProjectionsFile>("projections.json");
  // model-aware: these follow the masthead's projection-model control,
  // and keep the query shape because `ready` below gates on .loading
  const dviQ = useDviQuery();
  const cviQ = useCviQuery();
  // global files: the market and the consensus price a format, not a league
  const valsQ = useJson<Values>("data/values.json", "globalDaily");
  const ecrQ = useJson<EcrFile>("data/ecr.json", "globalDaily");
  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);
  // experimental; its absence costs the board nothing
  const knnQ = useJson<KnnFile>("projections_knn_hybrid.json");
  const projs = projsQ.data, dvi = dviQ.data, cvi = cviQ.data;
  const vals = valsQ.data, ecr = ecrQ.data, curTeams = teamsQ.data, knn = knnQ.data;
  const ready = ![projsQ, dviQ, cviQ, valsQ, ecrQ, teamsQ, knnQ].some(q => q.loading);

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
  const cols = useMemo(
    () => mobile ? mobileCols(COLS, ["dvi", "cvi", "war1"]) : COLS, [mobile]);
  const groups = mobile ? [...GROUPS, TAIL_GRP] : GROUPS;

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
        war1: p.composite?.[0] ?? null,
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
    // prices attach to known players, never create rows — values.json is
    // global and would otherwise flood the page with unrostered players
    for (const [pid, r] of Object.entries(vals?.players ?? {})) {
      const row = byId.get(pid);
      if (!row) continue;
      row.ktc = ktcOf(r, meta.tep);
      row.fc = r.fc ?? null;
    }
    // analog projection: attaches to known players only, same as prices. Its
    // corpus reaches every NFL player, not just this league's rosters.
    for (const k of knn?.players ?? []) {
      const row = k.pid ? byId.get(k.pid) : undefined;
      if (row) row.warK = k.proj?.[0] ?? null;
    }
    const slug = Object.keys(ecr?.formats ?? {})[0];
    if (slug) for (const [pid, byFmt] of Object.entries(ecr?.players ?? {})) {
      const row = byId.get(pid);
      const e = byFmt[slug];
      if (row && e) row.ecr = e.ecr ?? null;
    }
    const all = [...byId.values()];
    all.forEach(r => { r.team = owners[r.id] || "—"; });

    const ctx: BoardCtx = { warMax: 0.01 };
    // sort the FULL population first, then assign position rank from that
    // order, then filter — so RB4 stays RB4 inside the RB-only view
    const sorted = applySort(all, sortCol(COLS, sortId, "dvi"), dir);
    const counters: Record<string, number> = {};
    sorted.forEach(r => {
      counters[r.pos] = (counters[r.pos] ?? 0) + 1;
      r.posRank = counters[r.pos];
    });
    return { population: sorted, ctx };
    // `players` was listed here and read nowhere in the body — every row's name
    // and position come from projections/dvi/cvi. It only forced re-runs.
  }, [projs, dvi, cvi, vals, ecr, curTeams, knn, sortId, dir, meta]);

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
        </span>
      </div>

      {!ready ? <div className="empty">Loading…</div> : (
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
        bare figures by design. Proj WAR is the model's composite for the coming season;
        <b> Analog</b> is the experimental comparables model beside it — the median of what
        the k most similar historical player-seasons actually returned, so it reads low
        for anyone whose comparables mostly did nothing. Where the two disagree is the
        point of showing both.
        KTC and FantasyCalc are dynasty market prices in their own currencies; ECR is the
        FantasyPros expert consensus rank for redraft, where 1 is best, so it prices the
        coming season alone and a rookie will sit below his dynasty price. None of the
        three are blended, since where they disagree is the point. A DVI with no market behind it
        is still scored on whatever signals remain, so a low figure can mean "cheap" or
        "barely measured". The position badge carries rank within position for the
        active sort. What a player actually did in a given year is on Stats.
      </div>
    </>
  );
}
